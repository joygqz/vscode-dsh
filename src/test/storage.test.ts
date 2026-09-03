import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyDshHome } from '../storage';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vscode-dsh-storage-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('legacy DSH profile migration', () => {
  it('copies a workspace profile into an absent global directory without copying leases', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'workspace');
    const target = join(root, 'global');
    await mkdir(join(source, 'settings'), { recursive: true });
    await writeFile(join(source, 'settings', 'models.json'), '{"apiKey":"secret"}');
    await mkdir(join(source, '.vscode-dsh.lock'));
    await writeFile(join(source, '.vscode-dsh.lock', 'owner.json'), '{}');

    await expect(migrateLegacyDshHome(source, target)).resolves.toBe(true);
    await expect(readFile(join(target, 'settings', 'models.json'), 'utf8')).resolves.toContain('secret');
    expect(await readdir(target)).not.toContain('.vscode-dsh.lock');
  });

  it('does not overwrite an existing global profile', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'workspace');
    const target = join(root, 'global');
    await mkdir(source);
    await mkdir(target);
    await writeFile(join(source, 'settings.json'), 'legacy');
    await writeFile(join(target, 'settings.json'), 'global');

    await expect(migrateLegacyDshHome(source, target)).resolves.toBe(false);
    await expect(readFile(join(target, 'settings.json'), 'utf8')).resolves.toBe('global');
  });
});
