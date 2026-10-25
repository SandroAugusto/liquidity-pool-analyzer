/**
 * Record → sanitise → replay, on synthetic chain state. The real fixtures this
 * machinery exists for (#5, criteria 1–3) must be recorded where RPC is
 * reachable; see `pnpm record-fixture`.
 */

import { getPositionAddress } from '@orca-so/whirlpools-client';
import {
  getInitializableTickIndex,
  priceToSqrtPrice,
  priceToTickIndex,
  sqrtPriceToTickIndex,
} from '@orca-so/whirlpools-core';
import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import {
  FixtureMismatchError,
  readPositions,
  recordingPort,
  replayPort,
} from '../../../src/adapters/orca/index.js';
import type { Fixture } from '../../../src/adapters/orca/index.js';
import { main } from '../../../src/cli/record-fixture.js';
import { MINT, SyntheticChain, WALLET, fakeAddress } from './synthetic-chain.js';

const SPACING = 16;

async function chainWithForeignNft(): Promise<{ chain: SyntheticChain; foreignNft: Address }> {
  const chain = new SyntheticChain();
  const sqrtPrice = priceToSqrtPrice(1 / 1200, 9, 8);
  const pool = chain.addPool({
    mintA: MINT.SOL,
    mintB: MINT.WBTC,
    tickSpacing: SPACING,
    feeRate: 500,
    sqrtPrice,
    tickCurrentIndex: sqrtPriceToTickIndex(sqrtPrice),
  });
  await chain.addPosition(pool, SPACING, {
    liquidity: 4_000_000_000n,
    tickLowerIndex: getInitializableTickIndex(priceToTickIndex(1 / 1250, 9, 8), SPACING, false),
    tickUpperIndex: getInitializableTickIndex(priceToTickIndex(1 / 1150, 9, 8), SPACING, true),
  });
  // Some other NFT the wallet holds; it must not end up in a fixture.
  const foreignNft = fakeAddress(200);
  chain.nftMints.unshift(foreignNft);
  return { chain, foreignNft };
}

async function record(chain: SyntheticChain): Promise<{
  fixture: Fixture;
  json: string;
  readings: Awaited<ReturnType<typeof readPositions>>;
}> {
  const recorder = recordingPort(chain.port());
  const readings = await readPositions(recorder.port, WALLET);
  const fixture = await recorder.toFixture();
  return { fixture, json: JSON.stringify(fixture), readings };
}

describe('fixtures', () => {
  it('replay to the same readings as the recorded run, slots included', async () => {
    const { chain } = await chainWithForeignNft();
    const { json, readings } = await record(chain);

    const replayed = await readPositions(replayPort(JSON.parse(json) as Fixture), fakeAddress(9));

    expect(replayed).toEqual(readings);
    expect(replayed).toHaveLength(1);
  });

  it('never contain the wallet address', async () => {
    const { chain } = await chainWithForeignNft();
    const { json } = await record(chain);
    expect(json).not.toContain(WALLET);
  });

  it('drop NFTs that are not positions, and the lookups of their PDAs', async () => {
    const { chain, foreignNft } = await chainWithForeignNft();
    const [foreignPda] = await getPositionAddress(foreignNft);
    const { fixture, json } = await record(chain);

    expect(json).not.toContain(foreignNft);
    expect(json).not.toContain(foreignPda);
    expect(fixture.nftMints.mints).toHaveLength(1);
  });

  it('refuse to replay when the reader asks for other accounts', async () => {
    const { chain } = await chainWithForeignNft();
    const { fixture } = await record(chain);
    const stale: Fixture = {
      ...fixture,
      calls: fixture.calls.map((call, i) =>
        i === 0 ? { ...call, addresses: [fakeAddress(201)] } : call,
      ),
    };

    await expect(readPositions(replayPort(stale), WALLET)).rejects.toThrow(FixtureMismatchError);
  });

  it('refuse to replay past the end of the recording', async () => {
    const { chain } = await chainWithForeignNft();
    const { fixture } = await record(chain);
    const truncated: Fixture = { ...fixture, calls: fixture.calls.slice(0, 1) };

    await expect(readPositions(replayPort(truncated), WALLET)).rejects.toThrow(
      FixtureMismatchError,
    );
  });
});

// Review of #14: discovery is chunked by 100 accounts. Sanitising must cover
// every discovery chunk and re-chunk what is kept, or replay asks for
// different chunks than the fixture holds.
describe('fixtures with more than 100 NFT candidates (review of #14)', () => {
  for (const where of ['first', 'last'] as const) {
    it(`sanitise and replay with the position ${where} of 101 candidates`, async () => {
      const { chain } = await chainWithForeignNft();
      const [position] = chain.nftMints.filter((_, i) => i === chain.nftMints.length - 1);
      if (position === undefined) {
        throw new Error('expected the position NFT');
      }
      const foreign = Array.from({ length: 100 }, (_, i) => fakeAddress(100 + i));
      chain.nftMints.length = 0;
      chain.nftMints.push(...(where === 'first' ? [position, ...foreign] : [...foreign, position]));

      const { json, readings } = await record(chain);
      const replayed = await readPositions(replayPort(JSON.parse(json) as Fixture), WALLET);

      expect(replayed).toEqual(readings);
      for (const nft of foreign) {
        const [pda] = await getPositionAddress(nft);
        expect(json).not.toContain(nft);
        expect(json).not.toContain(pda);
      }
    });
  }
});

// Review of #14: a position that exists in discovery and closes before the
// state call is skipped by the reader. The fixture must keep it as it was
// discovered, or replay asks for different accounts than were recorded.
describe('fixtures when a position closes during the read (review of #14)', () => {
  it('replay to the recorded readings', async () => {
    const { chain } = await chainWithForeignNft();
    const [first] = await readPositions(chain.port(), WALLET);
    if (first === undefined) {
      throw new Error('expected one position');
    }
    const pool = first.source.pool as Address;
    const closing = await chain.addPosition(pool, SPACING, {
      liquidity: 1n,
      tickLowerIndex: -70400,
      tickUpperIndex: -70000,
    });
    chain.calls.length = 0;
    chain.beforeGetAccounts = (call) => {
      if (call === 3) {
        chain.accounts.delete(closing);
      }
    };

    const { json, readings } = await record(chain);
    const replayed = await readPositions(replayPort(JSON.parse(json) as Fixture), WALLET);

    expect(readings).toHaveLength(1);
    expect(replayed).toEqual(readings);
  });
});

describe('pnpm record-fixture', () => {
  it('writes the sanitised fixture under tests/fixtures/orca', async () => {
    const { chain } = await chainWithForeignNft();
    const files: Record<string, string> = {};
    let out = '';

    const code = await main([WALLET, 'example'], {
      env: {},
      createPort: () => chain.port(),
      writeFile: (path, contents) => {
        files[path] = contents;
        return Promise.resolve();
      },
      out: (text) => (out += text),
      err: () => undefined,
    });

    expect(code).toBe(0);
    expect(Object.keys(files)).toEqual(['tests/fixtures/orca/example.json']);
    expect(files['tests/fixtures/orca/example.json']).not.toContain(WALLET);
    expect(out).toMatch(/1 position\(s\) at slot\(s\) \d+/);
  });

  it.each([[[]], [[WALLET]], [[WALLET, '../escape']], [[WALLET, 'a', 'b']]])(
    'prints usage and exits 2 for %j',
    async (argv) => {
      let err = '';
      const code = await main(argv, {
        env: {},
        createPort: () => new SyntheticChain().port(),
        writeFile: () => Promise.reject(new Error('must not write')),
        out: () => undefined,
        err: (text) => (err += text),
      });
      expect(code).toBe(2);
      expect(err).toContain('usage: pnpm record-fixture');
    },
  );
});
