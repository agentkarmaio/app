import { enrichWallets } from '../indexer/enrichment';

console.log('[enrichment] Starting wallet enrichment...');
const start = Date.now();

enrichWallets()
  .then((result) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[enrichment] Done in ${elapsed}s`);
    console.log(`[enrichment] Enriched: ${result.enriched} | Sybil flagged: ${result.sybilFlagged}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[enrichment] Fatal:', err);
    process.exit(1);
  });
