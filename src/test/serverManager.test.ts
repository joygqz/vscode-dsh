import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DshServerManager, type ChildLike } from '../serverManager';
import type { ProbeResult } from '../http';
import { DEFAULT_SETTINGS, type DshSettings, type ServerSnapshot } from '../types';

/** A child process double whose exit is driven by the test. */
class FakeChild extends EventEmitter implements ChildLike {
  pid = 54321;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exited = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.emitExit(1, typeof signal === 'string' ? signal : null);
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => this.emit('exit', code, signal));
  }

  emitError(err: Error): void {
    setImmediate(() => this.emit('error', err));
  }
}

type ProbeMock = ReturnType<typeof vi.fn>;

interface Harness {
  manager: DshServerManager;
  settings: DshSettings;
  spawnCalls: Array<{ command: string; args: string[] }>;
  children: FakeChild[];
  snapshots: ServerSnapshot[];
  probeImpl: ProbeMock;
  /** The child playing the role of the main dsh process. */
  mainChild: () => FakeChild;
}

function makeSettings(overrides: Partial<DshSettings> = {}): DshSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** Let the async attach-probe microtask in doStart reach the spawn step. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Build a manager wired to fakes. `probeImpl` returns "nothing running"
 * unless the test overrides it; `spawnImpl` hands out FakeChild doubles and,
 * when a `taskkill` is issued (win32 kill-tree path), kills the main child —
 * mirroring what the OS does.
 */
function setup(overrides: Partial<DshSettings> = {}, probeImpl?: ProbeMock): Harness {
  const settings = makeSettings(overrides);
  const spawnCalls: Harness['spawnCalls'] = [];
  const children: FakeChild[] = [];
  const snapshots: ServerSnapshot[] = [];
  const defaultProbe = vi.fn(async (): Promise<ProbeResult> => ({ ok: false, isDsh: false }));

  const manager = new DshServerManager({
    getSettings: () => settings,
    log: () => {},
    onChanged: (snap) => snapshots.push(snap),
    cwdResolver: () => '/tmp/test-workspace',
    platform: 'win32', // exercises the taskkill kill-tree branch, keeping process.kill(-pid) out of the test
    probeImpl: probeImpl ?? defaultProbe,
    spawnImpl: (command, args) => {
      spawnCalls.push({ command, args });
      const child = new FakeChild();
      children.push(child);
      if (command === 'taskkill') {
        // Simulate the OS terminating the tree: the main process dies too.
        children[0]?.emitExit(1, 'SIGTERM');
      }
      return child;
    },
  });

  return {
    manager,
    settings,
    spawnCalls,
    children,
    snapshots,
    probeImpl: probeImpl ?? defaultProbe,
    mainChild: () => children[0],
  };
}

describe('DshServerManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the server and resolves with the URL parsed from stdout', async () => {
    const h = setup();
    const pending = h.manager.start();
    await tick();
    expect(h.snapshots[0]?.state).toBe('starting');
    expect(h.spawnCalls[0]).toMatchObject({ command: 'npx.cmd', args: expect.arrayContaining(['web']) });

    h.mainChild().stdout.write('boot noise\ndsh web: http://127.0.0.1:9999\n');

    const result = await pending;
    expect(result).toEqual({ kind: 'started', url: 'http://127.0.0.1:9999' });
    const snap = h.manager.getSnapshot();
    expect(snap.state).toBe('running');
    expect(snap.owned).toBe(true);
    expect(snap.attached).toBe(false);
    expect(snap.url).toBe('http://127.0.0.1:9999');
  });

  it('falls back to HTTP polling when stdout never prints the URL line', async () => {
    let calls = 0;
    const probe = vi.fn(async (): Promise<ProbeResult> => {
      calls += 1;
      // First call is the pre-spawn attach check: nothing there yet.
      return calls === 1
        ? { ok: false, isDsh: false }
        : { ok: true, isDsh: true, status: 200 };
    });
    const h = setup({}, probe);
    const result = await h.manager.start();
    expect(result.kind).toBe('started');
    expect(result.url).toBe('http://127.0.0.1:3080'); // built from configured host/port
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('attaches to an already-running DSH server instead of spawning', async () => {
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ ok: true, isDsh: true, status: 200 }));
    const h = setup({}, probe);
    const result = await h.manager.start();
    expect(result.kind).toBe('attached');
    expect(result.url).toBe('http://127.0.0.1:3080');
    expect(h.spawnCalls).toHaveLength(0);
    const snap = h.manager.getSnapshot();
    expect(snap.attached).toBe(true);
    expect(snap.owned).toBe(false);

    // Stopping an attached server only untracks it.
    await h.manager.stop();
    expect(h.manager.getSnapshot().state).toBe('stopped');
    expect(h.spawnCalls).toHaveLength(0); // no taskkill
  });

  it('rejects when the configured port is occupied by a non-DSH program', async () => {
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ ok: true, isDsh: false, status: 200 }));
    const h = setup({}, probe);
    await expect(h.manager.start()).rejects.toThrow(/已被其它程序占用/);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('rejects on readiness timeout and cleans up', async () => {
    const h = setup({ startupTimeout: 0.5 });
    await expect(h.manager.start()).rejects.toThrow(/超时/);
    expect(h.manager.getSnapshot().state).toBe('error');
    // The spawned tree was killed as part of the failure cleanup.
    expect(h.spawnCalls.some((c) => c.command === 'taskkill')).toBe(true);
  });

  it('rejects when the child exits before becoming ready', async () => {
    const h = setup();
    const pending = h.manager.start();
    await tick();
    h.mainChild().emitExit(1, null);
    await expect(pending).rejects.toThrow(/提前退出/);
    expect(h.manager.getSnapshot().state).toBe('error');
  });

  it('rejects with a helpful message when spawning fails', async () => {
    const h = setup();
    const pending = h.manager.start();
    await tick();
    h.mainChild().emitError(new Error('ENOENT'));
    await expect(pending).rejects.toThrow(/无法启动进程/);
  });

  it('recovers the real port from stdout when dsh.port = 0', async () => {
    const h = setup({ port: 0 });
    const pending = h.manager.start();
    await tick();
    h.mainChild().stdout.write('dsh web: http://127.0.0.1:34567\n');
    const result = await pending;
    expect(result.url).toBe('http://127.0.0.1:34567');
  });

  it('stops an owned server and transitions back to stopped', async () => {
    const h = setup();
    const pending = h.manager.start();
    await tick();
    h.mainChild().stdout.write('dsh web: http://127.0.0.1:3080\n');
    await pending;

    await h.manager.stop();
    const snap = h.manager.getSnapshot();
    expect(snap.state).toBe('stopped');
    expect(snap.owned).toBe(false);
    expect(snap.url).toBeUndefined();
    expect(h.spawnCalls.some((c) => c.command === 'taskkill')).toBe(true);
  });

  it('returns to stopped when the server crashes after becoming ready', async () => {
    const h = setup();
    const pending = h.manager.start();
    await tick();
    h.mainChild().stdout.write('dsh web: http://127.0.0.1:3080\n');
    await pending;

    h.mainChild().emitExit(1, 'SIGTERM');
    await tick();
    const snap = h.manager.getSnapshot();
    expect(snap.state).toBe('stopped');
    expect(snap.url).toBeUndefined();
  });

  it('rejects a cancelled start with a dedicated message', async () => {
    const h = setup();
    const pending = h.manager.start();
    await tick();
    h.manager.cancelStart();
    await expect(pending).rejects.toThrow('已取消启动');
  });

  it('reports already-running when started twice', async () => {
    const h = setup();
    const first = h.manager.start();
    await tick();
    h.mainChild().stdout.write('dsh web: http://127.0.0.1:3080\n');
    await first;
    const second = await h.manager.start();
    expect(second.kind).toBe('already-running');
    expect(h.spawnCalls.filter((c) => c.command !== 'taskkill')).toHaveLength(1);
  });
});
