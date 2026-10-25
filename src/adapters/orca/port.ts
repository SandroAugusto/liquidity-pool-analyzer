/**
 * The adapter's only way to reach the chain. Read-only by construction: it can
 * list NFT mints and fetch raw accounts, nothing else.
 *
 * Every response carries the slot it was served at. The reader puts all the
 * mutable accounts of a position into one {@link SolanaReadPort.getAccounts}
 * call, so they come from that single slot (#5, criterion 7). Fixtures are
 * recorded outputs of this interface.
 */

/** An account as returned by the RPC: owner program and raw data. */
export interface RawAccount {
  readonly address: string;
  /** Program that owns the account. */
  readonly programAddress: string;
  readonly data: Uint8Array;
}

export interface SolanaReadPort {
  /**
   * Mints of the token accounts owned by `owner` that hold exactly one unit of
   * a zero-decimal mint (NFT candidates), across both token programs.
   */
  findNftMints(
    owner: string,
  ): Promise<{ readonly slot: bigint; readonly mints: readonly string[] }>;

  /**
   * Fetches up to {@link MAX_ACCOUNTS_PER_CALL} accounts in one request, so all
   * of them come from the returned slot. `null` for an account that does not
   * exist. Order matches `addresses`.
   */
  getAccounts(
    addresses: readonly string[],
  ): Promise<{ readonly slot: bigint; readonly accounts: readonly (RawAccount | null)[] }>;
}

/** RPC limit for `getMultipleAccounts`. */
export const MAX_ACCOUNTS_PER_CALL = 100;
