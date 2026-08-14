/**
 * Pure string helpers for dsh output and URL handling. No side effects, no
 * imports — fully unit-testable.
 */

/** Matches the readiness line printed by the dsh web app: `dsh web: http://…`. */
const URL_LINE_RE = /dsh web:\s+(https?:\/\/\S+)/;

/**
 * Extract the canonical GUI URL from a dsh stdout line. The dsh web app prints
 * `dsh web: http://127.0.0.1:<port>` (optionally followed by a LAN address)
 * once the server has bound its port.
 */
export function parseWebUrlFromLine(line: string): string | null {
  const match = URL_LINE_RE.exec(line);
  return match ? match[1] : null;
}

/** Parse the port out of an http(s) URL, or null when absent/invalid. */
export function portFromUrl(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) {
      const n = Number(u.port);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Detect whether an HTML response belongs to the DeepSeek Harness web GUI.
 * The web shell is the only app that injects `window.__DSH_BOOT__`, so it is
 * a reliable marker for "this port serves DSH" (used both for readiness and
 * for attaching to an already-running instance).
 */
export function isDshPage(html: string): boolean {
  return html.includes('__DSH_BOOT__');
}

/**
 * A bind host of `0.0.0.0` cannot be used as a browser URL; probing and
 * opening must go through the loopback interface. (dsh itself rejects
 * `--host 0.0.0.0`, but stay defensive.)
 */
export function browseHost(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
}

/** Build the canonical GUI URL for a host/port pair. */
export function buildUrl(host: string, port: number): string {
  return `http://${browseHost(host)}:${port}`;
}
