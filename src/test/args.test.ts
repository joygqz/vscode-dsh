import { describe, expect, it } from 'vitest';
import { buildSpawnSpec } from '../args';
import { DEFAULT_SETTINGS, type DshSettings } from '../types';

function settings(overrides: Partial<DshSettings> = {}): DshSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('buildSpawnSpec', () => {
  it('builds the default npx invocation on posix', () => {
    const spec = buildSpawnSpec(settings(), 'darwin');
    expect(spec).toEqual({
      command: 'npx',
      args: ['--yes', '@deepseek-ai/dsh', 'web', '--host', '127.0.0.1', '--port', '3080'],
      shell: false,
    });
  });

  it('appends host/port after the web subcommand and then extraArgs', () => {
    const spec = buildSpawnSpec(settings({ port: 0, extraArgs: ['--patch', './x.yml'] }), 'linux');
    expect(spec.args).toEqual([
      '--yes',
      '@deepseek-ai/dsh',
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--patch',
      './x.yml',
    ]);
  });

  it('supports a custom executable as command', () => {
    const spec = buildSpawnSpec(settings({ command: '/usr/local/bin/dsh', args: ['web'] }), 'darwin');
    expect(spec).toEqual({
      command: '/usr/local/bin/dsh',
      args: ['web', '--host', '127.0.0.1', '--port', '3080'],
      shell: false,
    });
  });

  it('omits --host when host is empty', () => {
    const spec = buildSpawnSpec(settings({ host: '' }), 'darwin');
    expect(spec.args).toEqual(['--yes', '@deepseek-ai/dsh', 'web', '--port', '3080']);
  });

  it('switches to npx.cmd with a shell on Windows', () => {
    const spec = buildSpawnSpec(settings(), 'win32');
    expect(spec.command).toBe('npx.cmd');
    expect(spec.shell).toBe(true);
  });

  it('runs custom .cmd/.bat commands through a shell on Windows', () => {
    const spec = buildSpawnSpec(settings({ command: 'C:\\tools\\dsh.cmd', args: ['web'] }), 'win32');
    expect(spec.shell).toBe(true);
    expect(spec.command).toBe('C:\\tools\\dsh.cmd');
  });

  it('keeps plain executables shell-free on Windows', () => {
    const spec = buildSpawnSpec(settings({ command: 'C:\\tools\\dsh.exe', args: ['web'] }), 'win32');
    expect(spec.shell).toBe(false);
  });
});
