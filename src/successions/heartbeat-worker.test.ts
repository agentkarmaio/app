/// <reference types="bun-types" />
/**
 * Heartbeat worker tests — the Dead Man's Switch liveness drain (all chains).
 *
 * Drives the worker through the __setSupabaseForTest seam with a fake Supabase
 * that (a) serves the succession list + per-agent last-tx reads, and (b) records
 * every signal_events upsert + successions/wallets update so we can assert the
 * emitted signal kind/tier/chain and the persisted status. No live DB.
 *
 * Run: bun test src/successions/heartbeat-worker.test.ts
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { __setSupabaseForTest } from '../db/client';
import { drainHeartbeatsOnce, evaluateOneHeartbeat } from './heartbeat-worker';
import { SIGNAL_KINDS } from '../scoring/signals';
import type { Succession } from '../db/schema';

const NOW = new Date('2026-06-15T12:00:00Z');
const DAY = 86_400;

function tsAgo(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

interface SignalRow { kind: string; tier: number; chain?: string; agent_wallet: string; value?: number }
interface UpdateRec { table: string; patch: Record<string, unknown>; filters: Record<string, unknown> }

/**
 * Fake Supabase. `successions` = the heartbeat list. `lastTxByWallet` = the
 * newest tx timestamp per agent_wallet for the transactions read. Captures
 * signal upserts and successions/wallets updates.
 */
function makeFake(opts: {
  successions: Partial<Succession>[];
  lastTxByWallet: Record<string, string | null>;
  signals: SignalRow[];
  updates: UpdateRec[];
}) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (col: string, val: unknown) => { filters[col] = val; return builder; };
      builder.in = (col: string, val: unknown) => { filters[col] = val; return builder; };
      builder.not = () => builder;
      builder.order = () => builder;
      builder.limit = async () => {
        if (table === 'successions') {
          return { data: opts.successions, error: null };
        }
        if (table === 'transactions') {
          const w = filters.wallet_address as string;
          const ts = opts.lastTxByWallet[w] ?? null;
          return { data: ts ? [{ timestamp: ts }] : [], error: null };
        }
        return { data: [], error: null };
      };
      builder.upsert = (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        if (table === 'signal_events') {
          for (const row of arr) {
            opts.signals.push({
              kind: row.kind as string,
              tier: row.tier as number,
              chain: row.chain as string | undefined,
              agent_wallet: row.agent_wallet as string,
              value: row.value as number | undefined,
            });
          }
        }
        const result = { data: arr.map(() => ({ id: 'x' })), error: null };
        // insertSignalEvents chains .select('id').
        return { select: async () => result, then: (resolve: (v: typeof result) => void) => resolve(result) };
      };
      builder.update = (patch: Record<string, unknown>) => {
        const updFilters: Record<string, unknown> = {};
        const updBuilder: Record<string, unknown> = {
          eq: (col: string, val: unknown) => { updFilters[col] = val; return updBuilder; },
        };
        // Updates terminate on the second .eq() (chain + address/agent_wallet).
        (updBuilder as { then: unknown }).then = (resolve: (v: { error: null }) => void) => {
          opts.updates.push({ table, patch, filters: updFilters });
          return resolve({ error: null });
        };
        return updBuilder;
      };
      return builder;
    },
  };
}

function succ(over: Partial<Succession>): Succession {
  return {
    chain: 'solana',
    agent_wallet: 'AGENT',
    source_type: 'claim_form',
    interval_seconds: 7 * DAY,
    heirs: [{ address: 'HEIR', chain: 'solana' }],
    status: 'declared',
    will_hash: null,
    declared_at: tsAgo(30 * DAY),
    last_heartbeat_at: null,
    lapsed_at: null,
    executed_at: null,
    revoked_at: null,
    updated_at: tsAgo(30 * DAY),
    ...over,
  };
}

describe('evaluateOneHeartbeat', () => {
  let signals: SignalRow[];
  let updates: UpdateRec[];
  beforeEach(() => { signals = []; updates = []; });

  test('tx within interval → live, emits heartbeat_observed (T2)', async () => {
    __setSupabaseForTest(makeFake({
      successions: [], lastTxByWallet: { AGENT: tsAgo(2 * DAY) }, signals, updates,
    }));
    const outcome = await evaluateOneHeartbeat(succ({ agent_wallet: 'AGENT' }), NOW);
    expect(outcome).toBe('observed');
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe(SIGNAL_KINDS.HEARTBEAT_OBSERVED);
    expect(signals[0].tier).toBe(2);
    // succession + wallet both written with the derived status.
    const succUpdate = updates.find((u) => u.table === 'successions');
    const walletUpdate = updates.find((u) => u.table === 'wallets');
    expect(succUpdate?.patch.status).toBe('live');
    expect(walletUpdate?.patch.succession_status).toBe('live');
  });

  test('past interval+grace → lapsed, emits heartbeat_lapsed (T2)', async () => {
    __setSupabaseForTest(makeFake({
      successions: [], lastTxByWallet: { AGENT: tsAgo(30 * DAY) }, signals, updates,
    }));
    const outcome = await evaluateOneHeartbeat(succ({ agent_wallet: 'AGENT' }), NOW);
    expect(outcome).toBe('lapsed');
    expect(signals[0].kind).toBe(SIGNAL_KINDS.HEARTBEAT_LAPSED);
    expect(signals[0].tier).toBe(2);
    const succUpdate = updates.find((u) => u.table === 'successions');
    expect(succUpdate?.patch.status).toBe('lapsed');
    // lapsed_at stamped on first entering lapsed.
    expect(succUpdate?.patch.lapsed_at).toBeDefined();
  });

  test('no observed tx → skipped, NO signal, status stays declared', async () => {
    __setSupabaseForTest(makeFake({
      successions: [], lastTxByWallet: { AGENT: null }, signals, updates,
    }));
    const outcome = await evaluateOneHeartbeat(succ({ agent_wallet: 'AGENT' }), NOW);
    expect(outcome).toBe('skipped');
    expect(signals).toHaveLength(0); // thin/no-data agent is never penalized
    const succUpdate = updates.find((u) => u.table === 'successions');
    expect(succUpdate?.patch.status).toBe('declared');
  });

  test('multi-chain: emits the signal on the succession row chain (celo)', async () => {
    __setSupabaseForTest(makeFake({
      successions: [], lastTxByWallet: { AGENT_EVM: tsAgo(DAY) }, signals, updates,
    }));
    await evaluateOneHeartbeat(succ({ agent_wallet: 'AGENT_EVM', chain: 'celo' }), NOW);
    expect(signals[0].chain).toBe('celo');
    const walletUpdate = updates.find((u) => u.table === 'wallets');
    expect(walletUpdate?.filters.chain).toBe('celo');
  });

  test('terminal executed status passes through, no signal', async () => {
    __setSupabaseForTest(makeFake({
      successions: [], lastTxByWallet: { AGENT: tsAgo(2 * DAY) }, signals, updates,
    }));
    // (executed rows are normally excluded by the list query, but evaluating one
    // directly must still honor the terminal override and not emit a heartbeat.)
    const outcome = await evaluateOneHeartbeat(succ({ status: 'executed' }), NOW);
    expect(outcome).not.toBe('lapsed');
    expect(signals.find((s) => s.kind.startsWith('heartbeat'))).toBeUndefined();
    const succUpdate = updates.find((u) => u.table === 'successions');
    expect(succUpdate?.patch.status).toBe('executed');
  });
});

describe('drainHeartbeatsOnce', () => {
  test('processes the batch and tallies outcomes + transitions', async () => {
    const signals: SignalRow[] = [];
    const updates: UpdateRec[] = [];
    __setSupabaseForTest(makeFake({
      successions: [
        succ({ agent_wallet: 'A', status: 'declared' }), // → live (transition)
        succ({ agent_wallet: 'B', status: 'live' }),      // → lapsed (transition)
        succ({ agent_wallet: 'C', status: 'declared' }),  // → skipped (no tx)
      ],
      lastTxByWallet: { A: tsAgo(2 * DAY), B: tsAgo(30 * DAY), C: null },
      signals, updates,
    }));
    const r = await drainHeartbeatsOnce(500, undefined, NOW);
    expect(r.claimed).toBe(3);
    expect(r.observed).toBe(1);
    expect(r.lapsed).toBe(1);
    expect(r.skipped).toBe(1);
    // A: declared→live and B: live→lapsed both transition; C declared→declared not.
    expect(r.transitioned).toBe(2);
    expect(r.errors).toHaveLength(0);
  });
});
