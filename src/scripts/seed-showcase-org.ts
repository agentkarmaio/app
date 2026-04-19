/**
 * Seed the AgentKarma showcase organization — a 3-agent fleet used to
 * demonstrate the enterprise fleet view. All three wallets are freshly
 * generated in `.keys/` and under the operator's control; their claims
 * are inserted directly (bypassing the signed flow, same as seed-demo-claim).
 *
 * One wallet (the flagship) also gets a self-hosted manifest served from
 * `/public/.well-known/agentkarma.json`, which gives it a verified Tier 3
 * signal in addition to the claim.
 *
 * Usage:
 *   bun run src/scripts/seed-showcase-org.ts [--origin https://agentkarma.io]
 */

import { promises as fs } from 'fs';
import path from 'path';
import {
  claimWallet, upsertOrganization, addOrganizationMember,
  upsertAgentManifest, insertSignalEvents,
} from '../db/client';
import { parseAgentKarmaManifest } from '../integrations/manifest';
import { buildManifestSignal } from '../scoring/signals';
import type { ParsedManifest } from '../db/schema';

const ORG = {
  slug: 'agentkarma',
  name: 'AgentKarma',
  description: 'The reputation layer for autonomous on-chain agents.',
  verified: true,
};

const MEMBERS = [
  {
    wallet: 'BPMEefwk2VV3Ntt7ZKvBT5KDgTcRJ9Wy28Qj5r1mQCiD',
    displayName: 'Karma Flagship',
    description: 'Primary public-facing agent. Serves karma scores, manifests, and feedback attestations.',
    category: 'infra',
    role: 'flagship',
    isFlagship: true,
  },
  {
    wallet: 'BXYUcv6aRaSi6bkPY4oZyKF7TCH1cf5ymUPRgnmJFKms',
    displayName: 'Karma Indexer',
    description: 'Ingests x402 payments and behavioral signals across Solana facilitators.',
    category: 'infra',
    role: 'worker',
    isFlagship: false,
  },
  {
    wallet: '6LcZpmsiPuNtFrwUCdVF8a8JMpwM1TpW83TiMjc4X1mM',
    displayName: 'Karma Widget',
    description: 'Delivers embeddable trust badges and the public widget SDK.',
    category: 'infra',
    role: 'worker',
    isFlagship: false,
  },
] as const;

function parseArgs(argv: string[]) {
  const named: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) named[a.slice(2)] = argv[++i] ?? '';
  }
  return named;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const origin = (args.origin ?? 'https://agentkarma.io').replace(/\/$/, '');

  // 1. Upsert the organization
  await upsertOrganization({
    ...ORG,
    website: origin,
  });
  console.log(`[seed-org] Upserted organization "${ORG.slug}"`);

  // 2. Claim each member wallet + add to org
  for (const m of MEMBERS) {
    await claimWallet(m.wallet, m.displayName, m.description, origin, m.category);
    await addOrganizationMember(ORG.slug, m.wallet, m.role);
    console.log(`[seed-org] ✓ ${m.displayName} (${m.wallet.slice(0, 8)}…) claimed + added as "${m.role}"`);
  }

  // 3. Publish a manifest + verified Tier 3 signal for every member.
  //    Flagship is served at the canonical /.well-known/agentkarma.json;
  //    workers are served at /.well-known/agentkarma/{wallet}.json.
  const CAPABILITIES_BY_ROLE: Record<string, string[]> = {
    flagship: [
      'karma.score.read',
      'karma.badge.render',
      'karma.attestation.submit',
      'karma.feedback.submit',
    ],
    worker: ['karma.read', 'karma.badge'],
  };

  for (const m of MEMBERS) {
    const manifest: Record<string, unknown> = {
      schema: 'agentkarma.v1',
      wallet: m.wallet,
      name: `${ORG.name} — ${m.displayName}`,
      description: m.description,
      website: origin,
      github: 'https://github.com/agentkarma',
      category: m.category,
      capabilities: CAPABILITIES_BY_ROLE[m.role] ?? ['karma.read'],
      endpoints: [
        { kind: 'http', url: `${origin}/agent/${m.wallet}`, description: 'Agent profile' },
        { kind: 'http', url: `${origin}/api/v2/score/${m.wallet}`, description: 'Two-faced karma score (JSON)' },
        { kind: 'http', url: `${origin}/api/badge/${m.wallet}`, description: 'Embeddable SVG badge' },
        ...(m.isFlagship
          ? [{ kind: 'http', url: `${origin}/org/${ORG.slug}`, description: 'Fleet view' }]
          : []),
      ],
    };

    const filePath = m.isFlagship
      ? path.join(process.cwd(), 'public', '.well-known', 'agentkarma.json')
      : path.join(process.cwd(), 'public', '.well-known', 'agentkarma', `${m.wallet}.json`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    const manifestUrl = m.isFlagship
      ? `${origin}/.well-known/agentkarma.json`
      : `${origin}/.well-known/agentkarma/${m.wallet}.json`;

    const parsed = parseAgentKarmaManifest(manifest) as ParsedManifest;
    await upsertAgentManifest({
      agentWallet: m.wallet,
      sourceType:  'self_hosted',
      url:         manifestUrl,
      raw:         manifest,
      parsed,
      verified:    true,
    });
    await insertSignalEvents(
      [buildManifestSignal(m.wallet, { sourceType: 'self_hosted', verified: true, url: manifestUrl })],
      { overwrite: true },
    );
    console.log(`[seed-org] ✓ ${m.displayName}: manifest + verified Tier 3 signal (${path.relative(process.cwd(), filePath)})`);
  }

  const flagship = MEMBERS.find((m) => m.isFlagship)!;
  console.log('');
  console.log('[seed-org] Done.');
  console.log(`  Fleet view:      ${origin}/org/${ORG.slug}`);
  console.log(`  Flagship:        ${origin}/agent/${flagship.wallet}`);
  console.log('  After deploy, trigger a refresh so Tier 3 lands in scores:');
  console.log(`    curl -X POST ${origin}/api/score/refresh`);
}

main().catch((err) => {
  console.error('[seed-org] Failed:', err);
  process.exit(1);
});
