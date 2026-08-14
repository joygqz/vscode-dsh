/**
 * Shared plain types. This module must stay free of `vscode` imports so the
 * logic modules can be unit-tested outside the extension host.
 */

/** All extension settings, already resolved to concrete values. */
export interface DshSettings {
  /** Executable to spawn, e.g. `npx` (default) or an absolute path to `dsh`. */
  command: string;
  /** Arguments passed to the command; `--host`/`--port` are appended automatically. */
  args: string[];
  /** Web server bind host (dsh web --host). */
  host: string;
  /** Web server port (dsh web --port); 0 lets the OS pick a free port. */
  port: number;
  /** Extra trailing dsh web arguments (--patch, --trusted-host, ...). */
  extraArgs: string[];
  /** Start the server automatically when VS Code starts. */
  autoStart: boolean;
  /** Open the GUI automatically once the server is ready. */
  autoOpen: boolean;
  /** How to open the GUI: system browser or an in-editor Webview panel. */
  openMode: 'browser' | 'webview';
  /** Seconds to wait for the server to become ready. */
  startupTimeout: number;
  /** Kill the server process when VS Code exits (only if we started it). */
  stopOnExit: boolean;
  /** Working directory for the spawned process. */
  workspace: string;
  /** Extra environment variables merged over process.env. */
  env: Record<string, string>;
}

export const DEFAULT_SETTINGS: DshSettings = {
  command: 'npx',
  args: ['--yes', '@deepseek-ai/dsh', 'web'],
  host: '127.0.0.1',
  port: 3080,
  extraArgs: [],
  autoStart: false,
  autoOpen: true,
  openMode: 'browser',
  startupTimeout: 90,
  stopOnExit: true,
  workspace: '',
  env: {},
};

/** Lifecycle state of the server as observed by this extension. */
export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/** Immutable state snapshot published to listeners. */
export interface ServerSnapshot {
  state: ServerState;
  /** Canonical GUI URL once known (may change on restart). */
  url?: string;
  /** True when this extension spawned the process (vs. attached to an existing server). */
  owned: boolean;
  /** True when the server was already running before we started it. */
  attached: boolean;
  /** Human-readable error description when state === 'error'. */
  error?: string;
}

/** Result of a successful start. */
export interface StartResult {
  kind: 'started' | 'attached' | 'already-running';
  url: string;
}
