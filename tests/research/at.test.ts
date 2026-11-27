import { describe, expect, it } from 'vitest';

import { at } from '../../src/research/at.js';

describe('at', () => {
  it('reads in range and throws out of range', () => {
    expect(at([1, 2], 1)).toBe(2);
    expect(() => at([1, 2], 2)).toThrow(RangeError);
    expect(() => at([], -1)).toThrow(RangeError);
  });
});
