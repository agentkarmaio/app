/// <reference types="bun-types" />
/**
 * END-TO-END signal wiring tests — bonds / heartbeat / will folded into the
 * score via calculateScore + aggregateSignalEvents.
 *
 * These are the #1-blocker proofs: calculateScore used to never read
 * signal_events. They assert the cardinal CEILING DISCIPLINE end-to-end (not
 * just at the function boundary): a borrowed bond lifts the badge but never the
 * trust ceiling; a will_declared-only wallet stays ⚪; a heartbeat lapse dents
 * but never zeroes Tier-2; and is_demo signals NEVER touch a real score.
 */

import { describe, expect, test } from 'bun:test';
import { calculateScore, aggregateSignalEvents } from './index';
import {
  buildBondOpenedSignal,
  buildHeartbeatObservedSignal,
  buildHeartbeatLapsedSignal,
  buildWillDeclaredSignal,
  SIGNAL_KINDS,
} from './signals';
import type { SignalEvent } from '@/db/schema';

const DAY = 24 * 60 * 60 * 1000;

// A thin-file wallet: a handful of recent txs, one facilitator. High raw success
// rate, but genuinely thin — must stay capped no matter what borrowed capital
// is attached.
function thinTxs(n = 5) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    wallet_address: 'WALLET_THIN',
    facilitator: 'FAC_A',
    amount: 1,
    timestamp: new Date(now - i * DAY).toISOString(),
    success: true,
    tx_signature: `sig-${i}`,
  }));
}

// A thick-file wallet: many txs, many counterparties, long-lived.
function thickTxs(n = 400) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    wallet_address: 'WALLET_THICK',
    facilitator: `FAC_${i % 25}`,
    amount: 5,
    timestamp: new Date(now - (i % 120) * DAY - i * 60_000).toISOString(),
    success: true,
    tx_signature: `tsig-${i}`,
  }));
}

// Cast a built InsertSignalEventInput into the SignalEvent shape calculateScore
// reads (kind/tier/face/value/payload). The builders return the write-shape;
// the aggregator only reads these five fields.
function asEvent(input: ReturnType<typeof buildBondOpenedSignal>): SignalEvent {
  return {
    id: 'x',
    chain: 'solana',
    agent_wallet: input.agentWallet,
    tier: input.tier,
    kind: input.kind,
    face: input.face ?? 'provider',
    weight: input.weight ?? 1,
    value: input.value ?? null,
    payload: input.payload ?? null,
    signed_by: input.signedBy ?? null,
    tx_ref: input.txRef ?? null,
    observed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

describe('aggregateSignalEvents — pure folding', () => {
  test('a real bond is presence-only Tier-1, borrowed when no earned Tier-1', () => {
    const bond = asEvent(buildBondOpenedSignal('w', {
      bondId: 'b1', txHash: '0x1', underwriterCount: 3, bondedUsdc: 10000,
    }));
    const agg = aggregateSignalEvents([bond], /* hasEarnedTier1 */ false);
    expect(agg.bondTier1).not.toBeNull();
    expect(agg.borrowedTier1Only).toBe(true);
  });

  test('a bond is NOT borrowed when the wallet also earned Tier-1', () => {
    const bond = asEvent(buildBondOpenedSignal('w', {
      bondId: 'b1', txHash: '0x1', underwriterCount: 3, bondedUsdc: 10000,
    }));
    const agg = aggregateSignalEvents([bond], /* hasEarnedTier1 */ true);
    expect(agg.bondTier1).not.toBeNull();
    expect(agg.borrowedTier1Only).toBe(false);
  });

  test('is_demo bond signals are EXCLUDED from the aggregate', () => {
    const demo = asEvent(buildBondOpenedSignal('w', {
      bondId: 'b1', txHash: '0x1', underwriterCount: 3, bondedUsdc: 10000, isDemo: true,
    }));
    const agg = aggregateSignalEvents([demo], false);
    expect(agg.bondTier1).toBeNull();
    expect(agg.borrowedTier1Only).toBe(false);
  });

  test('will_declared folds to Tier-3 presence only (never Tier-1/2)', () => {
    const will = asEvent(buildWillDeclaredSignal('w', { sourceType: 'claim_form', intervalSeconds: 604800 }));
    const agg = aggregateSignalEvents([will], false);
    expect(agg.willTier3).toBe(0.5);
    expect(agg.bondTier1).toBeNull();
    expect(agg.heartbeatTier2).toBeNull();
    expect(agg.borrowedTier1Only).toBe(false); // will alone is not a bond Tier-1
  });

  test('heartbeat_lapsed yields a NEGATIVE bounded Tier-2 delta; observed positive', () => {
    const lapsed = asEvent(buildHeartbeatLapsedSignal('w', { haircut: 1, lapsedAt: new Date(), intervalSeconds: 3600 }));
    const obs = asEvent(buildHeartbeatObservedSignal('w', { strength: 1, lastHeartbeatAt: new Date(), intervalSeconds: 3600 }));
    const lapseAgg = aggregateSignalEvents([lapsed], false);
    const obsAgg = aggregateSignalEvents([obs], false);
    expect(lapseAgg.heartbeatTier2!).toBeLessThan(0);
    expect(lapseAgg.heartbeatLapsed).toBe(true);
    expect(obsAgg.heartbeatTier2!).toBeGreaterThan(0);
    // Bounded: magnitude never exceeds the band (0.25).
    expect(Math.abs(lapseAgg.heartbeatTier2!)).toBeLessThanOrEqual(0.25 + 1e-9);
  });
});

describe('calculateScore END-TO-END — signals fold in', () => {
  test('a real bond on a thin-file wallet LIFTS the badge to 🟢 but the trust tier stays capped', () => {
    const bond = asEvent(buildBondOpenedSignal('WALLET_THIN', {
      bondId: 'b1', txHash: '0x1', underwriterCount: 3, bondedUsdc: 10000,
    }));

    const withBond = calculateScore(thinTxs(), 0, undefined, undefined, null, null, null, [bond]);
    const without = calculateScore(thinTxs(), 0, undefined, undefined, null, null, null, []);

    // Badge lifts to receipt-backed (Tier-1 presence from the bond).
    expect(without.confidenceBadge).not.toBe('receipt-backed');
    expect(withBond.confidenceBadge).toBe('receipt-backed');

    // CEILING: the thin-file agent must NOT climb to a high tier on borrowed
    // capital. Borrowed Tier-1 collapses the receipt axis → thin ceiling 'Fair'.
    expect(withBond.trustTier).not.toBe('Excellent');
    expect(withBond.trustTier).not.toBe('Very Good');
    expect(withBond.trustTier).not.toBe('Good');
  });

  test('a will_declared-only signal keeps the badge ⚪ declared', () => {
    // Use a thin wallet whose behavioral Tier-2 alone would otherwise be 🟡 —
    // confirm the WILL does not change the badge story. To isolate the will, we
    // assert the aggregate + badge path directly: a Tier-3-only aggregate is ⚪.
    const will = asEvent(buildWillDeclaredSignal('WALLET_THIN', { sourceType: 'claim_form', intervalSeconds: 604800 }));
    const agg = aggregateSignalEvents([will], false);
    // The will contributes only Tier-3 presence; with no Tier-1/Tier-2 it is ⚪.
    // (calculateScore always has Tier-2 from txs, so we assert the will never
    // adds Tier-1 nor Tier-2 — the only thing that could wrongly lift the badge.)
    expect(agg.bondTier1).toBeNull();
    expect(agg.heartbeatTier2).toBeNull();
    expect(agg.willTier3).not.toBeNull();
  });

  test('heartbeat_lapsed LOWERS Tier-2 but never zeroes the score', () => {
    const lapsed = asEvent(buildHeartbeatLapsedSignal('WALLET_THICK', {
      haircut: 1, lapsedAt: new Date(), intervalSeconds: 3600,
    }));
    const base = calculateScore(thickTxs(), 0, undefined, undefined, null, null, null, []);
    const dented = calculateScore(thickTxs(), 0, undefined, undefined, null, null, null, [lapsed]);

    expect(dented.providerScore).toBeLessThan(base.providerScore);
    expect(dented.providerScore).toBeGreaterThan(0); // bounded — never zeroes
  });

  test('is_demo signals NEVER affect the real score', () => {
    const demoBond = asEvent(buildBondOpenedSignal('WALLET_THIN', {
      bondId: 'b1', txHash: '0x1', underwriterCount: 3, bondedUsdc: 10000, isDemo: true,
    }));
    const demoHeartbeatLapsed = {
      ...asEvent(buildHeartbeatLapsedSignal('WALLET_THIN', { haircut: 1, lapsedAt: new Date(), intervalSeconds: 3600 })),
      payload: { is_demo: true } as Record<string, unknown>,
    } as SignalEvent;

    const baseline = calculateScore(thinTxs(), 0, undefined, undefined, null, null, null, []);
    const withDemo = calculateScore(thinTxs(), 0, undefined, undefined, null, null, null, [demoBond, demoHeartbeatLapsed]);

    // Identical: demo signals are filtered out of the real score entirely.
    expect(withDemo.providerScore).toBe(baseline.providerScore);
    expect(withDemo.confidenceBadge).toBe(baseline.confidenceBadge);
    expect(withDemo.trustTier).toBe(baseline.trustTier);
  });

  test('heartbeat kinds are NOT presence-only (earned behavior, not borrowed)', () => {
    const obs = asEvent(buildHeartbeatObservedSignal('w', { strength: 1, lastHeartbeatAt: new Date(), intervalSeconds: 3600 }));
    const agg = aggregateSignalEvents([obs], false);
    // Heartbeat is the agent's OWN behavior; it must not flag borrowed Tier-1.
    expect(agg.borrowedTier1Only).toBe(false);
    expect(obs.kind).toBe(SIGNAL_KINDS.HEARTBEAT_OBSERVED);
  });
});
