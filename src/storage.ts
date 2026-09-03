import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const LEASE_PREFIX = '.vscode-dsh.lock';

/**
 * Seed the new global DSH profile from the current workspace's legacy profile.
 * The staged rename makes concurrent extension-window migrations single-winner;
 * an existing global profile is never merged with or overwritten.
 */
export async function migrateLegacyDshHome(source: string, target: string): Promise<boolean> {
  const sourceDirectory = resolve(source);
  const targetDirectory = resolve(target);
  if (sourceDirectory === targetDirectory) return false;

  const sourceEntries = (await readDirectory(sourceDirectory))?.filter(
    (entry) => !entry.startsWith(LEASE_PREFIX)
  );
  if (!sourceEntries?.length || (await readDirectory(targetDirectory)) !== undefined) return false;

  await mkdir(dirname(targetDirectory), { recursive: true });
  const stagingDirectory = `${targetDirectory}.migrate-${randomUUID()}`;
  await mkdir(stagingDirectory, { mode: 0o700 });
  try {
    for (const entry of sourceEntries) {
      await cp(join(sourceDirectory, entry), join(stagingDirectory, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    try {
      await rename(stagingDirectory, targetDirectory);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code)) return false;
      throw error;
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readDirectory(directory: string): Promise<string[] | undefined> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}
