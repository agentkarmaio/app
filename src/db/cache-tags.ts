export const CacheTags = {
  Stats: 'stats',
  Leaderboard: 'leaderboard',
  FacilitatorStats: 'facilitator-stats',
  RecentTransactions: 'recent-txs',
  WalletTiers: 'wallet-tiers',
  Organization: 'organization',
} as const;

export type CacheTag = (typeof CacheTags)[keyof typeof CacheTags];
