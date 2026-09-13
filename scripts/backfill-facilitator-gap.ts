/**
 * Close the un-ingested history behind a facilitator's dead cursor.
 *
 * Sixteen facilitators log `stored cursor … is outside this RPC's history` on
 * every prod run. Measured 2026-09-10: eleven are dormant (nothing missing),
 * but five have real un-ingested signatures behind that cursor, two of them
 * more than 1000 — all 59-81 days old.
 *
 * `keep-fresh:backfill` cannot recover any of it: it runs on SOLANA_RPC_URL,
 * which retains ~2 days. This runs on SOLANA_ARCHIVE_RPC_URL (full history,
 * defaults to api.mainnet-beta.solana.com) and pages past the 1000-signature
 * per-call cap that the two large gaps sit behind.
 *
 * Usage:
 *   bun run scripts/backfill-facilitator-gap.ts                    # dry run, ALL facilitators
 *   bun run scripts/backfill-facilitator-gap.ts --address <addr>   # one address
 *   bun run scripts/backfill-facilitator-gap.ts --write            # actually ingest
 *   bun run scripts/backfill-facilitator-gap.ts --max 5000         # cap the walk
 *
 * A --write run is RESUMABLE: the cursor climbs behind the contiguous ingested
 * prefix as batches land, so a run killed by a timeout resumes where it stopped
 * rather than re-walking from the dead cursor.
 *
 * Dry run is the DEFAULT: it reports each true gap size for ~3-5 RPC calls per
 * address and writes nothing.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      SOLANA_ARCHIVE_RPC_URL (optional — defaults to public mainnet-beta)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { ALL_FACILITATOR_ADDRESSES } from '../src/config/facilitators';
import { SPECIMEN_ADDRESSES } from '../src/config/specimen';
import { PAYSH_OPERATOR_ADDRESSES } from '../src/config/paysh-operators';
import {
  getCursor,
  upsertCursor,
  insertTransactions,
  ensureWalletsExist,
  markWalletsDirty,
} from '../src/db/client';
import { parseTransactionsBatch, extractX402Payment, getArchiveRpcUrl } from '../src/indexer/helius';
import { recoverFacilitatorGap } from '../src/indexer/facilitator-gap';
import { assertLegacyGapWriteAllowed } from '../src/indexer/legacy-gap-guard';
import { requireEnv } from '../src/lib/require-env';

requireEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const write = process.argv.includes('--write');
const only = flag('--address');
const maxSignatures = Number(flag('--max')) || 10_000;

// Read-only probes stay independent. Long writes require an intentionally
// paused managed poller; never change that operational policy automatically.
if (write) await assertLegacyGapWriteAllowed();

// Full history is the whole point — never fall back to the indexer's RPC here.
const archive = new Connection(getArchiveRpcUrl(), 'confirmed');
// Serialized upstream in parseTransactionsBatch; this is the signature walk,
// which is a handful of calls per address.
const PACING_MS = 1500;

const addresses = only
  ? [only]
  : [...new Set([...ALL_FACILITATOR_ADDRESSES, ...PAYSH_OPERATOR_ADDRESSES, ...SPECIMEN_ADDRESSES])];

console.log(
  `[gap] ${write ? 'WRITE' : 'DRY RUN'} · ${addresses.length} address(es) · ` +
  `archive=${getArchiveRpcUrl()} · max=${maxSignatures}`,
);

let totalGap = 0;
let totalInserted = 0;
const stranded: string[] = [];

for (const address of addresses) {
  const cursor = (await getCursor(address))?.last_signature;
  if (!cursor) {
    console.log(`[gap] ${address.slice(0, 10)}… no stored cursor — nothing to page back to, skipping`);
    continue;
  }

  const pubkey = new PublicKey(address);
  let result;
  try {
    result = await recoverFacilitatorGap(address, cursor, {
      fetchSignatures: async (o) => {
        await new Promise((r) => setTimeout(r, PACING_MS));
        const sigs = await archive.getSignaturesForAddress(pubkey, o);
        return sigs.map((s) => ({ signature: s.signature, blockTime: s.blockTime ?? null }));
      },
      parseBatch: (sigs) => parseTransactionsBatch(sigs),
      extract: (tx, facilitator) => extractX402Payment(tx, facilitator),
      persist: async (rows) => {
        await ensureWalletsExist([...new Set(rows.map((r) => r.wallet_address))]);
        return insertTransactions(rows);
      },
      markDirty: (addrs) => markWalletsDirty(addrs),
      advanceCursor: async (a, s) => { await upsertCursor(a, s); },
    }, { maxSignatures, dryRun: !write });
  } catch (err) {
    // Loud, per address: a throttled walk that quietly recorded gap=0 would be
    // read as "nothing missing" — the exact confusion this script exists to end.
    console.error(`[gap] ${address.slice(0, 10)}… FAILED:`, err instanceof Error ? err.message.slice(0, 160) : err);
    stranded.push(address);
    continue;
  }

  totalGap += result.gap;
  totalInserted += result.inserted;

  // An aborted walk still did work. Report the real counts before anything
  // else: run 34611182319 printed "inserted 0" for 2,241 committed rows.
  if (result.error) {
    console.error(
      `[gap] ${address}: ABORTED after ${result.scanned}/${result.gap} signatures — ` +
      `${result.error.slice(0, 120)}`,
    );
    console.error(
      `[gap] ${address.slice(0, 10)}… kept: inserted=${result.inserted} ` +
      `cursorAdvanced=${result.cursorAdvanced} — re-run to continue from there`,
    );
    stranded.push(address);
    continue;
  }

  if (result.gap === 0) continue;

  console.log(
    `[gap] ${address}: gap=${result.gap}${result.capped ? ' (CAPPED — more remains)' : ''}` +
    (write
      ? ` scanned=${result.scanned} extracted=${result.extracted} inserted=${result.inserted}` +
        ` unresolved=${result.unresolved} complete=${result.complete}`
      : ' (dry run)'),
  );
  if (write && !result.complete) {
    console.warn(
      `[gap] ${address.slice(0, 10)}… NOT closed ` +
      `(${result.capped ? 'walk capped' : `${result.unresolved} unresolved`}) — ` +
      (result.cursorAdvanced
        ? 'cursor moved up behind what did land; re-run to continue from there'
        : 'cursor untouched; re-run walks the same range again'),
    );
  }
}

console.log(
  `\n[gap] total gap ${totalGap} signature(s)` +
  (write ? `, inserted ${totalInserted}` : ' — re-run with --write to ingest'),
);
if (stranded.length > 0) {
  console.error(`[gap] ${stranded.length} address(es) FAILED and were not measured: ${stranded.join(', ')}`);
  process.exit(1);
}
