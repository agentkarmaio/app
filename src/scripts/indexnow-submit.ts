/**
 * indexnow-submit — ping IndexNow with URLs that changed recently, so Bing &
 * co. re-crawl fresh agent profiles within minutes instead of days.
 *
 * The URL set is NOT re-derived here: it is read from the app's own sitemap
 * (src/app/sitemap.ts), the single source of truth for "what pages exist".
 * That module's default export returns entries with a `lastModified`, which we
 * filter by a recency window so we only submit genuinely-changed URLs (per
 * IndexNow etiquette — do not re-ping unchanged pages on a schedule).
 *
 * Usage:
 *   bun run src/scripts/indexnow-submit.ts                 # changed in last 12h
 *   bun run src/scripts/indexnow-submit.ts --since 24      # changed in last 24h
 *   bun run src/scripts/indexnow-submit.ts --all           # every sitemap URL (seed once)
 *
 * Env (same DB secrets the sitemap needs — provided by the keep-fresh CI job):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import sitemap from '../app/sitemap';
import { submitUrls } from '../lib/indexnow';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const submitAll = process.argv.includes('--all');
const sinceHours = Number(arg('--since') ?? 12);

async function main() {
  const entries = await sitemap();

  const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
  const selected = submitAll
    ? entries
    : entries.filter((e) => {
        const mod = e.lastModified ? new Date(e.lastModified).getTime() : 0;
        return mod >= cutoff;
      });

  const urls = selected.map((e) => e.url);
  if (urls.length === 0) {
    console.log(`[indexnow] nothing changed in the last ${sinceHours}h — no submission`);
    return;
  }

  const label = submitAll ? 'all sitemap URLs' : `changed in last ${sinceHours}h`;
  console.log(`[indexnow] submitting ${urls.length} URLs (${label})`);
  const result = await submitUrls(urls);

  const failed = result.batches.filter((b) => !b.ok);
  for (const b of result.batches) {
    console.log(`[indexnow] batch of ${b.count} → HTTP ${b.status} ${b.ok ? 'OK' : 'FAILED'}`);
  }
  if (failed.length > 0) {
    console.error(`[indexnow] ${failed.length}/${result.batches.length} batch(es) failed`);
    process.exit(1);
  }
  console.log(`[indexnow] done — ${result.submitted} URLs accepted`);
}

main().catch((err) => {
  console.error('[indexnow] fatal:', err);
  process.exit(1);
});
