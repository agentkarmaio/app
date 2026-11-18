/**
 * Agent Bond (slashable self-stake) as a bounded Provider-face factor.
 * Design: web/docs/bond/PLAN.md §6, RFC v0.3.4-draft §16.4.
 *
 * Cardinal rules, enforced here and by callers:
 *  - the bond NEVER touches tier1, the confidence badge or the evidence-gated
 *    ceiling; it only moves the numeric Provider score;
 *  - no bond-only karma (calculateScore needs a transaction to exist);
 *  - stellar-testnet only: testnet USDC is free, so a leak into any other chain
 *    would let anyone mint karma;
 *  - it is never what pushes a score past 90 (Excellent).
 */
import type { Chain } from '@/db/schema';

export const AGENT_BOND_SCORING_CHAIN: Chain = 'stellar-testnet';
/** Log-scale cap: 10k USDC reaches full strength. */
export const AGENT_BOND_CAP_USDC = 10_000;
/** USDC on Stellar has 7 decimals. */
export const STROOPS_PER_USDC = 10_000_000n;
/** Lift is at most this share of the distance to 100. */
export const AGENT_BOND_WEIGHT = 0.10;
/** Only the minimum balance held over this window counts. */
export const AGENT_BOND_SEASON_DAYS = 30;
export const AGENT_BOND_SLASH_MAX_POINTS = 25;
export const AGENT_BOND_SLASH_MIN_SEVERITY = 0.5;
/** The Excellent threshold (getTrustTier: >90 is Excellent). */
const EXCELLENT_FLOOR = 90;

export interface AgentBondInput {
  chain: Chain;
  /** Sum over the wallet's bonds of the min bonded balance in the window, in stroops. */
  countedStroops: bigint;
  slashedEver: boolean;
  lastSlashStroops: bigint;
  /** bonded + unbonding just before the last slash, in stroops. */
  stakeBeforeLastSlashStroops: bigint;
}

export interface AgentBondEffect {
  strength: number;
  lift: number;
  penalty: number;
}

/** Post-state of one bond event, in stroops (7 decimals). */
export interface AgentBondAmounts {
  bonded: bigint;
  unbonding: bigint;
  amount: bigint;
}

export const DAY_MS = 86_400_000;
/**
 * Above this many events inside the window for one bond, the lift fails closed
 * to 0. Kept below PostgREST's max_rows (1000 by default) so `limit(CAP + 1)`
 * is never silently truncated by the server, which would defeat the check.
 */
export const AGENT_BOND_WINDOW_EVENT_CAP = 500;

/** Min of the balance at the window start and every post-event balance inside it (stroops, exact). */
export function seasonedBalance(atStartBonded: bigint, inWindowBonded: bigint[]): bigint {
  let min = atStartBonded;
  for (const b of inWindowBonded) if (b < min) min = b;
  return min > 0n ? min : 0n;
}

export function slashFields(last: AgentBondAmounts | undefined):
  Pick<AgentBondInput, 'slashedEver' | 'lastSlashStroops' | 'stakeBeforeLastSlashStroops'> {
  return {
    slashedEver: last !== undefined,
    lastSlashStroops: last?.amount ?? 0n,
    stakeBeforeLastSlashStroops: last ? last.bonded + last.unbonding + last.amount : 0n,
  };
}

/** Pure. Returns the adjusted Provider score and the effect, or a no-op off-chain. */
export function applyAgentBond(
  score: number,
  input: AgentBondInput | null | undefined,
): { score: number; effect: AgentBondEffect | null } {
  if (!input || input.chain !== AGENT_BOND_SCORING_CHAIN) return { score, effect: null };

  // Amounts stay exact stroops until here; the only float step is the log.
  const capStroops = BigInt(AGENT_BOND_CAP_USDC) * STROOPS_PER_USDC;
  const counted = input.countedStroops > capStroops ? capStroops : input.countedStroops > 0n ? input.countedStroops : 0n;
  const countedUsdc = Number(counted) / Number(STROOPS_PER_USDC);
  const size = Math.min(1, Math.log10(1 + countedUsdc) / Math.log10(1 + AGENT_BOND_CAP_USDC));
  const strength = input.slashedEver ? 0 : size;
  const lift = AGENT_BOND_WEIGHT * strength * (100 - score);
  // Slash ratio in basis points, computed on integers.
  const ratio = input.stakeBeforeLastSlashStroops > 0n
    ? Number((input.lastSlashStroops * 10_000n) / input.stakeBeforeLastSlashStroops) / 10_000
    : 1;
  const severity = input.slashedEver
    ? Math.max(AGENT_BOND_SLASH_MIN_SEVERITY, Math.min(1, ratio))
    : 0;
  const penalty = AGENT_BOND_SLASH_MAX_POINTS * severity;

  let adjusted = Math.max(0, Math.min(100, score + lift - penalty));
  if (score <= EXCELLENT_FLOOR) adjusted = Math.min(adjusted, EXCELLENT_FLOOR);
  const round2 = (x: number) => Math.round(x * 100) / 100;
  return {
    score: round2(adjusted),
    effect: { strength: Math.round(strength * 1000) / 1000, lift: round2(lift), penalty: round2(penalty) },
  };
}

/**
 * Slash fields when slash EVENTS may have been lost to RPC retention: prefer the
 * last slash event; otherwise fall back to the contract's slashed_total (kept on
 * agent_bonds, restored by reconcile). With the event gone the severity is
 * unknown, so it is taken as MAXIMAL: deriving it from live balances would let
 * the owner dilute the penalty by topping up. A lost event never erases or
 * softens a penalty.
 */
export function slashFieldsWithFallback(
  lastSlashEvent: AgentBondAmounts | undefined,
  bonds: { bonded: bigint; unbonding: bigint; slashedTotal: bigint }[],
): Pick<AgentBondInput, 'slashedEver' | 'lastSlashStroops' | 'stakeBeforeLastSlashStroops'> {
  if (lastSlashEvent) return slashFields(lastSlashEvent);
  const slashed = bonds.filter((b) => b.slashedTotal > 0n);
  if (slashed.length === 0) return slashFields(undefined);
  const total = slashed.reduce((a, b) => a + b.slashedTotal, 0n);
  return { slashedEver: true, lastSlashStroops: total, stakeBeforeLastSlashStroops: total };
}
