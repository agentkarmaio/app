import { describe, expect, test } from 'bun:test';

import { calculateScore } from './index';
import { applyAgentBond, deriveAgentBondInput, type AgentBondEventLite } from './agent-bond';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 18);
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function ev(daysAgo: number, kind: AgentBondEventLite['kind'], bonded: number, unbonding = 0, amount = 0, agentId = 1): AgentBondEventLite {
  return { agentId, kind, ledgerClosedAt: iso(daysAgo), bonded, unbonding, amount };
}

function txs(wallet: string, n: number, cps: number, days: number, amt: number, fail = 0) {
  return Array.from({ length: n }, (_, i) => ({
    wallet_address: wallet, facilitator: 'f', amount: amt,
    timestamp: new Date(Date.now() - days * DAY + (i / Math.max(1, n - 1)) * (days * DAY - DAY / 24)),
    success: i >= fail, tx_signature: `${wallet}-${i}`, counterparty: `cp${i % cps}`,
  }));
}

const input = (countedUsdc: number, slash?: { last: number; before: number }) => ({
  chain: 'stellar-testnet' as const,
  countedUsdc,
  slashedEver: !!slash,
  lastSlashUsdc: slash?.last ?? 0,
  stakeBeforeLastSlash: slash?.before ?? 0,
});

describe('deriveAgentBondInput (seasoning = min balance over trailing 30 days)', () => {
  test('a bond held all window counts in full', () => {
    expect(deriveAgentBondInput('stellar-testnet', [ev(40, 'deposited', 500)], NOW).countedUsdc).toBe(500);
  });

  test('fresh money counts zero for 30 days', () => {
    expect(deriveAgentBondInput('stellar-testnet', [ev(5, 'deposited', 1_000_000)], NOW).countedUsdc).toBe(0);
  });

  test('1 USDC then top-up counts only the 1 USDC', () => {
    const r = deriveAgentBondInput('stellar-testnet', [ev(40, 'deposited', 1), ev(2, 'deposited', 10_000)], NOW);
    expect(r.countedUsdc).toBe(1);
  });

  test('requesting unbond lowers the count at once', () => {
    const r = deriveAgentBondInput('stellar-testnet', [ev(40, 'deposited', 1000), ev(1, 'unbond_requested', 200, 800, 800)], NOW);
    expect(r.countedUsdc).toBe(200);
  });

  test('sums across agent ids owned by the wallet', () => {
    const r = deriveAgentBondInput('stellar-testnet', [ev(40, 'deposited', 100, 0, 0, 1), ev(40, 'deposited', 50, 0, 0, 2)], NOW);
    expect(r.countedUsdc).toBe(150);
  });

  test('records the last slash and the stake before it', () => {
    const r = deriveAgentBondInput('stellar-testnet', [ev(40, 'deposited', 500), ev(3, 'slashed', 250, 0, 250)], NOW);
    expect(r.slashedEver).toBe(true);
    expect(r.lastSlashUsdc).toBe(250);
    expect(r.stakeBeforeLastSlash).toBe(500);
  });
});

describe('applyAgentBond', () => {
  test('headroom-scaled lift, capped at 10k USDC', () => {
    const a = applyAgentBond(57.64, input(1_000_000));
    expect(a.effect?.strength).toBe(1);
    expect(a.score).toBeCloseTo(61.88, 2);
    expect(applyAgentBond(57.64, input(10_000)).score).toBeCloseTo(a.score, 6);
  });

  test('never what makes an agent Excellent', () => {
    expect(applyAgentBond(88.99, input(10_000)).score).toBe(90);
    // Already-earned Excellent still gets its small lift.
    expect(applyAgentBond(95.49, input(500)).score).toBeCloseTo(95.79, 2);
  });

  test('a slash zeroes the lift and costs up to 25 points', () => {
    const r = applyAgentBond(95.49, input(250, { last: 250, before: 500 }));
    expect(r.effect?.strength).toBe(0);
    expect(r.effect?.penalty).toBe(12.5);
    expect(r.score).toBeCloseTo(82.99, 2);
    // Any slash costs at least half the max penalty.
    expect(applyAgentBond(80, input(0, { last: 1, before: 10_000 })).effect?.penalty).toBe(12.5);
    expect(applyAgentBond(10, input(0, { last: 100, before: 100 })).score).toBe(0);
  });

  test('no-op off stellar-testnet', () => {
    const r = applyAgentBond(50, { ...input(10_000), chain: 'stellar' });
    expect(r.score).toBe(50);
    expect(r.effect).toBeNull();
  });
});

describe('calculateScore with an agent bond (PLAN.md §6.4)', () => {
  const run = (t: ReturnType<typeof txs>, fb: number | undefined, fbN: number | undefined, paysh: number, bond: ReturnType<typeof input> | null) =>
    calculateScore(t as never, 0, fb, fbN, null, null, paysh, [], bond);

  test('thin agent with a 1M bond: numeric lift, ceiling holds at Fair, badge unchanged', () => {
    const t = txs('A', 12, 2, 60, 0.05);
    const before = run(t, undefined, undefined, 0, null);
    const after = run(t, undefined, undefined, 0, input(1_000_000));
    expect(after.providerScore).toBeCloseTo(before.providerScore + 0.1 * (100 - before.providerScore), 1);
    expect(after.trustTier).toBe('Fair');
    expect(after.confidenceBadge).toBe(before.confidenceBadge);
    expect(after.tierAggregates.tier1).toBe(before.tierAggregates.tier1);
    expect(after.agentBond?.lift).toBeGreaterThan(0);
  });

  test('thick + strong agent near 90 does not cross into Excellent on the bond', () => {
    const t = txs('D', 220, 11, 35, 5, 120);
    const before = run(t, 1, 12, 3, null);
    expect(before.trustTier).toBe('Very Good');
    const after = run(t, 1, 12, 3, input(10_000));
    expect(after.providerScore).toBeLessThanOrEqual(90);
    expect(after.trustTier).toBe('Very Good');
  });

  test('slash drops an Excellent agent a tier', () => {
    const t = txs('C', 300, 15, 120, 5, 6);
    const before = run(t, 0.95, 20, 3, null);
    expect(before.trustTier).toBe('Excellent');
    const after = run(t, 0.95, 20, 3, input(250, { last: 250, before: 500 }));
    expect(after.trustTier).toBe('Very Good');
  });

  test('consumer face is untouched', () => {
    const t = txs('B', 80, 5, 45, 2, 3);
    expect(run(t, 0.9, 6, 0, input(10_000)).consumerScore).toBe(run(t, 0.9, 6, 0, null).consumerScore);
  });
});
