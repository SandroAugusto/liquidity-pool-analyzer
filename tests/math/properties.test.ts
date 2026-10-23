/**
 * Property-based tests for the math core.
 *
 * The invariant under test, for every public function:
 *
 *   for all inputs the constructors accept, the function returns a finite
 *   result (or an object whose numeric fields are all finite), or it throws
 *   one of the module's typed errors.
 *
 * Generators deliberately span the whole range the constructors accept — down
 * to Number.MIN_VALUE and up to Number.MAX_VALUE — not just realistic
 * magnitudes. Three review rounds found "finite in, non-finite out" cases by
 * hand; this file exists so the next one is found by the suite.
 *
 * Two classes of property, with different input domains:
 *
 * - **Representation** properties ("finite in ⇒ finite out or typed error") run
 *   over the full range the constructors accept, denormals included. They are
 *   about the code never leaking NaN/Infinity/underflow as a plausible number.
 * - **Mathematical** properties (sign, ordering, ≈ 0 at entry) run over the
 *   realistic domain — magnitudes 1e-9..1e9 for prices, 1e-12..1e12 for
 *   liquidity and amounts, ranges at least one tick wide. There the double is a
 *   faithful model of the reals; at denormal scale (one significant bit) it is
 *   not, and sign claims fail for reasons that have nothing to do with the
 *   formulas.
 *
 * Example-based tests remain the documentation of independently computed values; these
 * complement them.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EmptyDepositError,
  InvalidAmountError,
  InvalidLiquidityError,
  InvalidRangeError,
  PriceOutOfRangeError,
  amountsAtPrice,
  createPosition,
  createRange,
  distanceToBounds,
  divergenceLoss,
  divergenceLossToEdgeFromCentre,
  geometricCentre,
  liquidityFromBase,
  liquidityFromQuote,
  rangeAround,
  tokenAmounts,
  valueInQuote,
} from '../../src/math/clmm.js';
import type { Position, PriceRange, TokenAmounts } from '../../src/math/clmm.js';
import { NumericOverflowError } from '../../src/math/errors.js';
import { InvalidPriceError, quotePerBase } from '../../src/math/price.js';
import type { QuotePerBase } from '../../src/math/price.js';
import {
  InsufficientDataError,
  amortisedDivergenceCostPerDay,
  dailyVolatility,
  expectedDaysToExit,
  halfWidthForHorizon,
  logReturns,
  mean,
  standardDeviation,
} from '../../src/math/volatility.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TYPED_ERRORS = [
  InvalidPriceError,
  InvalidRangeError,
  InvalidLiquidityError,
  InvalidAmountError,
  PriceOutOfRangeError,
  EmptyDepositError,
  NumericOverflowError,
  InsufficientDataError,
] as const;

function isTypedError(e: unknown): boolean {
  return TYPED_ERRORS.some((E) => e instanceof E);
}

function allFinite(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).every((v) => typeof v !== 'number' || Number.isFinite(v));
  }
  return true;
}

/**
 * For functions whose result is mathematically guaranteed to be representable
 * given valid inputs (a centre between two finite bounds, a mean between min and
 * max, a log difference bounded by ±745), throwing is itself a defect. Use this
 * instead of {@link finiteOrTyped}: the call must succeed and be finite.
 */
function mustBeFinite<T>(fn: () => T): T {
  const value = fn();
  expect(allFinite(value), `non-finite result: ${JSON.stringify(value)}`).toBe(true);
  return value;
}

/**
 * Asserts the core invariant. Returns the value when the call succeeded so the
 * caller can assert stronger, function-specific properties on it.
 */
function finiteOrTyped<T>(fn: () => T): T | undefined {
  // Only the call under test goes inside the try. Assertions stay outside, so
  // a failed assertion is never classified as an application error and the
  // failure message names the real defect.
  let value: T;
  try {
    value = fn();
  } catch (e: unknown) {
    expect(isTypedError(e), `untyped error: ${String(e)}`).toBe(true);
    return undefined;
  }
  expect(allFinite(value), `non-finite result: ${JSON.stringify(value)}`).toBe(true);
  return value;
}

// ---------------------------------------------------------------------------
// Generators — exactly what the constructors accept, no narrower
// ---------------------------------------------------------------------------

const finitePositive = fc
  .double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true, noDefaultInfinity: true })
  .filter((x) => x > 0);

const finiteNonNegative = fc.double({
  min: 0,
  max: Number.MAX_VALUE,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Realistic magnitudes, for mathematical properties. */
const realisticPositive = fc.double({ min: 1e-9, max: 1e9, noNaN: true });
const realisticNonNegative = fc.oneof(
  fc.constant(0),
  fc.double({ min: 1e-12, max: 1e12, noNaN: true }),
);

const price: fc.Arbitrary<QuotePerBase> = finitePositive.map(quotePerBase);

const range: fc.Arbitrary<PriceRange> = fc
  .tuple(finitePositive, finitePositive)
  .filter(([a, b]) => a !== b)
  .map(([a, b]) => createRange(quotePerBase(Math.min(a, b)), quotePerBase(Math.max(a, b))));

/**
 * Ranges at least one tick wide (tick spacing 1 ⇒ 0.01 %). Narrower ranges do
 * not exist on-chain, and at a few ulps of width floating-point noise can make
 * sign properties fail by ~1e-9 relative. Used for sign/ordering properties;
 * the finite-or-typed invariant is still tested on `range`, which has no
 * such restriction.
 */
const MIN_TICK_RATIO = 1.0001;
const meaningfulRange: fc.Arbitrary<PriceRange> = fc
  .tuple(realisticPositive, realisticPositive)
  .filter(([a, b]) => Math.max(a, b) / Math.min(a, b) >= MIN_TICK_RATIO)
  .map(([a, b]) => createRange(quotePerBase(Math.min(a, b)), quotePerBase(Math.max(a, b))));

const position = fc
  .tuple(finiteNonNegative, range)
  .map(([liquidity, r]) => createPosition(liquidity, r));

interface PositionWithDeposit {
  readonly pos: Position;
  readonly entry: QuotePerBase;
  readonly deposit: TokenAmounts;
}

/**
 * A position together with its own deposit at an in-range entry price. Cases
 * where the deposit itself is not representable (liquidity × huge base amount
 * overflows) are discarded here; the finite-or-typed invariant for those is
 * covered by the arbitrary-deposit property.
 */
const positionWithDeposit: fc.Arbitrary<PositionWithDeposit> = fc
  .tuple(realisticNonNegative, meaningfulRange, fc.double({ min: 0, max: 1, noNaN: true }))
  .map(([liquidity, r, t]): PositionWithDeposit | null => {
    const pos = createPosition(liquidity, r);
    // Interpolate in log space: upper / lower can overflow when lower is
    // denormal, but log of any positive finite double is safe.
    const logLo = Math.log(r.lower);
    const logHi = Math.log(r.upper);
    const entry = quotePerBase(Math.exp(logLo + (0.05 + 0.9 * t) * (logHi - logLo)));
    try {
      return { pos, entry, deposit: amountsAtPrice(pos, entry) };
    } catch (e: unknown) {
      if (isTypedError(e)) return null;
      throw e;
    }
  })
  .filter((x): x is PositionWithDeposit => x !== null);

const amounts = fc.tuple(finiteNonNegative, finiteNonNegative).map(([b, q]) => tokenAmounts(b, q));

const finiteSeries = fc.array(
  fc.double({
    min: -Number.MAX_VALUE,
    max: Number.MAX_VALUE,
    noNaN: true,
    noDefaultInfinity: true,
  }),
  { minLength: 1, maxLength: 64 },
);

const priceSeries = fc.array(finitePositive, { minLength: 2, maxLength: 64 });

const RUNS = { numRuns: 500 };

// ---------------------------------------------------------------------------
// clmm.ts
// ---------------------------------------------------------------------------

describe('clmm: finite in ⇒ finite out or typed error', () => {
  it('rangeAround', () => {
    fc.assert(
      fc.property(price, finitePositive, (centre, hw) => {
        finiteOrTyped(() => rangeAround(centre, hw));
      }),
      RUNS,
    );
  });

  it('geometricCentre always succeeds and lies inside the range', () => {
    // The centre of two finite positive bounds is always representable; a
    // throw here is the PR #6 overflow regression, not an acceptable outcome.
    fc.assert(
      fc.property(range, (r) => {
        const c = mustBeFinite(() => geometricCentre(r));
        expect(c).toBeGreaterThanOrEqual(r.lower);
        expect(c).toBeLessThanOrEqual(r.upper);
      }),
      RUNS,
    );
  });

  it('distanceToBounds has the sign structure of the price position', () => {
    fc.assert(
      fc.property(price, range, (p, r) => {
        const d = finiteOrTyped(() => distanceToBounds(p, r));
        if (d !== undefined) {
          expect(d.toLower).toBeLessThanOrEqual(d.toUpper);
          if (p >= r.lower && p <= r.upper) {
            expect(d.toLower).toBeLessThanOrEqual(0);
            expect(d.toUpper).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      RUNS,
    );
  });

  it('liquidityFromQuote / liquidityFromBase', () => {
    fc.assert(
      fc.property(finitePositive, price, range, (amount, p, r) => {
        const lq = finiteOrTyped(() => liquidityFromQuote(amount, p, r));
        const lb = finiteOrTyped(() => liquidityFromBase(amount, p, r));
        if (lq !== undefined) expect(lq).toBeGreaterThan(0);
        if (lb !== undefined) expect(lb).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  it('amountsAtPrice is non-negative and clamps outside the range', () => {
    fc.assert(
      fc.property(position, price, (pos, p) => {
        const a = finiteOrTyped(() => amountsAtPrice(pos, p));
        if (a !== undefined) {
          expect(a.base).toBeGreaterThanOrEqual(0);
          expect(a.quote).toBeGreaterThanOrEqual(0);
          if (p >= pos.range.upper) expect(a.base).toBe(0);
          if (p <= pos.range.lower) expect(a.quote).toBe(0);
        }
      }),
      RUNS,
    );
  });

  it('valueInQuote', () => {
    fc.assert(
      fc.property(amounts, price, (a, p) => {
        const v = finiteOrTyped(() => valueInQuote(a, p));
        if (v !== undefined) expect(v).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });

  it('divergenceLoss with an arbitrary deposit is finite or typed (no sign claim)', () => {
    // With a deposit unrelated to the position the sign is unconstrained; only
    // the core invariant applies.
    fc.assert(
      fc.property(position, amounts, price, (pos, dep, p) => {
        finiteOrTyped(() => divergenceLoss(pos, dep, p));
      }),
      RUNS,
    );
  });

  it('divergenceLoss against the position own deposit is never positive', () => {
    fc.assert(
      fc.property(
        positionWithDeposit,
        realisticPositive.map(quotePerBase),
        ({ pos, deposit }, p) => {
          const d = finiteOrTyped(() => divergenceLoss(pos, deposit, p));
          if (d !== undefined) expect(d).toBeLessThanOrEqual(1e-12);
        },
      ),
      RUNS,
    );
  });

  it('divergenceLoss is ~0 at the entry price for the position own deposit', () => {
    fc.assert(
      fc.property(
        realisticPositive.map(quotePerBase),
        fc.double({ min: 1e-4, max: 1, noNaN: true }),
        fc.double({ min: 1e-6, max: 1e6, noNaN: true }),
        (centre, hw, liquidity) => {
          const r = rangeAround(centre, hw);
          const pos = createPosition(liquidity, r);
          const deposit = amountsAtPrice(pos, centre);
          if (valueInQuote(deposit, centre) > 0) {
            expect(Math.abs(divergenceLoss(pos, deposit, centre))).toBeLessThan(1e-9);
          }
        },
      ),
      RUNS,
    );
  });

  it('divergenceLossToEdgeFromCentre is finite or typed on any range', () => {
    fc.assert(
      fc.property(range, (r) => {
        finiteOrTyped(() => divergenceLossToEdgeFromCentre(r));
      }),
      RUNS,
    );
  });

  it('divergenceLossToEdgeFromCentre is never positive on a meaningful range', () => {
    fc.assert(
      fc.property(meaningfulRange, (r) => {
        const d = finiteOrTyped(() => divergenceLossToEdgeFromCentre(r));
        if (d !== undefined) expect(d).toBeLessThanOrEqual(1e-12);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// volatility.ts
// ---------------------------------------------------------------------------

describe('volatility: finite in ⇒ finite out or typed error', () => {
  it('logReturns always succeeds on a positive finite series', () => {
    // ln of any positive finite double lies in about [-745, 710], so the
    // difference is always representable; a throw is the PR #1 overflow.
    fc.assert(
      fc.property(priceSeries, (s) => {
        const r = mustBeFinite(() => logReturns(s));
        expect(r).toHaveLength(s.length - 1);
      }),
      RUNS,
    );
  });

  it('mean always succeeds and lies within [min, max] of the input', () => {
    // The mean of finite values is bounded by them; a throw is the PR #1
    // running-sum overflow.
    fc.assert(
      fc.property(finiteSeries, (s) => {
        const m = mustBeFinite(() => mean(s));
        expect(m).toBeGreaterThanOrEqual(Math.min(...s));
        expect(m).toBeLessThanOrEqual(Math.max(...s));
      }),
      RUNS,
    );
  });

  it('standardDeviation is non-negative under both estimators', () => {
    fc.assert(
      fc.property(finiteSeries, fc.constantFrom('sample', 'population'), (s, est) => {
        const sd = finiteOrTyped(() => standardDeviation(s, est));
        if (sd !== undefined) expect(sd).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });

  it('dailyVolatility', () => {
    fc.assert(
      fc.property(priceSeries, (s) => {
        const v = finiteOrTyped(() => dailyVolatility(s));
        if (v !== undefined) expect(v).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });

  it('expectedDaysToExit / halfWidthForHorizon', () => {
    fc.assert(
      fc.property(finitePositive, finitePositive, (a, b) => {
        finiteOrTyped(() => expectedDaysToExit(a, b));
        finiteOrTyped(() => halfWidthForHorizon(a, b));
      }),
      RUNS,
    );
  });

  it('amortisedDivergenceCostPerDay', () => {
    fc.assert(
      fc.property(fc.double({ min: -1, max: 1, noNaN: true }), finitePositive, (loss, days) => {
        const c = finiteOrTyped(() => amortisedDivergenceCostPerDay(loss, days));
        if (c !== undefined) expect(c).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });
});
