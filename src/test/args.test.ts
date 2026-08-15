import { describe, expect, it } from 'vitest';
import { buildSpawnSpec, formatSpawnSpec, validateLaunchSettings } from '../args';
import { DEFAULT_SETTINGS, type DshSettings } from '../types';

function settings(overrides: Partial<DshSettings> = {}): DshSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

const POSIX_NPX = '/usr/local/bin/npx';
const WINDOWS_NPX = 'C:\\Program Files\\nodejs\\npx.cmd';

describe('buildSpawnSpec', () => {
  it('builds the pinned, loopback-only default invocation', () => {
    expect(buildSpawnSpec(settings(), POSIX_NPX, 'darwin')).toEqual({
      command: POSIX_NPX,
      args: [
        '--yes',
        '@deepseek-ai/dsh@0.1.0-rc.6',
        'web',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
      ],
      shell: false,
      display: [
        POSIX_NPX,
        '--yes',
        '@deepseek-ai/dsh@0.1.0-rc.6',
        'web',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
      ],
    });
  });

  it('places the fixed loopback host before the configured port', () => {
    const spec = buildSpawnSpec(
      settings({ port: 43123 }),
      POSIX_NPX,
      'linux'
    );
    expect(spec.args).toEqual([
      '--yes',
      '@deepseek-ai/dsh@0.1.0-rc.6',
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '43123',
    ]);
  });

  it('places additional Web arguments last', () => {
    const spec = buildSpawnSpec(
      settings({ webArgs: ['--trusted-host', 'example.test'] }),
      POSIX_NPX,
      'linux'
    );
    expect(spec.args.slice(-2)).toEqual(['--trusted-host', 'example.test']);
  });

  it('invokes the Windows npx shim through an explicitly quoted cmd command', () => {
    const spec = buildSpawnSpec(
      settings({ webArgs: ['--trusted-host', 'team host.test'] }),
      WINDOWS_NPX,
      'win32'
    );
    expect(spec).toMatchObject({ command: expect.stringMatching(/cmd\.exe$/i), shell: false });
    expect(spec.args.slice(0, 4)).toEqual(['/d', '/s', '/v:off', '/c']);
    expect(spec.args[4]).toContain('"team host.test"');
    expect(spec.display[0]).toBe(WINDOWS_NPX);
  });

  it.each(['bad%PATH%', 'bad"quote', 'bad\nline'])(
    'rejects Windows command-shell expansion in arguments: %s',
    (value) => {
      expect(() => buildSpawnSpec(settings({ webArgs: [value] }), WINDOWS_NPX, 'win32')).toThrow(/Windows/);
    }
  );

  it('keeps Windows metacharacters inert inside quoted arguments', () => {
    const spec = buildSpawnSpec(settings({ webArgs: ['value & whoami'] }), WINDOWS_NPX, 'win32');
    expect(spec.args[4]).toContain('"value & whoami"');
  });

  it('renders a readable, quoted log line', () => {
    const spec = buildSpawnSpec(settings({ webArgs: ['team host.test'] }), POSIX_NPX, 'linux');
    expect(formatSpawnSpec(spec)).toContain("'team host.test'");
  });
});

describe('validateLaunchSettings', () => {
  it.each([
    [{ packageSpec: '' }, /包标识/],
    [{ packageSpec: '--bad' }, /包标识/],
    [{ port: -1 }, /port/],
    [{ port: 65536 }, /port/],
    [{ port: 1.5 }, /port/],
    [{ startupTimeout: 4 }, /startupTimeout/],
  ] as Array<[Partial<DshSettings>, RegExp]>)('rejects invalid settings %o', (overrides, expected) => {
    expect(() => validateLaunchSettings(settings(overrides))).toThrow(expected);
  });

  it.each(['--host', '--host=localhost', '--port', '--port=1234', '--patch']) (
    'rejects extension-owned Web argument %s',
    (arg) => {
      expect(() => validateLaunchSettings(settings({ webArgs: [arg] }))).toThrow(/由扩展管理/);
    }
  );
});
