/**
 * heartbeat-drain — out-of-process Dead Man's Switch liveness drain. The
 * defense-in-depth layer that survives a wedged web app (mirrors keep-fresh).
 *
 * Walks every declared, non-terminal succession (all chains), derives liveness
 * from each agent's last meaningful tx, emits Tier-2 heartbeat_observed /
 * heartbeat_lapsed signals, and persists the derived status. AK never executes
 * a will — pure observation + scoring.
 *
 * Usage:
 *   bun run src/scripts/heartbeat-drain.ts [--batch N] [--max-batches N] [--chain solana|celo|arc|stellar]
 *
 * Env (provide as CI secrets when run externally):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — DB writes
 */

import { drainHeartbeatsOnce } from './../successions/heartbeat-worker';
import { isChain, type Chain } from '../db/schema';
import { requireEnv } from '../lib/require-env';

// DB writes are mandatory. Fail at line 1 with a clear message if the floor's
// secrets are unset (see the 2026-06-23 outage — empty CI secrets crashed every
// run silently). Mirrors keep-fresh.
const REQUIRED_ENV = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

function numArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function chainArg(): Chain | undefined {
  const i = process.argv.indexOf('--chain');
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (!isChain(v)) throw new Error(`--chain must be one of solana|celo|arc|stellar, got: ${v}`);
  return v;
}

const batch = numArg('--batch', 500);
const maxBatches = numArg('--max-batches', 20);
const chain = chainArg();

async function main() {
  requireEnv(REQUIRED_ENV);
  const start = Date.now();
  console.log(`[heartbeat-drain] start · batch=${batch} maxBatches=${maxBatches} chain=${chain ?? 'all'}`);

  let totalClaimed = 0;
  let totalLapsed = 0;
  let totalObserved = 0;
  let totalTransitioned = 0;
  let totalErrors = 0;

  for (let i = 0; i < maxBatches; i++) {
    const r = await drainHeartbeatsOnce(batch, chain);
    totalClaimed += r.claimed;
    totalLapsed += r.lapsed;
    totalObserved += r.observed;
    totalTransitioned += r.transitioned;
    totalErrors += r.errors.length;
    if (r.transitioned > 0 || r.lapsed > 0 || r.errors.length > 0) {
      console.log(
        `[heartbeat-drain] batch ${i + 1}/${maxBatches}: claimed=${r.claimed} ` +
        `observed=${r.observed} lapsed=${r.lapsed} transitioned=${r.transitioned} errors=${r.errors.length}`,
      );
    }
    for (const e of r.errors) console.error(`[heartbeat-drain] error ${e.chain}:${e.agentWallet}: ${e.message}`);
    // Stop once a full batch was smaller than the limit (drained everything).
    if (r.claimed < batch) break;
  }

  console.log(
    `[heartbeat-drain] done: claimed=${totalClaimed} observed=${totalObserved} ` +
    `lapsed=${totalLapsed} transitioned=${totalTransitioned} errors=${totalErrors} ` +
    `in ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );
}

main().catch((err) => {
  console.error('[heartbeat-drain] fatal:', err);
  process.exit(1);
});
