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
import { ALL_FACILITATOR_ADDRESSES } from '../config/facilitators';
import { SPECIMEN_ADDRESSES } from '../config/specimen';

const HELIUS_WEBHOOK_API = 'https://api-mainnet.helius-rpc.com/v0/webhooks';

async function main() {
  const webhookUrl = process.argv[2];

  if (!webhookUrl) {
    console.error('Usage: bun run src/scripts/setup-webhook.ts <WEBHOOK_URL>');
    process.exit(1);
  }

  const apiKey = getHeliusApiKey();
  const secret = process.env.HELIUS_WEBHOOK_SECRET;

  const watchedAddresses = [...new Set([...ALL_FACILITATOR_ADDRESSES, ...SPECIMEN_ADDRESSES])];

  const payload: Record<string, unknown> = {
    webhookURL: webhookUrl,
    webhookType: 'enhanced',
    accountAddresses: watchedAddresses,
    transactionTypes: ['TRANSFER'],
  };

  if (secret) {
    payload.authHeader = `Bearer ${secret}`;
  }

  console.log(`Creating Helius webhook...`);
  console.log(`  URL:           ${webhookUrl}`);
  console.log(`  Type:          enhanced`);
  console.log(`  Addresses:     ${watchedAddresses.length} (${ALL_FACILITATOR_ADDRESSES.length} facilitators + ${SPECIMEN_ADDRESSES.length} specimen)`);
  console.log(`  Auth header:   ${secret ? 'yes' : 'none'}`);

  const res = await fetch(`${HELIUS_WEBHOOK_API}?api-key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Failed to create webhook: ${res.status} ${res.statusText}`);
    console.error(text);
    process.exit(1);
  }

  const data = await res.json();

  console.log(`\nWebhook created successfully.`);
  console.log(`  ID:    ${data.webhookID}`);
  console.log(`  Type:  ${data.webhookType}`);
  console.log(`  URL:   ${data.webhookURL}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
