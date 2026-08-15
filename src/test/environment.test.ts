import { describe, expect, it } from 'vitest';
import { mergeEnvironment } from '../environment';

describe('mergeEnvironment', () => {
  it('keeps POSIX environment keys case-sensitive', () => {
    expect(mergeEnvironment({ PATH: '/base' }, { Path: '/override' }, 'linux')).toEqual({
      PATH: '/base',
      Path: '/override',
    });
  });

  it('lets the final Windows key override any casing variant', () => {
    expect(mergeEnvironment({ Path: 'C:\\base', HOME: 'x' }, { PATH: 'C:\\custom' }, 'win32')).toEqual({
      PATH: 'C:\\custom',
      HOME: 'x',
    });
  });
});
