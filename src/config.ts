import * as vscode from 'vscode';
import { DEFAULT_SETTINGS, type DshSettings } from './types';

const SECTION = 'dsh';

/** Read the current extension settings, merged over the defaults. */
export function readSettings(): DshSettings {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    command: c.get<string>('command', DEFAULT_SETTINGS.command),
    args: c.get<string[]>('args', DEFAULT_SETTINGS.args),
    host: c.get<string>('host', DEFAULT_SETTINGS.host),
    port: c.get<number>('port', DEFAULT_SETTINGS.port),
    extraArgs: c.get<string[]>('extraArgs', DEFAULT_SETTINGS.extraArgs),
    autoStart: c.get<boolean>('autoStart', DEFAULT_SETTINGS.autoStart),
    autoOpen: c.get<boolean>('autoOpen', DEFAULT_SETTINGS.autoOpen),
    openMode: c.get<'browser' | 'webview'>('openMode', DEFAULT_SETTINGS.openMode),
    startupTimeout: c.get<number>('startupTimeout', DEFAULT_SETTINGS.startupTimeout),
    stopOnExit: c.get<boolean>('stopOnExit', DEFAULT_SETTINGS.stopOnExit),
    workspace: c.get<string>('workspace', DEFAULT_SETTINGS.workspace),
    env: c.get<Record<string, string>>('env', DEFAULT_SETTINGS.env),
  };
}
