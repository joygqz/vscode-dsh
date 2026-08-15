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
    throw new Error('扩展内置的 DSH npm 包标识无效');
  }
  if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) {
    throw new Error('vscode-dsh.port 必须是 0 到 65535 之间的整数');
  }
  if (!Number.isFinite(settings.startupTimeout) || settings.startupTimeout < 5) {
    throw new Error('vscode-dsh.startupTimeout 必须至少为 5 秒');
  }
  const reserved = settings.webArgs.find((arg) =>
    RESERVED_WEB_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
  );
  if (reserved) {
    throw new Error(
      `${reserved} 由扩展管理，不能放入 vscode-dsh.webArgs；` +
        '`--patch` 可能改写监听安全边界，因此本扩展不支持'
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
    throw new Error('npx 可执行文件必须先解析为绝对路径');
  }

  const npxArgs = ['--yes', settings.packageSpec, 'web'];
  npxArgs.push('--host', '127.0.0.1', '--port', String(settings.port), ...settings.webArgs);

  if (platform === 'win32') {
    // .cmd shims cannot be executed directly by CreateProcess. Invoke cmd.exe
    // explicitly, disable AutoRun/delayed expansion, and quote every data
    // argument. Reject the two characters that cmd expands even inside quotes.
    const unsafe = npxArgs.find((arg) => /[%"\r\n\0]/.test(arg));
    if (unsafe !== undefined) {
      throw new Error('Windows 上的 package 与 webArgs 不能包含 %、双引号或换行符');
    }
    if (/[%"\r\n\0]/.test(npxExecutable)) {
      throw new Error('Windows 上的 npx 路径不能包含 %、双引号或换行符');
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
