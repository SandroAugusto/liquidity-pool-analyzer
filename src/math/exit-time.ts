/**
 * Distribution of the time a driftless log-price walk takes to leave a range
 * when it starts at the geometric centre. See docs/adr/0005-rebalance-economics.md
 * for the model and docs/research/exit-time.md for how it is tested.
 *
 * Time is measured in units of the expected exit time, c = t / E[T], where
 * E[T] = hL² / σ² (`expectedDaysToExitFrom` at the centre). In those units the
 * distribution does not depend on the width or on σ, which is what lets
 * positions of different widths and volatility regimes be pooled in one test.
 *
 * Survival function, from the eigenfunction expansion of Brownian motion
 * killed at ±hL, started at 0:
 *
 *   S(c) = P(T > c · E[T]) = Σₙ 4 (−1)ⁿ / ((2n+1) π) · exp(−(2n+1)² π² c / 8)
 *
 * The series converges for c > 0; S(0) = 1 by definition.
 */

/** Below this time the series needs too many terms; the walk has not exited. */
const SMALL_C = 1e-6;
const MAX_TERMS = 100_000;

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number, got ${String(value)}`);
  }
}

/**
 * P(T > c · E[T]) for a driftless walk started at the centre of the range.
 * `c` is dimensionless (time over expected time). Returns a probability in [0, 1].
 */
export function exitSurvivalFromCentre(c: number): number {
  assertNonNegativeFinite(c, 'c');
  if (c < SMALL_C) {
    return 1;
  }
  let sum = 0;
  for (let n = 0; n < MAX_TERMS; n++) {
    const k = 2 * n + 1;
    const term =
      ((4 * (n % 2 === 0 ? 1 : -1)) / (k * Math.PI)) *
      Math.exp((-k * k * Math.PI * Math.PI * c) / 8);
    sum += term;
    if (Math.abs(term) < 1e-17) {
      break;
    }
  }
  // Truncation error can leave the partial sum a few ulps outside [0, 1]; the
  // true value is a probability, so this bounds rounding, not invalid input.
  return Math.min(1, Math.max(0, sum));
}

/**
 * The c at which a fraction `p` of walks started at the centre has exited:
 * the p-quantile of T / E[T]. Bisection on the survival function.
 */
export function exitTimeQuantileFromCentre(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new RangeError(`p must be in (0, 1), got ${String(p)}`);
  }
  let lo = 0;
  let hi = 1;
  while (1 - exitSurvivalFromCentre(hi) < p) {
    hi *= 2;
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (1 - exitSurvivalFromCentre(mid) < p) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * −ζ(1/2) / √(2π) ≈ 0.5826: the barrier shift, in units of σ·√Δt, of the
 * continuity correction for a Brownian motion observed every Δt (Broadie,
 * Glasserman and Kou, "A continuity correction for discrete barrier options",
 * Mathematical Finance 7(4), 1997).
 */
export const DISCRETE_MONITORING_SHIFT = 1.4603545088095868 / Math.sqrt(2 * Math.PI);

/**
 * The log half-width a continuously monitored walk would need to exit, on
 * average, when the price is only checked every `stepDays`: hL + 0.5826·σ·√Δt.
 * Exits seen only at sample closes are late; using this half-width in
 * E[T] = h² / σ² removes most of that bias when σ·√Δt is small against hL.
 */
export function discretelyMonitoredHalfWidth(
  logHalfWidth: number,
  sigmaPerDay: number,
  stepDays: number,
): number {
  for (const [name, value] of [
    ['logHalfWidth', logHalfWidth],
    ['sigmaPerDay', sigmaPerDay],
    ['stepDays', stepDays],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be positive and finite, got ${String(value)}`);
    }
  }
  return logHalfWidth + DISCRETE_MONITORING_SHIFT * sigmaPerDay * Math.sqrt(stepDays);
}
