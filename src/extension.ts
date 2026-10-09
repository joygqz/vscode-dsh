import type { ExtensionContext } from 'vscode';
import { ExtensionApp } from './controller';

let controller: ExtensionApp | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  controller = new ExtensionApp(context);
  await controller.initialize();
}

export async function deactivate(): Promise<void> {
  const current = controller;
  controller = undefined;
  await current?.dispose();
}
