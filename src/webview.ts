import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { portFromUrl } from './parse';

export const GUI_VIEW_TYPE = 'vscode-dsh.gui';

/** A minimal, secured editor-hosted browser for the DSH Web UI. */
export class GuiPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private internalUrl?: string;
  private renderedUrl?: string;
  private renderId = 0;

  async show(internalUrl: string): Promise<void> {
    const sameUrl = this.panel !== undefined && this.renderedUrl === internalUrl;
    this.internalUrl = internalUrl;
    if (!this.panel) this.panel = this.createPanel();
    this.updateTitle(internalUrl);
    this.panel.reveal(vscode.ViewColumn.Beside, false);
    if (sameUrl) return;
    this.showMessage('正在建立安全访问通道…');
    try {
      await this.renderUrl(internalUrl);
    } catch (error) {
      this.showMessage(`无法打开 DeepSeek Harness：${messageOf(error)}`);
      throw error;
    }
  }

  async refresh(): Promise<void> {
    if (this.panel && this.internalUrl) await this.renderUrl(this.internalUrl);
  }

  async updateUrl(internalUrl: string): Promise<void> {
    if (this.panel && this.renderedUrl === internalUrl) return;
    this.internalUrl = internalUrl;
    this.updateTitle(internalUrl);
    if (!this.panel) return;
    try {
      await this.renderUrl(internalUrl);
    } catch (error) {
      this.showMessage(`无法更新 DeepSeek Harness：${messageOf(error)}`);
      throw error;
    }
  }

  showOffline(
    message = 'DeepSeek Harness 服务已停止。请运行“DeepSeek Harness Launcher: 打开”重新启动。',
    titleSuffix = '已停止'
  ): void {
    if (!this.panel) return;
    this.internalUrl = undefined;
    this.updateTitle(undefined, titleSuffix);
    this.showMessage(message);
  }

  private showMessage(message: string): void {
    if (!this.panel) return;
    this.renderedUrl = undefined;
    const nonce = randomBytes(16).toString('base64');
    this.panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body { height: 100vh; margin: 0; display: grid; place-items: center; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    p { max-width: 38rem; padding: 2rem; line-height: 1.6; text-align: center; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body><p>${escapeHtml(message)}</p></body>
</html>`;
  }

  getUrl(): string | undefined {
    return this.internalUrl;
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  dispose(): void {
    this.renderId += 1;
    this.panel?.dispose();
    this.panel = undefined;
    this.internalUrl = undefined;
    this.renderedUrl = undefined;
  }

  private createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      GUI_VIEW_TYPE,
      'DeepSeek Harness',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.renderId += 1;
        this.panel = undefined;
        this.internalUrl = undefined;
        this.renderedUrl = undefined;
      }
    });
    return panel;
  }

  private async renderUrl(internalUrl: string): Promise<void> {
    const renderId = ++this.renderId;
    let externalUri: vscode.Uri;
    try {
      externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(internalUrl));
    } catch (error) {
      // A newer navigation may already have rendered successfully. Never let
      // an older tunnel failure replace that page with a stale error screen.
      if (!this.panel || renderId !== this.renderId || internalUrl !== this.internalUrl) return;
      throw error;
    }
    if (!this.panel || renderId !== this.renderId || internalUrl !== this.internalUrl) return;

    const nonce = randomBytes(16).toString('base64');
    const source = externalUri.toString();
    const origin = `${externalUri.scheme}://${externalUri.authority}`;
    this.panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; frame-src ${escapeCsp(origin)};">
  <style nonce="${nonce}">
    html, body, iframe { width: 100%; height: 100%; margin: 0; padding: 0; border: 0; overflow: hidden; background: var(--vscode-editor-background); }
  </style>
</head>
<body>
  <iframe src="${escapeHtml(source)}" title="DeepSeek Harness" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
</body>
</html>`;
    this.renderedUrl = internalUrl;
  }

  private updateTitle(internalUrl?: string, suffix?: string): void {
    if (!this.panel) return;
    if (suffix) {
      this.panel.title = `DeepSeek Harness（${suffix}）`;
      return;
    }
    const port = internalUrl ? portFromUrl(internalUrl) : undefined;
    this.panel.title = port ? `DeepSeek Harness (:${port})` : 'DeepSeek Harness';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeCsp(value: string): string {
  return value.replace(/[;\s]/g, '');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
