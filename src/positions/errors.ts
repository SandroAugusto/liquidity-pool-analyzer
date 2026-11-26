/**
 * Errors a consumer of position readings is expected to catch. They live here,
 * not in an adapter, so that catching them never requires importing adapter
 * internals (#5, criterion 8).
 */

/**
 * Neither token of a pair is a known quote token, so the price direction
 * cannot be chosen without guessing. Pass the quote mint explicitly.
 */
export class AmbiguousQuoteError extends Error {
  constructor(
    readonly mintA: string,
    readonly mintB: string,
  ) {
    super(
      `Cannot tell which token is the quote in pair ${mintA} / ${mintB}; ` +
        'pass the quote mint explicitly',
    );
    this.name = 'AmbiguousQuoteError';
  }
}

/** A position exists but its figures cannot be computed correctly (yet). */
export class UnsupportedPositionError extends Error {
  constructor(
    readonly position: string,
    readonly reason: string,
  ) {
    super(`Position ${position} is not supported: ${reason}`);
    this.name = 'UnsupportedPositionError';
  }
}

/** An account the reading depends on is missing or is not what it should be. */
export class InvalidAccountError extends Error {
  constructor(
    readonly address: string,
    readonly expected: string,
  ) {
    super(`Account ${address} is missing or is not a valid ${expected}`);
    this.name = 'InvalidAccountError';
  }
}

/**
 * The chain kept changing under the reader: a position's range moved again
 * every time it was re-read, so no single-slot view of it could be taken.
 */
export class InconsistentReadError extends Error {
  constructor(
    readonly position: string,
    readonly attempts: number,
  ) {
    super(`Position ${position} changed range on each of ${String(attempts)} reads; try again`);
    this.name = 'InconsistentReadError';
  }
}
