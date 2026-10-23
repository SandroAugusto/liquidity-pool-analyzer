/** Errors shared across the math core. */

/** A computation on valid, finite inputs produced a non-finite result. */
export class NumericOverflowError extends RangeError {
  constructor(operation: string) {
    super(`${operation} overflowed to a non-finite value`);
    this.name = 'NumericOverflowError';
  }
}
