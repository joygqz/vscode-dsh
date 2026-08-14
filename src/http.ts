import { buildUrl, isDshPage } from './parse';

export interface ProbeResult {
  /** HTTP round-trip completed and status was 2xx/3xx. */
  ok: boolean;
  /** Response body is the DeepSeek Harness GUI. */
  isDsh: boolean;
  status?: number;
  error?: string;
}

/** Injectable probe signature so the server manager can be tested offline. */
export type ProbeFn = (url: string, timeoutMs: number) => Promise<ProbeResult>;

/**
 * Probe a URL with a hard timeout. Used for:
 *  - readiness polling while the spawned server boots,
 *  - attaching to an already-running DSH instance before starting a new one,
 *  - detecting port conflicts (port answers, but not with DSH).
 */
export async function probeUrl(url: string, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const body = await res.text();
    return { ok: res.ok, isDsh: isDshPage(body), status: res.status };
  } catch (err) {
    return { ok: false, isDsh: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the configured host/port; a port of 0 has no fixed endpoint to probe. */
export function probeHostPort(
  host: string,
  port: number,
  timeoutMs: number,
  impl: ProbeFn = probeUrl
): Promise<ProbeResult> {
  if (port <= 0) {
    return Promise.resolve({ ok: false, isDsh: false, error: 'port 0: no fixed endpoint' });
  }
  return impl(buildUrl(host, port), timeoutMs);
}
