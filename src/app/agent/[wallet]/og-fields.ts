/**
 * Shared display-field resolution for the agent profile's social surfaces —
 * `generateMetadata` (the unfurl title/description) and `opengraph-image`
 * (the preview card). Both must show the SAME name / score / tier / chain, and
 * both must handle ERC-8004 REGISTRY agents (fleets + self-owned), which aren't
 * in `wallets` and so return nothing from an address-only `getWallet` lookup.
 *
 * Resolution order:
 *   1. a real `wallets` row with signal (Solana/Stellar/claimed EVM)
 *   2. the ERC-8004 mirror by agentId (when the caller has the `?agentId=` hint)
 *      — ownership-checked against the address, mirroring the page render
 *   3. the ERC-8004 mirror by address (OG image has no searchParams)
 *   4. bare fallback (an unindexed address)
 */

import { getWallet, getErc8004Agent, getErc8004AgentByAddress } from '@/db/client';
import { getTrustTier } from '@/scoring/index';

export interface AgentCardFields {
  name: string;
  score: number;
  tier: string;
  badge: string;
  txCount: number;
  chain: string;
  claimed: boolean;
  /** true when resolved from the ERC-8004 registry mirror (declared-tier). */
  isRegistry: boolean;
}

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

function ownsAddress(row: Record<string, unknown> | null, lc: string): boolean {
  return (
    !!row &&
    (String(row.owner ?? '').toLowerCase() === lc ||
      String(row.agent_wallet ?? '').toLowerCase() === lc)
  );
}

function fromRegistry(row: Record<string, unknown>, chain: string, wallet: string): AgentCardFields {
  const score = Number(row.metadata_score ?? 0);
  const reg = (row.registration ?? {}) as { name?: string };
  return {
    name: typeof reg.name === 'string' && reg.name.trim() ? reg.name : `Agent ${short(wallet)}`,
    score,
    tier: getTrustTier(score),
    badge: 'declared',
    txCount: 0, // declared-tier: no indexed receipt transactions
    chain,
    claimed: Boolean(row.claimed ?? false),
    isRegistry: true,
  };
}

export async function resolveAgentCardFields(
  wallet: string,
  opts: { agentId?: number | null } = {},
): Promise<AgentCardFields> {
  const w = await getWallet(wallet).catch(() => null);

  // 1. A wallets-backed agent with actual signal (Solana/Stellar, or a claimed
  //    EVM row that carries an agentId). A bare 0-score EVM stub falls through
  //    to the registry lookup below.
  const wScore = Number(w?.provider_score ?? w?.score ?? 0);
  if (w && (wScore > 0 || (w.tx_count ?? 0) > 0 || w.claimed)) {
    return {
      name: w.display_name ?? `Agent ${short(wallet)}`,
      score: wScore,
      tier: w.trust_tier ?? 'Unrated',
      badge: w.confidence_badge ?? 'declared',
      txCount: w.tx_count ?? 0,
      chain: w.chain ?? 'solana',
      claimed: w.claimed ?? false,
      isRegistry: false,
    };
  }

  // 2. ERC-8004 registry by agentId hint (ownership-checked, Celo then Arc).
  const lc = wallet.toLowerCase();
  if (opts.agentId != null) {
    for (const c of ['celo', 'arc'] as const) {
      const r = await getErc8004Agent(c, opts.agentId).catch(() => null);
      if (ownsAddress(r, lc)) return fromRegistry(r as Record<string, unknown>, c, wallet);
    }
  }

  // 3. ERC-8004 registry by address (no agentId — e.g. the OG image path).
  if (EVM_RE.test(wallet)) {
    const reg = await getErc8004AgentByAddress(wallet).catch(() => null);
    if (reg) return fromRegistry(reg.row, reg.chain, wallet);
  }

  // 4. Bare fallback (unindexed, or a 0-score wallets stub).
  return {
    name: w?.display_name ?? `Agent ${short(wallet)}`,
    score: wScore,
    tier: w?.trust_tier ?? 'Unrated',
    badge: w?.confidence_badge ?? 'declared',
    txCount: w?.tx_count ?? 0,
    chain: w?.chain ?? 'solana',
    claimed: w?.claimed ?? false,
    isRegistry: false,
  };
}
