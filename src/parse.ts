/** Pure URL and output parsing helpers. */

// CSI and the common single-character ANSI sequences. DSH may color console output.
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const URL_LINE_RE = /(?:^|[\r\n])\s*dsh web:\s+(http:\/\/[^\s]+)/m;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}

/** Extract and validate DSH's documented supervisor readiness signal. */
export function parseWebUrlFromLine(output: string): string | null {
  const match = URL_LINE_RE.exec(stripAnsi(output));
  return match ? normalizeLoopbackUrl(match[1]) : null;
}

/**
 * Accept only local, credential-free HTTP endpoints. The managed DSH server is
 * intentionally loopback-only because it can execute code in the workspace.
 */
export function normalizeLoopbackUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'http:' || url.username || url.password) return null;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    const port = portFromUrl(url.toString());
    if (port === null) return null;
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

export function portFromUrl(input: string): number | null {
  try {
    const url = new URL(input);
    if (!url.port) return url.protocol === 'http:' ? 80 : url.protocol === 'https:' ? 443 : null;
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/** Best available identity marker for explicitly connected external instances. */
export function isDshPage(html: string): boolean {
  return html.includes('__DSH_BOOT__');
}

export function buildLoopbackUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
