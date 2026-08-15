import { describe, expect, it } from 'vitest';
import { isSupportedNodeVersion, parseNodeVersion } from '../runtime';

describe('Node runtime requirements', () => {
  it('parses node --version output', () => {
    expect(parseNodeVersion('v24.19.0\n')).toEqual({ major: 24, minor: 19, patch: 0 });
    expect(parseNodeVersion('unknown')).toBeNull();
  });

  it.each(['v22.19.0', 'v22.21.1', 'v24.0.0', 'v25.3.0'])('accepts supported version %s', (version) => {
    expect(isSupportedNodeVersion(version)).toBe(true);
  });

  it.each(['v18.20.0', 'v20.19.5', 'v22.18.9', 'v23.9.0', 'garbage'])('rejects unsupported version %s', (version) => {
    expect(isSupportedNodeVersion(version)).toBe(false);
  });
});
