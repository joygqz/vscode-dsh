import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import type { DshSettings, ServerSnapshot, ServerState, StartResult } from './types';
import { buildSpawnSpec } from './args';
import { buildUrl, parseWebUrlFromLine } from './parse';
import { probeHostPort, probeUrl, type ProbeFn } from './http';

/** Minimal child-process surface, satisfied by both real and fake children. */
export interface ChildLike {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnImpl = (command: string, args: string[], options: SpawnOptions) => ChildLike;
export type LogFn = (message: string, kind: 'info' | 'data') => void;

export interface ManagerDeps {
  getSettings: () => DshSettings;
  log: LogFn;
  onChanged: (snapshot: ServerSnapshot) => void;
  /** Resolve the fallback working directory (VS Code workspace folder). */
  cwdResolver?: () => string | undefined;
  platform?: NodeJS.Platform;
  spawnImpl?: SpawnImpl;
  probeImpl?: ProbeFn;
}

const POLL_INTERVAL_MS = 400;
const ATTACH_TIMEOUT_MS = 800;
const PROBE_TIMEOUT_MS = 600;
const STOP_GRACE_MS = 3000;
/** Only the tail of stdout is kept for line parsing. */
const STDOUT_TAIL = 2000;

/**
 * Owns the dsh web server process lifecycle: spawn, readiness detection
 * (stdout `dsh web: http://…` line + HTTP polling), attach to pre-existing
 * servers, stop/restart, and crash/exit bookkeeping.
 *
 * Everything vscode-specific (logging sinks, status bar, panels) is injected,
 * so this class is fully unit-testable with fake children and probes.
 */
export class DshServerManager {
  private state: ServerState = 'stopped';
  private url?: string;
  private owned = false;
  private attached = false;
  private error?: string;

  private child: ChildLike | null = null;
  private startPromise: Promise<StartResult> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private deadline = 0;
  private stdoutTail = '';
  private cancelled = false;
  private waiters: { resolve: (r: StartResult) => void; reject: (e: Error) => void } | null = null;

  private readonly deps: ManagerDeps;
  private readonly platform: NodeJS.Platform;
  private readonly spawnImpl: SpawnImpl;
  private readonly probeImpl: ProbeFn;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
    this.platform = deps.platform ?? process.platform;
    this.spawnImpl = deps.spawnImpl ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.probeImpl = deps.probeImpl ?? probeUrl;
  }

  getSnapshot(): ServerSnapshot {
    return {
      state: this.state,
      url: this.url,
      owned: this.owned,
      attached: this.attached,
      error: this.error,
    };
  }

  getUrl(): string | undefined {
    return this.url;
  }

  /**
   * Start the server (or attach to one already running on the configured
   * port) and resolve once the GUI is ready. Rejects with a descriptive
   * Error on spawn failure, early exit, port conflict, or readiness timeout.
   */
  start(): Promise<StartResult> {
    if (this.startPromise) return this.startPromise;
    if (this.state === 'running' && this.url) {
      return Promise.resolve({ kind: 'already-running', url: this.url });
    }
    if (this.state === 'stopping') {
      return Promise.reject(new Error('服务正在停止中，请稍后再试'));
    }

    const promise = this.doStart();
    this.startPromise = promise;
    // `.then(cb, cb)` — unlike `.finally()` — does not create a second
    // promise that would carry the rejection unhandled.
    const clear = () => {
      if (this.startPromise === promise) this.startPromise = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  private async doStart(): Promise<StartResult> {
    const settings = this.deps.getSettings();
    this.cancelled = false;

    // 1. Attach to an already-running DSH instance when possible.
    if (settings.port > 0) {
      const probe = await probeHostPort(settings.host, settings.port, ATTACH_TIMEOUT_MS, this.probeImpl);
      if (probe.ok && probe.isDsh) {
        const url = buildUrl(settings.host, settings.port);
        this.attached = true;
        this.owned = false;
        this.url = url;
        this.setState('running');
        this.deps.log(`检测到 DeepSeek Harness 已在运行（非本扩展启动），直接使用 ${url}`, 'info');
        return { kind: 'attached', url };
      }
      if (probe.ok && !probe.isDsh) {
        throw new Error(
          `端口 ${settings.port} 已被其它程序占用（并非 DeepSeek Harness）。` +
            `请在设置中修改 dsh.port，或先停用占用该端口的程序。`
        );
      }
    }

    // 2. Spawn the server.
    const spec = buildSpawnSpec(settings, this.platform);
    const cwd = this.resolveCwd(settings);
    const child = this.spawnImpl(spec.command, spec.args, {
      cwd,
      env: { ...process.env, ...settings.env },
      detached: this.platform !== 'win32',
      shell: spec.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child = child;
    this.owned = true;
    this.attached = false;
    this.url = undefined;
    this.stdoutTail = '';
    this.setState('starting');
    this.deps.log(`启动: ${spec.command} ${spec.args.join(' ')}（工作目录 ${cwd}）`, 'info');

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.deps.log(text, 'data');
      this.stdoutTail = (this.stdoutTail + text).slice(-STDOUT_TAIL);
      const parsed = parseWebUrlFromLine(this.stdoutTail);
      if (parsed) this.onReady(parsed);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.deps.log(chunk.toString(), 'data');
    });

    child.on('error', (err) => {
      if (this.state === 'starting') {
        this.fail(
          new Error(
            `无法启动进程 ${spec.command}：${err.message}。` +
              `请确认已安装 Node.js，或调整 dsh.command / dsh.args 设置。`
          )
        );
      } else {
        this.deps.log(`进程错误: ${err.message}`, 'info');
      }
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.state === 'starting') {
        if (this.cancelled) {
          this.fail(new Error('已取消启动'));
        } else {
          this.fail(
            new Error(
              `服务进程提前退出（code=${code ?? '?'}${signal ? `, signal=${signal}` : ''}）。` +
                `请打开“输出 → DeepSeek Harness”查看日志排查。`
            )
          );
        }
      } else if (this.state === 'stopping') {
        this.finishStop();
      } else if (this.state === 'running') {
        this.owned = false;
        this.url = undefined;
        this.setState('stopped');
        this.deps.log(`服务进程已退出（code=${code ?? '?'}${signal ? `, signal=${signal}` : ''}）`, 'info');
      }
    });

    // 3. HTTP polling fallback (covers cases where the stdout line is missed,
    //    e.g. stdout redirected or an unusual dsh version).
    this.deadline = Date.now() + settings.startupTimeout * 1000;
    this.pollTimer = setInterval(() => this.pollTick(settings), POLL_INTERVAL_MS);

    return await new Promise<StartResult>((resolve, reject) => {
      this.waiters = { resolve, reject };
    });
  }

  private pollTick(settings: DshSettings): void {
    if (this.state !== 'starting') return;
    if (Date.now() > this.deadline) {
      this.fail(
        new Error(
          `等待服务就绪超时（${settings.startupTimeout}s）。首次运行 npx 需要下载依赖，` +
            `可调大 dsh.startupTimeout 后重试；详情见“输出 → DeepSeek Harness”。`
        )
      );
      return;
    }
    if (settings.port <= 0) return; // fixed endpoint unknown; stdout line is authoritative
    void probeHostPort(settings.host, settings.port, PROBE_TIMEOUT_MS, this.probeImpl).then((probe) => {
      if (this.state !== 'starting') return;
      if (probe.ok && probe.isDsh) {
        this.onReady(buildUrl(settings.host, settings.port));
      } else if (probe.ok && !probe.isDsh) {
        this.fail(new Error(`端口 ${settings.port} 已被其它程序占用（并非 DeepSeek Harness）。`));
      }
    });
  }

  private onReady(url: string): void {
    if (this.state !== 'starting') return;
    this.clearPollTimer();
    this.url = url;
    this.setState('running');
    this.deps.log(`服务已就绪: ${url}`, 'info');
    const waiters = this.waiters;
    this.waiters = null;
    waiters?.resolve({ kind: 'started', url });
  }

  private fail(err: Error): void {
    this.clearPollTimer();
    const child = this.child;
    this.child = null;
    if (child && this.owned) {
      this.killTree(child, 'SIGKILL');
    }
    this.owned = false;
    this.error = err.message;
    this.setState('error');
    const waiters = this.waiters;
    this.waiters = null;
    if (waiters) waiters.reject(err);
  }

  /** User-initiated cancellation of an in-flight start. */
  cancelStart(): void {
    if (this.state === 'starting' && this.child) {
      this.cancelled = true;
      this.deps.log('用户取消启动', 'info');
      this.killTree(this.child, 'SIGTERM');
      // The exit handler rejects the pending start with "已取消启动".
    }
  }

  /** Stop the server. Attached (not-owned) servers are merely untracked. */
  async stop(): Promise<void> {
    if (this.attached) {
      this.attached = false;
      this.url = undefined;
      this.setState('stopped');
      this.deps.log('已断开对在别处运行的服务的跟踪（未停止它）', 'info');
      return;
    }
    if (this.state === 'error') {
      this.error = undefined;
      this.setState('stopped');
      return;
    }
    const child = this.child;
    if (!child || (this.state !== 'running' && this.state !== 'starting')) {
      if (this.state === 'stopped') return;
      this.setState('stopped');
      return;
    }

    this.setState('stopping');
    this.deps.log('正在停止服务…', 'info');
    this.killTree(child, 'SIGTERM');
    await this.waitExit(child, STOP_GRACE_MS);
    if (this.child === child) {
      // Still alive after the grace period — force it.
      this.deps.log('进程未在宽限期内退出，强制终止', 'info');
      this.killTree(child, 'SIGKILL');
      await this.waitExit(child, STOP_GRACE_MS);
      if (this.child === child) this.child = null;
    }
    this.finishStop();
  }

  private finishStop(): void {
    if (this.state !== 'stopping') return;
    this.clearPollTimer();
    this.child = null;
    this.owned = false;
    this.url = undefined;
    this.setState('stopped');
    this.deps.log('服务已停止', 'info');
  }

  /** Restart: full stop then a fresh start. */
  async restart(): Promise<StartResult> {
    await this.stop();
    return this.start();
  }

  /**
   * Best-effort teardown used when VS Code itself is exiting.
   * @param killProcess - terminate an owned server; pass false to leave it
   *   running in the background (dsh.stopOnExit = false).
   */
  dispose(killProcess: boolean): void {
    this.clearPollTimer();
    const child = this.child;
    this.child = null;
    if (killProcess && child && this.owned) {
      this.deps.log('VS Code 退出，终止服务进程', 'info');
      this.killTree(child, 'SIGTERM');
    }
    this.owned = false;
    this.attached = false;
  }

  private resolveCwd(settings: DshSettings): string {
    if (settings.workspace) return settings.workspace;
    const resolved = this.deps.cwdResolver?.();
    if (resolved) return resolved;
    return homedir();
  }

  private setState(state: ServerState): void {
    this.state = state;
    this.deps.onChanged(this.getSnapshot());
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private killTree(child: ChildLike, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (!pid) {
      child.kill(signal);
      return;
    }
    if (this.platform === 'win32') {
      this.spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, signal); // detached: the child leads its own process group
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          /* already gone */
        }
      }
    }
  }

  private waitExit(child: ChildLike, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      child.on('exit', done);
    });
  }
}

export type { ChildProcess };
