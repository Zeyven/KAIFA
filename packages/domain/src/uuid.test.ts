import { describe, expect, it } from 'vitest';
import { isUuidV7, newUuidv7, parseUuidParts } from './uuid';

describe('uuidv7 (RFC 9562, invariant I1)', () => {
  it('produces valid v7 layout: version 7, variant 10, 48-bit timestamp', () => {
    const before = Date.now();
    const id = newUuidv7();
    const after = Date.now();
    expect(isUuidV7(id)).toBe(true);
    const parts = parseUuidParts(id);
    expect(parts.version).toBe(7);
    expect(parts.variantBits).toBe(0b10);
    expect(parts.timestampMs).toBeGreaterThanOrEqual(BigInt(before));
    expect(parts.timestampMs).toBeLessThanOrEqual(BigInt(after));
  });

  it('sorts chronologically within the same millisecond (monotonic rand_a)', () => {
    const t = 1_790_000_000_000; // fixed ms
    const ids = Array.from({ length: 500 }, () => newUuidv7(t));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts across distinct timestamps by time', () => {
    const early = Array.from({ length: 50 }, (_, i) => newUuidv7(1_790_000_000_000 + i));
    const late = Array.from({ length: 50 }, (_, i) => newUuidv7(1_790_000_001_000 + i));
    const maxEarly = early.reduce((m, s) => (s > m ? s : m), early[0]!);
    const minLate = late.reduce((m, s) => (s < m ? s : m), late[0]!);
    expect(maxEarly < minLate).toBe(true);
  });

  it('stays monotonic when the clock ticks backwards', () => {
    const a = newUuidv7(1_790_000_005_000);
    const b = newUuidv7(1_790_000_004_000); // clock skew
    expect(b > a).toBe(true);
  });

  it('produces unique ids under a tight burst', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => newUuidv7()));
    expect(ids.size).toBe(20_000);
  });
});
