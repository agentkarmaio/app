/**
 * CLI script to register a Helius enhanced webhook for x402 facilitator monitoring.
 *
 * Usage:
 *   bun run src/scripts/setup-webhook.ts <WEBHOOK_URL>
 *
 * Env vars:
 *   HELIUS_RPC_URL            — required (contains api-key)
 *   HELIUS_WEBHOOK_SECRET     — optional, sent as authHeader on each delivery
 */

import { getHeliusApiKey } from '../indexer/helius';
import { createWebhook, WATCHED_ADDRESSES } from '../lib/helius-watchdog';
import { ALL_FACILITATOR_ADDRESSES } from '../config/facilitators';
import { SPECIMEN_ADDRESSES } from '../config/specimen';

async function main() {
  const webhookUrl = process.argv[2];

  if (!webhookUrl) {
    console.error('Usage: bun run src/scripts/setup-webhook.ts <WEBHOOK_URL>');
    process.exit(1);
  }

  const apiKey = getHeliusApiKey();

  console.log(`Creating Helius webhook...`);
  console.log(`  URL:           ${webhookUrl}`);
  console.log(`  Type:          enhanced`);
  console.log(`  Addresses:     ${WATCHED_ADDRESSES.length} (${ALL_FACILITATOR_ADDRESSES.length} facilitators + ${SPECIMEN_ADDRESSES.length} specimen)`);
  console.log(`  Auth header:   ${process.env.HELIUS_WEBHOOK_SECRET ? 'yes' : 'none'}`);

  // Same call the watchdog makes when it adopts an account, so the watch set
  // and auth header cannot drift between the two paths.
  const webhookID = await createWebhook(apiKey, webhookUrl);
  console.log(`\nWebhook created successfully.\n  ID: ${webhookID}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
