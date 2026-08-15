import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const LOCK_DIRECTORY_NAME = '.vscode-dsh.lock';
const METADATA_FILE_NAME = 'owner.json';
const DEFAULT_STALE_CONFIRMATION_MS = 100;
const DEFAULT_INITIALIZATION_GRACE_MS = 5_000;
const DEFAULT_ENDPOINT_TIMEOUT_MS = 300;
const MAX_ACQUIRE_ATTEMPTS = 12;

export interface HomeLeaseMetadata {
  version: 1;
  token: string;
  extensionHostPid: number;
  childPid?: number;
  port?: number;
  createdAt: string;
  updatedAt: string;
}

export interface HomeLeaseUpdate {
  /** `null` clears a PID previously written to the lease. */
  childPid?: number | null;
  /** `null` clears a port previously written to the lease. */
  port?: number | null;
}

export type ProcessAliveCheck = (pid: number) => boolean | Promise<boolean>;
export type EndpointInUseCheck = (port: number) => boolean | Promise<boolean>;

export interface HomeLeaseAcquireOptions {
  extensionHostPid?: number;
  isProcessAlive?: ProcessAliveCheck;
  isEndpointInUse?: EndpointInUseCheck;
  staleConfirmationMs?: number;
  initializationGraceMs?: number;
  endpointTimeoutMs?: number;
  now?: () => Date;
}

export class HomeLeaseConflictError extends Error {
  readonly code = 'DSH_HOME_IN_USE';

  constructor(
    message: string,
    readonly metadata?: HomeLeaseMetadata
  ) {
    super(message);
    this.name = 'HomeLeaseConflictError';
  }
}

export class HomeLeaseOwnershipError extends Error {
  readonly code = 'DSH_HOME_OWNERSHIP_LOST';

  constructor() {
    super('The DeepSeek Harness data directory lease no longer belongs to this window; the lock was left untouched to avoid affecting other windows.');
    this.name = 'HomeLeaseOwnershipError';
  }
}

interface RequiredAcquireOptions {
  extensionHostPid: number;
  isProcessAlive: ProcessAliveCheck;
  isEndpointInUse: EndpointInUseCheck;
  staleConfirmationMs: number;
  initializationGraceMs: number;
  now: () => Date;
}

interface LockSnapshot {
  identity: string;
  signature: string;
  modifiedAtMs: number;
  metadata?: HomeLeaseMetadata;
}

class RetryAcquireError extends Error {}

/**
 * An exclusive, workspace-scoped lease for a DSH_HOME directory.
 *
 * Keep the returned object for the lifetime of the managed DSH process. The
 * token is deliberately instance-specific: another extension instance in the
 * same OS process still cannot update or release this lease.
 */
export class HomeLease {
  readonly homeDirectory: string;
  readonly lockDirectory: string;
  readonly metadataFile: string;
  readonly token: string;

  private metadata: HomeLeaseMetadata;
  private released = false;
  private operation: Promise<void> = Promise.resolve();

  constructor(homeDirectory: string, metadata: HomeLeaseMetadata) {
    this.homeDirectory = homeDirectory;
    this.lockDirectory = join(homeDirectory, LOCK_DIRECTORY_NAME);
    this.metadataFile = join(this.lockDirectory, METADATA_FILE_NAME);
    this.token = metadata.token;
    this.metadata = metadata;
  }

  get currentMetadata(): Readonly<HomeLeaseMetadata> {
    return { ...this.metadata };
  }

  update(patch: HomeLeaseUpdate): Promise<HomeLeaseMetadata> {
    return this.enqueue(async () => {
      if (this.released) throw new HomeLeaseOwnershipError();
      validateOptionalPid(patch.childPid, 'child process PID');
      validateOptionalPort(patch.port);

      const snapshot = await readOwnedSnapshot(this.lockDirectory, this.token);
      const next: HomeLeaseMetadata = {
        ...snapshot.metadata,
        updatedAt: new Date().toISOString(),
      };
      if (patch.childPid === null) delete next.childPid;
      else if (patch.childPid !== undefined) next.childPid = patch.childPid;
      if (patch.port === null) delete next.port;
      else if (patch.port !== undefined) next.port = patch.port;

      await writeMetadataAtomically(this.lockDirectory, next, this.token, snapshot.identity);
      const current = await readOwnedSnapshot(this.lockDirectory, this.token);
      this.metadata = current.metadata;
      return { ...this.metadata };
    });
  }

  release(): Promise<void> {
    return this.enqueue(async () => {
      if (this.released) return;

      const snapshot = await readOwnedSnapshot(this.lockDirectory, this.token);
      const releaseDirectory = `${this.lockDirectory}.release-${this.token}`;
      try {
        await rename(this.lockDirectory, releaseDirectory);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') throw new HomeLeaseOwnershipError();
        throw error;
      }

      const moved = await inspectLock(releaseDirectory).catch(() => undefined);
      if (moved?.identity !== snapshot.identity || moved.metadata?.token !== this.token) {
        await restoreMovedLock(releaseDirectory, this.lockDirectory);
        throw new HomeLeaseOwnershipError();
      }

      await rm(releaseDirectory, { recursive: true, force: true });
      this.released = true;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/** Acquire the single-writer lease stored inside an absolute DSH_HOME path. */
export async function acquireHomeLease(
  dshHome: string,
  options: HomeLeaseAcquireOptions = {}
): Promise<HomeLease> {
  if (!dshHome || !isAbsolute(dshHome)) {
    throw new Error('The DeepSeek Harness data directory must be an absolute path.');
  }

  const homeDirectory = resolve(dshHome);
  const extensionHostPid = options.extensionHostPid ?? process.pid;
  validatePid(extensionHostPid, 'extension host PID');
  const normalized: RequiredAcquireOptions = {
    extensionHostPid,
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
    isEndpointInUse:
      options.isEndpointInUse ??
      ((port) => isLoopbackEndpointInUse(port, options.endpointTimeoutMs ?? DEFAULT_ENDPOINT_TIMEOUT_MS)),
    staleConfirmationMs: nonNegativeInteger(
      options.staleConfirmationMs,
      DEFAULT_STALE_CONFIRMATION_MS,
      'stale lock confirmation time'
    ),
    initializationGraceMs: nonNegativeInteger(
      options.initializationGraceMs,
      DEFAULT_INITIALIZATION_GRACE_MS,
      'lock initialization grace time'
    ),
    now: options.now ?? (() => new Date()),
  };

  await mkdir(homeDirectory, { recursive: true, mode: 0o700 });
  const lockDirectory = join(homeDirectory, LOCK_DIRECTORY_NAME);

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const created = await tryCreateLease(homeDirectory, lockDirectory, normalized);
    if (created) return created;

    try {
      const first = await inspectLock(lockDirectory);
      await assertSnapshotIsStale(first, normalized);
      await pause(normalized.staleConfirmationMs);
      const second = await inspectLock(lockDirectory);
      if (first.signature !== second.signature) continue;
      await assertSnapshotIsStale(second, normalized);

      const staleDirectory = `${lockDirectory}.stale-${randomUUID()}`;
      try {
        await rename(lockDirectory, staleDirectory);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }

      const moved = await inspectLock(staleDirectory).catch(() => undefined);
      if (moved?.identity !== second.identity || moved.signature !== second.signature) {
        await restoreMovedLock(staleDirectory, lockDirectory);
        continue;
      }

      let lease: HomeLease | undefined;
      try {
        lease = await tryCreateLease(homeDirectory, lockDirectory, normalized);
      } catch (error) {
        await rm(staleDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      await rm(staleDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (lease) return lease;
    } catch (error) {
      if (error instanceof RetryAcquireError || errorCode(error) === 'ENOENT') continue;
      throw error;
    }
  }

  throw new HomeLeaseConflictError(
    'The DeepSeek Harness data directory lock is being updated by another window. Try again later; if the problem persists, stop the server in the other window first.'
  );
}

async function tryCreateLease(
  homeDirectory: string,
  lockDirectory: string,
  options: RequiredAcquireOptions
): Promise<HomeLease | undefined> {
  const timestamp = options.now().toISOString();
  const metadata: HomeLeaseMetadata = {
    version: 1,
    token: randomUUID(),
    extensionHostPid: options.extensionHostPid,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  // Fully initialize an unpublished candidate, then atomically rename it into
  // place. A slow creator can therefore never delete or overwrite a newer
  // owner's lock after stale recovery.
  const candidateDirectory = `${lockDirectory}.init-${metadata.token}`;

  try {
    await mkdir(candidateDirectory, { mode: 0o700 });
    await writeMetadataAtomically(candidateDirectory, metadata, metadata.token);
    try {
      await rename(candidateDirectory, lockDirectory);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || (code === 'EPERM' && await pathExists(lockDirectory))) {
        return undefined;
      }
      throw error;
    }
    return new HomeLease(homeDirectory, metadata);
  } finally {
    await rm(candidateDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function assertSnapshotIsStale(
  snapshot: LockSnapshot,
  options: RequiredAcquireOptions
): Promise<void> {
  const metadata = snapshot.metadata;
  if (!metadata) {
    const age = Math.max(0, options.now().getTime() - snapshot.modifiedAtMs);
    if (age < options.initializationGraceMs) {
      throw new HomeLeaseConflictError(
        'The DeepSeek Harness data directory lock is being initialized. Try again later; if the problem persists, close other VS Code windows using this workspace.'
      );
    }
    return;
  }

  const active: string[] = [];
  if (await processIsAlive(options.isProcessAlive, metadata.extensionHostPid)) {
    active.push(`extension host PID ${metadata.extensionHostPid}`);
  }
  if (
    metadata.childPid !== undefined &&
    metadata.childPid !== metadata.extensionHostPid &&
    (await processIsAlive(options.isProcessAlive, metadata.childPid))
  ) {
    active.push(`DSH child process PID ${metadata.childPid}`);
  }
  if (metadata.port !== undefined && (await endpointIsInUse(options.isEndpointInUse, metadata.port))) {
    active.push(`local port ${metadata.port}`);
  }

  if (active.length > 0) {
    throw new HomeLeaseConflictError(
      `The DeepSeek Harness data directory for this workspace is still in use (${active.join(', ')}). Stop the server in the original VS Code window and try again.`,
      metadata
    );
  }
}

async function inspectLock(lockDirectory: string): Promise<LockSnapshot> {
  const before = await lstat(lockDirectory);
  const identity = `${before.dev}:${before.ino}:${before.mode}`;
  let raw = '';
  try {
    raw = await readFile(join(lockDirectory, METADATA_FILE_NAME), 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new HomeLeaseConflictError(
        `Could not read the DeepSeek Harness data directory lease: ${error instanceof Error ? error.message : String(error)}. ` +
          'To avoid damaging another window\'s data, the extension will not take over automatically.'
      );
    }
  }
  const after = await lstat(lockDirectory);
  const afterIdentity = `${after.dev}:${after.ino}:${after.mode}`;
  if (afterIdentity !== identity) throw new RetryAcquireError();

  const metadata = parseMetadata(raw);
  return {
    identity,
    signature: `${identity}:${after.mtimeMs}:${raw}`,
    modifiedAtMs: after.mtimeMs,
    metadata,
  };
}

async function readOwnedSnapshot(
  lockDirectory: string,
  token: string
): Promise<LockSnapshot & { metadata: HomeLeaseMetadata }> {
  const snapshot = await inspectLock(lockDirectory).catch((error) => {
    if (errorCode(error) === 'ENOENT') throw new HomeLeaseOwnershipError();
    throw error;
  });
  if (!snapshot.metadata || snapshot.metadata.token !== token) throw new HomeLeaseOwnershipError();
  return { ...snapshot, metadata: snapshot.metadata };
}

async function writeMetadataAtomically(
  lockDirectory: string,
  metadata: HomeLeaseMetadata,
  token: string,
  expectedIdentity?: string
): Promise<void> {
  const temporaryFile = join(lockDirectory, `.owner-${token}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryFile, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (expectedIdentity !== undefined) {
      const current = await lstat(lockDirectory).catch(() => undefined);
      const identity = current ? `${current.dev}:${current.ino}:${current.mode}` : undefined;
      if (identity !== expectedIdentity) throw new HomeLeaseOwnershipError();
      const owner = await readOwnedSnapshot(lockDirectory, token);
      if (owner.identity !== expectedIdentity) throw new HomeLeaseOwnershipError();
    }
    await rename(temporaryFile, join(lockDirectory, METADATA_FILE_NAME));
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => undefined);
  }
}

function parseMetadata(raw: string): HomeLeaseMetadata | undefined {
  if (!raw || raw.startsWith('!')) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return undefined;
    if (value.version !== 1 || typeof value.token !== 'string' || value.token.length < 8) return undefined;
    if (!isPid(value.extensionHostPid)) return undefined;
    if (value.childPid !== undefined && !isPid(value.childPid)) return undefined;
    if (value.port !== undefined && !isPort(value.port)) return undefined;
    if (typeof value.createdAt !== 'string' || !value.createdAt) return undefined;
    if (typeof value.updatedAt !== 'string' || !value.updatedAt) return undefined;
    return {
      version: 1,
      token: value.token,
      extensionHostPid: value.extensionHostPid,
      ...(value.childPid === undefined ? {} : { childPid: value.childPid }),
      ...(value.port === undefined ? {} : { port: value.port }),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  } catch {
    return undefined;
  }
}

async function restoreMovedLock(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    throw new HomeLeaseConflictError(
      `The DeepSeek Harness data directory lock changed concurrently; the isolated directory ${from} was preserved. Close other windows, inspect that directory, and try again.`
    );
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

async function processIsAlive(check: ProcessAliveCheck, pid: number): Promise<boolean> {
  try {
    return await check(pid);
  } catch {
    return true;
  }
}

async function endpointIsInUse(check: EndpointInUseCheck, port: number): Promise<boolean> {
  try {
    return await check(port);
  } catch {
    return true;
  }
}

function isLoopbackEndpointInUse(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveResult(inUse);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function validateOptionalPid(value: number | null | undefined, label: string): void {
  if (value !== undefined && value !== null) validatePid(value, label);
}

function validatePid(value: number, label: string): void {
  if (!isPid(value)) throw new Error(`${label} must be a positive integer.`);
}

function validateOptionalPort(value: number | null | undefined): void {
  if (value !== undefined && value !== null && !isPort(value)) {
    throw new Error('The DeepSeek Harness port must be an integer between 1 and 65535.');
  }
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0) throw new Error(`${label} must be a non-negative integer number of milliseconds.`);
  return result;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function pause(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}
