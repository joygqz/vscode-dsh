import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import * as vscode from 'vscode';

/** Choose the process cwd from explicit settings, editor context, or user input. */
export async function resolveWorkingDirectory(
  configured: string,
  interactive: boolean
): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const activeFolder = vscode.window.activeTextEditor
    ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
    : undefined;

  if (configured) {
    const base = interactive ? activeFolder ?? folders[0] : folders[0];
    let candidate = configured;
    if (candidate === '~') candidate = homedir();
    else if (/^~[\\/]/.test(candidate)) candidate = resolve(homedir(), candidate.slice(2));
    if (candidate.includes('${workspaceFolder}') && !base) {
      throw new Error('vscode-dsh.workingDirectory 使用了 ${workspaceFolder}，但当前没有打开工作区文件夹');
    }
    candidate = candidate.replace(/\$\{workspaceFolder\}/g, () => base?.uri.fsPath ?? '');
    if (!isAbsolute(candidate)) {
      if (!base) throw new Error('相对 workingDirectory 需要先在 VS Code 中打开工作区文件夹');
      candidate = resolve(base.uri.fsPath, candidate);
    }
    await assertDirectory(candidate);
    return candidate;
  }

  if (!interactive) return folders[0]?.uri.fsPath;
  if (activeFolder) return activeFolder.uri.fsPath;
  if (folders.length === 1) return folders[0].uri.fsPath;
  if (folders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { title: '选择 DeepSeek Harness 使用的工作目录', placeHolder: '选择一个 VS Code 工作区文件夹' }
    );
    return picked?.folder.uri.fsPath;
  }

  if (!interactive) return undefined;
  const selected = await vscode.window.showOpenDialog({
    title: '选择 DeepSeek Harness 使用的工作目录',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '使用此文件夹',
  });
  const path = selected?.[0]?.fsPath;
  if (!path) return undefined;
  const confirmed = await vscode.window.showWarningMessage(
    `DeepSeek Harness 将能读写此目录并执行命令：${path}`,
    { modal: true, detail: '空窗口没有 Workspace Trust 边界。请只选择你完全信任的目录。' },
    '信任并使用'
  );
  return confirmed === '信任并使用' ? path : undefined;
}

async function assertDirectory(path: string): Promise<void> {
  if (!path) throw new Error('vscode-dsh.workingDirectory 无法解析，请选择有效目录');
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`工作目录不存在或不是文件夹：${path}`);
  }
}
