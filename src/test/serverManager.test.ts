import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortCheckFn, ProbeFn, ProbeResult } from '../http';
import {
  DshServerManager,
  PortConflictError,
  StartCancelledError,
  type ChildLike,
  type LeaseAcquireFn,
  type SpawnImpl,
} from '../serverManager';
import { DEFAULT_SETTINGS, type DshSettings, type LaunchRequest, type ServerSnapshot } from '../types';

let nextPid = 4000;

class FakeChild extends EventEmitter implements ChildLike {
  readonly pid = nextPid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exited = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.emitExit(null, typeof signal === 'string' ? signal : null);
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => this.emit('exit', code, signal));
  }

  emitLateExit(code: number | null, signal: NodeJS.Signals | null): void {
    setImmediate(() => this.emit('exit', code, signal));
  }

  emitError(error: Error): void {
    setImmediate(() => this.emit('error', error));
  }
}

interface Harness {
  manager: DshServerManager;
  children: FakeChild[];
  spawnCalls: Array<{ command: string; args: string[] }>;
  snapshots: ServerSnapshot[];
  portCheck: ReturnType<typeof vi.fn<PortCheckFn>>;
  probe: ReturnType<typeof vi.fn<ProbeFn>>;
}

interface SetupOptions {
  portCheck?: PortCheckFn;
  probe?: ProbeFn;
  spawn?: SpawnImpl;
  acquireLease?: LeaseAcquireFn;
  taskkillExits?: boolean | 'force';
}

function makeSettings(overrides: Partial<DshSettings> = {}): DshSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function request(
  overrides: Partial<DshSettings> = {},
  cwd = '/tmp/project',
  homeDirectory?: string
): LaunchRequest {
  return {
    settings: makeSettings(overrides),
    cwd,
    npxPath: 'C:\\Program Files\\nodejs\\npx.cmd',
    homeDirectory,
  };
}

function isTaskkillCommand(command: string): boolean {
  return /(?:^|[\\/])taskkill(?:\.exe)?$/i.test(command);
}

function setup(options: SetupOptions = {}): Harness {
  const children: FakeChild[] = [];
  const spawnCalls: Harness['spawnCalls'] = [];
  const snapshots: ServerSnapshot[] = [];
  const portCheck = vi.fn<PortCheckFn>(options.portCheck ?? (async () => false));
  const probe = vi.fn<ProbeFn>(
    options.probe ?? (async (): Promise<ProbeResult> => ({ reachable: false, isDsh: false }))
  );

  const defaultSpawn: SpawnImpl = (command, args) => {
    spawnCalls.push({ command, args });
    const child = new FakeChild();
    children.push(child);
    if (
      isTaskkillCommand(command) &&
      options.taskkillExits !== false &&
      (options.taskkillExits !== 'force' || args.includes('/F'))
    ) {
      const pidIndex = args.indexOf('/pid');
      const pid = Number(args[pidIndex + 1]);
      const target = children.find((candidate) => candidate.pid === pid);
      target?.emitExit(null, args.includes('/F') ? 'SIGKILL' : 'SIGTERM');
    }
    return child;
  };

  const manager = new DshServerManager({
    log: () => {},
    onChanged: (snapshot) => snapshots.push(snapshot),
    platform: 'win32',
    spawnImpl: options.spawn ?? defaultSpawn,
    portCheckImpl: portCheck,
    probeImpl: probe,
    acquireLease: options.acquireLease,
  });

  return { manager, children, spawnCalls, snapshots, portCheck, probe };
}

function managedChildren(harness: Harness): FakeChild[] {
  return harness.spawnCalls
    .map((call, index) => ({ call, child: harness.children[index] }))
    .filter(({ call }) => !isTaskkillCommand(call.command))
    .map(({ child }) => child);
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('managed lifecycle', () => {
  it('starts from the documented readiness signal and records ownership', async () => {
    const h = setup();
    const pending = h.manager.start(request());
    managedChildren(h)[0].stdout.write('boot\ndsh web: http://127.0.0.1:45678\n');

    await expect(pending).resolves.toEqual({ kind: 'started', url: 'http://127.0.0.1:45678' });
    expect(h.manager.getSnapshot()).toEqual({
      state: 'running',
      url: 'http://127.0.0.1:45678',
      ownership: 'managed',
      cwd: '/tmp/project',
    });
  });

  it('acquires the data-directory lease before spawning and releases it on stop', async () => {
    const release = vi.fn(async () => undefined);
    const updates: Array<{ childPid?: number | null; port?: number | null }> = [];
    const h = setup({
      acquireLease: vi.fn(async (homeDirectory) => {
        expect(homeDirectory).toBe('/data/vscode-dsh');
        return {
          release,
          update: async (patch: { childPid?: number | null; port?: number | null }) => {
            updates.push(patch);
          },
        };
      }),
    });

    const pending = h.manager.start(request({}, '/tmp/project', '/data/vscode-dsh'));
    await tick();
    const child = managedChildren(h)[0];
    child.stdout.write('dsh web: http://127.0.0.1:45678\n');
    await pending;

    expect(updates).toEqual([
      { childPid: child.pid },
      { port: 45678 },
    ]);
    expect(release).not.toHaveBeenCalled();

    await h.manager.stop();
    expect(release).toHaveBeenCalledTimes(1);
    expect(h.manager.getSnapshot().state).toBe('stopped');
  });

  it('recognizes a split readiness signal written to stderr', async () => {
    const h = setup();
    const pending = h.manager.start(request());
    const child = managedChildren(h)[0];
    child.stderr.write('dsh web: http://127.0.');
    child.stderr.write('0.1:9000\n');
    await expect(pending).resolves.toMatchObject({ url: 'http://127.0.0.1:9000' });
  });

  it('coalesces concurrent starts into one process and one promise', async () => {
    const h = setup();
    const first = h.manager.start(request());
    const second = h.manager.start(request());
    expect(second).toBe(first);
    expect(managedChildren(h)).toHaveLength(1);

    managedChildren(h)[0].stdout.write('dsh web: http://127.0.0.1:8000\n');
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('reports already-running without starting another process', async () => {
    const h = setup();
    const first = h.manager.start(request());
    managedChildren(h)[0].stdout.write('dsh web: http://127.0.0.1:8001\n');
    await first;
    await expect(h.manager.start(request())).resolves.toEqual({
      kind: 'already-running',
      url: 'http://127.0.0.1:8001',
    });
    expect(managedChildren(h)).toHaveLength(1);
  });

  it('rejects a fixed occupied port before spawning', async () => {
    const h = setup({ portCheck: async () => true });
    await expect(h.manager.start(request({ port: 3080 }))).rejects.toThrow(/Port 3080 is already in use/);
    expect(managedChildren(h)).toHaveLength(0);
    expect(h.manager.getSnapshot().state).toBe('error');
  });

  it('classifies a bind race reported by DSH after the port preflight', async () => {
    let checks = 0;
    const h = setup({ portCheck: async () => ++checks > 1 });
    const pending = h.manager.start(request({ port: 43123 }));
    await tick();
    const child = managedChildren(h)[0];
    child.stderr.write('listen EADDRINUSE: address already in use 127.0.0.1:43123\n');
    child.emitExit(1, null);

    await expect(pending).rejects.toBeInstanceOf(PortConflictError);
    expect(h.portCheck).toHaveBeenCalledTimes(1);
    expect(h.manager.getSnapshot()).toMatchObject({ state: 'error' });
    expect(h.manager.getSnapshot().ownership).toBeUndefined();
  });

  it('keeps ownership when a generic early exit leaves the assigned endpoint alive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let checks = 0;
    const h = setup({
      portCheck: async () => ++checks > 1,
      taskkillExits: false,
    });
    const pending = h.manager.start(request({ port: 43123 }));
    await tick();
    managedChildren(h)[0].emitExit(1, null);

    await vi.advanceTimersByTimeAsync(9000);
    await expect(pending).rejects.toThrow(/listening port was not released/);
    expect(h.manager.getSnapshot()).toMatchObject({ state: 'error', ownership: 'managed' });
  });

  it('rejects a readiness URL that differs from the assigned fixed port', async () => {
    const h = setup();
    const pending = h.manager.start(request({ port: 43123 }));
    await tick();
    managedChildren(h)[0].stdout.write('dsh web: http://127.0.0.1:43124\n');

    await expect(pending).rejects.toThrow(/ready port 43124.*43123/);
    expect(h.manager.getSnapshot()).toMatchObject({ state: 'error' });
  });

  it('skips the port preflight for automatic port zero', async () => {
    const h = setup();
    const pending = h.manager.start(request({ port: 0 }));
    expect(h.portCheck).not.toHaveBeenCalled();
    managedChildren(h)[0].stdout.write('dsh web: http://127.0.0.1:8010\n');
    await pending;
  });

  it('reports a synchronous spawn failure and remains retryable', async () => {
    let calls = 0;
    const h = setup({
      spawn: (command, args) => {
        calls += 1;
        if (calls === 1) throw new Error('ENOENT');
        const child = new FakeChild();
        h.children.push(child);
        h.spawnCalls.push({ command, args });
        return child;
      },
    });

    await expect(h.manager.start(request())).rejects.toThrow(/Could not start/);
    expect(h.manager.getSnapshot().state).toBe('error');

    const retry = h.manager.start(request());
    h.children[0].stdout.write('dsh web: http://127.0.0.1:8020\n');
    await expect(retry).resolves.toMatchObject({ url: 'http://127.0.0.1:8020' });
  });

  it('rejects when the child errors or exits before readiness', async () => {
    const errored = setup();
    const errorPending = errored.manager.start(request());
    managedChildren(errored)[0].emitError(new Error('spawn EACCES'));
    await expect(errorPending).rejects.toThrow(/Could not start/);

    const exited = setup();
    const exitPending = exited.manager.start(request());
    managedChildren(exited)[0].emitExit(2, null);
    await expect(exitPending).rejects.toThrow(/exited before it became ready/);
  });

  it('times out, terminates the process, and settles the start promise', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = setup();
    const pending = h.manager.start(request({ startupTimeout: 5 }));
    await vi.advanceTimersByTimeAsync(5000);
    await tick();

    await expect(pending).rejects.toThrow(/Timed out/);
    expect(h.manager.getSnapshot().state).toBe('error');
    expect(h.spawnCalls.some((call) => isTaskkillCommand(call.command))).toBe(true);
  });

  it('stops an owned process and settles duplicate stops', async () => {
    const h = setup();
    const start = h.manager.start(request());
    managedChildren(h)[0].stdout.write('dsh web: http://127.0.0.1:8030\n');
    await start;

    const first = h.manager.stop();
    const second = h.manager.stop();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(h.manager.getSnapshot()).toEqual({ state: 'stopped' });
    expect(h.spawnCalls.some((call) => isTaskkillCommand(call.command))).toBe(true);
  });

  it('waits through the graceful window before escalating to a forced tree kill', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = setup({ taskkillExits: 'force' });
    const start = h.manager.start(request());
    managedChildren(h)[0].stdout.write('dsh web: http://127.0.0.1:8031\n');
    await start;

    const stopped = h.manager.stop();
    expect(h.spawnCalls.filter((call) => isTaskkillCommand(call.command))).toHaveLength(1);
    expect(h.spawnCalls.find((call) => isTaskkillCommand(call.command))?.args).not.toContain('/F');

    await vi.advanceTimersByTimeAsync(6500);
    await tick();
    await stopped;
    const kills = h.spawnCalls.filter((call) => isTaskkillCommand(call.command));
    expect(kills).toHaveLength(2);
    expect(kills[1].args).toContain('/F');
    expect(h.manager.getSnapshot()).toEqual({ state: 'stopped' });
  });

  it('keeps ownership and blocks replacement when a forced tree kill cannot be confirmed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = setup({ taskkillExits: false });
    const start = h.manager.start(request());
    const child = managedChildren(h)[0];
    child.stdout.write('dsh web: http://127.0.0.1:8032\n');
    await start;

    const stopped = h.manager.stop();
    await vi.advanceTimersByTimeAsync(8500);
    await expect(stopped).rejects.toThrow(/Could not confirm/);
    expect(h.manager.getSnapshot()).toMatchObject({ state: 'error', ownership: 'managed' });
    await expect(h.manager.start(request())).rejects.toThrow(/run "Stop Server" again/);
    await expect(h.manager.connect('http://127.0.0.1:3080')).rejects.toThrow(/run "Stop Server" again/);

    child.emitExit(null, 'SIGKILL');
    await tick();
    expect(h.manager.getSnapshot()).toMatchObject({ state: 'error' });
    expect(h.manager.getSnapshot().ownership).toBeUndefined();
  });

  it('uses a deactivate-specific grace budget shorter than five seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = setup({ taskkillExits: 'force' });
    const start = h.manager.start(request());
    managedChildren(h)[0].stdout.write('dsh web: http://127.0.0.1:8033\n');
    await start;

    const disposed = h.manager.dispose();
    await vi.advanceTimersByTimeAsync(2799);
    expect(h.spawnCalls.filter((call) => isTaskkillCommand(call.command) && call.args.includes('/F'))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    await disposed;
    expect(h.spawnCalls.filter((call) => isTaskkillCommand(call.command) && call.args.includes('/F'))).toHaveLength(1);
    expect(h.manager.getSnapshot()).toEqual({ state: 'stopped' });
  });

  it('keeps managed cleanup available when the launcher exited but its endpoint remains', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = setup({ portCheck: async () => true, taskkillExits: false });
    const start = h.manager.start(request());
    const child = managedChildren(h)[0];
    child.stdout.write('dsh web: http://127.0.0.1:8034\n');
    await start;
    child.emitExit(1, null);
    await tick();
    expect(h.manager.getSnapshot()).toMatchObject({ state: 'error', ownership: 'managed' });

    const stopped = h.manager.stop();
    expect(h.manager.getSnapshot().state).toBe('stopping');
    await vi.advanceTimersByTimeAsync(9000);
    await expect(stopped).rejects.toThrow(/listening port was not released/);
    expect(h.manager.getSnapshot()).toMatchObject({ state: 'error', ownership: 'managed' });
  });

  it('moves to error when a managed process crashes after readiness', async () => {
    const h = setup();
    const start = h.manager.start(request());
    const child = managedChildren(h)[0];
    child.stdout.write('dsh web: http://127.0.0.1:8040\n');
    await start;
    child.emitExit(1, null);
    await tick();
    expect(h.manager.getSnapshot()).toMatchObject({ state: 'error', error: expect.stringMatching(/exited unexpectedly/) });
  });

  it('does not let the crash endpoint watcher overwrite a concurrent stop', async () => {
    const endpointChecks: Array<(inUse: boolean) => void> = [];
    const h = setup({
      portCheck: () => new Promise<boolean>((resolve) => endpointChecks.push(resolve)),
    });
    const start = h.manager.start(request());
    const child = managedChildren(h)[0];
    child.stdout.write('dsh web: http://127.0.0.1:8041\n');
    await start;
    child.emitExit(1, null);
    await tick();

    const stopped = h.manager.stop();
    await tick();
    expect(endpointChecks).toHaveLength(2);
    endpointChecks[0](false);
    await tick();
    expect(h.manager.getSnapshot().state).toBe('stopping');
    endpointChecks[1](false);
    await stopped;
    expect(h.manager.getSnapshot()).toEqual({ state: 'stopped' });
  });
});

describe('cancellation and generation isolation', () => {
  it('cancels during a preflight probe that ignores AbortSignal', async () => {
    const never = new Promise<boolean>(() => {});
    const h = setup({ portCheck: () => never });
    const pending = h.manager.start(request({ port: 3080 }));
    expect(h.manager.getSnapshot().state).toBe('starting');

    const stopped = h.manager.stop();
    await expect(pending).rejects.toBeInstanceOf(StartCancelledError);
    await stopped;
    expect(h.manager.getSnapshot()).toEqual({ state: 'stopped' });
    expect(managedChildren(h)).toHaveLength(0);
  });

  it('cancels after spawn without leaving start pending forever', async () => {
    const h = setup();
    const pending = h.manager.start(request());
    const cancelled = h.manager.cancelStart();
    await expect(pending).rejects.toBeInstanceOf(StartCancelledError);
    await cancelled;
    expect(h.manager.getSnapshot()).toEqual({ state: 'stopped' });
  });

  it('restart during startup cancels the old run and starts exactly one replacement', async () => {
    const h = setup();
    const oldStart = h.manager.start(request());
    const restarted = h.manager.restart(request({}, '/tmp/replacement'));
    await expect(oldStart).rejects.toBeInstanceOf(StartCancelledError);
    await tick();

    const children = managedChildren(h);
    expect(children).toHaveLength(2);
    children[1].stdout.write('dsh web: http://127.0.0.1:8050\n');
    await expect(restarted).resolves.toMatchObject({ url: 'http://127.0.0.1:8050' });
    expect(h.manager.getSnapshot().cwd).toBe('/tmp/replacement');
  });

  it('ignores late events from an old process after retry', async () => {
    const h = setup();
    const first = h.manager.start(request());
    const oldChild = managedChildren(h)[0];
    oldChild.emitExit(1, null);
    await expect(first).rejects.toThrow(/exited before it became ready/);

    const second = h.manager.start(request());
    const newChild = managedChildren(h)[1];
    oldChild.emitLateExit(99, 'SIGKILL');
    oldChild.stdout.write('dsh web: http://127.0.0.1:9999\n');
    await tick();
    expect(h.manager.getSnapshot().state).toBe('starting');

    newChild.stdout.write('dsh web: http://127.0.0.1:8060\n');
    await expect(second).resolves.toMatchObject({ url: 'http://127.0.0.1:8060' });
  });

  it('dispose cancels preflight and prevents a later spawn', async () => {
    const never = new Promise<boolean>(() => {});
    const h = setup({ portCheck: () => never });
    const pending = h.manager.start(request({ port: 3080 }));
    const disposed = h.manager.dispose();
    await expect(pending).rejects.toBeInstanceOf(StartCancelledError);
    await disposed;
    expect(managedChildren(h)).toHaveLength(0);
    await expect(h.manager.start(request())).rejects.toThrow(/shutting down/);
  });
});

describe('external connections', () => {
  it('connects explicitly, records external ownership, and disconnects without taskkill', async () => {
    const h = setup({ probe: async () => ({ reachable: true, isDsh: true, status: 200 }) });
    await expect(h.manager.connect('http://localhost:3080')).resolves.toEqual({
      kind: 'connected',
      url: 'http://127.0.0.1:3080',
    });
    expect(h.manager.getSnapshot()).toEqual({
      state: 'running',
      url: 'http://127.0.0.1:3080',
      ownership: 'external',
    });

    await h.manager.stop();
    expect(h.manager.getSnapshot()).toEqual({ state: 'stopped' });
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('rejects unreachable and non-DSH endpoints', async () => {
    const unreachable = setup({ probe: async () => ({ reachable: false, isDsh: false, error: 'refused' }) });
    await expect(unreachable.manager.connect('http://127.0.0.1:3080')).rejects.toThrow(/Could not connect/);

    const other = setup({ probe: async () => ({ reachable: true, isDsh: false, status: 404 }) });
    await expect(other.manager.connect('http://127.0.0.1:3080')).rejects.toThrow(/not the DeepSeek Harness Web service/);
  });

  it('cancels an external probe that never settles', async () => {
    const h = setup({ probe: () => new Promise<ProbeResult>(() => {}) });
    const pending = h.manager.connect('http://127.0.0.1:3080');
    const cancelled = h.manager.cancelStart();
    await expect(pending).rejects.toBeInstanceOf(StartCancelledError);
    await cancelled;
    expect(h.manager.getSnapshot()).toEqual({ state: 'stopped' });
  });

  it('does not coalesce simultaneous connections to different targets', async () => {
    const h = setup({ probe: () => new Promise<ProbeResult>(() => {}) });
    const first = h.manager.connect('http://127.0.0.1:3080');
    await expect(h.manager.connect('http://127.0.0.1:3081')).rejects.toThrow(/Already connecting/);
    const cancelled = h.manager.cancelStart();
    await expect(first).rejects.toBeInstanceOf(StartCancelledError);
    await cancelled;
  });

  it('detects a dead external service before opening it', async () => {
    let available = true;
    const h = setup({
      probe: async () => ({ reachable: available, isDsh: available, status: available ? 200 : undefined }),
    });
    await h.manager.connect('http://127.0.0.1:3080');
    available = false;
    await expect(h.manager.revalidateExternal()).resolves.toBe(false);
    expect(h.manager.getSnapshot()).toMatchObject({ state: 'error', error: expect.stringMatching(/connection to the external DeepSeek Harness was lost/) });
  });

  it('cancels an external revalidation probe that ignores AbortSignal', async () => {
    let calls = 0;
    const h = setup({
      probe: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ reachable: true, isDsh: true })
          : new Promise<ProbeResult>(() => {});
      },
    });
    await h.manager.connect('http://127.0.0.1:3080');
    const revalidated = h.manager.revalidateExternal();
    await h.manager.stop();
    await expect(revalidated).resolves.toBe(false);
  });

  it('refuses to restart an external service', async () => {
    const h = setup({ probe: async () => ({ reachable: true, isDsh: true }) });
    await h.manager.connect('http://127.0.0.1:3080');
    await expect(h.manager.restart(request())).rejects.toThrow(/cannot be restarted/);
  });
});
