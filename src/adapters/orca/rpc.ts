/**
 * Live {@link SolanaReadPort} over Solana JSON-RPC. Only read methods are
 * used: `getTokenAccountsByOwner` and `getMultipleAccounts`.
 */

import {
  address,
  createSolanaRpc,
  createSolanaRpcFromTransport,
  getBase64Encoder,
} from '@solana/kit';
import type { RpcTransport } from '@solana/kit';

import type { RawAccount, SolanaReadPort } from './port.js';

const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
] as const;

/** Commitment for every read: confirmed by a supermajority, not yet finalised. */
const COMMITMENT = 'confirmed';

type ReadRpc = ReturnType<typeof createSolanaRpc>;

/** A port reading from the RPC endpoint at `url`. */
export function createRpcPort(url: string): SolanaReadPort {
  return portFromRpc(createSolanaRpc(url));
}

/** A port over a custom transport. For tests: exercises the real RPC client offline. */
export function createRpcPortFromTransport(transport: RpcTransport): SolanaReadPort {
  return portFromRpc(createSolanaRpcFromTransport(transport));
}

function portFromRpc(rpc: ReadRpc): SolanaReadPort {
  const base64 = getBase64Encoder();
  return {
    async findNftMints(owner): ReturnType<SolanaReadPort['findNftMints']> {
      const responses = await Promise.all(
        TOKEN_PROGRAMS.map((programId) =>
          rpc
            .getTokenAccountsByOwner(
              address(owner),
              { programId: address(programId) },
              { encoding: 'jsonParsed', commitment: COMMITMENT },
            )
            .send(),
        ),
      );
      const mints = responses.flatMap((response) =>
        response.value
          .map((entry) => entry.account.data.parsed.info)
          .filter((info) => info.tokenAmount.decimals === 0 && info.tokenAmount.amount === '1')
          .map((info) => info.mint),
      );
      const slot = responses.reduce((max, r) => (r.context.slot > max ? r.context.slot : max), 0n);
      return { slot, mints };
    },

    async getAccounts(addresses): ReturnType<SolanaReadPort['getAccounts']> {
      const response = await rpc
        .getMultipleAccounts(
          addresses.map((a) => address(a)),
          { encoding: 'base64', commitment: COMMITMENT },
        )
        .send();
      const accounts = response.value.map((account, i): RawAccount | null =>
        account === null
          ? null
          : {
              address: addresses[i] ?? '',
              programAddress: account.owner,
              data: Uint8Array.from(base64.encode(account.data[0])),
            },
      );
      return { slot: response.context.slot, accounts };
    },
  };
}
