/**
 * Money — integer cents only (Master Prompt §4.1, ADR-0002).
 *
 * Invariant I9: floats NEVER represent RMB authority. Domain math is `bigint`
 * cents; rates are integer basis points (bps); rounding happens only where
 * explicitly documented (HALF_UP on division), never via binary floats.
 */

/** An amount of money in CENTS. Always bigint in the domain. */
export type Cents = bigint;

/** A non-negative, whole-cent money amount (business rows are >= 0, spec §4.7). */
export type NonNegativeCents = Cents;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const CENTS_PER_YUAN = 100n;
const MAX_SAFE_CENTS = 9_007_199_254_740_991n; // Number.MAX_SAFE_INTEGER — wire format ceiling

/** Parse "¥1,680.50" / "1680.5" / "-3.01" into bigint cents. Rejects floats-as-numbers. */
export function parseCents(input: string): Cents {
  const cleaned = input.trim().replace(/[¥\s]/g, '');
  // Validate BEFORE stripping commas so "1,2,3.45" is rejected, not "123.45"
  if (!/^-?(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/.test(cleaned)) {
    throw new MoneyError(`invalid money string: ${input}`);
  }
  const trimmed = cleaned.replace(/,/g, '');
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [yuan = '0', frac = ''] = unsigned.split('.');
  const cents = BigInt(yuan) * CENTS_PER_YUAN + BigInt(frac.padEnd(2, '0'));
  return negative ? -cents : cents;
}

/** Guard for values crossing the JSON wire: integer cents within safe range. */
export function assertWireSafeCents(cents: Cents): void {
  if (cents > MAX_SAFE_CENTS || cents < -MAX_SAFE_CENTS) {
    throw new MoneyError('cents exceed safe integer range for JSON wire transport');
  }
}

export function addCents(a: Cents, b: Cents): Cents {
  return a + b;
}

export function subCents(a: Cents, b: Cents): Cents {
  return a - b;
}

/** Sum helper (reduces loop/float temptations). */
export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((acc, v) => acc + v, 0n);
}

/** bps: 10000 bps = 100%. Rounds HALF_UP on the final division only. */
export function applyBps(cents: Cents, bps: bigint): Cents {
  const product = cents * bps;
  const denominator = 10_000n;
  return divHalfUp(product, denominator);
}

/** Exact division with HALF_UP rounding (commercial rounding, dev default). */
export function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const absN = numerator < 0n ? -numerator : numerator;
  const absD = denominator < 0n ? -denominator : denominator;
  const quotient = absN / absD;
  const remainder = absN % absD;
  const rounded = remainder * 2n >= absD ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Split `total` across integer weights so pieces sum EXACTLY to total
 * (largest-remainder). Used for split tender, pro-rata discounts, ledger
 * allocations — never floats.
 */
export function splitCents(total: Cents, weights: readonly bigint[]): Cents[] {
  if (weights.length === 0) throw new MoneyError('splitCents: no weights');
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  if (weightSum <= 0n) throw new MoneyError('splitCents: weights must sum > 0');

  const base = weights.map((w) => divHalfUp(total * w, weightSum));
  // Reconcile rounding drift onto the largest piece so Σparts === total exactly.
  const drift = total - base.reduce((a, b) => a + b, 0n);
  if (drift !== 0n) {
    let idx = 0;
    for (let i = 1; i < base.length; i += 1) {
      if (base[i]! > base[idx]!) idx = i;
    }
    base[idx] = base[idx]! + drift;
  }
  return base;
}

/** Display helper (UI edge only — never round-trip into domain math). */
export function formatYuan(cents: Cents): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const yuan = abs / CENTS_PER_YUAN;
  const frac = abs % CENTS_PER_YUAN;
  const grouped = yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}¥${grouped}.${frac.toString().padStart(2, '0')}`;
}
