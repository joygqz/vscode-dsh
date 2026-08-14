import type { DshSettings } from './types';

/** Fully-resolved spawn instruction. */
export interface SpawnSpec {
  command: string;
  args: string[];
  /** Whether to run through the platform shell (Windows .cmd/.bat handling). */
  shell: boolean;
}

/**
 * Resolve settings into a concrete spawn instruction.
 *
 * `--host`/`--port` are always appended after the configured args (which end
 * with the `web` subcommand in the default configuration), followed by any
 * `extraArgs`. Passing `--port 0` lets dsh pick a free port; the real port is
 * then recovered from the `dsh web: http://…` stdout line.
 *
 * @param platform - Node platform string, injectable for tests.
 */
export function buildSpawnSpec(s: DshSettings, platform: NodeJS.Platform = process.platform): SpawnSpec {
  const args = [...s.args];
  if (s.host) {
    args.push('--host', s.host);
  }
  args.push('--port', String(s.port));
  args.push(...s.extraArgs);

  let command = s.command;
  let shell = false;
  if (platform === 'win32') {
    // Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980).
    if (command === 'npx') {
      command = 'npx.cmd';
      shell = true;
    } else if (/\.(cmd|bat)$/i.test(command)) {
      shell = true;
    }
  }
  return { command, args, shell };
}
