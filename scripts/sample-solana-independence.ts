/**
 * Acceptance harness for the Solana revenue-independence signal.
 *
 * Samples distinct recent Solana PAYEES — addresses drawn from the
 * `counterparty` column, i.e. the providers whose independence anyone would
 * actually ask about — and runs the production reciprocity read on each. The
 * output is the verdict distribution, which is how the counterparty backfill
 * (`backfill-solana-counterparty.ts`) is judged.
 *
 * Pin the address list across runs. `counterparty` is the column the backfill
 * WRITES, so a fresh sample after a backfill draws from a different population
 * and the before/after comparison would be measuring two different sets of
 * wallets. `--out` writes the addresses it used; `--addresses` replays them.
 *
 *   bun run scripts/sample-solana-independence.ts --out=.tmp/before.json
 *   bun run scripts/sample-solana-independence.ts --addresses=.tmp/before.json --out=.tmp/after.json
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { supabase } from '@/db/client';
import { getPaymentFlowsForAddress } from '@/db/enrichment-queries';
import { computeReciprocity, COVERAGE_FLOOR, type ReciprocityResult } from '@/scoring/reciprocity';

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const num = (name: string, fallback: number): number => {
  const raw = flag(name);
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const SAMPLE = num('limit', 28);
const SINCE_DAYS = num('since-days', 90);
const SCAN_CAP = num('scan-cap', 20_000);
const addressesFile = flag('addresses');
const outFile = flag('out');

/**
 * Buckets split `insufficient-data` by WHY, because "we cannot see this
 * wallet's payees at all" and "this wallet has no revenue" are different
 * problems and only the first is one a backfill can fix.
 */
type Bucket =
  | 'zero-coverage'
  | 'below-floor'
  | 'no-outbound'
  | 'no-inbound'
  | 'independent'
  | 'mixed'
  | 'circular';

function bucketFor(r: ReciprocityResult, outboundRows: number): Bucket {
  if (r.verdict !== 'insufficient-data') return r.verdict;
  if (outboundRows === 0) return 'no-outbound';
  if (r.coverage === 0) return 'zero-coverage';
  if (r.coverage < COVERAGE_FLOOR) return 'below-floor';
  return 'no-inbound';
}

/** Distinct payees on recent rows, newest first, deduped in TS. */
async function sampleRecentPayees(): Promise<string[]> {
  const since = new Date(Date.now() - SINCE_DAYS * 86_400_000).toISOString();
  const PAGE = 1000;
  const seen = new Set<string>();
  for (let offset = 0; offset < SCAN_CAP && seen.size < SAMPLE; offset += PAGE) {
    const { data, error } = await supabase
      .from('transactions')
      .select('counterparty')
      .eq('chain', 'solana')
      .not('counterparty', 'is', null)
      .gte('timestamp', since)
      .order('timestamp', { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ counterparty: string | null }>;
    for (const row of rows) {
      if (row.counterparty) seen.add(row.counterparty);
      if (seen.size >= SAMPLE) break;
    }
    if (rows.length < PAGE) break;
  }
  return [...seen].slice(0, SAMPLE);
}

function loadAddresses(path: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { addresses?: unknown }).addresses;
  if (!Array.isArray(list) || !list.every((a): a is string => typeof a === 'string')) {
    throw new Error(`${path} does not contain an address list`);
  }
  return list;
}

const addresses = addressesFile ? loadAddresses(addressesFile) : await sampleRecentPayees();
console.log(
  addressesFile
    ? `[sample] replaying ${addresses.length} pinned addresses from ${addressesFile}`
    : `[sample] sampled ${addresses.length} distinct payees from the last ${SINCE_DAYS}d`,
);

interface Row {
  address: string;
  bucket: Bucket;
  coverage: number;
  outboundRows: number;
  payerCount: number;
  reciprocalShare: number | null;
}

const results: Row[] = [];
for (const address of addresses) {
  const flows = await getPaymentFlowsForAddress('solana', address);
  const r = computeReciprocity({ ...flows, chain: 'solana' });
  results.push({
    address,
    bucket: bucketFor(r, flows.outbound.length),
    coverage: Math.round(r.coverage * 1000) / 1000,
    outboundRows: flows.outbound.length,
    payerCount: r.payerCount,
    reciprocalShare: r.reciprocalShare === null ? null : Math.round(r.reciprocalShare * 1000) / 1000,
  });
}

const distribution = results.reduce<Record<string, number>>((acc, r) => {
  acc[r.bucket] = (acc[r.bucket] ?? 0) + 1;
  return acc;
}, {});

console.log('\noutcome                 count');
for (const [bucket, count] of Object.entries(distribution).sort((a, b) => b[1] - a[1])) {
  console.log(`${bucket.padEnd(22)} ${String(count).padStart(5)}`);
}
const decided = results.filter((r) => r.reciprocalShare !== null).length;
console.log(`\ndecided (a verdict, not insufficient-data): ${decided}/${results.length}`);

console.log('\naddress                                       bucket           cov   out   payers  recip');
for (const r of results) {
  console.log(
    `${r.address.padEnd(45)} ${r.bucket.padEnd(15)} ${String(r.coverage).padStart(5)} ${String(r.outboundRows).padStart(5)} ${String(r.payerCount).padStart(7)}  ${r.reciprocalShare ?? '-'}`,
  );
}

if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify({ sampledAt: new Date().toISOString(), sinceDays: SINCE_DAYS, addresses, distribution, results }, null, 2),
  );
  console.log(`\n[sample] wrote ${outFile}`);
}
