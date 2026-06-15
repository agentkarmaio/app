/**
 * Seed labeled DEMO bond lifecycle data across ALL chains.
 *
 * Until a real ownerless bond-escrow (contracts/agentkarma-bond-escrow) is
 * deployed, this lights up the entire bond pipeline + UI on clearly-flagged demo
 * data: every projected `bonds` row gets is_demo=true and an escrow_ref that
 * literally starts with "demo-escrow-", so nothing ever implies a real on-chain
 * bond.
 *
 * It builds a `BondEventSource` of realistic lifecycle fixtures (a mix of
 * in-flight, success-resolved, and failure-resolved bonds, one per chain) and
 * runs them through the SAME `bondProjector` a real escrow indexer will use —
 * so this exercises the exact production path (upsert bonds + bond_underwriters,
 * emit Tier-1 bond_opened/bond_resolved provider signals).
 *
 * CARDINAL DISCIPLINE: the emitted signals are presence-only — they lift the
 * bonded agent's badge + Tier-1 presence, never the evidence-gated ceiling. A
 * thin-file demo agent stays capped regardless of a flashy bond (enforced in the
 * scorer; the seeder just records the borrowed-capital signal).
 *
 * Usage:
 *   bun run src/scripts/seed-demo-bonds.ts            # all chains
 *   bun run src/scripts/seed-demo-bonds.ts --chain stellar
 *   bun run src/scripts/seed-demo-bonds.ts --dry      # print fixtures, no write
 */

import { CHAINS, isChain, type Chain } from '../db/schema';
import {
  runBondProjector,
  type BondEventSource,
  type BondLifecycleEvent,
} from '../indexer/bond-projection';

// ─── Per-chain demo address book (valid-format, deterministic, clearly demo) ───
//
// Formats match each chain so projection + FK behave like production. They are
// fixed fixtures, never real counterparties. The is_demo flag + "demo-escrow-"
// ref are the durable demo markers; addresses are valid-shaped so the chain-aware
// UI renders them correctly.

interface ChainActors {
  agentThin: string;   // young/thin-file agent being vouched for
  agentThick: string;  // alternate bonded agent (failure case)
  beneficiary: string;
  underwriters: string[];
}

const ACTORS: Record<Chain, ChainActors> = {
  solana: {
    agentThin:   'DemoBondThinAgentSo1ana1111111111111111111',
    agentThick:  'DemoBondThickAgentSo1ana2222222222222222222',
    beneficiary: 'DemoBondBenefSo1ana3333333333333333333333',
    underwriters: [
      'DemoBondUW1So1ana44444444444444444444444444',
      'DemoBondUW2So1ana55555555555555555555555555',
      'DemoBondUW3So1ana66666666666666666666666666',
    ],
  },
  celo: {
    agentThin:   '0xDe0000000000000000000000000000000000A001',
    agentThick:  '0xDe0000000000000000000000000000000000A002',
    beneficiary: '0xDe0000000000000000000000000000000000B001',
    underwriters: [
      '0xDe0000000000000000000000000000000000C001',
      '0xDe0000000000000000000000000000000000C002',
      '0xDe0000000000000000000000000000000000C003',
    ],
  },
  arc: {
    agentThin:   '0xDe1000000000000000000000000000000000A001',
    agentThick:  '0xDe1000000000000000000000000000000000A002',
    beneficiary: '0xDe1000000000000000000000000000000000B001',
    underwriters: [
      '0xDe1000000000000000000000000000000000C001',
      '0xDe1000000000000000000000000000000000C002',
      '0xDe1000000000000000000000000000000000C003',
    ],
  },
  stellar: {
    // Stellar G-addresses are 56 chars, base32 [A-Z2-7]. Deterministic demo set.
    agentThin:   'GDEMOBONDTHINAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2222',
    agentThick:  'GDEMOBONDTHICKAGENTBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB3333',
    beneficiary: 'GDEMOBONDBENEFICIARYCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC4444',
    underwriters: [
      'GDEMOBONDUNDERWRITER1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD5555',
      'GDEMOBONDUNDERWRITER2EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE6666',
      'GDEMOBONDUNDERWRITER3FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7777',
    ],
  },
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * Build a realistic 3-bond lifecycle per chain:
 *   1. OPEN (in-flight)         — thin agent, 2 underwriters, not yet resolved.
 *   2. RESOLVED SUCCESS         — thin agent delivered (3 underwriters, refunded).
 *   3. RESOLVED FAILURE         — thick agent failed (1 underwriter, stake → benef).
 * The success/failure pairs each emit BOTH an open and a resolve event so the
 * projector marks underwriters settled and derives Surety Karma correctly.
 */
function buildEventsForChain(chain: Chain): BondLifecycleEvent[] {
  const a = ACTORS[chain];
  const now = Date.now();
  const ts = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
  const ref = (n: number) => `demo-escrow-${chain}-${n}`;

  return [
    // 1. In-flight bond on the thin agent.
    {
      type: 'opened',
      chain,
      escrowRef: ref(1),
      bondedAgent: a.agentThin,
      beneficiary: a.beneficiary,
      taskRef: `demo-task-${chain}-inflight`,
      openTxHash: `demo-tx-open-${chain}-1`,
      stakes: [
        { underwriter: a.underwriters[0], amount: 250 },
        { underwriter: a.underwriters[1], amount: 150 },
      ],
      observedAt: ts(2),
    },
    // 2. Success-resolved bond on the thin agent (delivered before deadline).
    {
      type: 'opened',
      chain,
      escrowRef: ref(2),
      bondedAgent: a.agentThin,
      beneficiary: a.beneficiary,
      taskRef: `demo-task-${chain}-success`,
      openTxHash: `demo-tx-open-${chain}-2`,
      stakes: [
        { underwriter: a.underwriters[0], amount: 300 },
        { underwriter: a.underwriters[1], amount: 200 },
        { underwriter: a.underwriters[2], amount: 100 },
      ],
      observedAt: ts(10),
    },
    {
      type: 'resolved',
      chain,
      escrowRef: ref(2),
      bondedAgent: a.agentThin,
      beneficiary: a.beneficiary,
      success: true,
      resolveTxHash: `demo-tx-resolve-${chain}-2`,
      observedAt: ts(7),
    },
    // 3. Failure-resolved bond on the thick agent (deadline elapsed, no delivery).
    {
      type: 'opened',
      chain,
      escrowRef: ref(3),
      bondedAgent: a.agentThick,
      beneficiary: a.beneficiary,
      taskRef: `demo-task-${chain}-failure`,
      openTxHash: `demo-tx-open-${chain}-3`,
      stakes: [{ underwriter: a.underwriters[2], amount: 500 }],
      observedAt: ts(20),
    },
    {
      type: 'resolved',
      chain,
      escrowRef: ref(3),
      bondedAgent: a.agentThick,
      beneficiary: a.beneficiary,
      success: false,
      resolveTxHash: `demo-tx-resolve-${chain}-3`,
      observedAt: ts(12),
    },
  ];
}

function parseArgs(argv: string[]) {
  const named: Record<string, string> = {};
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry') dry = true;
    else if (arg.startsWith('--')) named[arg.slice(2)] = argv[++i] ?? '';
  }
  return { named, dry };
}

async function main() {
  const { named, dry } = parseArgs(process.argv.slice(2));

  // Refuse to write demo fixtures into a production DB unless explicitly opted
  // in. A --dry run (no writes) is always allowed. The is_demo flag keeps these
  // rows out of real scores, but seeding them into prod is still a footgun.
  if (!dry && process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    console.error(
      '[seed-bonds] Refusing to seed DEMO bonds with NODE_ENV=production. ' +
        'Set ALLOW_DEMO_SEED=true to override (writes is_demo=true fixtures).',
    );
    process.exit(1);
  }

  let chains: Chain[] = [...CHAINS];
  if (named.chain) {
    if (!isChain(named.chain)) {
      console.error(`Invalid --chain: ${named.chain}. One of: ${CHAINS.join(', ')}`);
      process.exit(1);
    }
    chains = [named.chain];
  }

  const events: BondLifecycleEvent[] = chains.flatMap(buildEventsForChain);

  console.log(`[seed-bonds] DEMO bond lifecycle — chains: ${chains.join(', ')}`);
  console.log(`[seed-bonds] ${events.length} lifecycle events (is_demo=true, escrow_ref="demo-escrow-…").`);

  if (dry) {
    for (const ev of events) {
      if (ev.type === 'opened') {
        console.log(`  OPEN     ${ev.chain} ${ev.escrowRef} agent=${ev.bondedAgent.slice(0, 10)}… stakes=${ev.stakes.length}`);
      } else {
        console.log(`  RESOLVE  ${ev.chain} ${ev.escrowRef} ${ev.success ? 'SUCCESS' : 'FAILURE'}`);
      }
    }
    console.log('[seed-bonds] --dry: no writes performed.');
    return;
  }

  const source: BondEventSource = { events: async () => events, isDemo: true };
  const result = await runBondProjector(source);

  console.log(`[seed-bonds] Done. Projected ${result.fetched} events; ${result.inserted} signals upserted.`);
  console.log('[seed-bonds] Trigger a rescore so bond signals blend into provider badges/presence:');
  console.log('       bun run src/scripts/rescore-dirty.ts');
}

main().catch((err) => {
  console.error('[seed-bonds] Failed:', err);
  process.exit(1);
});
