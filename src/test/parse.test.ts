import { describe, expect, it } from 'vitest';
import { browseHost, buildUrl, isDshPage, parseWebUrlFromLine, portFromUrl } from '../parse';

describe('parseWebUrlFromLine', () => {
  it('extracts the URL from the dsh readiness line', () => {
    expect(parseWebUrlFromLine('dsh web: http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080');
  });

  it('extracts the loopback URL when a LAN address is appended', () => {
    expect(parseWebUrlFromLine('dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)')).toBe(
      'http://127.0.0.1:3080'
    );
  });

  it('matches the line embedded in a larger chunk', () => {
    const chunk = '[2026-08-14 12:00:00] plugin loaded\ndsh web: http://127.0.0.1:43123\nother output';
    expect(parseWebUrlFromLine(chunk)).toBe('http://127.0.0.1:43123');
  });

  it('returns null for unrelated output', () => {
    expect(parseWebUrlFromLine('starting webserver…')).toBeNull();
    expect(parseWebUrlFromLine('')).toBeNull();
  });
});

describe('portFromUrl', () => {
  it('parses explicit ports', () => {
    expect(portFromUrl('http://127.0.0.1:3080')).toBe(3080);
    expect(portFromUrl('http://127.0.0.1:43123/x?y=1')).toBe(43123);
  });

  it('derives default ports for absent ones', () => {
    expect(portFromUrl('http://127.0.0.1/')).toBe(80);
    expect(portFromUrl('https://127.0.0.1/')).toBe(443);
  });

  it('returns null for invalid input', () => {
    expect(portFromUrl('not a url')).toBeNull();
  });
});

describe('isDshPage', () => {
  it('detects the __DSH_BOOT__ marker', () => {
    expect(isDshPage('<html><script>window.__DSH_BOOT__ = {}</script></html>')).toBe(true);
  });

  it('rejects unrelated HTML', () => {
    expect(isDshPage('<html><body>hello</body></html>')).toBe(false);
    expect(isDshPage('')).toBe(false);
  });
});

describe('browseHost / buildUrl', () => {
  it('keeps a loopback host as-is', () => {
    expect(browseHost('127.0.0.1')).toBe('127.0.0.1');
    expect(buildUrl('127.0.0.1', 3080)).toBe('http://127.0.0.1:3080');
  });

  it('maps wildcard hosts to loopback for browsing', () => {
    expect(browseHost('0.0.0.0')).toBe('127.0.0.1');
    expect(browseHost('')).toBe('127.0.0.1');
    expect(buildUrl('0.0.0.0', 3080)).toBe('http://127.0.0.1:3080');
  });
});
