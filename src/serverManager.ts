import { spawn, type SpawnOptions } from 'node:child_process';
import { win32 } from 'node:path';
import { buildSpawnSpec, formatSpawnSpec, validateLaunchSettings } from './args';
import { isPortInUse, probeDshUrl, type PortCheckFn, type ProbeFn } from './http';
import { mergeEnvironment } from './environment';
import { normalizeLoopbackUrl, portFromUrl } from './parse';
import { ReadinessScanner } from './readiness';
import type {
  ConnectResult,
  LaunchRequest,
  ServerSnapshot,
  StartResult,
} from './types';

export interface ChildLike {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnImpl = (command: string, args: string[], options: SpawnOptions) => ChildLike;
export type LogFn = (message: string, kind: 'info' | 'data') => void;

export interface ManagerDeps {
  log: LogFn;
  onChanged: (snapshot: ServerSnapshot) => void;
  onManagedProcessSpawned?: (pid: number | undefined) => void | Promise<void>;
  onManagedProcessReady?: (url: string) => void | Promise<void>;
  platform?: NodeJS.Platform;
  spawnImpl?: SpawnImpl;
  probeImpl?: ProbeFn;
  portCheckImpl?: PortCheckFn;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
}

interface Run {
  id: number;
  abort: AbortController;
  ready: Deferred<string>;
  failed: Deferred<Error>;
  exited: Deferred<ExitInfo>;
  child?: ChildLike;
  url?: string;
  expectedPort?: number;
  ignoreExpectedPortOnCleanup: boolean;
  outputTail: string;
  cwd?: string;
  termSent: boolean;
  forceSent: boolean;
}

const PORT_CHECK_TIMEOUT_MS = 600;
const CONNECT_TIMEOUT_MS = 3000;
// Upstream grants itself 5 seconds for graceful disposal. Leave scheduling margin.
const STOP_GRACE_MS = 6500;
const FORCE_KILL_WAIT_MS = 2000;
// VS Code gives deactivate handlers about five seconds in practice. Keep the
// shutdown path comfortably inside that budget while normal Stop remains
// generous enough for DSH's own five-second session flush.
const DISPOSE_GRACE_MS = 2800;
const DISPOSE_FORCE_WAIT_MS = 900;

export class StartCancelledError extends Error {
  constructor() {
    super('已取消启动');
    this.name = 'StartCancelledError';
  }
}

/** A fixed port was taken between the preflight check and DSH binding it. */
export class PortConflictError extends Error {
  constructor(readonly port: number) {
    super(
      `端口 ${port} 已被占用。建议把 vscode-dsh.port 设为 0，` +
        '或使用“连接到运行中的服务”显式连接。'
    );
    this.name = 'PortConflictError';
  }
}

export function isCancellationError(error: unknown): boolean {
  return error instanceof StartCancelledError;
}

/**
 * Concurrency-safe lifecycle owner for exactly one managed or explicitly
 * connected DSH instance. Every asynchronous callback is scoped to a Run id.
 */
export class DshServerManager {
  private snapshot: ServerSnapshot = { state: 'stopped' };
  private run?: Run;
  private nextRunId = 1;
  private pendingKind?: 'start' | 'connect';
  private pendingTarget?: string;
  private pendingPromise?: Promise<StartResult | ConnectResult>;
  private stopPromise?: Promise<void>;
  private disposed = false;

  private readonly platform: NodeJS.Platform;
  private readonly spawnImpl: SpawnImpl;
  private readonly probeImpl: ProbeFn;
  private readonly portCheckImpl: PortCheckFn;

  constructor(private readonly deps: ManagerDeps) {
    this.platform = deps.platform ?? process.platform;
    this.spawnImpl = deps.spawnImpl ?? ((command, args, options) => spawn(command, args, options));
    this.probeImpl = deps.probeImpl ?? probeDshUrl;
    this.portCheckImpl = deps.portCheckImpl ?? isPortInUse;
  }

  getSnapshot(): ServerSnapshot {
    return { ...this.snapshot };
  }

  getUrl(): string | undefined {
    return this.snapshot.url;
  }

  start(request: LaunchRequest): Promise<StartResult> {
    if (this.disposed) return Promise.reject(new Error('扩展正在关闭'));
    if (this.snapshot.state === 'error' && this.run) {
      return Promise.reject(new Error('上一个 DeepSeek Harness 进程仍未确认退出，请先再次执行“停止服务”'));
    }
    if (this.snapshot.state === 'running' && this.snapshot.url) {
      return Promise.resolve({ kind: 'already-running', url: this.snapshot.url });
    }
    if (this.snapshot.state === 'starting') {
      if (this.pendingKind === 'start' && this.pendingPromise) {
        return this.pendingPromise as Promise<StartResult>;
      }
      return Promise.reject(new Error('正在连接其它服务，请先取消当前操作'));
    }
    if (this.snapshot.state === 'stopping') {
      const stopped = this.stopPromise ?? Promise.resolve();
      return stopped.then(() => this.start(request));
    }

    const promise = this.doStart(request);
    this.trackPending('start', promise);
    return promise;
  }

  connect(input: string): Promise<ConnectResult> {
    if (this.disposed) return Promise.reject(new Error('扩展正在关闭'));
    const url = normalizeLoopbackUrl(input);
    if (!url) return Promise.reject(new Error('请输入工作区环境的回环地址，例如 http://127.0.0.1:3080'));
    if (this.snapshot.state === 'error' && this.run) {
      return Promise.reject(new Error('上一个 DeepSeek Harness 进程仍未确认退出，请先再次执行“停止服务”'));
    }
    if (this.snapshot.state === 'running' && this.snapshot.url) {
      return Promise.resolve({ kind: 'already-running', url: this.snapshot.url });
    }
    if (this.snapshot.state === 'starting') {
      if (this.pendingKind === 'connect' && this.pendingPromise) {
        if (this.pendingTarget !== url) {
          return Promise.reject(new Error(`正在连接 ${this.pendingTarget ?? '另一个地址'}，请等待或取消后重试`));
        }
        return this.pendingPromise as Promise<ConnectResult>;
      }
      return Promise.reject(new Error('服务正在启动，请先取消当前操作'));
    }
    if (this.snapshot.state === 'stopping') {
      const stopped = this.stopPromise ?? Promise.resolve();
      return stopped.then(() => this.connect(url));
    }

    const promise = this.doConnect(url);
    this.trackPending('connect', promise, url);
    return promise;
  }

  /** Cancel both spawn startup and an in-flight external connection probe. */
  cancelStart(): Promise<void> {
    if (this.snapshot.state === 'starting') {
      const stopped = this.stop();
      stopped.catch((error) => {
        this.deps.log(`取消操作时清理失败：${normalizeError(error).message}`, 'info');
      });
      return stopped;
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const promise = this.doStop();
    this.stopPromise = promise;
    const clear = () => {
      if (this.stopPromise === promise) this.stopPromise = undefined;
    };
    promise.then(clear, clear);
    return promise;
  }

  async restart(request: LaunchRequest): Promise<StartResult> {
    if (this.snapshot.state === 'running' && this.snapshot.ownership === 'external') {
      throw new Error('外部服务不由本扩展管理，不能重启；请先断开连接');
    }
    await this.stop();
    return this.start(request);
  }

  /** Recheck an external connection immediately before presenting it. */
  async revalidateExternal(): Promise<boolean> {
    if (this.snapshot.state !== 'running' || this.snapshot.ownership !== 'external' || !this.snapshot.url) {
      return this.snapshot.state === 'running';
    }
    const run = this.run;
    if (!run) return false;
    let result;
    try {
      result = await awaitAbortable(
        this.probeImpl(this.snapshot.url, CONNECT_TIMEOUT_MS, run.abort.signal),
        run.abort.signal
      );
    } catch (error) {
      if (isCancellationError(error) && !this.isCurrent(run)) return false;
      throw error;
    }
    if (!this.isCurrent(run)) return false;
    if (result.reachable && result.isDsh) return true;

    this.run = undefined;
    run.abort.abort();
    const error = '与外部 DeepSeek Harness 的连接已断开';
    this.setSnapshot({ state: 'error', error });
    this.deps.log(error, 'info');
    return false;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const run = this.run;
    if (!run) return;

    run.abort.abort();
    if (!run.child || this.snapshot.ownership === 'external') {
      if (this.isCurrent(run)) this.run = undefined;
      this.setSnapshot({ state: 'stopped' });
      return;
    }

    this.setSnapshot({ state: 'stopping', cwd: run.cwd });
    try {
      await this.terminateRun(run, DISPOSE_GRACE_MS, DISPOSE_FORCE_WAIT_MS);
      if (this.isCurrent(run)) this.run = undefined;
      this.setSnapshot({ state: 'stopped' });
    } catch (error) {
      const normalized = normalizeError(error);
      this.setSnapshot({
        state: 'error',
        error: normalized.message,
        cwd: run.cwd,
        ownership: run.child ? 'managed' : undefined,
      });
      this.deps.log(normalized.message, 'info');
    }
  }

  private async doStart(request: LaunchRequest): Promise<StartResult> {
    const { settings, cwd } = request;
    const run = this.createRun(cwd, settings.port > 0 ? settings.port : undefined);
    this.run = run;
    this.setSnapshot({ state: 'starting', cwd });

    try {
      validateLaunchSettings(settings);
      if (settings.port > 0) {
        const occupied = await awaitAbortable(
          this.portCheckImpl(settings.port, PORT_CHECK_TIMEOUT_MS, run.abort.signal),
          run.abort.signal
        );
        this.assertCurrent(run);
        if (occupied) {
          throw new PortConflictError(settings.port);
        }
      }

      this.assertCurrent(run);
      const spec = buildSpawnSpec(settings, request.npxPath, this.platform);
      let child: ChildLike;
      try {
        child = this.spawnImpl(spec.command, spec.args, {
          cwd,
          env: mergeEnvironment(process.env, settings.environment, this.platform),
          detached: this.platform !== 'win32',
          shell: spec.shell,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        throw this.spawnError(spec.command, error);
      }

      run.child = child;
      this.attachChild(run);
      try {
        await awaitAbortable(
          Promise.resolve(this.deps.onManagedProcessSpawned?.(child.pid)),
          run.abort.signal
        );
      } catch (error) {
        if (isCancellationError(error)) throw error;
        throw new Error(`无法登记托管进程：${normalizeError(error).message}`);
      }
      this.deps.log(`启动: ${formatSpawnSpec(spec)}（工作目录 ${cwd}）`, 'info');

      const url = await this.waitUntilReady(run, settings.startupTimeout);
      this.assertCurrent(run);
      if (run.exited.settled) throw this.earlyExitError(run, await run.exited.promise);
      if (run.failed.settled) throw await run.failed.promise;
      const readyPort = portFromUrl(url);
      if (settings.port > 0 && readyPort !== settings.port) {
        throw new Error(
          `DSH 报告的就绪端口 ${readyPort ?? '未知'} 与扩展分配的端口 ${settings.port} 不一致；` +
            '已停止该进程以避免使用错误的 Remote 转发或 Host 信任配置。'
        );
      }
      try {
        await awaitAbortable(
          Promise.resolve(this.deps.onManagedProcessReady?.(url)),
          run.abort.signal
        );
      } catch (error) {
        if (isCancellationError(error)) throw error;
        throw new Error(`无法登记托管服务端口：${normalizeError(error).message}`);
      }
      this.assertCurrent(run);

      run.url = url;
      this.setSnapshot({ state: 'running', url, ownership: 'managed', cwd });
      this.deps.log(`服务已就绪: ${url}`, 'info');
      return { kind: 'started', url };
    } catch (error) {
      const normalized = normalizeError(error);
      if (this.isCurrent(run)) {
        // Cancellation is initiated by stop()/dispose(), which owns process
        // termination. Avoid two independent grace timers for the same run.
        if (!this.stopOwnsRun()) {
          let finalError = normalized;
          let terminationFailed = false;
          if (normalized instanceof PortConflictError) run.ignoreExpectedPortOnCleanup = true;
          try {
            await this.terminateRun(run);
          } catch (terminationError) {
            terminationFailed = true;
            finalError = new Error(`${normalized.message}；${normalizeError(terminationError).message}`);
          }
          // stop()/dispose() may have taken ownership while cleanup awaited.
          // Let that operation publish the terminal state.
          if (!this.isCurrent(run) || this.stopOwnsRun()) {
            throw normalized;
          }
          if (!terminationFailed) this.run = undefined;
          this.setSnapshot({
            state: 'error',
            error: finalError.message,
            cwd,
            ownership: terminationFailed ? 'managed' : undefined,
          });
          throw finalError;
        }
      }
      throw normalized;
    }
  }

  private async doConnect(input: string): Promise<ConnectResult> {
    const url = normalizeLoopbackUrl(input);
    if (!url) throw new Error('请输入本机地址，例如 http://127.0.0.1:3080');

    const run = this.createRun();
    this.run = run;
    this.setSnapshot({ state: 'starting' });
    this.deps.log(`正在连接外部服务: ${url}`, 'info');

    try {
      const result = await awaitAbortable(this.probeImpl(url, CONNECT_TIMEOUT_MS, run.abort.signal), run.abort.signal);
      this.assertCurrent(run);
      if (!result.reachable) throw new Error(`无法连接 ${url}：${result.error ?? '服务没有响应'}`);
      if (!result.isDsh) throw new Error(`${url} 可以访问，但不是 DeepSeek Harness Web 服务`);

      this.setSnapshot({ state: 'running', url, ownership: 'external' });
      this.deps.log(`已连接外部 DeepSeek Harness: ${url}`, 'info');
      return { kind: 'connected', url };
    } catch (error) {
      const normalized = normalizeError(error);
      if (this.isCurrent(run)) {
        this.run = undefined;
        run.abort.abort();
        if (isCancellationError(normalized) || this.snapshot.state === 'stopping' || this.disposed) {
          this.setSnapshot({ state: 'stopped' });
        } else {
          this.setSnapshot({ state: 'error', error: normalized.message });
        }
      }
      throw normalized;
    }
  }

  private async doStop(): Promise<void> {
    try {
      await this.performStop();
    } catch (error) {
      const normalized = normalizeError(error);
      const run = this.run;
      this.setSnapshot({
        state: 'error',
        error: normalized.message,
        cwd: run?.cwd,
        ownership: run?.child ? 'managed' : undefined,
      });
      this.deps.log(normalized.message, 'info');
      throw normalized;
    }
  }

  private async performStop(): Promise<void> {
    const run = this.run;
    if (!run) {
      if (this.snapshot.state !== 'stopped') this.setSnapshot({ state: 'stopped' });
      return;
    }

    if (this.snapshot.state === 'starting') {
      this.setSnapshot({ state: 'stopping', cwd: run.cwd });
      run.abort.abort();
      this.signalRun(run, false);
      const pending = this.pendingPromise;
      if (pending) await pending.catch(() => undefined);
      if (this.isCurrent(run)) {
        await this.terminateRun(run);
        this.run = undefined;
        this.setSnapshot({ state: 'stopped' });
      }
      return;
    }

    if (this.snapshot.state === 'running' && this.snapshot.ownership === 'external') {
      run.abort.abort();
      this.run = undefined;
      this.setSnapshot({ state: 'stopped' });
      this.deps.log('已断开外部服务（没有停止该服务）', 'info');
      return;
    }

    if (this.snapshot.state === 'running') {
      this.setSnapshot({ state: 'stopping', cwd: run.cwd });
      this.deps.log('正在停止服务…', 'info');
      await this.terminateRun(run);
      if (this.isCurrent(run)) {
        this.run = undefined;
        this.setSnapshot({ state: 'stopped' });
        this.deps.log('服务已停止', 'info');
      }
      return;
    }

    this.setSnapshot({ state: 'stopping', cwd: run.cwd });
    run.abort.abort();
    // A previous best-effort termination may have failed. A user retry must
    // send both signals again instead of merely waiting on stale flags.
    run.termSent = false;
    run.forceSent = false;
    await this.terminateRun(run);
    if (this.isCurrent(run)) {
      this.run = undefined;
      this.setSnapshot({ state: 'stopped' });
    }
  }

  private createRun(cwd?: string, expectedPort?: number): Run {
    return {
      id: this.nextRunId++,
      abort: new AbortController(),
      ready: deferred<string>(),
      failed: deferred<Error>(),
      exited: deferred<ExitInfo>(),
      cwd,
      expectedPort,
      ignoreExpectedPortOnCleanup: false,
      outputTail: '',
      termSent: false,
      forceSent: false,
    };
  }

  private attachChild(run: Run): void {
    const child = run.child;
    if (!child) return;
    const stdoutScanner = new ReadinessScanner();
    const stderrScanner = new ReadinessScanner();

    const consume = (scanner: ReadinessScanner, chunk: Buffer | string) => {
      const text = chunk.toString();
      this.deps.log(text, 'data');
      run.outputTail = `${run.outputTail}${text}`.slice(-8192);
      const url = scanner.write(chunk);
      if (url && this.isCurrent(run)) {
        run.url = url;
        run.ready.resolve(url);
      }
    };
    child.stdout?.on('data', (chunk: Buffer | string) => consume(stdoutScanner, chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => consume(stderrScanner, chunk));

    child.on('error', (error) => {
      if (!this.isCurrent(run)) return;
      run.failed.resolve(this.spawnError('npx', error));
    });

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (run.exited.settled) return;
      run.exited.resolve({ code, signal });
      if (!this.isCurrent(run)) return;
      if (this.snapshot.state === 'running' && this.snapshot.ownership === 'managed') {
        const message = `DeepSeek Harness 意外退出（${formatExit(code, signal)}）`;
        this.setSnapshot({ state: 'error', error: message, ownership: 'managed', cwd: run.cwd });
        this.deps.log(message, 'info');
        void this.releaseOwnershipWhenEndpointGone(run, message);
      } else if (this.snapshot.state === 'error' && this.snapshot.ownership === 'managed') {
        const message = `${this.snapshot.error ?? '服务停止失败'}；进程现已退出，可以重试`;
        this.setSnapshot({ state: 'error', error: message, ownership: 'managed', cwd: run.cwd });
        this.deps.log(message, 'info');
        void this.releaseOwnershipWhenEndpointGone(run, message);
      }
    };
    child.on('exit', onExit);
    child.on('close', onExit);
  }

  private waitUntilReady(run: Run, timeoutSeconds: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, url?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.abort.signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(url as string);
      };
      const onAbort = () => finish(new StartCancelledError());
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `等待 DeepSeek Harness 就绪超时（${timeoutSeconds}s）。` +
                '首次下载可能较慢，可调大 vscode-dsh.startupTimeout；详情见输出面板。'
            )
          ),
        timeoutSeconds * 1000
      );
      run.abort.signal.addEventListener('abort', onAbort, { once: true });
      run.ready.promise.then((url) => finish(undefined, url));
      run.failed.promise.then((error) => finish(error));
      run.exited.promise.then((info) => finish(this.earlyExitError(run, info)));
      if (run.abort.signal.aborted) onAbort();
    });
  }

  private async terminateRun(
    run: Run,
    graceMs = STOP_GRACE_MS,
    forceWaitMs = FORCE_KILL_WAIT_MS
  ): Promise<void> {
    const child = run.child;
    if (!child) return;
    // A failed spawn has no operating-system process to wait for.
    if (!child.pid && run.failed.settled) return;

    let forced = false;
    if (!run.exited.settled) {
      this.signalRun(run, false);
      if (!(await waitFor(run.exited.promise, graceMs))) {
        forced = true;
        this.deps.log('服务未在宽限期内退出，正在强制终止进程树', 'info');
        this.signalRun(run, true);
        if (!(await waitFor(run.exited.promise, forceWaitMs))) {
          throw new Error('无法确认 DeepSeek Harness 进程树已经退出；已保留进程所有权，可再次执行“停止服务”');
        }
      }
    }

    if (await this.waitForEndpointRelease(run, forced ? 250 : graceMs)) return;
    if (!forced) {
      this.deps.log('启动器已退出但监听端口仍在使用，正在强制清理残留进程树', 'info');
      this.signalRun(run, true);
      if (await this.waitForEndpointRelease(run, forceWaitMs)) return;
    }
    throw new Error('DeepSeek Harness 启动器已退出，但监听端口仍未释放；已保留所有权，可再次执行“停止服务”');
  }

  private async waitForEndpointRelease(run: Run, budgetMs: number): Promise<boolean> {
    const ports = new Set<number>();
    const reportedPort = run.url ? portFromUrl(run.url) : undefined;
    if (reportedPort) ports.add(reportedPort);
    if (run.expectedPort && !run.ignoreExpectedPortOnCleanup) ports.add(run.expectedPort);
    if (ports.size === 0) return true;
    const interval = 200;
    for (let elapsed = 0; elapsed <= budgetMs; elapsed += interval) {
      const occupied = await Promise.all(
        [...ports].map((port) => this.portCheckImpl(port, Math.min(interval, 150)))
      );
      if (occupied.every((value) => !value)) return true;
      if (elapsed + interval <= budgetMs) await delay(interval);
    }
    return false;
  }

  private async releaseOwnershipWhenEndpointGone(run: Run, message: string): Promise<void> {
    try {
      if (!(await this.waitForEndpointRelease(run, 600)) || !this.isCurrent(run)) return;
      if (this.snapshot.state !== 'error' || this.snapshot.ownership !== 'managed') return;
      this.run = undefined;
      this.setSnapshot({ state: 'error', error: `${message}；可以直接重试` });
    } catch (error) {
      this.deps.log(`检查残留监听端口失败：${normalizeError(error).message}`, 'info');
    }
  }

  private signalRun(run: Run, force: boolean): void {
    const child = run.child;
    if (!child) return;
    if (force ? run.forceSent : run.termSent) return;
    if (force) run.forceSent = true;
    else run.termSent = true;

    const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
    const pid = child.pid;
    if (!pid) {
      try {
        child.kill(signal);
      } catch {
        /* process already gone */
      }
      return;
    }

    if (this.platform === 'win32') {
      const args = ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])];
      try {
        const taskkill = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = this.spawnImpl(taskkill, args, { shell: false, stdio: 'ignore', windowsHide: true });
        killer.on('error', (error) => this.deps.log(`taskkill 失败: ${error.message}`, 'info'));
      } catch (error) {
        this.deps.log(`taskkill 失败: ${normalizeError(error).message}`, 'info');
      }
      return;
    }

    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* process already gone */
      }
    }
  }

  private earlyExitError(run: Run, info: ExitInfo): Error {
    if (run.expectedPort && /EADDRINUSE|address already in use|端口[^\n]*占用/i.test(run.outputTail)) {
      return new PortConflictError(run.expectedPort);
    }
    return new Error(
      `服务进程在就绪前退出（${formatExit(info.code, info.signal)}）。` +
        '请打开“输出 → DeepSeek Harness Launcher”查看完整日志。'
    );
  }

  private spawnError(command: string, error: unknown): Error {
    const message = normalizeError(error).message;
    return new Error(
      `无法启动 ${command}：${message}。` +
        '请确认已安装受支持的 Node.js，且 node / npx 可从 PATH 访问。'
    );
  }

  private assertCurrent(run: Run): void {
    if (!this.isCurrent(run) || run.abort.signal.aborted || this.disposed) throw new StartCancelledError();
  }

  private isCurrent(run: Run): boolean {
    return this.run?.id === run.id;
  }

  private stopOwnsRun(): boolean {
    return this.snapshot.state === 'stopping' || this.disposed;
  }

  private setSnapshot(snapshot: ServerSnapshot): void {
    this.snapshot = snapshot;
    this.deps.onChanged(this.getSnapshot());
  }

  private trackPending<T extends StartResult | ConnectResult>(
    kind: 'start' | 'connect',
    promise: Promise<T>,
    target?: string
  ): void {
    this.pendingKind = kind;
    this.pendingPromise = promise;
    this.pendingTarget = target;
    const clear = () => {
      if (this.pendingPromise !== promise) return;
      this.pendingPromise = undefined;
      this.pendingKind = undefined;
      this.pendingTarget = undefined;
    };
    promise.then(clear, clear);
  }
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    settled: false,
    resolve(value: T) {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
  };
  return result;
}

function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new StartCancelledError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new StartCancelledError()));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

async function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('timed-out');
  const result = await Promise.race([
    promise,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result !== timedOut;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  return `code=${code ?? '?'}${signal ? `, signal=${signal}` : ''}`;
}
