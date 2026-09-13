/**
 * Read-only liveness census: how many wallets fall in each `LivenessStatus`
 * bucket, per chain, plus the observed-liveness invariant check.
 *
 * Run this BEFORE and AFTER `drizzle/0022_backfill_observed_last_seen.sql` so
 * the re-bucketing is a measured fact rather than an expectation. Before the
 * backfill the buckets describe indexer cadence; after, they describe agents.
 *
 * The invariant (see docs/superpowers/specs/2026-09-13-observed-liveness.md):
 *
 *     tx_count = 0  <=>  last_seen IS NULL
 *
 * A violation means some writer moved one side without the other — either a
 * third source feeds `tx_count`, or an upsert stamped `last_seen` from a clock
 * again. Either way the liveness column is lying and the count says how much.
 *
 * Writes nothing.
 *
 * Usage:
 *   bun run scripts/liveness-histogram.ts
 *   bun run scripts/liveness-histogram.ts --chain=arc
 */
import { supabase } from '../src/db/client';
import { CHAINS, LIVENESS_STATUSES, isChain } from '../src/db/schema';
import type { Chain, LivenessStatus } from '../src/db/schema';

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const chainArg = arg('chain');
if (chainArg && !isChain(chainArg)) {
  console.error(`unknown chain: ${chainArg} (expected one of ${CHAINS.join(', ')})`);
  process.exit(1);
}
const chains: readonly Chain[] = chainArg ? [chainArg as Chain] : CHAINS;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/**
 * Same boundaries as getLivenessStatus / applyLivenessFilter. Duplicated here
 * on purpose: this script is the independent check on that code, so it must not
 * import the thing it is auditing.
 */
function bucketCount(chain: Chain, status: LivenessStatus) {
  let q = supabase
    .from('wallets')
    .select('*', { count: 'exact', head: true })
    .eq('chain', chain);
  switch (status) {
    case 'Active':     q = q.gte('last_seen', hoursAgo(24)); break;
    case 'Recent':     q = q.lt('last_seen', hoursAgo(24)).gte('last_seen', hoursAgo(7 * 24)); break;
    case 'Dormant':    q = q.lt('last_seen', hoursAgo(7 * 24)).gte('last_seen', hoursAgo(90 * 24)); break;
    case 'Inactive':   q = q.lt('last_seen', hoursAgo(90 * 24)); break;
    case 'Unobserved': q = q.is('last_seen', null); break;
  }
  return q;
}

async function count(q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count: n, error } = await q;
  if (error) throw error;
  return n ?? 0;
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

for (const chain of chains) {
  const total = await count(
    supabase.from('wallets').select('*', { count: 'exact', head: true }).eq('chain', chain),
  );
  if (total === 0) continue;

  const counts = await Promise.all(
    LIVENESS_STATUSES.map((s) => count(bucketCount(chain, s))),
  );

  console.log(`\n${chain}  (${total.toLocaleString()} wallets)`);
  LIVENESS_STATUSES.forEach((status, i) => {
    const n = counts[i];
    const pct = total === 0 ? 0 : (n / total) * 100;
    console.log(`  ${status.padEnd(11)} ${pad(n.toLocaleString(), 9)}  ${pad(pct.toFixed(1), 5)}%`);
  });

  const bucketed = counts.reduce((a, b) => a + b, 0);
  if (bucketed !== total) {
    console.log(`  ⚠ ${total - bucketed} wallets fell in no bucket — the boundaries have a gap`);
  }

  // Invariant: the two halves of "we observed nothing" must agree.
  const [zeroTxSeen, someTxUnseen] = await Promise.all([
    count(
      supabase.from('wallets').select('*', { count: 'exact', head: true })
        .eq('chain', chain).eq('tx_count', 0).not('last_seen', 'is', null),
    ),
    count(
      supabase.from('wallets').select('*', { count: 'exact', head: true })
        .eq('chain', chain).gt('tx_count', 0).is('last_seen', null),
    ),
  ]);
  if (zeroTxSeen || someTxUnseen) {
    console.log(
      `  ⚠ invariant violated: ${zeroTxSeen} rows with tx_count=0 carry a last_seen; ` +
      `${someTxUnseen} rows with transactions have none`,
    );
  } else {
    console.log('  ✓ tx_count = 0 ⟺ last_seen IS NULL');
  }
}
