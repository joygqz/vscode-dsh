import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';

const SUPPORTED_NODE_DESCRIPTION = 'Node.js 22.19+（22.x）或 24+';

export interface NodeRuntime {
  version: string;
  nodePath: string;
  /** Absolute path resolved outside the workspace cwd to prevent command shadowing. */
  npxPath: string;
}

export function parseNodeVersion(output: string): { major: number; minor: number; patch: number } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function isSupportedNodeVersion(output: string): boolean {
  const version = parseNodeVersion(output);
  if (!version) return false;
  return (version.major === 22 && version.minor >= 19) || version.major >= 24;
}

/** Check the exact Node executable and npx shim that a managed launch will use. */
export async function checkNodeRuntime(environment: NodeJS.ProcessEnv = process.env): Promise<NodeRuntime> {
  const nodePath = await findExecutableOnPath('node', environment);
  if (!nodePath) {
    throw new Error(`未找到可用的 Node.js。请先安装 ${SUPPORTED_NODE_DESCRIPTION}，然后重试。`);
  }

  let output: string;
  try {
    output = (await execFileText(nodePath, ['--version'], environment)).trim();
  } catch {
    throw new Error(`无法运行 ${nodePath}。请确认 Node.js 安装完整且 VS Code 扩展环境有执行权限。`);
  }
  if (!isSupportedNodeVersion(output)) {
    throw new Error(`当前 PATH 中的 Node.js 为 ${output || '未知版本'}；DeepSeek Harness 需要 ${SUPPORTED_NODE_DESCRIPTION}。`);
  }

  const npxPath = join(dirname(nodePath), process.platform === 'win32' ? 'npx.cmd' : 'npx');
  try {
    await access(npxPath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    if (!(await stat(npxPath)).isFile()) throw new Error('not a file');
  } catch {
    throw new Error('未找到 npx。请安装包含 npm/npx 的 Node.js，并确保它可从 VS Code 扩展环境的 PATH 访问。');
  }
  return { version: output, nodePath, npxPath };
}

/** Resolve PATH ourselves so the later workspace cwd cannot shadow node/npx. */
export async function findExecutableOnPath(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  const pathValue = getEnvironmentValue(environment, 'PATH');
  if (!pathValue) return undefined;
  const windows = process.platform === 'win32';
  const extensions = windows
    ? extname(executable)
      ? ['']
      : (getEnvironmentValue(environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];

  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = stripOuterQuotes(rawDirectory.trim());
    // Relative/empty PATH entries resolve against cwd and are intentionally
    // ignored for an extension that later changes cwd into an untrusted repo.
    if (!directory || !isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${executable}${extension}`);
      try {
        await access(candidate, windows ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // Try the next PATH entry/extension.
      }
    }
  }
  return undefined;
}

function execFileText(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: 5000, windowsHide: true, env: environment }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function getEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = process.platform === 'win32'
    ? Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    : Object.prototype.hasOwnProperty.call(environment, name) ? name : undefined;
  return key ? environment[key] : undefined;
}

function stripOuterQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
