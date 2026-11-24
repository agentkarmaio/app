/// <reference types="bun-types" />
/**
 * Feedback reads count only rows whose referenced transaction paid the rated
 * agent from the rating consumer. Rows written before /api/feedback checked the
 * payee (or by the demo seeder) stay in the table but never reach a score.
 *
 * Run: bun test src/db/feedback-verified.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as db from './client';

afterEach(() => db.__setSupabaseForTest(null));

const AGENT = 'AGENT111';
const PAYER = 'PAYER111';

const FEEDBACK = [
  // genuine: PAYER paid AGENT in sig-ok
  { agent_wallet: AGENT, consumer_wallet: PAYER, rating: 'delivered', tx_signature: 'sig-ok', created_at: '2026-11-01T00:00:00Z' },
  // forged: sig-other paid someone else
  { agent_wallet: AGENT, consumer_wallet: PAYER, rating: 'delivered', tx_signature: 'sig-other', created_at: '2026-11-02T00:00:00Z' },
  // demo seeder: synthetic consumer on the agent's own outgoing tx
  { agent_wallet: AGENT, consumer_wallet: 'demo-counterparty-x', rating: 'failed', tx_signature: 'sig-own', created_at: '2026-11-03T00:00:00Z' },
  // tx unknown to us
  { agent_wallet: AGENT, consumer_wallet: PAYER, rating: 'failed', tx_signature: 'sig-missing', created_at: '2026-11-04T00:00:00Z' },
  // same payer, second genuine paid tx — counts once in summaries (older, so sig-ok's rating wins)
  { agent_wallet: AGENT, consumer_wallet: PAYER, rating: 'failed', tx_signature: 'sig-ok-2', created_at: '2026-10-01T00:00:00Z' },
];
const TXS = [
  { tx_signature: 'sig-ok', wallet_address: PAYER, counterparty: AGENT },
  { tx_signature: 'sig-ok-2', wallet_address: PAYER, counterparty: AGENT },
  { tx_signature: 'sig-other', wallet_address: PAYER, counterparty: 'ELSEWHERE' },
  { tx_signature: 'sig-own', wallet_address: AGENT, counterparty: 'VENDOR' },
];

function fakeDb() {
  db.__setSupabaseForTest({ from(table: string) {
    const state: { inCol?: string; inVals?: unknown[] } = {};
    const rows = () => {
      const base = table === 'feedback' ? FEEDBACK : table === 'transactions' ? TXS : [];
      if (!state.inCol) return base;
      return base.filter((r) => state.inVals!.includes((r as Record<string, unknown>)[state.inCol!]));
    };
    const builder: Record<string, unknown> = {
      select: () => builder, eq: () => builder, order: () => builder, limit: () => builder,
      in: (col: string, vals: unknown[]) => { state.inCol = col; state.inVals = vals; return builder; },
      then: (resolve: (v: unknown) => void) => Promise.resolve(resolve({ data: rows(), error: null })),
    };
    return builder;
  } });
}

describe('payee-verified feedback reads', () => {
  test('getFeedbackSummary counts only verified rows', async () => {
    fakeDb();
    expect(await db.getFeedbackSummary(AGENT)).toEqual({ total: 1, delivered: 1, failed: 0, deliveryRate: 1 });
  });

  test('getFeedbackSummariesForWallets counts only verified rows', async () => {
    fakeDb();
    const m = await db.getFeedbackSummariesForWallets([AGENT]);
    expect(m.get(AGENT)).toEqual({ total: 1, delivered: 1, failed: 0, deliveryRate: 1 });
  });

  test('getFeedbackForAgent lists only verified rows', async () => {
    fakeDb();
    // Listing shows every verified receipt; only summaries collapse per payer.
    expect((await db.getFeedbackForAgent(AGENT)).map((r) => r.tx_signature)).toEqual(['sig-ok', 'sig-ok-2']);
  });

  test('getFeedbackRatingsForSignatures returns only verified ratings', async () => {
    fakeDb();
    const m = await db.getFeedbackRatingsForSignatures(['sig-ok', 'sig-ok-2', 'sig-other', 'sig-own']);
    expect([...m.keys()].sort()).toEqual(['sig-ok', 'sig-ok-2']);
  });
});
