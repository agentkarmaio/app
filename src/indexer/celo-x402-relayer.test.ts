/// <reference types="bun-types" />
/**
 * Celo x402 relayer-mode indexer tests.
 *
 * Mock strategy: DEPENDENCY INJECTION (mirrors celo-x402.test.ts). The core
 * takes injected RPC + DB hooks, so receipts are hand-built fixtures and no
 * live RPC or Supabase is touched.
 *
 * Run: bun test src/indexer/celo-x402-relayer.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  AUTHORIZATION_USED_TOPIC,
  TRANSFER_TOPIC,
  CELO_RELAYER_CURSOR_KEY,
  matchRelayerSettlements,
  interpolateBlockTime,
  celoX402RelayerIndexer,
  type RelayerReceipt,
  type CeloX402Settlement,
} from './celo-x402-relayer';
import { CELO_X402_TOKENS, CELO_X402_RELAYERS, celoX402RelayerSet } from '../config/celo-x402';

const RELAYER = '0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48';
const PAYER = '0x1111111111111111111111111111111111111111';
const PAYEE = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const USDC = CELO_X402_TOKENS.find((t) => t.symbol === 'USDC')!;
const USAT = CELO_X402_TOKENS.find((t) => t.symbol === 'USAT')!;
const RELAYERS: ReadonlySet<string> = new Set([RELAYER]);

const pad = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, '0')}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

function authLog(token: string, authorizer: string, logIndex: number) {
  return { address: token, topics: [AUTHORIZATION_USED_TOPIC, pad(authorizer), word(BigInt(logIndex))], data: '0x', logIndex };
}
function transferLog(token: string, from: string, to: string, value: bigint, logIndex: number) {
  return { address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: word(value), logIndex };
}
function receipt(over: Partial<RelayerReceipt> = {}): RelayerReceipt {
  return {
    transactionHash: '0xaaa',
    blockNumber: BigInt(1_000),
    from: RELAYER,
    status: 'success',
    logs: [authLog(USDC.address, PAYER, 0), transferLog(USDC.address, PAYER, PAYEE, BigInt(80_000), 1)],
    ...over,
  };
}

describe('config', () => {
  test('USAT is a settlement token (Celo facilitator /supported lists it)', () => {
    expect(USAT.address.toLowerCase()).toBe('0xd2ab3c9a02dbbab236bfec45d1d755df4267f771');
    expect(USAT.decimals).toBe(6);
  });

  test('Celo native facilitator relayer is seeded', () => {
    expect(CELO_X402_RELAYERS.map((r) => r.address.toLowerCase())).toContain(RELAYER);
    expect(celoX402RelayerSet().has(RELAYER)).toBe(true);
  });
});

describe('matchRelayerSettlements', () => {
  test('pairs AuthorizationUsed with the payer Transfer on the same token', () => {
    const out = matchRelayerSettlements(receipt(), RELAYERS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      txHash: '0xaaa', logIndex: 1, blockNumber: BigInt(1_000), relayer: RELAYER,
      token: USDC.address.toLowerCase(), symbol: 'USDC', payer: PAYER, payee: PAYEE,
      rawValue: BigInt(80_000), value: 0.08,
    });
  });

  test('ignores transactions not sent by a watched relayer', () => {
    expect(matchRelayerSettlements(receipt({ from: OTHER }), RELAYERS)).toEqual([]);
  });

  test('ignores reverted transactions', () => {
    expect(matchRelayerSettlements(receipt({ status: 'reverted' }), RELAYERS)).toEqual([]);
  });

  test('ignores Transfers with no matching authorization (e.g. fee legs, other payers)', () => {
    const r = receipt({
      logs: [
        transferLog(USDC.address, OTHER, PAYEE, BigInt(5), 0),
        authLog(USDC.address, PAYER, 1),
        transferLog(USDC.address, PAYER, PAYEE, BigInt(80_000), 2),
      ],
    });
    const out = matchRelayerSettlements(r, RELAYERS);
    expect(out.map((s) => s.logIndex)).toEqual([2]);
  });

  test('ignores logs from non-settlement token contracts', () => {
    const r = receipt({ logs: [authLog(OTHER, PAYER, 0), transferLog(OTHER, PAYER, PAYEE, BigInt(1), 1)] });
    expect(matchRelayerSettlements(r, RELAYERS)).toEqual([]);
  });

  test('batched settlements in one tx each get their own row', () => {
    const r = receipt({
      logs: [
        authLog(USDC.address, PAYER, 0), transferLog(USDC.address, PAYER, PAYEE, BigInt(1_000_000), 1),
        authLog(USAT.address, OTHER, 2), transferLog(USAT.address, OTHER, PAYER, BigInt(2_000_000), 3),
      ],
    });
    const out = matchRelayerSettlements(r, RELAYERS);
    expect(out.map((s) => [s.symbol, s.payer, s.payee, s.value])).toEqual([
      ['USDC', PAYER, PAYEE, 1], ['USAT', OTHER, PAYER, 2],
    ]);
  });

  test('relayer match is case-insensitive', () => {
    expect(matchRelayerSettlements(receipt({ from: RELAYER.toUpperCase().replace('0X', '0x') }), RELAYERS)).toHaveLength(1);
  });
});

describe('interpolateBlockTime', () => {
  test('linear between window endpoints', () => {
    expect(interpolateBlockTime(BigInt(150), { block: BigInt(100), unix: 1_000 }, { block: BigInt(200), unix: 1_100 }))
      .toBe(new Date(1_050_000).toISOString());
  });
  test('single-block window returns that block time', () => {
    expect(interpolateBlockTime(BigInt(7), { block: BigInt(7), unix: 5 }, { block: BigInt(7), unix: 5 }))
      .toBe(new Date(5_000).toISOString());
  });
});

// ── DI core ───────────────────────────────────────────────────────────────────

function makeDeps(receipts: RelayerReceipt[], over: Partial<Parameters<typeof celoX402RelayerIndexer>[0]> = {}) {
  const inserted: CeloX402Settlement[][] = [];
  const cursors: Array<[string, string, number | undefined]> = [];
  const windows: Array<[bigint, bigint]> = [];
  const deps: Parameters<typeof celoX402RelayerIndexer>[0] = {
    relayers: RELAYERS,
    getHead: async () => BigInt(1_999),
    getAuthorizationTxHashes: async (from, to) => {
      windows.push([from, to]);
      return receipts.filter((r) => r.blockNumber >= from && r.blockNumber <= to).map((r) => r.transactionHash);
    },
    getReceipt: async (hash) => receipts.find((r) => r.transactionHash === hash)!,
    blockUnix: async (b) => Number(b),
    insertSettlements: async (rows) => { inserted.push(rows); return rows.length; },
    getCursor: async () => null,
    upsertCursor: async (key, last, slot) => { cursors.push([key, last, slot]); },
    startBlockFallback: BigInt(1_000),
    windowSize: 500,
    ...over,
  };
  return { deps, inserted, cursors, windows };
}

describe('celoX402RelayerIndexer', () => {
  test('no relayers → dormant no-op, no RPC', async () => {
    let called = false;
    const { deps } = makeDeps([], { relayers: new Set(), getHead: async () => { called = true; return BigInt(0); } });
    const r = await celoX402RelayerIndexer(deps);
    expect(called).toBe(false);
    expect(r.coverage.reason).toBe('empty_seed');
  });

  test('writes settlements per window and advances its own cursor', async () => {
    const { deps, inserted, cursors, windows } = makeDeps([
      receipt({ transactionHash: '0x01', blockNumber: BigInt(1_100) }),
      receipt({ transactionHash: '0x02', blockNumber: BigInt(1_700), from: OTHER }),
    ]);
    const r = await celoX402RelayerIndexer(deps);
    expect(windows).toEqual([[BigInt(1_000), BigInt(1_499)], [BigInt(1_500), BigInt(1_999)]]);
    expect(inserted.flat().map((s) => s.txHash)).toEqual(['0x01']);
    expect(inserted.flat()[0].blockTime).toBe(new Date(1_100_000).toISOString());
    expect(cursors).toEqual([
      [CELO_RELAYER_CURSOR_KEY, '1499', 1_499],
      [CELO_RELAYER_CURSOR_KEY, '1999', 1_999],
    ]);
    expect(r).toMatchObject({ fetched: 1, inserted: 1 });
    expect(r.coverage).toMatchObject({ complete: true, pending: 0 });
  });

  test('resumes from cursor + 1', async () => {
    const { deps, windows } = makeDeps([], { getCursor: async () => ({ last_signature: '1799', last_slot: 1_799 }) });
    await celoX402RelayerIndexer(deps);
    expect(windows).toEqual([[BigInt(1_800), BigInt(1_999)]]);
  });

  test('time budget stops between windows and reports catching_up', async () => {
    let t = 0;
    const { deps, windows } = makeDeps([], { timeBudgetMs: 10, now: () => (t += 6) });
    const r = await celoX402RelayerIndexer(deps);
    expect(windows).toHaveLength(1);
    expect(r.coverage).toMatchObject({ complete: false, reason: 'time_budget' });
  });

  test('cursor key is distinct from the payee-mode indexer', () => {
    expect(CELO_RELAYER_CURSOR_KEY).toBe('celo:x402-relayer');
  });
});
