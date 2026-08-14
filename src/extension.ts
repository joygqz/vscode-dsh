import * as vscode from 'vscode';
import { readSettings } from './config';
import { Logger } from './output';
import { DshServerManager } from './serverManager';
import { GuiPanel, type GuiPanelAction } from './webview';
import { portFromUrl } from './parse';
import type { ServerSnapshot, StartResult } from './types';

let logger: Logger;
let manager: DshServerManager;
let panel: GuiPanel;
let statusItem: vscode.StatusBarItem;
let lastUrl: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  logger = new Logger();
  logger.log('DeepSeek Harness 扩展已激活', 'info');

  manager = new DshServerManager({
    getSettings: () => readSettings(),
    log: (message, kind) => logger.log(message, kind),
    onChanged: onStateChanged,
    cwdResolver: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });

  panel = new GuiPanel(handlePanelAction);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusItem.command = 'dsh.statusClick';
  renderStatus(manager.getSnapshot());
  statusItem.show();

  const register = (id: string, handler: (...args: never[]) => unknown) =>
    vscode.commands.registerCommand(id, handler);

  context.subscriptions.push(
    register('dsh.statusClick', onStatusClick),
    register('dsh.start', () => startAndOpen(true)),
    register('dsh.startServer', () => startAndOpen(false)),
    register('dsh.openBrowser', () => openCurrentOrPrompt('browser')),
    register('dsh.openWebview', () => openCurrentOrPrompt('webview')),
    register('dsh.stop', stopServer),
    register('dsh.restart', restartServer),
    register('dsh.copyUrl', copyUrl),
    register('dsh.showLogs', () => logger.show()),
    panel,
    logger,
    statusItem,
    { dispose: () => manager.dispose(true) }
  );

  if (readSettings().autoStart) {
    void startWithProgress(readSettings().autoOpen);
  }
}

/** Runs after every `deactivate` and subscription disposal; see deactivate. */
export function deactivate(): void {
  let stop = true;
  try {
    stop = readSettings().stopOnExit;
  } catch {
    /* settings unavailable — default to stopping */
  }
  if (!stop) {
    // Leave the server running after VS Code exits.
    manager?.dispose(false);
    logger?.log('dsh.stopOnExit=false，退出 VS Code 时保留服务进程', 'info');
  }
}

// ---------------------------------------------------------------------------
// State → UI
// ---------------------------------------------------------------------------

function onStateChanged(snap: ServerSnapshot): void {
  renderStatus(snap);
  if (snap.state === 'running' && snap.url && snap.url !== lastUrl) {
    // Restart may pick a new port (especially with dsh.port = 0).
    panel.updateUrl(snap.url);
  }
  lastUrl = snap.url;
}

function renderStatus(snap: ServerSnapshot): void {
  switch (snap.state) {
    case 'running': {
      const port = snap.url ? portFromUrl(snap.url) : undefined;
      statusItem.text = `$(server) DSH${port ? `:${port}` : ''}`;
      statusItem.tooltip = `DeepSeek Harness 运行中 — ${snap.url ?? ''}\n点击打开 GUI`;
      break;
    }
    case 'starting':
      statusItem.text = '$(sync~spin) DSH 启动中…';
      statusItem.tooltip = '正在启动 DeepSeek Harness…（点击查看日志）';
      break;
    case 'stopping':
      statusItem.text = '$(sync~spin) DSH 停止中…';
      statusItem.tooltip = '正在停止 DeepSeek Harness…';
      break;
    case 'error':
      statusItem.text = '$(error) DSH';
      statusItem.tooltip = `启动失败：${snap.error ?? ''}\n点击重试`;
      break;
    default:
      statusItem.text = '$(server) DSH';
      statusItem.tooltip = 'DeepSeek Harness 未运行\n点击启动并打开 GUI';
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function onStatusClick(): void {
  const snap = manager.getSnapshot();
  switch (snap.state) {
    case 'stopped':
    case 'error':
      void startAndOpen(true);
      break;
    case 'running':
      void openGui(snap.url ?? '', readSettings().openMode);
      break;
    case 'starting':
    case 'stopping':
      logger.show();
      break;
  }
}

/** "启动并打开 GUI" / auto-start：启动，就绪后按需打开。 */
async function startAndOpen(open: boolean): Promise<void> {
  await startWithProgress(open);
}

async function startWithProgress(openWhenReady: boolean): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在启动 DeepSeek Harness…',
        cancellable: true,
      },
      async (_progress, token) => {
        token.onCancellationRequested(() => manager.cancelStart());
        const result = await manager.start();
        handleReady(result, openWhenReady);
      }
    );
  } catch (err) {
    handleStartError(err);
  }
}

function handleReady(result: StartResult, openWhenReady: boolean): void {
  if (result.kind === 'attached') {
    const settings = readSettings();
    const buttons = openWhenReady ? [] : ['打开'];
    void vscode.window
      .showInformationMessage(`已连接到运行中的 DeepSeek Harness（${result.url}），未重复启动。`, ...buttons)
      .then((choice) => {
        if (openWhenReady || choice === '打开') void openGui(result.url, settings.openMode);
      });
    return;
  }
  if (openWhenReady) {
    void openGui(result.url, readSettings().openMode);
  } else {
    const settings = readSettings();
    void vscode.window.showInformationMessage(`DeepSeek Harness 已就绪：${result.url}`, '打开').then((choice) => {
      if (choice === '打开') void openGui(result.url, settings.openMode);
    });
  }
}

function handleStartError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message === '已取消启动') {
    logger.log('启动已由用户取消', 'info');
    return;
  }
  void vscode.window.showErrorMessage(message, '查看日志').then((choice) => {
    if (choice === '查看日志') logger.show();
  });
}

async function stopServer(): Promise<void> {
  try {
    await manager.stop();
  } catch (err) {
    void vscode.window.showErrorMessage(`停止失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function restartServer(): Promise<void> {
  const open = readSettings().autoOpen;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在重启 DeepSeek Harness…' },
      async () => {
        const result = await manager.restart();
        if (open) void openGui(result.url, readSettings().openMode);
      }
    );
  } catch (err) {
    handleStartError(err);
  }
}

async function copyUrl(): Promise<void> {
  const url = manager.getUrl();
  if (!url) {
    void vscode.window.showWarningMessage('DeepSeek Harness 尚未运行。', '启动并打开').then((choice) => {
      if (choice === '启动并打开') void startAndOpen(true);
    });
    return;
  }
  await vscode.env.clipboard.writeText(url);
  void vscode.window.showInformationMessage(`已复制：${url}`);
}

async function openCurrentOrPrompt(mode: 'browser' | 'webview'): Promise<void> {
  const url = manager.getUrl();
  if (url) {
    await openGui(url, mode);
    return;
  }
  void vscode.window.showWarningMessage('DeepSeek Harness 尚未运行。', '启动并打开').then((choice) => {
    if (choice === '启动并打开') void startAndOpen(true);
  });
}

async function openGui(url: string, mode: 'browser' | 'webview'): Promise<void> {
  if (!url) return;
  if (mode === 'browser') {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  } else {
    panel.show(url);
  }
}

function handlePanelAction(action: GuiPanelAction): void {
  switch (action) {
    case 'refresh': {
      const url = manager.getUrl();
      if (url) panel.updateUrl(url);
      break;
    }
    case 'openBrowser': {
      const url = manager.getUrl();
      if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
      break;
    }
    case 'copyUrl': {
      const url = manager.getUrl();
      if (url) void vscode.env.clipboard.writeText(url);
      break;
    }
  }
}
