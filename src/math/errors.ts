/** Errors and guards shared across the math core. */

/**
 * A computation on valid inputs produced a result outside the representable
 * range: overflow to ±Infinity or NaN, or underflow to zero where the inputs
 * guarantee a positive result. Both are "plausible wrong numbers" and are
 * refused rather than returned.
 */
export class NumericOverflowError extends RangeError {
  constructor(operation: string, detail: 'non-finite' | 'underflow to zero' = 'non-finite') {
    super(`${operation} produced a ${detail} result from valid inputs`);
    this.name = 'NumericOverflowError';
  }
}

/** Returns `value` if finite, otherwise throws {@link NumericOverflowError}. */
export function ensureFinite(value: number, operation: string): number {
  if (!Number.isFinite(value)) {
    throw new NumericOverflowError(operation);
  }
  return value;
}

/**
 * Returns `value` if finite and strictly positive. For use where the inputs
 * mathematically guarantee a positive result, so zero can only mean underflow.
 */
export function ensurePositiveFinite(value: number, operation: string): number {
  ensureFinite(value, operation);
  if (value <= 0) {
    throw new NumericOverflowError(operation, 'underflow to zero');
  }
  return value;
}
