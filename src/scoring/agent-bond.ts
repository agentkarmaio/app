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
  /** Sum over the wallet's bonds of the min bonded balance in the window. */
  countedUsdc: number;
  slashedEver: boolean;
  lastSlashUsdc: number;
  /** bonded + unbonding just before the last slash. */
  stakeBeforeLastSlash: number;
}

export interface AgentBondEffect {
  strength: number;
  lift: number;
  penalty: number;
}

/** Post-state of one bond event, human USDC. */
export interface AgentBondAmounts {
  bonded: number;
  unbonding: number;
  amount: number;
}

export const DAY_MS = 86_400_000;
/** Above this many events inside the window for one bond, the lift fails closed to 0. */
export const AGENT_BOND_WINDOW_EVENT_CAP = 2000;

/** Min of the balance at the window start and every post-event balance inside it. */
export function seasonedBalance(atStartBonded: number, inWindowBonded: number[]): number {
  return Math.max(0, Math.min(atStartBonded, ...inWindowBonded));
}

export function slashFields(last: AgentBondAmounts | undefined):
  Pick<AgentBondInput, 'slashedEver' | 'lastSlashUsdc' | 'stakeBeforeLastSlash'> {
  return {
    slashedEver: last !== undefined,
    lastSlashUsdc: last?.amount ?? 0,
    stakeBeforeLastSlash: last ? last.bonded + last.unbonding + last.amount : 0,
  };
}

/** Pure. Returns the adjusted Provider score and the effect, or a no-op off-chain. */
export function applyAgentBond(
  score: number,
  input: AgentBondInput | null | undefined,
): { score: number; effect: AgentBondEffect | null } {
  if (!input || input.chain !== AGENT_BOND_SCORING_CHAIN) return { score, effect: null };

  const size = Math.min(1, Math.log10(1 + Math.max(0, input.countedUsdc)) / Math.log10(1 + AGENT_BOND_CAP_USDC));
  const strength = input.slashedEver ? 0 : size;
  const lift = AGENT_BOND_WEIGHT * strength * (100 - score);
  const severity = input.slashedEver
    ? Math.max(
        AGENT_BOND_SLASH_MIN_SEVERITY,
        Math.min(1, input.stakeBeforeLastSlash > 0 ? input.lastSlashUsdc / input.stakeBeforeLastSlash : 1),
      )
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
