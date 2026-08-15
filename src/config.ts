import * as vscode from 'vscode';
import { DEFAULT_SETTINGS, type DshSettings, type OpenLocation, type StartupBehavior } from './types';

export const CONFIG_SECTION = 'vscode-dsh';

/** Read defensively: malformed hand-edited JSON must not crash activation. */
export function readSettings(): DshSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const environment = objectValue(config.get<unknown>('environment'), DEFAULT_SETTINGS.environment);
  return {
    packageSpec: DEFAULT_SETTINGS.packageSpec,
    port: numberValue(config.get<unknown>('port'), DEFAULT_SETTINGS.port),
    startupTimeout: numberValue(config.get<unknown>('startupTimeout'), DEFAULT_SETTINGS.startupTimeout),
    startupBehavior: enumValue(
      config.get<unknown>('startupBehavior'),
      ['manual', 'start', 'startAndOpen'] as const,
      DEFAULT_SETTINGS.startupBehavior
    ),
    openLocation: enumValue(
      config.get<unknown>('openLocation'),
      ['browser', 'editor'] as const,
      DEFAULT_SETTINGS.openLocation
    ),
    workingDirectory: stringValue(
      config.get<unknown>('workingDirectory'),
      DEFAULT_SETTINGS.workingDirectory
    ).trim(),
    webArgs: stringArray(config.get<unknown>('webArgs'), DEFAULT_SETTINGS.webArgs),
    environment: Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && entry[0].toLowerCase() !== 'dsh_home'
      )
    ),
  };
}

/** Values whose change cannot affect an already running process without a restart. */
export function launchSettingsFingerprint(settings: DshSettings): string {
  const environment = Object.fromEntries(
    Object.entries(settings.environment).sort(([left], [right]) => left.localeCompare(right))
  );
  return JSON.stringify({
    packageSpec: settings.packageSpec,
    port: settings.port,
    workingDirectory: settings.workingDirectory,
    webArgs: settings.webArgs,
    environment,
  });
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] : [...fallback];
}

function objectValue(value: unknown, fallback: Record<string, string>): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : fallback;
}

function enumValue<T extends StartupBehavior | OpenLocation>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}
