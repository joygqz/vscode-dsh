import { describe, expect, it } from 'vitest';
import {
  buildLoopbackUrl,
  isDshPage,
  normalizeLoopbackUrl,
  parseWebUrlFromLine,
  portFromUrl,
  stripAnsi,
} from '../parse';
import { ReadinessScanner } from '../readiness';

describe('readiness output', () => {
  it('extracts the canonical URL from the documented supervisor signal', () => {
    expect(parseWebUrlFromLine('dsh web: http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080');
    expect(
      parseWebUrlFromLine('noise\ndsh web: http://127.0.0.1:43123 (LAN: http://192.168.1.5:43123)')
    ).toBe('http://127.0.0.1:43123');
  });

  it('handles ANSI styling and split UTF-8 process chunks', () => {
    const scanner = new ReadinessScanner();
    expect(scanner.write(Buffer.from('\u001b[32mdsh web: http://127.'))).toBeNull();
    expect(scanner.write(Buffer.from('0.0.1:45678\u001b[0m\n'))).toBe('http://127.0.0.1:45678');
    expect(stripAnsi('\u001b[31mhello\u001b[0m')).toBe('hello');
  });

  it('does not lose a readiness line before a very long later chunk', () => {
    const scanner = new ReadinessScanner();
    expect(scanner.write(`dsh web: http://127.0.0.1:9000\n${'x'.repeat(20_000)}`)).toBe(
      'http://127.0.0.1:9000'
    );
  });

  it('rejects unrelated or non-loopback readiness URLs', () => {
    expect(parseWebUrlFromLine('starting webserver…')).toBeNull();
    expect(parseWebUrlFromLine('dsh web: https://127.0.0.1:3080')).toBeNull();
    expect(parseWebUrlFromLine('dsh web: http://example.com:3080')).toBeNull();
  });
});

describe('normalizeLoopbackUrl', () => {
  it('canonicalizes supported local host spellings', () => {
    expect(normalizeLoopbackUrl('http://localhost:3080/')).toBe('http://127.0.0.1:3080');
    expect(normalizeLoopbackUrl('http://127.0.0.1:43123')).toBe('http://127.0.0.1:43123');
    expect(normalizeLoopbackUrl('http://[::1]:8080/')).toBe('http://127.0.0.1:8080');
  });

  it.each([
    'https://127.0.0.1:3080',
    'http://0.0.0.0:3080',
    'http://user:pass@127.0.0.1:3080',
    'http://127.0.0.1:3080/path',
    'not a url',
  ])('rejects unsafe or malformed URL %s', (url) => {
    expect(normalizeLoopbackUrl(url)).toBeNull();
  });
});

describe('URL helpers', () => {
  it('parses explicit and default ports', () => {
    expect(portFromUrl('http://127.0.0.1:3080')).toBe(3080);
    expect(portFromUrl('http://127.0.0.1')).toBe(80);
    expect(portFromUrl('https://localhost')).toBe(443);
    expect(portFromUrl('not a url')).toBeNull();
  });

  it('builds loopback URLs', () => {
    expect(buildLoopbackUrl(1234)).toBe('http://127.0.0.1:1234');
  });

  it('detects the Web shell marker for explicit external connections', () => {
    expect(isDshPage('<script>window.__DSH_BOOT__ = {}</script>')).toBe(true);
    expect(isDshPage('<html>other app</html>')).toBe(false);
  });
});
