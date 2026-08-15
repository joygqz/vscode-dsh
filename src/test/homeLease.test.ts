import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireHomeLease,
  HomeLeaseOwnershipError,
} from '../homeLease';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vscode-dsh-home-lease-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('home lease', () => {
  it('rejects a second owner while the extension host is alive', async () => {
    const home = await temporaryHome();
    const first = await acquireHomeLease(home, {
      extensionHostPid: 101,
      isProcessAlive: (pid) => pid === 101,
      staleConfirmationMs: 0,
    });

    await expect(
      acquireHomeLease(home, {
        extensionHostPid: 202,
        isProcessAlive: (pid) => pid === 101,
        staleConfirmationMs: 0,
      })
    ).rejects.toMatchObject({ code: 'DSH_HOME_IN_USE' });

    await first.release();
  });

  it.each([
    {
      name: 'a live child process',
      update: { childPid: 303 },
      processAlive: (pid: number) => pid === 303,
      endpointInUse: () => false,
      message: 'DSH 子进程 PID 303',
    },
    {
      name: 'an occupied endpoint',
      update: { port: 43123 },
      processAlive: () => false,
      endpointInUse: (port: number) => port === 43123,
      message: '本机端口 43123',
    },
  ])('rejects takeover while $name remains active', async (scenario) => {
    const home = await temporaryHome();
    const first = await acquireHomeLease(home, {
      extensionHostPid: 101,
      isProcessAlive: () => false,
      staleConfirmationMs: 0,
    });
    await first.update(scenario.update);

    await expect(
      acquireHomeLease(home, {
        extensionHostPid: 202,
        isProcessAlive: scenario.processAlive,
        isEndpointInUse: scenario.endpointInUse,
        staleConfirmationMs: 0,
      })
    ).rejects.toThrow(scenario.message);
  });

  it('recovers a confirmed stale lease', async () => {
    const home = await temporaryHome();
    const stale = await acquireHomeLease(home, {
      extensionHostPid: 101,
      isProcessAlive: () => false,
      staleConfirmationMs: 0,
    });
    const replacement = await acquireHomeLease(home, {
      extensionHostPid: 202,
      isProcessAlive: () => false,
      isEndpointInUse: () => false,
      staleConfirmationMs: 0,
    });

    expect(replacement.token).not.toBe(stale.token);
    expect(replacement.currentMetadata.extensionHostPid).toBe(202);
    await expect(stale.release()).rejects.toBeInstanceOf(HomeLeaseOwnershipError);
    await replacement.release();
  });

  it('allows only one winner when stale recovery races', async () => {
    const home = await temporaryHome();
    await acquireHomeLease(home, {
      extensionHostPid: 101,
      isProcessAlive: () => false,
      staleConfirmationMs: 0,
    });
    const options = {
      isProcessAlive: (pid: number) => pid !== 101,
      isEndpointInUse: () => false,
      staleConfirmationMs: 0,
    };

    const results = await Promise.allSettled([
      acquireHomeLease(home, { ...options, extensionHostPid: 201 }),
      acquireHomeLease(home, { ...options, extensionHostPid: 202 }),
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (winners[0]?.status === 'fulfilled') await winners[0].value.release();
  });

  it('does not delete a lock when its token no longer matches', async () => {
    const home = await temporaryHome();
    const lease = await acquireHomeLease(home, {
      extensionHostPid: 101,
      isProcessAlive: () => true,
    });
    const metadata = JSON.parse(await readFile(lease.metadataFile, 'utf8')) as Record<string, unknown>;
    metadata.token = 'different-owner-token';
    await writeFile(lease.metadataFile, JSON.stringify(metadata), 'utf8');

    await expect(lease.release()).rejects.toBeInstanceOf(HomeLeaseOwnershipError);
    await expect(stat(lease.lockDirectory)).resolves.toBeDefined();
  });

  it('updates and clears child process metadata without changing ownership', async () => {
    const home = await temporaryHome();
    const lease = await acquireHomeLease(home, {
      extensionHostPid: 101,
      isProcessAlive: () => true,
    });
    const originalToken = lease.token;

    const updated = await lease.update({ childPid: 303, port: 43123 });
    expect(updated).toMatchObject({
      token: originalToken,
      extensionHostPid: 101,
      childPid: 303,
      port: 43123,
    });

    const cleared = await lease.update({ childPid: null, port: null });
    expect(cleared.token).toBe(originalToken);
    expect(cleared).not.toHaveProperty('childPid');
    expect(cleared).not.toHaveProperty('port');
    await lease.release();
  });
});
