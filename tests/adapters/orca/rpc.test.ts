/**
 * The live port, through the real `@solana/kit` RPC client, over a fake
 * transport: request shapes and response parsing are tested offline. Response
 * bodies follow the JSON-RPC shapes documented by Solana; they are synthetic.
 */

import type { RpcTransport } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { createRpcPortFromTransport } from '../../../src/adapters/orca/rpc.js';
import { MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WALLET, fakeAddress } from './synthetic-chain.js';

interface Request {
  readonly method: string;
  readonly params: readonly unknown[];
}

function fakeTransport(respond: (request: Request) => unknown): {
  transport: RpcTransport;
  requests: Request[];
} {
  const requests: Request[] = [];
  const transport = (async ({ payload }: { payload: unknown }) => {
    const request = payload as Request & { id: number };
    requests.push(request);
    return Promise.resolve({ jsonrpc: '2.0', id: request.id, result: respond(request) });
  }) as RpcTransport;
  return { transport, requests };
}

function tokenAccount(mint: string, amount: string, decimals: number): unknown {
  return {
    pubkey: fakeAddress(50),
    account: {
      data: {
        program: 'spl-token',
        parsed: {
          type: 'account',
          info: {
            mint,
            owner: WALLET,
            state: 'initialized',
            isNative: false,
            tokenAmount: { amount, decimals, uiAmount: Number(amount), uiAmountString: amount },
          },
        },
        space: 165,
      },
      executable: false,
      lamports: 2039280,
      owner: TOKEN_PROGRAM,
      rentEpoch: 0,
      space: 165,
    },
  };
}

describe('createRpcPortFromTransport', () => {
  it('finds NFT mints in both token programs and ignores fungible balances', async () => {
    const nft1 = fakeAddress(60);
    const nft2 = fakeAddress(61);
    const { transport, requests } = fakeTransport((request) => {
      const programId = (request.params[1] as { programId: string }).programId;
      return {
        context: { slot: programId === TOKEN_PROGRAM ? 10 : 12 },
        value:
          programId === TOKEN_PROGRAM
            ? [tokenAccount(nft1, '1', 0), tokenAccount(MINT.USDC, '1', 6)]
            : [tokenAccount(nft2, '1', 0), tokenAccount(fakeAddress(62), '0', 0)],
      };
    });

    const result = await createRpcPortFromTransport(transport).findNftMints(WALLET);

    expect(result.mints).toEqual([nft1, nft2]);
    expect(result.slot).toBe(12n);
    expect(requests.map((r) => r.method)).toEqual([
      'getTokenAccountsByOwner',
      'getTokenAccountsByOwner',
    ]);
    expect(requests.map((r) => (r.params[1] as { programId: string }).programId)).toEqual([
      TOKEN_PROGRAM,
      TOKEN_2022_PROGRAM,
    ]);
    expect(requests[0]?.params[2]).toMatchObject({
      encoding: 'jsonParsed',
      commitment: 'confirmed',
    });
  });

  it('returns raw accounts in request order, null for missing ones, with the slot', async () => {
    const [a, b] = [fakeAddress(70), fakeAddress(71)];
    const { transport, requests } = fakeTransport(() => ({
      context: { slot: 42 },
      value: [
        {
          data: [Buffer.from([1, 2, 3]).toString('base64'), 'base64'],
          executable: false,
          lamports: 1,
          owner: TOKEN_PROGRAM,
          rentEpoch: 0,
          space: 3,
        },
        null,
      ],
    }));

    const result = await createRpcPortFromTransport(transport).getAccounts([a, b]);

    expect(result.slot).toBe(42n);
    expect(result.accounts).toEqual([
      { address: a, programAddress: TOKEN_PROGRAM, data: new Uint8Array([1, 2, 3]) },
      null,
    ]);
    expect(requests[0]).toMatchObject({
      method: 'getMultipleAccounts',
      params: [[a, b], { encoding: 'base64', commitment: 'confirmed' }],
    });
  });
});
