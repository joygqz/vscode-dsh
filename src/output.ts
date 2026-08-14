import * as vscode from 'vscode';

/** Thin wrapper around a dedicated output channel. */
export class Logger {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('DeepSeek Harness');
  }

  /** Lifecycle messages get a timestamp prefix; raw process output is verbatim. */
  log(message: string, kind: 'info' | 'data'): void {
    if (kind === 'info') {
      this.channel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    } else {
      this.channel.append(message);
    }
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
