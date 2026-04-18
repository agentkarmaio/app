/**
 * Backfill Tier 3 manifest signals for every claimed wallet that declared a
 * `website`. For each, fetches `{website}/.well-known/agentkarma.json` and:
 *   - Stores raw + normalized manifest in `agent_manifests`
 *   - Emits a Tier 3 `kind='manifest'` signal_event (idempotent via AGGREGATE_TX_REF)
 *
 * Usage:
 *   bun run src/scripts/backfill-h1-manifests.ts
 */

import {
  supabase, insertSignalEvents, upsertAgentManifest,
} from '../db/client';
import { resolveManifest } from '../integrations/manifest';
import { buildManifestSignal } from '../scoring/signals';

async function main() {
  console.log('[backfill-h1] Loading claimed wallets with a website…');
  const { data, error } = await supabase
    .from('wallets')
    .select('address, website')
    .eq('claimed', true)
    .not('website', 'is', null);
  if (error) throw error;

  const rows = (data ?? []) as { address: string; website: string | null }[];
  console.log(`[backfill-h1] ${rows.length} claimed wallets with websites`);

  const signals = [];
  const summary = { resolved: 0, verified: 0, missed: 0, errors: 0 };

  for (const { address, website } of rows) {
    try {
      const result = await resolveManifest(address, website);
      if (!result) {
        summary.missed++;
        continue;
      }

      await upsertAgentManifest({
        agentWallet: address,
        sourceType:  result.sourceType,
        url:         result.url,
        raw:         result.raw,
        parsed:      result.parsed,
        verified:    result.verified,
      });

      signals.push(buildManifestSignal(address, {
        sourceType: result.sourceType,
        verified:   result.verified,
        url:        result.url,
      }));

      summary.resolved++;
      if (result.verified) summary.verified++;
      console.log(
        `[backfill-h1] ✓ ${address.slice(0, 6)}… ${result.url}${result.verified ? ' (verified)' : ''}`,
      );
    } catch (err) {
      summary.errors++;
      console.warn(`[backfill-h1] ✗ ${address.slice(0, 6)}…:`, (err as Error).message);
    }
  }

  if (signals.length > 0) {
    await insertSignalEvents(signals, { overwrite: true });
  }

  console.log('[backfill-h1] Done:', summary);
}

main().catch((err) => {
  console.error('[backfill-h1] Failed:', err);
  process.exit(1);
});
