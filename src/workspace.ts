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
      throw new Error('vscode-dsh.workingDirectory uses ${workspaceFolder}, but no workspace folder is open');
    }
    candidate = candidate.replace(/\$\{workspaceFolder\}/g, () => base?.uri.fsPath ?? '');
    if (!isAbsolute(candidate)) {
      if (!base) throw new Error('A relative workingDirectory requires an open workspace folder in VS Code');
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
      { title: 'Select Working Directory for DeepSeek Harness', placeHolder: 'Select a VS Code workspace folder' }
    );
    return picked?.folder.uri.fsPath;
  }

  if (!interactive) return undefined;
  const selected = await vscode.window.showOpenDialog({
    title: 'Select Working Directory for DeepSeek Harness',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use This Folder',
  });
  const path = selected?.[0]?.fsPath;
  if (!path) return undefined;
  const confirmed = await vscode.window.showWarningMessage(
    `DeepSeek Harness will be able to read and write this directory and run commands: ${path}`,
    { modal: true, detail: 'An empty window has no Workspace Trust boundary. Only choose a directory you fully trust.' },
    'Trust and Use'
  );
  return confirmed === 'Trust and Use' ? path : undefined;
}

async function assertDirectory(path: string): Promise<void> {
  if (!path) throw new Error('vscode-dsh.workingDirectory could not be resolved; choose a valid directory');
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Working directory does not exist or is not a folder: ${path}`);
  }
}
