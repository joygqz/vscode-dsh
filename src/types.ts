/**
 * Shared plain types. Keep this module free of `vscode` imports so lifecycle
 * code can be exercised outside the extension host.
 */

export type StartupBehavior = 'manual' | 'start' | 'startAndOpen';
export type OpenLocation = 'browser' | 'editor';
export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type ServerOwnership = 'managed' | 'external';

/** Settings that affect one managed DSH process. */
export interface DshSettings {
  /** npm package spec executed through npx. Pinned by default because DSH is a developer preview. */
  packageSpec: string;
  /** Listening port. Zero asks DSH/the OS for an unused port. */
  port: number;
  /** Maximum time to wait for DSH's documented readiness line. */
  startupTimeout: number;
  /** What to do after this extension activates. */
  startupBehavior: StartupBehavior;
  /** Preferred UI surface for the main Open command. */
  openLocation: OpenLocation;
  /** Explicit process cwd. Empty means resolve it from the active VS Code workspace. */
  workingDirectory: string;
  /** Additional arguments owned by the DSH Web application. */
  webArgs: string[];
  /** Extra environment variables for the managed process. */
  environment: Record<string, string>;
}

/** The DSH release this extension has been tested against. */
export const TESTED_DSH_VERSION = '0.1.0-rc.6';

export const DEFAULT_SETTINGS: DshSettings = {
  packageSpec: `@deepseek-ai/dsh@${TESTED_DSH_VERSION}`,
  port: 0,
  startupTimeout: 120,
  startupBehavior: 'manual',
  openLocation: 'browser',
  workingDirectory: '',
  webArgs: [],
  environment: {},
};

/** Immutable lifecycle view published to the VS Code adapter. */
export interface ServerSnapshot {
  state: ServerState;
  url?: string;
  ownership?: ServerOwnership;
  /** Working directory of a managed instance. Absent for external connections. */
  cwd?: string;
  /** Human-readable failure when state is `error`. */
  error?: string;
}

export interface StartResult {
  kind: 'started' | 'already-running';
  url: string;
}

export interface ConnectResult {
  kind: 'connected' | 'already-running';
  url: string;
}

export interface LaunchRequest {
  settings: DshSettings;
  cwd: string;
  /** Absolute npx executable resolved before switching into the workspace cwd. */
  npxPath: string;
  /**
   * DSH data directory guarded by the single-writer lease. Managed launches
   * only; external connections use their own data directory.
   */
  homeDirectory?: string;
}
