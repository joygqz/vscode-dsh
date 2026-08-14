import * as vscode from 'vscode';

export type GuiPanelAction = 'refresh' | 'openBrowser' | 'copyUrl';

/**
 * In-editor panel embedding the dsh GUI in an iframe. The dsh web server
 * sends no X-Frame-Options, so embedding works; browser mode remains the
 * default because it best matches the app's expectations.
 */
export class GuiPanel {
  private panel: vscode.WebviewPanel | null = null;

  constructor(private readonly onAction: (action: GuiPanelAction) => void) {}

  show(url: string): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'deepseekHarness.gui',
        'DeepSeek Harness',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = null;
      });
      this.panel.webview.onDidReceiveMessage((msg: { action?: string }) => {
        if (typeof msg?.action === 'string') {
          this.onAction(msg.action as GuiPanelAction);
        }
      });
    }
    this.panel.webview.html = this.buildHtml(url);
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  /** Re-render with a new URL (e.g. after a restart picked a new port). */
  updateUrl(url: string): void {
    if (this.panel) {
      this.panel.webview.html = this.buildHtml(url);
    }
  }

  isOpen(): boolean {
    return this.panel !== null;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  private buildHtml(url: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src 'unsafe-inline';
    script-src 'unsafe-inline';
    frame-src http://127.0.0.1:* http://localhost:*;
    connect-src http://127.0.0.1:* http://localhost:*;
  ">
  <title>DeepSeek Harness</title>
  <style>
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
    body { display: flex; flex-direction: column; background: #1e1e1e; }
    #toolbar {
      flex: none; display: flex; align-items: center; gap: 8px;
      padding: 6px 12px; background: #2d2d30; border-bottom: 1px solid #3e3e42;
      font-family: var(--vscode-font-family); font-size: 12px; color: #cccccc;
    }
    #toolbar .url { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #toolbar button {
      background: #0e639c; color: #ffffff; border: none; border-radius: 2px;
      padding: 3px 10px; font-size: 12px; cursor: pointer;
    }
    #toolbar button:hover { background: #1177bb; }
    iframe { flex: 1 1 auto; width: 100%; border: none; background: #ffffff; }
  </style>
</head>
<body>
  <div id="toolbar">
    <span class="url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
    <button onclick="post({action:'refresh'})">刷新</button>
    <button onclick="post({action:'openBrowser'})">在浏览器中打开</button>
    <button onclick="post({action:'copyUrl'})">复制地址</button>
  </div>
  <iframe id="frame" src="${escapeHtml(url)}" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
  <script>
    const vscodeApi = acquireVsCodeApi();
    function post(msg) { vscodeApi.postMessage(msg); }
    window.addEventListener('message', function (event) {
      if (event.data && event.data.action === 'refresh') {
        var frame = document.getElementById('frame');
        frame.src = frame.src;
      }
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
