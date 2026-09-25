/**
 * Cached read-side wrappers around src/db/client.ts.
 *
 * Rules (enforced by JsonSafe<T> below):
 *   1. Pages must import from this file, never re-wrap getX with unstable_cache.
 *   2. Cached return values must be JSON-serializable. Map/Set/Date/class
 *      instances silently corrupt across the cache boundary — convert to
 *      [k, v][] / arrays / ISO strings inside the wrapper, hydrate at call site.
 *   3. Every wrapper carries a tag from CacheTags so indexer write paths can
 *      surgically invalidate via revalidateTag(CacheTags.X).
 *
 * Migration path: when Next stabilises 'use cache', swap the body of each
 * wrapper for `'use cache'; cacheLife('default'); cacheTag(...)` — call sites
 * stay identical.
 */

import { unstable_cache } from 'next/cache';
import {
  getStats,
  getLeaderboard,
  getFacilitatorStats,
  getRecentTransactions,
  getWalletTiers,
  getFeedbackSummariesForWallets,
  getScoreHistoriesForWallets,
  getOrganization,
  getOrganizationMembers,
  getErc8004Agent,
  getErc8004Feedback,
} from './client';
import { CacheTags, type CacheTag } from './cache-tags';
import type { TrustTier, Chain } from './schema';
import { computeAgentLiveBundle, type AgentLiveBundle } from '@/scoring/live-agent-score';
import { resolveAgentCardFields } from '@/lib/agent-card-fields';
import {
  readAgent as readCeloAgent,
  aggregateFeedback as aggregateCeloFeedback,
  type CeloAgent,
  type FeedbackRecord,
} from '@/integrations/erc8004-celo';
import {
  readAgent as readArcMainnetAgent,
  aggregateFeedback as aggregateArcMainnetFeedback,
} from '@/integrations/erc8004-arc-mainnet';

// --- JSON-safety guard -------------------------------------------------------
// Compile error if a wrapper tries to return a Map/Set/Date/class instance.
// Plain objects, arrays, primitives, null/undefined are allowed.
type Primitive = string | number | boolean | null | undefined;
type JsonSafe<T> = T extends Primitive
  ? T
  : T extends Date | Map<unknown, unknown> | Set<unknown> | ((...args: never[]) => unknown)
    ? never
    : T extends Array<infer U>
      ? Array<JsonSafe<U>>
      : T extends object
        ? { [K in keyof T]: JsonSafe<T[K]> }
        : never;

interface CacheOpts {
  key: string;
  tag: CacheTag;
  revalidate: number;
}

function defineCache<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<JsonSafe<TReturn>>,
  { key, tag, revalidate }: CacheOpts,
): (...args: TArgs) => Promise<JsonSafe<TReturn>> {
  return unstable_cache(fn, [key], { revalidate, tags: [tag] });
}

// --- Cached queries ----------------------------------------------------------

export const cachedStats = defineCache(() => getStats(), {
  key: 'stats',
  tag: CacheTags.Stats,
  revalidate: 30,
});

export const cachedLeaderboardEntries = defineCache(
  async () => {
    const page = await getLeaderboard(25, 0, {}, { withCount: false });
    const wallets = page.wallets;
    const perNetwork = new Map(await Promise.all([...new Set(wallets.map(w => w.chain))].map(async chain => {
      const addresses = wallets.filter(w => w.chain === chain).map(w => w.address);
      const [delivery, history] = await Promise.all([
        getFeedbackSummariesForWallets(addresses, chain),
        getScoreHistoriesForWallets(addresses, 30, 30, chain),
      ]);
      return [chain, { delivery, history }] as const;
    })));
    return wallets.map((w, i) => {
      const delivery = perNetwork.get(w.chain)?.delivery.get(w.address) ?? null;
      const history = perNetwork.get(w.chain)?.history.get(w.address) ?? [];
      return {
        rank: i + 1,
        address: w.address,
        chain: w.chain,
        displayName: w.display_name,
        imageUrl: w.image_url ?? null,
        score: Number(w.score),
        trustTier: w.trust_tier as TrustTier,
        confidenceBadge: w.confidence_badge ?? null,
        autonomyScore: w.autonomy_score != null ? Number(w.autonomy_score) : null,
        autonomyLabel: w.autonomy_label ?? null,
        txCount: w.tx_count,
        lastSeen: w.last_seen,
        delivery: delivery
          ? { total: delivery.total, deliveryRate: delivery.deliveryRate }
          : null,
        trend: history.map((h) => h.score),
      };
    });
  },
  { key: 'leaderboard-entries-v3-network', tag: CacheTags.Leaderboard, revalidate: 30 },
);

export const cachedFacilitatorStats = defineCache(() => getFacilitatorStats(), {
  key: 'facilitator-stats',
  tag: CacheTags.FacilitatorStats,
  revalidate: 30,
});

export const cachedRecentTransactions = defineCache(
  (facilitator: string | undefined, sinceIso: string | undefined) =>
    getRecentTransactions(facilitator, 40, sinceIso ? new Date(sinceIso) : undefined),
  { key: 'recent-txs', tag: CacheTags.RecentTransactions, revalidate: 30 },
);

const cachedWalletTierRecord = defineCache(
  async (addresses: string[]): Promise<Record<string, TrustTier>> => {
    const map = await getWalletTiers(addresses);
    return Object.fromEntries(map.entries());
  },
  { key: 'wallet-tiers', tag: CacheTags.WalletTiers, revalidate: 60 },
);

// Hydration helper — call sites get a Map without ever caching one.
export async function getCachedWalletTierMap(
  addresses: string[],
): Promise<Map<string, TrustTier>> {
  if (addresses.length === 0) return new Map();
  const record = await cachedWalletTierRecord(addresses);
  return new Map(Object.entries(record));
}

/**
 * Full live-score bundle for an agent profile (up to 10k tx rows + one Solana
 * RPC attestation read per compute). This is the expensive read behind
 * /agent/[wallet]; caching it per-wallet is what makes profile navigation
 * fast on repeat visits. 60s matches the leaderboard/stats staleness budget.
 */
export const cachedAgentLiveBundle: (wallet: string, chain?: Chain) => Promise<AgentLiveBundle> = defineCache(
  (wallet: string, chain: Chain = 'solana') => computeAgentLiveBundle(wallet, chain),
  { key: 'agent-live-bundle-v2-network', tag: CacheTags.AgentProfile, revalidate: 60 },
);

/** Shared unfurl fields for generateMetadata + the OG image (2-3 DB reads). */
export const cachedAgentCardFields = defineCache(
  (wallet: string, agentId: number | null, chain?: Chain) => resolveAgentCardFields(wallet, { agentId, chain }),
  { key: 'agent-card-fields-v2-network', tag: CacheTags.AgentProfile, revalidate: 60 },
);

// --- EVM on-chain profile reads (Celo/Arc) -----------------------------------
// Celo readAgent + readAllFeedback hit the public RPC live —
// the flakiest dependency the profile has. Cache the pair per (chain, agentId);
// bigint fields cross the JSON boundary as number/string and are hydrated back
// below. A fully-failed read (both null) THROWS so the failure is never cached
// — the caller falls back to the DB row and the next request retries the RPC.

interface EvmOnchainJson {
  agent: (Omit<CeloAgent, 'agentId'> & { agentId: number }) | null;
  feedback: {
    count: number;
    average: number | null;
    records: (Omit<FeedbackRecord, 'feedbackIndex' | 'rawValue'> & {
      feedbackIndex: number;
      rawValue: string;
    })[];
  } | null;
}

const LIVE_EVM_READS = {
  celo: { readAgent: readCeloAgent, aggregateFeedback: aggregateCeloFeedback },
  'arc-mainnet': { readAgent: readArcMainnetAgent, aggregateFeedback: aggregateArcMainnetFeedback },
} as const;

const cachedEvmAgentOnchainJson = defineCache(
  async (chain: 'celo' | 'arc-mainnet', agentId: number): Promise<EvmOnchainJson> => {
    const reads = LIVE_EVM_READS[chain];
    if (!reads) throw new Error('Registry network unsupported');
    const [agent, feedback] = await Promise.all([
      reads.readAgent(BigInt(agentId)).catch(() => null),
      reads.aggregateFeedback(BigInt(agentId), { includeRevoked: true }).catch(() => null),
    ]);
    if (agent === null && feedback === null) {
      throw new Error(`on-chain reads failed for ${chain} agent ${agentId}`);
    }
    return {
      agent: agent ? { ...agent, agentId: Number(agent.agentId) } : null,
      feedback: feedback
        ? {
            count: feedback.count,
            average: feedback.average,
            records: feedback.records.map((r) => ({
              ...r,
              feedbackIndex: Number(r.feedbackIndex),
              rawValue: r.rawValue.toString(),
            })),
          }
        : null,
    };
  },
  { key: 'evm-agent-onchain-v2-network', tag: CacheTags.AgentProfile, revalidate: 120 },
);

export interface EvmAgentOnchain {
  agent: CeloAgent | null;
  feedback: { count: number; average: number | null; records: FeedbackRecord[] } | null;
}

/** Hydration helper — call sites get real bigint-typed records back. */
/**
 * Identity + feedback from the registry-scan mirror (erc8004_agents +
 * erc8004_feedback), no RPC. The only source for the retired Arc testnet, and
 * the fallback for Arc mainnet when its public RPC is unreachable.
 */
async function mirroredEvmAgentOnchain(
  chain: 'arc' | 'arc-mainnet',
  agentId: number,
): Promise<EvmAgentOnchain> {
  const [row, savedFeedback] = await Promise.all([
    getErc8004Agent(chain, agentId).catch(() => null),
    getErc8004Feedback(chain, agentId).catch(() => null),
  ]);
  const agent: CeloAgent | null = row ? {
    agentId: BigInt(agentId),
    owner: row.owner as `0x${string}`,
    agentWallet: (row.agent_wallet ?? row.owner) as `0x${string}`,
    tokenURI: typeof row.token_uri === 'string' ? row.token_uri : '',
    registration: row.registration as CeloAgent['registration'],
  } : null;
  const records: FeedbackRecord[] = (savedFeedback ?? []).flatMap(record => {
    // Null exact values are unavailable, never invented as zero.
    if (record.raw_value == null || !/^-?\d+$/.test(record.raw_value)) return [];
    const value = record.value == null ? Number(record.raw_value) / 10 ** record.value_decimals : Number(record.value);
    if (!Number.isFinite(value)) return [];
    return [{
      client: record.client as `0x${string}`,
      feedbackIndex: BigInt(record.feedback_index), rawValue: BigInt(record.raw_value),
      valueDecimals: record.value_decimals, value,
      tag1: record.tag1, tag2: record.tag2, revoked: record.revoked,
    }];
  });
  // Preserve the saved aggregate independently of partial mirrored records.
  const count = row?.feedback_count == null ? null : Number(row.feedback_count);
  const average = row?.feedback_avg == null ? null : Number(row.feedback_avg);
  return {
    agent,
    feedback: savedFeedback && row && count != null && Number.isSafeInteger(count) && count >= 0
      ? { count, average: average != null && Number.isFinite(average) ? average : null, records }
      : null,
  };
}

export async function getCachedEvmAgentOnchain(
  chain: 'celo' | 'arc' | 'arc-mainnet',
  agentId: number,
): Promise<EvmAgentOnchain> {
  // Retirement freezes the mirror. Never refresh this identity/feedback from
  // the former RPC or registration URL, even if the archive is missing.
  if (chain === 'arc') return mirroredEvmAgentOnchain('arc', agentId);
  let raw: EvmOnchainJson;
  try {
    raw = await cachedEvmAgentOnchainJson(chain, agentId);
  } catch {
    return chain === 'arc-mainnet'
      ? mirroredEvmAgentOnchain('arc-mainnet', agentId)
      : { agent: null, feedback: null };
  }
  return {
    agent: raw.agent ? { ...raw.agent, agentId: BigInt(raw.agent.agentId) } : null,
    feedback: raw.feedback
      ? {
          ...raw.feedback,
          records: raw.feedback.records.map((r) => ({
            ...r,
            feedbackIndex: BigInt(r.feedbackIndex),
            rawValue: BigInt(r.rawValue),
          })),
        }
      : null,
  };
}

export const cachedOrganization = defineCache(
  (slug: string) => getOrganization(slug),
  { key: 'organization', tag: CacheTags.Organization, revalidate: 60 },
);

export const cachedOrganizationMembers = defineCache(
  (slug: string) => getOrganizationMembers(slug),
  { key: 'organization-members', tag: CacheTags.Organization, revalidate: 60 },
);
