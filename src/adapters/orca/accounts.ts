/**
 * Checked account access shared by the Orca readers: alignment of responses
 * with requests, account type checks and mint decimals.
 */

import { WHIRLPOOL_PROGRAM_ADDRESS } from '@orca-so/whirlpools-client';

import { InvalidAccountError } from '../../positions/index.js';
import { MAX_ACCOUNTS_PER_CALL } from './port.js';
import type { RawAccount, SolanaReadPort } from './port.js';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Offset of `decimals` in an SPL mint account (same in Token-2022's base layout). */
const MINT_DECIMALS_OFFSET = 44;

/** Whether `account` is a Whirlpool-program account of this size and discriminator. */
export function isAccountOf(account: RawAccount, size: number, discriminator: Uint8Array): boolean {
  return (
    account.programAddress === WHIRLPOOL_PROGRAM_ADDRESS &&
    account.data.length === size &&
    discriminator.every((byte, i) => account.data[i] === byte)
  );
}

/**
 * `port.getAccounts`, checked: one entry per requested address, in order, each
 * non-null entry being the account that was asked for. A misaligned response
 * would attach one pool's mint decimals to another — a plausible wrong number.
 */
export async function getAccountsAligned(
  port: SolanaReadPort,
  addresses: readonly string[],
): Promise<{ readonly slot: bigint; readonly accounts: readonly (RawAccount | null)[] }> {
  const response = await port.getAccounts(addresses);
  if (
    response.accounts.length !== addresses.length ||
    response.accounts.some((account, i) => account !== null && account.address !== addresses[i])
  ) {
    throw new InvalidAccountError(addresses.join(','), 'response aligned with the request');
  }
  return response;
}

/** {@link getAccountsAligned} in chunks of at most {@link MAX_ACCOUNTS_PER_CALL}. */
export async function getAccountsChunked(
  port: SolanaReadPort,
  addresses: readonly string[],
): Promise<(RawAccount | null)[]> {
  const accounts: (RawAccount | null)[] = [];
  for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_CALL) {
    const chunk = addresses.slice(i, i + MAX_ACCOUNTS_PER_CALL);
    accounts.push(...(await getAccountsAligned(port, chunk)).accounts);
  }
  return accounts;
}

/** Decimals per mint; `null` for a Token-2022 mint (unsupported by both readers). */
export async function readMintDecimals(
  port: SolanaReadPort,
  addresses: readonly string[],
): Promise<Map<string, number | null>> {
  const accounts = await getAccountsChunked(port, addresses);
  const decimals = new Map<string, number | null>();
  accounts.forEach((account, i) => {
    const mint = addresses[i] ?? '';
    if (account?.programAddress === TOKEN_2022_PROGRAM) {
      decimals.set(mint, null);
      return;
    }
    const value = account?.data[MINT_DECIMALS_OFFSET];
    if (account?.programAddress !== TOKEN_PROGRAM || value === undefined) {
      throw new InvalidAccountError(mint, 'SPL token mint');
    }
    decimals.set(mint, value);
  });
  return decimals;
}
