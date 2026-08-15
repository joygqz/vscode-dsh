import { createConnection } from 'node:net';
import { isDshPage, normalizeLoopbackUrl } from './parse';

export interface ProbeResult {
  /** A HTTP response was received, regardless of its status code. */
  reachable: boolean;
  /** The response looks like the DSH Web shell. */
  isDsh: boolean;
  status?: number;
  error?: string;
}

export type ProbeFn = (url: string, timeoutMs: number, signal?: AbortSignal) => Promise<ProbeResult>;
export type PortCheckFn = (port: number, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>;

const MAX_PROBE_BODY = 512 * 1024;

/** Probe a user-supplied loopback URL before explicitly connecting to it. */
export async function probeDshUrl(
  input: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ProbeResult> {
  const url = normalizeLoopbackUrl(input);
  if (!url) return { reachable: false, isDsh: false, error: '只允许本机 HTTP 地址' };
  if (signal?.aborted) return { reachable: false, isDsh: false, error: '操作已取消' };

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { Accept: 'text/html' },
    });
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_PROBE_BODY) {
      await response.body?.cancel().catch(() => undefined);
      return { reachable: true, isDsh: false, status: response.status, error: '响应过大' };
    }
    const bodyResult = await readBodyLimited(response, MAX_PROBE_BODY);
    if (bodyResult.oversized) {
      return { reachable: true, isDsh: false, status: response.status, error: '响应过大' };
    }
    const body = bodyResult.text;
    return { reachable: true, isDsh: isDshPage(body), status: response.status };
  } catch (error) {
    return {
      reachable: false,
      isDsh: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readBodyLimited(
  response: Response,
  maximumBytes: number
): Promise<{ text: string; oversized: boolean }> {
  const body = response.body;
  if (!body) return { text: '', oversized: false };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return { text: '', oversized: true };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { text, oversized: false };
  } finally {
    reader.releaseLock();
  }
}

/** Check whether a fixed loopback TCP port already has a listener. */
export function isPortInUse(port: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (port <= 0) return Promise.resolve(false);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(inUse);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
