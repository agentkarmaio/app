/// <reference types="bun-types" />
/**
 * Promotion of Celo relayer settlements from quarantine into `transactions`.
 * Data integrity: a ring row promoted once cannot be taken back, so the
 * decide-once cursor and the graph window around each decided slice are
 * tested as hard as the detector itself.
 */

import { describe, expect, test } from 'bun:test';
import {
  celoX402PromotionRun,
  CELO_PROMOTION_CURSOR_KEY,
  LATE_CHECK_MAX_EDGES,
  PROMOTION_GRAPH_WINDOW_MS,
  PROMOTION_HOLD_MS,
  type CeloX402PromotionDeps,
  type QuarantinedSettlement,
} from './celo-x402-promotion';

const RELAYER = '0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48';
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-29T14:00:00Z');
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString();

let seq = 0;
function row(payer: string, payee: string, hours: number, amount: number | string = 0.1): QuarantinedSettlement {
  seq += 1;
  return {
    tx_hash: `0x${seq.toString(16).padStart(64, '0')}`,
    log_index: 3,
    // PostgREST's timestamptz shape, not toISOString's.
    block_time: at(hours).replace('.000Z', '+00:00'),
    relayer: RELAYER,
    payer,
    payee,
    amount,
  };
}

/** a → b → c → a, one lap per hour starting at `fromHour`. */
function ring(fromHour: number, laps: number): QuarantinedSettlement[] {
  const out: QuarantinedSettlement[] = [];
  for (let i = 0; i < laps; i++) {
    out.push(row('0xa', '0xb', fromHour + i), row('0xb', '0xc', fromHour + i + 0.1), row('0xc', '0xa', fromHour + i + 0.2));
  }
  return out;
}

function harness(table: QuarantinedSettlement[], opts: { cursor?: string; promoted?: Record<string, number>; dryRun?: boolean } = {}) {
  const calls: string[] = [];
  const state = {
    cursor: opts.cursor ?? null as string | null,
    transactions: [] as Parameters<CeloX402PromotionDeps['insertTransactions']>[0],
    signals: [] as Parameters<CeloX402PromotionDeps['insertSignalEvents']>[0],
    wallets: [] as string[],
    reads: [] as [string | null, string][],
    insertBatches: 0,
    getCursorCalls: 0,
  };
  const ms = (s: string) => Date.parse(s);
  const deps: CeloX402PromotionDeps = {
    dryRun: opts.dryRun,
    getMaxBlockTime: async () =>
      table.length === 0 ? null : table.reduce((m, r) => (ms(r.block_time) > ms(m) ? r.block_time : m), table[0].block_time),
    getSettlements: async (from, to) => {
      state.reads.push([from, to]);
      return table.filter((r) => (from == null || ms(r.block_time) > ms(from)) && ms(r.block_time) <= ms(to));
    },
    countPromotedOnEdge: async (payer, payee) => opts.promoted?.[`${payer}>${payee}`] ?? 0,
    ensureWallets: async (addresses) => { calls.push('ensureWallets'); state.wallets.push(...addresses); },
    insertTransactions: async (rows) => {
      calls.push('insertTransactions');
      state.insertBatches += 1;
      state.transactions.push(...rows);
      return rows.length;
    },
    insertSignalEvents: async (inputs) => { calls.push('insertSignalEvents'); state.signals.push(...inputs); return inputs.length; },
    getCursor: async (key) => {
      if (state.getCursorCalls++ > 0) calls.push('getCursor');
      return key === CELO_PROMOTION_CURSOR_KEY && state.cursor ? { last_signature: state.cursor } : null;
    },
    upsertCursor: async (key, last) => { calls.push('upsertCursor'); expect(key).toBe(CELO_PROMOTION_CURSOR_KEY); state.cursor = last; },
  };
  return { deps, state, calls };
}

describe('constants', () => {
  test('match the approved spec', () => {
    expect(CELO_PROMOTION_CURSOR_KEY).toBe('celo:x402-promotion');
    expect(PROMOTION_HOLD_MS).toBe(24 * HOUR);
    expect(PROMOTION_GRAPH_WINDOW_MS).toBe(7 * 24 * HOUR);
  });
});

describe('first run', () => {
  const clean = row('0xpayer', '0xservice', 1, '0.25');
  const table = [...ring(0, 3), clean, row('0xlate', '0xservice', 40)];

  test('promotes clean rows up to max block_time − 24h, quarantines the ring', async () => {
    const { deps, state, calls } = harness(table);
    const r = await celoX402PromotionRun(deps);

    expect(r.slice).toEqual({ from: null, to: at(16) });
    expect(r.decided).toBe(10);
    expect(r.quarantined.map((q) => q.row.payer).sort()).toEqual(['0xa', '0xa', '0xa', '0xb', '0xb', '0xb', '0xc', '0xc', '0xc']);
    expect(r.quarantined[0].reasons).toEqual(['short-cycle', 'closed-cluster']);
    expect(r.promoted).toHaveLength(1);
    expect(r.inserted).toBe(1);
    expect(r.clusters.map((c) => c.members)).toEqual([['0xa', '0xb', '0xc']]);

    expect(state.transactions).toEqual([{
      chain: 'celo',
      wallet_address: '0xpayer',
      facilitator: RELAYER,
      counterparty: '0xservice',
      amount: 0.25,
      timestamp: at(1),
      success: true,
      tx_signature: `${clean.tx_hash}:3`,
    }]);
    expect(state.signals.map((s) => [s.agentWallet, s.face, s.chain])).toEqual([
      ['0xpayer', 'consumer', 'celo'],
      ['0xservice', 'provider', 'celo'],
    ]);
    expect(state.wallets.sort()).toEqual(['0xpayer', '0xservice']);
    expect(calls).toEqual(['getCursor', 'ensureWallets', 'insertTransactions', 'insertSignalEvents', 'upsertCursor']);
    expect(state.cursor).toBe(at(16));
  });
});

describe('decide once', () => {
  test('a second run decides only rows after the cursor', async () => {
    const table = [row('0xp1', '0xs', 1), row('0xp2', '0xs', 30), row('0xp3', '0xs', 60)];
    const h = harness(table);

    const first = await celoX402PromotionRun(h.deps);
    expect(first.slice).toEqual({ from: null, to: at(36) });
    expect(h.state.transactions.map((t) => t.wallet_address)).toEqual(['0xp1', '0xp2']);

    // No new flow indexed: the cutoff has not moved, nothing is due.
    const second = await celoX402PromotionRun(h.deps);
    expect(second.slice).toBeNull();
    expect(h.state.transactions).toHaveLength(2);

    // Newer flow moves the cutoff; only the hour-60 row is decided, once.
    table.push(row('0xp4', '0xs', 90));
    const third = await celoX402PromotionRun(h.deps);
    expect(third.slice).toEqual({ from: at(36), to: at(66) });
    expect(third.decided).toBe(1);
    expect(h.state.transactions.map((t) => t.wallet_address)).toEqual(['0xp1', '0xp2', '0xp3']);
  });

  test('nothing to decide: no writes, cursor untouched', async () => {
    const h = harness([row('0xp', '0xs', 10)], { cursor: at(0) });
    const r = await celoX402PromotionRun(h.deps);
    expect(r.slice).toBeNull();
    expect(r.decided).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.state.cursor).toBe(at(0));
  });

  test('empty table is a no-op', async () => {
    const h = harness([]);
    const r = await celoX402PromotionRun(h.deps);
    expect(r).toEqual({ slice: null, decided: 0, promoted: [], inserted: 0, quarantined: [], clusters: [], lateFlagged: [] });
    expect(h.calls).toEqual([]);
  });

  test('a slice with no clean rows still advances the cursor without writes', async () => {
    const h = harness([...ring(0, 2), row('0xp', '0xs', 40)]);
    const r = await celoX402PromotionRun(h.deps);
    expect(r.promoted).toEqual([]);
    expect(h.calls).toEqual(['getCursor', 'upsertCursor']);
    expect(h.state.cursor).toBe(at(16));
  });
});

describe('graph window', () => {
  test('reads [cursor − 7d, max block_time] and judges the slice against all of it', async () => {
    // Ring legs a→b and b→c settled before the cursor; the closing c→a leg is the
    // first row in the slice. Without the lookback it would read as clean.
    const table = [row('0xa', '0xb', 100), row('0xb', '0xc', 101), row('0xc', '0xa', 103), row('0xp', '0xs', 200)];
    const cursor = at(102);
    const h = harness(table, { cursor });
    const r = await celoX402PromotionRun(h.deps);

    expect(h.state.reads).toEqual([[new Date(Date.parse(cursor) - PROMOTION_GRAPH_WINDOW_MS).toISOString(), table[3].block_time]]);
    expect(r.decided).toBe(1);
    expect(r.quarantined.map((q) => q.row.payer)).toEqual(['0xc']);
    expect(h.state.transactions).toEqual([]);
  });

  test('a cycle closing within the hold catches the rows it would have promoted', async () => {
    // a→b at hour 0 looks clean on its own; b→a 20h later closes the loop. The
    // 24h hold means a→b is only decided once b→a is in view.
    const h = harness([row('0xa', '0xb', 0), row('0xb', '0xa', 20), row('0xp', '0xs', 30)]);
    const r = await celoX402PromotionRun(h.deps);
    expect(r.decided).toBe(1);
    expect(r.quarantined).toHaveLength(1);
    expect(h.state.transactions).toEqual([]);
  });

  test('the cutoff follows the newest indexed row, not wall-clock time', async () => {
    // These rows are months old in wall-clock terms, but the indexer has seen
    // nothing after hour 10, so nothing is past the hold yet.
    const h = harness([row('0xp', '0xs', 0), row('0xq', '0xs', 10)]);
    const r = await celoX402PromotionRun(h.deps);
    expect(r.slice).toEqual({ from: null, to: at(-14) });
    expect(r.decided).toBe(0);
    expect(h.state.transactions).toEqual([]);
  });
});

describe('late flags', () => {
  test('reports flagged edges that already have promoted rows; skips self-payments', async () => {
    const table = [...ring(0, 2), row('0xs', '0xs', 1), row('0xp', '0xs', 40)];
    const h = harness(table, { promoted: { '0xa>0xb': 4, '0xs>0xs': 9 } });
    const r = await celoX402PromotionRun(h.deps);
    expect(r.lateFlagged).toEqual([{ payer: '0xa', payee: '0xb', promoted: 4, reasons: ['short-cycle', 'closed-cluster'] }]);
    expect(r.quarantined.find((q) => q.row.payer === '0xs')!.reasons).toEqual(['self-payment']);
  });
});

describe('late flags cap', () => {
  test('checks at most LATE_CHECK_MAX_EDGES flagged edges, largest first', async () => {
    // 60 disjoint pairs; pair 59 has the most payments.
    const table = Array.from({ length: 60 }, (_, i) =>
      Array.from({ length: i + 1 }, () => [row(`0xa${i}`, `0xb${i}`, 1), row(`0xb${i}`, `0xa${i}`, 1)]).flat(),
    ).flat();
    table.push(row('0xp', '0xs', 40));
    const h = harness(table);
    const checked: string[] = [];
    h.deps.countPromotedOnEdge = async (payer) => { checked.push(payer); return 0; };
    await celoX402PromotionRun(h.deps);
    expect(LATE_CHECK_MAX_EDGES).toBe(50);
    expect(checked).toHaveLength(50);
    expect(checked[0]).toMatch(/^0x[ab]59$/);
    expect(checked).not.toContain('0xa0');
  });

  test('runs after the cursor is written', async () => {
    const h = harness([...ring(0, 2), row('0xp', '0xs', 1), row('0xq', '0xs', 40)]);
    h.deps.countPromotedOnEdge = async () => { h.calls.push('countPromotedOnEdge'); return 0; };
    await celoX402PromotionRun(h.deps);
    expect(h.calls.indexOf('upsertCursor')).toBeLessThan(h.calls.indexOf('countPromotedOnEdge'));
  });
});

describe('concurrent runs', () => {
  test('aborts before any write when another run moved the cursor', async () => {
    const h = harness([row('0xp', '0xs', 0), row('0xq', '0xs', 30)]);
    let reads = 0;
    h.deps.getCursor = async () => (reads++ === 0 ? null : { last_signature: at(5) });
    await expect(celoX402PromotionRun(h.deps)).rejects.toThrow('promotion_cursor_moved');
    expect(h.calls).toEqual([]);
  });
});

describe('writes', () => {
  test('inserts in batches of 500', async () => {
    const table = Array.from({ length: 1201 }, (_, i) => row(`0xp${i}`, '0xs', i / 100));
    table.push(row('0xlast', '0xs', 60));
    const h = harness(table);
    const r = await celoX402PromotionRun(h.deps);
    expect(r.inserted).toBe(1201);
    expect(h.state.insertBatches).toBe(3);
  });

  test('a failed insert leaves the cursor where it was', async () => {
    const h = harness([row('0xp', '0xs', 0), row('0xq', '0xs', 30)], { cursor: at(-1) });
    h.deps.insertTransactions = async () => { throw new Error('57014'); };
    await expect(celoX402PromotionRun(h.deps)).rejects.toThrow('57014');
    expect(h.state.cursor).toBe(at(-1));
  });

  test('dry run decides the same slice but writes nothing', async () => {
    const h = harness([...ring(0, 2), row('0xp', '0xs', 1), row('0xq', '0xs', 40)], { dryRun: true });
    const r = await celoX402PromotionRun(h.deps);
    expect(r.promoted).toHaveLength(1);
    expect(r.quarantined).toHaveLength(6);
    expect(r.inserted).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.state.cursor).toBeNull();
  });

  test('abort signal stops the run before any write', async () => {
    const h = harness([row('0xp', '0xs', 0), row('0xq', '0xs', 30)]);
    const controller = new AbortController();
    controller.abort();
    h.deps.signal = controller.signal;
    await expect(celoX402PromotionRun(h.deps)).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });
});
