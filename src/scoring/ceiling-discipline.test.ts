/// <reference types="bun-types" />
/**
 * CEILING DISCIPLINE tests — the invariant-critical proof.
 *
 * docs/BONDING-AND-SUCCESSION-DESIGN.md §4.3 / CLAUDE.md architectural invariant:
 * a bond or a declared/executed will lifts the CONFIDENCE BADGE + Tier-presence
 * ONLY. It MUST NOT raise the evidence-gated trust-tier ceiling. A thin-file
 * agent must never reach a high trust tier on borrowed capital (a bond) or a
 * flashy will. Enforced in evidenceGatedTier via TierEvidence.borrowedTier1Only.
 *
 * Also covers the new signal-event builders' tier/face/value contracts.
 */

import { describe, expect, test } from 'bun:test';
import {
  evidenceGatedTier,
  getConfidenceBadge,
  type TierEvidence,
} from './index';
import {
  SIGNAL_KINDS,
  PRESENCE_ONLY_KINDS,
  buildWillDeclaredSignal,
  buildHeartbeatObservedSignal,
  buildHeartbeatLapsedSignal,
  buildInheritanceExecutedSignal,
  buildWillRevokedSignal,
  buildBondOpenedSignal,
  buildBondResolvedSignal,
} from './signals';

// A genuinely thin-file agent: a handful of txs, one counterparty, brand new.
const THIN: Omit<TierEvidence, 'hasTier1Receipts' | 'tier1Strong' | 'borrowedTier1Only'> = {
  txCount: 5,
  counterparties: 1,
  daysActive: 2,
};

describe('ceiling discipline — borrowed Tier-1 cannot lift the ceiling', () => {
  test('thin agent with a BOND (borrowed Tier-1) cannot reach Excellent', () => {
    // High numeric score (would map to Excellent), strong borrowed Tier-1.
    const tier = evidenceGatedTier(95, {
      ...THIN,
      hasTier1Receipts: true,
      tier1Strong: true,
      borrowedTier1Only: true,
    });
    // Thin behavior + receipt axis collapsed to "none" → ceiling 'Fair'.
    expect(tier).toBe('Fair');
  });

  test('thin agent with a WILL (declared/executed) cannot reach Very Good', () => {
    const tier = evidenceGatedTier(92, {
      ...THIN,
      hasTier1Receipts: true,
      tier1Strong: true,
      borrowedTier1Only: true,
    });
    expect(tier).not.toBe('Excellent');
    expect(tier).not.toBe('Very Good');
    expect(tier).toBe('Fair');
  });

  test('borrowed Tier-1 is strictly weaker than EARNED Tier-1 for the same thin agent', () => {
    const borrowed = evidenceGatedTier(95, {
      ...THIN, hasTier1Receipts: true, tier1Strong: true, borrowedTier1Only: true,
    });
    const earned = evidenceGatedTier(95, {
      ...THIN, hasTier1Receipts: true, tier1Strong: true, borrowedTier1Only: false,
    });
    // Earned Tier-1 lifts the thin ceiling to 'Very Good'; borrowed stays 'Fair'.
    expect(earned).toBe('Very Good');
    expect(borrowed).toBe('Fair');
  });

  test('a THICK agent with earned receipts CAN reach Excellent (control)', () => {
    const tier = evidenceGatedTier(95, {
      txCount: 500, counterparties: 20, daysActive: 120,
      hasTier1Receipts: true, tier1Strong: true, borrowedTier1Only: false,
    });
    expect(tier).toBe('Excellent');
  });

  test('borrowed flag is irrelevant once the agent is thick (behavior carries it)', () => {
    // A thick agent whose ONLY Tier-1 is a bond still gets a high ceiling from
    // behavioral thickness alone — the bond just didn't ADD to it.
    const tier = evidenceGatedTier(95, {
      txCount: 500, counterparties: 20, daysActive: 120,
      hasTier1Receipts: true, tier1Strong: true, borrowedTier1Only: true,
    });
    // thick × receipt-none ceiling = 'Very Good'. Not Excellent (no earned T1).
    expect(tier).toBe('Very Good');
  });
});

describe('confidence badge — Tier-presence rules (invariant #4)', () => {
  test('will_declared is Tier 3 → badge STAYS declared (⚪) alone, never lifts', () => {
    // A wallet whose ONLY signal is will_declared has tier3 present, tier1/tier2
    // absent. CARDINAL: Tier-3 (declared identity/intent) is NOT behavioral
    // evidence — it must stay ⚪ 'declared', not 🟡.
    const badge = getConfidenceBadge({ tier1: null, tier2: null, tier3: 0.5, tier4: null });
    expect(badge).toBe('declared');
    expect(badge).not.toBe('behavior-inferred');
    expect(badge).not.toBe('receipt-backed');
  });

  test('🟡 behavior-inferred REQUIRES Tier-2 presence', () => {
    // Tier-2 present (behavioral evidence), no Tier-1 → 🟡, never ⚪.
    const badge = getConfidenceBadge({ tier1: null, tier2: 0.4, tier3: null, tier4: null });
    expect(badge).toBe('behavior-inferred');
    // Adding Tier-3 declared identity on top does not change the 🟡 (still no T1).
    const withT3 = getConfidenceBadge({ tier1: null, tier2: 0.4, tier3: 0.5, tier4: null });
    expect(withT3).toBe('behavior-inferred');
  });

  test('a wallet with NO tiers at all is declared (⚪)', () => {
    const badge = getConfidenceBadge({ tier1: null, tier2: null, tier3: null, tier4: null });
    expect(badge).toBe('declared');
  });

  test('🟢 receipt-backed REQUIRES Tier-1; a bond (Tier 1) lifts the badge (presence allowed)', () => {
    const badge = getConfidenceBadge({ tier1: 0.85, tier2: null, tier3: null, tier4: null });
    expect(badge).toBe('receipt-backed');
  });
});

describe('signal builders — tier / face / value contracts', () => {
  test('will_declared: Tier 3, provider, declared-floor value', () => {
    const s = buildWillDeclaredSignal('wallet1', { sourceType: 'claim_form', intervalSeconds: 604800 });
    expect(s.kind).toBe(SIGNAL_KINDS.WILL_DECLARED);
    expect(s.tier).toBe(3);
    expect(s.face).toBe('provider');
    expect(s.value).toBe(0.5);
  });

  test('heartbeat_observed: Tier 2, provider, clamped strength', () => {
    const s = buildHeartbeatObservedSignal('w', { strength: 1.5, lastHeartbeatAt: new Date(), intervalSeconds: 3600 });
    expect(s.tier).toBe(2);
    expect(s.face).toBe('provider');
    expect(s.value).toBe(1); // clamped
  });

  test('heartbeat_lapsed: Tier 2 (bounded negative — never Tier 1)', () => {
    const s = buildHeartbeatLapsedSignal('w', { haircut: 0.4, lapsedAt: new Date(), intervalSeconds: 3600 });
    expect(s.tier).toBe(2);
    expect(s.face).toBe('provider');
  });

  test('inheritance_executed: Tier 1, provider, per-event tx_ref', () => {
    const s = buildInheritanceExecutedSignal('w', { txHash: '0xabc', heirCount: 2 });
    expect(s.tier).toBe(1);
    expect(s.value).toBe(1.0);
    expect(s.txRef).toBe('0xabc');
  });

  test('will_revoked: Tier 1, provider, positive', () => {
    const s = buildWillRevokedSignal('w', { txHash: '0xdef' });
    expect(s.tier).toBe(1);
    expect(s.value).toBe(1.0);
  });

  test('bond_opened: Tier 1, provider, ramp × amount, idempotent tx_ref', () => {
    const one = buildBondOpenedSignal('w', { bondId: 'b1', txHash: '0x1', underwriterCount: 1, bondedUsdc: 10000 });
    const three = buildBondOpenedSignal('w', { bondId: 'b1', txHash: '0x1', underwriterCount: 3, bondedUsdc: 10000 });
    expect(one.tier).toBe(1);
    expect(one.txRef).toBe('b1:0x1');
    // More underwriters at the same amount → strictly stronger.
    expect(three.value!).toBeGreaterThan(one.value!);
  });

  test('bond_resolved: success=1.0, failure=0.0, Tier 1', () => {
    const ok = buildBondResolvedSignal('w', { bondId: 'b', txHash: '0x', outcome: 'success', bondedUsdc: 100 });
    const bad = buildBondResolvedSignal('w', { bondId: 'b', txHash: '0x', outcome: 'failure', bondedUsdc: 100 });
    expect(ok.value).toBe(1.0);
    expect(bad.value).toBe(0.0);
    expect(ok.tier).toBe(1);
  });

  test('PRESENCE_ONLY_KINDS gate: all borrowed-capital kinds are members; heartbeat is NOT', () => {
    expect(PRESENCE_ONLY_KINDS.has(SIGNAL_KINDS.BOND_OPENED)).toBe(true);
    expect(PRESENCE_ONLY_KINDS.has(SIGNAL_KINDS.BOND_RESOLVED)).toBe(true);
    expect(PRESENCE_ONLY_KINDS.has(SIGNAL_KINDS.WILL_DECLARED)).toBe(true);
    expect(PRESENCE_ONLY_KINDS.has(SIGNAL_KINDS.INHERITANCE_EXECUTED)).toBe(true);
    expect(PRESENCE_ONLY_KINDS.has(SIGNAL_KINDS.WILL_REVOKED)).toBe(true);
    // heartbeat_observed is EARNED behavior (the agent's own txs), not borrowed.
    expect(PRESENCE_ONLY_KINDS.has(SIGNAL_KINDS.HEARTBEAT_OBSERVED)).toBe(false);
  });
});
