import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/db/client';
import { getLeaderboard } from '@/db/client';
import type { Chain, Transaction, Wallet } from '@/db/schema';
import { corsHeaders, corsPreflight, enforceRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Balanced multi-chain hub: pull top-by-score from EACH chain so the hero
// graphic visibly represents all four chains, not just whichever chain
// dominates the global leaderboard (currently Celo + Arc after backfill).
//
// Equal-slot allocation: each chain gets a base slot count; if a chain is
// short (e.g. Stellar today has only ~4 scored wallets), its unused slots
// are redistributed round-robin to chains with surplus so the final set
// stays at TARGET_NODES.
const TARGET_NODES = 18;
const CHAIN_SLOTS: Record<Chain, number> = {
  solana: 5,
  celo: 5,
  stellar: 4,
  arc: 4,
};
const CHAIN_ORDER: Chain[] = ['solana', 'celo', 'stellar', 'arc'];
const PER_CHAIN_FETCH = 12; // headroom for redistribution

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: NextRequest) {
  const gate = await enforceRateLimit('graph', request);
  if (!gate.ok) return gate.response;

  const perChainPages = await Promise.all(
    CHAIN_ORDER.map((chain) =>
      getLeaderboard(PER_CHAIN_FETCH, 0, { chain }, { withCount: false }),
    ),
  );

  // Allocate slots: start with the configured base, then redistribute any
  // shortfall (chain had fewer scored wallets than its slot count) round-robin
  // to the next chain with surplus availability.
  const pool: Record<Chain, Wallet[]> = {
    solana: perChainPages[0].wallets,
    celo: perChainPages[1].wallets,
    stellar: perChainPages[2].wallets,
    arc: perChainPages[3].wallets,
  };

  const take: Record<Chain, number> = { solana: 0, celo: 0, stellar: 0, arc: 0 };
  let remaining = TARGET_NODES;
  // Pass 1: take up to each chain's base allocation.
  for (const chain of CHAIN_ORDER) {
    const want = Math.min(CHAIN_SLOTS[chain], pool[chain].length);
    take[chain] = want;
    remaining -= want;
  }
  // Pass 2: round-robin any leftover budget to chains with spare wallets.
  while (remaining > 0) {
    let progressed = false;
    for (const chain of CHAIN_ORDER) {
      if (remaining === 0) break;
      if (take[chain] < pool[chain].length) {
        take[chain] += 1;
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break; // every chain exhausted
  }

  const agents: Wallet[] = CHAIN_ORDER.flatMap((chain) =>
    pool[chain].slice(0, take[chain]),
  );

  if (agents.length === 0) {
    return NextResponse.json({ facilitator: null, agents: [] }, {
      headers: {
        ...gate.headers,
        ...corsHeaders(),
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
      },
    });
  }

  // Facilitator stats are Solana-only (x402 transactions live on Solana).
  // Restricting the lookup keeps the query tight even though the IN-list now
  // contains addresses from non-Solana chains that will never match.
  const solanaAddresses = agents
    .filter((a) => a.chain === 'solana')
    .map((a) => a.address);

  let txs: Pick<Transaction, 'wallet_address' | 'facilitator'>[] = [];
  if (solanaAddresses.length > 0) {
    const { data, error } = await supabase
      .from('transactions')
      .select('wallet_address, facilitator')
      .eq('chain', 'solana')
      .in('wallet_address', solanaAddresses);
    if (error) throw error;
    txs = (data ?? []) as Pick<Transaction, 'wallet_address' | 'facilitator'>[];
  }

  const facilitatorCounts = new Map<string, number>();
  const agentFacilitator = new Map<string, Map<string, number>>();

  for (const t of txs) {
    facilitatorCounts.set(t.facilitator, (facilitatorCounts.get(t.facilitator) ?? 0) + 1);
    const inner = agentFacilitator.get(t.wallet_address) ?? new Map<string, number>();
    inner.set(t.facilitator, (inner.get(t.facilitator) ?? 0) + 1);
    agentFacilitator.set(t.wallet_address, inner);
  }

  const topFacilitator =
    [...facilitatorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return NextResponse.json({
    facilitator: topFacilitator,
    agents: agents.map((a) => {
      const fMap = a.chain === 'solana' ? agentFacilitator.get(a.address) : null;
      const primary = fMap
        ? [...fMap.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
        : null;
      return {
        chain: a.chain,
        address: a.address,
        displayName: a.display_name,
        score: Number(a.score),
        trustTier: a.trust_tier,
        txCount: a.tx_count,
        primaryFacilitator: primary,
      };
    }),
  }, {
    headers: {
      ...gate.headers,
      ...corsHeaders(),
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
  });
}
