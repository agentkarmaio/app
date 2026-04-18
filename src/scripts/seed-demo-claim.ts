/**
 * Seed a demo claim + self-hosted manifest so the agent profile page shows a
 * fully-populated Tier 3 state on the live site. Intended for one-off demo
 * wallets under the operator's control — it bypasses the signed-claim flow.
 *
 * What it does:
 *   1. Writes `public/.well-known/agentkarma.json` declaring the given wallet
 *   2. Directly upserts the claim row in `wallets` (no signature verification)
 *   3. Upserts a verified `agent_manifests` row + Tier 3 signal_event
 *
 * Because the served manifest declares the same wallet we just claimed, the
 * manifest is considered owner-verified without needing an external proof.
 *
 * Usage:
 *   bun run src/scripts/seed-demo-claim.ts <wallet> \
 *     [--name "AgentKarma Demo"] [--description "..."] [--origin https://agentkarma.io]
 *
 * After running, trigger a score refresh so Tier 3 lands in the blended score:
 *   curl -X POST https://agentkarma.io/api/score/refresh -d '{"wallet":"<wallet>"}'
 */

import { promises as fs } from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import {
  claimWallet, upsertAgentManifest, insertSignalEvents,
} from '../db/client';
import { parseAgentKarmaManifest } from '../integrations/manifest';
import { buildManifestSignal } from '../scoring/signals';
import type { ParsedManifest } from '../db/schema';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      named[a.slice(2)] = argv[++i] ?? '';
    } else {
      positional.push(a);
    }
  }
  return { positional, named };
}

async function main() {
  const { positional, named } = parseArgs(process.argv.slice(2));
  const wallet = positional[0];
  if (!wallet) {
    console.error('Usage: bun run src/scripts/seed-demo-claim.ts <wallet> [--name ...] [--description ...] [--origin ...]');
    process.exit(1);
  }

  try { new PublicKey(wallet); } catch {
    console.error('Invalid Solana wallet address.');
    process.exit(1);
  }

  const name        = named.name        ?? 'AgentKarma Demo Agent';
  const description = named.description ?? 'Live demo agent — reads on-chain signals via AgentKarma.';
  const origin      = (named.origin     ?? 'https://agentkarma.io').replace(/\/$/, '');
  const githubUrl   = named.github      ?? null;

  const manifest: Record<string, unknown> = {
    schema: 'agentkarma.v1',
    wallet,
    name,
    description,
    website: origin,
    ...(githubUrl ? { github: githubUrl } : {}),
    category: 'infra',
    capabilities: ['karma.read', 'karma.badge', 'karma.widget'],
    endpoints: [
      { kind: 'http', url: `${origin}/agent/${wallet}`, description: 'AgentKarma profile' },
      { kind: 'http', url: `${origin}/api/score/${wallet}`, description: 'JSON karma score' },
    ],
  };

  // 1. Write the served file so /.well-known/agentkarma.json matches.
  const filePath = path.join(process.cwd(), 'public', '.well-known', 'agentkarma.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`[seed] Wrote ${filePath}`);

  // 2. Claim the wallet directly (bypasses signature verification — demo only).
  await claimWallet(wallet, name, description, origin, 'infra');
  console.log(`[seed] Claimed ${wallet.slice(0, 8)}… as "${name}"`);

  // 3. Upsert the manifest row + Tier 3 signal. Verified=true because the
  // manifest declares this wallet.
  const parsed = parseAgentKarmaManifest(manifest) as ParsedManifest;
  const manifestUrl = `${origin}/.well-known/agentkarma.json`;
  await upsertAgentManifest({
    agentWallet: wallet,
    sourceType:  'self_hosted',
    url:         manifestUrl,
    raw:         manifest,
    parsed,
    verified:    true,
  });
  await insertSignalEvents(
    [buildManifestSignal(wallet, { sourceType: 'self_hosted', verified: true, url: manifestUrl })],
    { overwrite: true },
  );
  console.log('[seed] Manifest + Tier 3 signal upserted (verified)');
  console.log('[seed] Trigger a score refresh to blend Tier 3 into the score:');
  console.log(`       curl -X POST ${origin}/api/score/refresh -d '{"wallet":"${wallet}"}'`);
}

main().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
