import { describe, expect, it } from 'vitest';
import {
  addCents,
  applyBps,
  assertWireSafeCents,
  divHalfUp,
  formatYuan,
  MoneyError,
  parseCents,
  splitCents,
  subCents,
  sumCents,
} from './money';

describe('money (bigint cents, invariant I9)', () => {
  it('parses yuan strings exactly (no float artifacts)', () => {
    expect(parseCents('¥398.00')).toBe(39800n);
    expect(parseCents('1680.5')).toBe(168050n);
    expect(parseCents('0.01')).toBe(1n);
    expect(parseCents('-3.01')).toBe(-301n);
    expect(parseCents('1,680.00')).toBe(168000n);
    // classic 0.1 + 0.2 float trap must be exact here
    expect(addCents(parseCents('0.10'), parseCents('0.20'))).toBe(30n);
  });

  it('rejects malformed money strings', () => {
    for (const bad of ['1.234', 'abc', '', '1e3', '1,2,3.45']) {
      expect(() => parseCents(bad)).toThrow(MoneyError);
    }
  });

  it('adds/subs/sums exactly at large magnitudes floats cannot hold', () => {
    const big = 12_345_678_901_234n;
    expect(subCents(addCents(big, 99n), 99n)).toBe(big);
    expect(sumCents([big, 1n, 2n])).toBe(big + 3n);

    // Beyond Number.MAX_SAFE_INTEGER floats cannot represent +1 at all —
    // this is why money authority is bigint, never float (invariant I9).
    const huge = 12_345_678_901_234_567n;
    expect(Number(huge) + 1 === Number(huge)).toBe(true); // float loses the increment
    expect(subCents(addCents(huge, 1n), 1n)).toBe(huge); // bigint does not
  });

  it('applies basis points with HALF_UP rounding on the final division only', () => {
    expect(applyBps(10000n, 1500n)).toBe(1500n); // 15% of ¥100
    expect(applyBps(1n, 5000n)).toBe(1n); // ¥0.01 * 50% → 0.5 → HALF_UP → 1
    expect(applyBps(3n, 5000n)).toBe(2n); // 1.5 → 2
    expect(applyBps(-3n, 5000n)).toBe(-2n); // symmetric HALF_UP away from zero
    expect(applyBps(333n, 3333n)).toBe(111n); // 333 * 0.3333 = 110.9889 → 111
  });

  it('divHalfUp is exact and rejects zero denominator', () => {
    expect(divHalfUp(5n, 2n)).toBe(3n);
    expect(divHalfUp(4n, 2n)).toBe(2n);
    expect(divHalfUp(1n, 3n)).toBe(0n);
    expect(divHalfUp(2n, 3n)).toBe(1n);
    expect(() => divHalfUp(1n, 0n)).toThrow(MoneyError);
  });

  it('splitCents allocates exactly (largest-remainder, Σ parts === total)', () => {
    const cases: Array<[bigint, bigint[]]> = [
      [100n, [1n, 1n, 1n]],
      [1680n, [5000n, 3000n, 2000n]],
      [1n, [1n, 1n]],
      [999999n, [1n, 1n, 1n, 1n]],
      [5n, [3n, 9n]],
    ];
    for (const [total, weights] of cases) {
      const parts = splitCents(total, weights);
      expect(sumCents(parts)).toBe(total);
      expect(parts.every((p) => p >= 0n)).toBe(total >= 0n);
    }
    expect(() => splitCents(1n, [])).toThrow(MoneyError);
    expect(() => splitCents(1n, [0n, 0n])).toThrow(MoneyError);
  });

  it('wire guard rejects out-of-range cents', () => {
    expect(() => assertWireSafeCents(39800n)).not.toThrow();
    expect(() => assertWireSafeCents(10_000_000_000_000_000n)).toThrow(MoneyError);
  });

  it('formats display strings only at the UI edge', () => {
    expect(formatYuan(39800n)).toBe('¥398.00');
    expect(formatYuan(168000n)).toBe('¥1,680.00');
    expect(formatYuan(5n)).toBe('¥0.05');
    expect(formatYuan(-100n)).toBe('-¥1.00');
  });
});
