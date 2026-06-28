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
} from './client';
import { CacheTags, type CacheTag } from './cache-tags';
import type { TrustTier } from './schema';

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
    const addresses = wallets.map((w) => w.address);
    const [deliveryMap, historyMap] = await Promise.all([
      getFeedbackSummariesForWallets(addresses),
      getScoreHistoriesForWallets(addresses),
    ]);
    return wallets.map((w, i) => {
      const delivery = deliveryMap.get(w.address) ?? null;
      const history = historyMap.get(w.address) ?? [];
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
  { key: 'leaderboard-entries-v2', tag: CacheTags.Leaderboard, revalidate: 30 },
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

export const cachedOrganization = defineCache(
  (slug: string) => getOrganization(slug),
  { key: 'organization', tag: CacheTags.Organization, revalidate: 60 },
);

export const cachedOrganizationMembers = defineCache(
  (slug: string) => getOrganizationMembers(slug),
  { key: 'organization-members', tag: CacheTags.Organization, revalidate: 60 },
);
