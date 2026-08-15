import type { DshSettings } from './types';
import { win32 } from 'node:path';

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Always false: process arguments must never be interpolated by Node's shell mode. */
  shell: boolean;
  /** Logical command used only for redacted/readable output. */
  display: string[];
}

const RESERVED_WEB_FLAGS = ['--host', '--port', '--patch'];

/** Validate process-affecting configuration before any executable is launched. */
export function validateLaunchSettings(settings: DshSettings): void {
  if (!settings.packageSpec.trim() || settings.packageSpec.startsWith('-')) {
    throw new Error('The built-in DSH npm package spec is invalid');
  }
  if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) {
    throw new Error('vscode-dsh.port must be an integer between 0 and 65535');
  }
  if (!Number.isFinite(settings.startupTimeout) || settings.startupTimeout < 5) {
    throw new Error('vscode-dsh.startupTimeout must be at least 5 seconds');
  }
  const reserved = settings.webArgs.find((arg) =>
    RESERVED_WEB_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
  );
  if (reserved) {
    throw new Error(
      `${reserved} is managed by the extension and cannot be placed in vscode-dsh.webArgs; ` +
        '`--patch` can rewrite the listening security boundary and is not supported by this extension'
    );
  }
}

/**
 * Build the documented DSH CLI shape. Security-sensitive host/port arguments
 * are extension-owned; additional Web arguments remain last.
 */
export function buildSpawnSpec(
  settings: DshSettings,
  npxExecutable: string,
  platform: NodeJS.Platform = process.platform
): SpawnSpec {
  validateLaunchSettings(settings);
  if (!(platform === 'win32' ? win32.isAbsolute(npxExecutable) : npxExecutable.startsWith('/'))) {
    throw new Error('The npx executable must be resolved to an absolute path first');
  }

  const npxArgs = ['--yes', settings.packageSpec, 'web'];
  npxArgs.push('--host', '127.0.0.1', '--port', String(settings.port), ...settings.webArgs);

  if (platform === 'win32') {
    // .cmd shims cannot be executed directly by CreateProcess. Invoke cmd.exe
    // explicitly, disable AutoRun/delayed expansion, and quote every data
    // argument. Reject the two characters that cmd expands even inside quotes.
    const unsafe = npxArgs.find((arg) => /[%"\r\n\0]/.test(arg));
    if (unsafe !== undefined) {
      throw new Error('The package and webArgs cannot contain %, double quotes, or newlines on Windows');
    }
    if (/[%"\r\n\0]/.test(npxExecutable)) {
      throw new Error('The npx path cannot contain %, double quotes, or newlines on Windows');
    }
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const configuredShell = process.env.ComSpec;
    const commandProcessor =
      configuredShell && win32.isAbsolute(configuredShell) && win32.basename(configuredShell).toLowerCase() === 'cmd.exe'
        ? configuredShell
        : win32.join(systemRoot, 'System32', 'cmd.exe');
    const commandLine = [`"${npxExecutable}"`, ...npxArgs.map((arg) => `"${arg}"`)].join(' ');
    return {
      command: commandProcessor,
      args: ['/d', '/s', '/v:off', '/c', commandLine],
      shell: false,
      display: [npxExecutable, ...npxArgs],
    };
  }
  return { command: npxExecutable, args: npxArgs, shell: false, display: [npxExecutable, ...npxArgs] };
}

/** Readable command rendering for logs only; never passed to a shell. */
export function formatSpawnSpec(spec: SpawnSpec): string {
  return spec.display.map(quoteForDisplay).join(' ');
}

function quoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
