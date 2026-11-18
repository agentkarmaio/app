import { describe, expect, test } from 'bun:test';

import { calculateScore } from './index';
import { applyAgentBond, seasonedBalance, slashFields, slashFieldsWithFallback } from './agent-bond';

const DAY = 86_400_000;
function txs(wallet: string, n: number, cps: number, days: number, amt: number, fail = 0) {
  return Array.from({ length: n }, (_, i) => ({
    wallet_address: wallet, facilitator: 'f', amount: amt,
    timestamp: new Date(Date.now() - days * DAY + (i / Math.max(1, n - 1)) * (days * DAY - DAY / 24)),
    success: i >= fail, tx_signature: `${wallet}-${i}`, counterparty: `cp${i % cps}`,
  }));
}

const S = 10_000_000n; // stroops per USDC
const input = (countedUsdc: number, slash?: { last: number; before: number }) => ({
  chain: 'stellar-testnet' as const,
  countedStroops: BigInt(countedUsdc) * S,
  slashedEver: !!slash,
  lastSlashStroops: BigInt(slash?.last ?? 0) * S,
  stakeBeforeLastSlashStroops: BigInt(slash?.before ?? 0) * S,
});

describe('seasonedBalance (min balance over the trailing 30 days, in stroops)', () => {
  test('a bond held all window counts in full', () => expect(seasonedBalance(500n * S, [])).toBe(500n * S));
  test('fresh money counts zero for 30 days', () => expect(seasonedBalance(0n, [1_000_000n * S])).toBe(0n));
  test('1 USDC then top-up counts only the 1 USDC', () => expect(seasonedBalance(S, [10_000n * S])).toBe(S));
  test('requesting unbond lowers the count at once', () => expect(seasonedBalance(1000n * S, [200n * S])).toBe(200n * S));
  test('the current (reconciled) balance caps the count when window events were lost', () => {
    // 1000 held at window start, no events left in the window, but chain says 100 now.
    expect(seasonedBalance(1000n * S, [100n * S])).toBe(100n * S);
  });
  test('stays exact beyond float precision', () => {
    const big = 2n ** 53n + 1n; // not representable as a JS number
    expect(seasonedBalance(big, [big + 1n])).toBe(big);
  });
});

describe('slashFields', () => {
  test('records the last slash and the stake before it, in stroops', () => {
    expect(slashFields({ amount: 250n * S, bonded: 250n * S, unbonding: 0n }))
      .toEqual({ slashedEver: true, lastSlashStroops: 250n * S, stakeBeforeLastSlashStroops: 500n * S });
    expect(slashFields(undefined)).toEqual({ slashedEver: false, lastSlashStroops: 0n, stakeBeforeLastSlashStroops: 0n });
  });
  test('1 stroop over a huge stake still reads as the minimum severity', () => {
    const r = applyAgentBond(80, { chain: 'stellar-testnet', countedStroops: 0n, slashedEver: true,
      lastSlashStroops: 1n, stakeBeforeLastSlashStroops: 2n ** 70n });
    expect(r.effect?.penalty).toBe(12.5);
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

describe('slashFieldsWithFallback (slash events lost to RPC retention)', () => {
  test('uses the last slash event when there is one', () => {
    expect(slashFieldsWithFallback({ amount: 250n * S, bonded: 250n * S, unbonding: 0n }, [])).toEqual(slashFields({ amount: 250n * S, bonded: 250n * S, unbonding: 0n }));
  });
  test('falls back to the contract slashed_total when no slash event survived', () => {
    // Severity is unknown, so it is taken as maximal: the owner cannot dilute it by topping up.
    const r = slashFieldsWithFallback(undefined, [{ bonded: 250n * S, unbonding: 0n, slashedTotal: 250n * S }]);
    expect(r).toEqual({ slashedEver: true, lastSlashStroops: 250n * S, stakeBeforeLastSlashStroops: 250n * S });
    const topped = slashFieldsWithFallback(undefined, [{ bonded: 1_000_000n * S, unbonding: 0n, slashedTotal: S }]);
    expect(applyAgentBond(80, { chain: 'stellar-testnet', countedStroops: 0n, ...topped }).effect?.penalty).toBe(25);
  });
  test('no slash anywhere means no penalty', () => {
    expect(slashFieldsWithFallback(undefined, [{ bonded: S, unbonding: 0n, slashedTotal: 0n }]).slashedEver).toBe(false);
  });
});
