/**
 * Recorded {@link SolanaReadPort} traffic, for offline tests against real
 * chain state (#5, criteria 3–4).
 *
 * A fixture is the sequence of port responses one `readPositions` run saw,
 * replayed in the same order. Replay is strict: if the reader asks for
 * different accounts than were recorded, the fixture is out of date and
 * replay throws instead of improvising.
 *
 * Sanitised by construction:
 * - the wallet address is never stored (replay ignores the owner argument);
 * - NFTs that are not Whirlpool positions are dropped, together with the
 *   lookups of their would-be position accounts, so the fixture does not
 *   reveal the wallet's other holdings. The remaining lookups are re-chunked
 *   the way the reader will request them on replay.
 * Position, pool and mint addresses remain. Pool and mint addresses are
 * public protocol data; position addresses and accounts are **owner position
 * data** under AGENTS.md (a position leads to its NFT and to the wallet), so a
 * fixture of real positions is never committed. The CLI writes it outside the
 * repository; see `src/cli/record-fixture.ts`.
 */

import { getPositionAddress } from '@orca-so/whirlpools-client';
import { address } from '@solana/kit';

import { MAX_ACCOUNTS_PER_CALL } from './port.js';
import { isPositionAccount } from './read-positions.js';
import type { RawAccount, SolanaReadPort } from './port.js';

export interface FixtureAccount {
  readonly address: string;
  readonly programAddress: string;
  /** Account data, base64. */
  readonly data: string;
}

export interface Fixture {
  readonly format: 'orca-port-v1';
  readonly nftMints: { readonly slot: string; readonly mints: readonly string[] };
  readonly calls: readonly {
    readonly slot: string;
    readonly addresses: readonly string[];
    readonly accounts: readonly (FixtureAccount | null)[];
  }[];
}

export class FixtureMismatchError extends Error {
  constructor(detail: string) {
    super(`Fixture does not match the reader's requests (${detail}); re-record it`);
    this.name = 'FixtureMismatchError';
  }
}

/** Wraps `port`, keeping every response for {@link toFixture}. */
export function recordingPort(port: SolanaReadPort): {
  readonly port: SolanaReadPort;
  readonly toFixture: () => Promise<Fixture>;
} {
  let nftMints: { slot: bigint; mints: readonly string[] } = { slot: 0n, mints: [] };
  const calls: {
    slot: bigint;
    addresses: readonly string[];
    accounts: readonly (RawAccount | null)[];
  }[] = [];
  return {
    port: {
      async findNftMints(owner): ReturnType<SolanaReadPort['findNftMints']> {
        nftMints = await port.findNftMints(owner);
        return nftMints;
      },
      async getAccounts(addresses): ReturnType<SolanaReadPort['getAccounts']> {
        const response = await port.getAccounts(addresses);
        calls.push({ slot: response.slot, addresses, accounts: response.accounts });
        return response;
      },
    },
    /**
     * The sanitised fixture. An NFT is kept when its PDA lookup in discovery
     * found a Whirlpool position — even if that position closed before the
     * state call and is absent from the readings, since the rest of the trace
     * still contains its requests. Every other NFT is dropped.
     */
    async toFixture(): Promise<Fixture> {
      const pdas = await Promise.all(
        nftMints.mints.map(async (mint) => (await getPositionAddress(address(mint)))[0]),
      );
      // Discovery is the leading calls that looked up every candidate's
      // position PDA, in chunks. Keep only real positions and re-chunk them
      // exactly as the reader will request them on replay.
      let discoveryCalls = 0;
      let looked = 0;
      while (looked < pdas.length) {
        looked += calls[discoveryCalls]?.addresses.length ?? pdas.length;
        discoveryCalls += 1;
      }
      const discovery = calls.slice(0, discoveryCalls);
      const entries = discovery.flatMap((call) =>
        call.addresses.map((a, i) => [a, call.accounts[i] ?? null] as const),
      );
      if (entries.map(([a]) => a).join() !== pdas.join()) {
        throw new Error('Recording does not start with the position-PDA lookups of every NFT');
      }
      const kept = entries.filter(([, account]) => account !== null && isPositionAccount(account));
      const keep = new Set(kept.map(([a]) => a));
      const mints = nftMints.mints.filter((_, i) => keep.has(pdas[i] ?? ''));
      const slot = discovery[0]?.slot ?? 0n;
      const keptDiscovery = [];
      for (let i = 0; i < kept.length; i += MAX_ACCOUNTS_PER_CALL) {
        keptDiscovery.push({ slot, ...unzip(kept.slice(i, i + MAX_ACCOUNTS_PER_CALL)) });
      }
      const rest = calls.slice(discoveryCalls);
      return {
        format: 'orca-port-v1',
        nftMints: { slot: nftMints.slot.toString(), mints },
        calls: [...keptDiscovery, ...rest].map((call) => ({
          slot: call.slot.toString(),
          addresses: call.addresses,
          accounts: call.accounts.map((account) =>
            account === null
              ? null
              : {
                  address: account.address,
                  programAddress: account.programAddress,
                  data: Buffer.from(account.data).toString('base64'),
                },
          ),
        })),
      };
    },
  };
}

/** A port that replays `fixture`, in order. */
export function replayPort(fixture: Fixture): SolanaReadPort {
  let next = 0;
  return {
    findNftMints(): ReturnType<SolanaReadPort['findNftMints']> {
      return Promise.resolve({
        slot: BigInt(fixture.nftMints.slot),
        mints: fixture.nftMints.mints,
      });
    },
    getAccounts(addresses): ReturnType<SolanaReadPort['getAccounts']> {
      const call = fixture.calls[next++];
      if (call === undefined) {
        return Promise.reject(new FixtureMismatchError(`unexpected call #${String(next)}`));
      }
      if (call.addresses.join() !== addresses.join()) {
        return Promise.reject(
          new FixtureMismatchError(`call #${String(next)} asked for other accounts`),
        );
      }
      return Promise.resolve({
        slot: BigInt(call.slot),
        accounts: call.accounts.map((account) =>
          account === null
            ? null
            : {
                address: account.address,
                programAddress: account.programAddress,
                data: new Uint8Array(Buffer.from(account.data, 'base64')),
              },
        ),
      });
    },
  };
}

function unzip(pairs: readonly (readonly [string, RawAccount | null])[]): {
  addresses: string[];
  accounts: (RawAccount | null)[];
} {
  return { addresses: pairs.map(([a]) => a), accounts: pairs.map(([, account]) => account) };
}
