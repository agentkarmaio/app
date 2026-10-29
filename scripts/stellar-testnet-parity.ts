/**
 * Parity check: AgentKarma stellar-testnet payment legs vs an external
 * indexer's CSV export. Read-only (public GETs only).
 *
 * Run:
 *   bun run scripts/stellar-testnet-parity.ts --csv path/to/export.csv [--base https://agentkarma.io] [--received-only]
 *
 * `--received-only` checks the received side against a deployment that predates
 * `direction` (prod before this ships): no sent legs on either side.
 *
 * CSV: the partner's payments export (received legs; `payer_agent_id` marks the
 * sender's SENT leg). With `counted` / `excluded_reason` columns those are
 * compared too; without them only amounts and directions are. Exit 0 only with
 * zero mismatches on every leg and on each agent's totals.
 *
 * Pages explore with `limit=100&offset=…` (the route's cap), then each agent's
 * `/payments?direction=all` by cursor. Honors 429 `retry-after`.
 */
import { readFileSync } from 'node:fs';
import { compareLegs, parseCsv, partnerLegs, usdcToUnits, type ParityLeg } from '@/lib/stellar-testnet-parity';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const csvPath = arg('csv');
const receivedOnly = process.argv.includes('--received-only');
const base = (arg('base') ?? 'https://agentkarma.io').replace(/\/$/, '');
if (!csvPath) { console.error('usage: --csv <export.csv> [--base <url>]'); process.exit(2); }

async function getJson<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
    if (res.status === 429 && attempt < 5) {
      await Bun.sleep((Number(res.headers.get('retry-after')) || 10) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
    return (await res.json()) as T;
  }
}

interface ExploreRow { agentId: number | null }
interface PaymentsPage {
  payments: Array<{ id: string; direction?: 'received' | 'sent'; amount: string; counted: boolean; excludedReason: string | null }>;
  nextCursor: string | null;
}

const agentIds: number[] = [];
for (let offset = 0; ; offset += 100) {
  const page = await getJson<{ wallets: ExploreRow[] }>(`/api/explore/agents?chain=stellar-testnet&limit=100&offset=${offset}`);
  for (const w of page.wallets) if (w.agentId != null) agentIds.push(w.agentId);
  if (page.wallets.length < 100) break;
}

const ak: ParityLeg[] = [];
for (const agentId of agentIds) {
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ limit: '200', ...(receivedOnly ? {} : { direction: 'all' }), ...(cursor ? { cursor } : {}) });
    const page: PaymentsPage = await getJson(`/api/v2/agent/stellar-testnet/${agentId}/payments?${qs}`);
    for (const p of page.payments) {
      ak.push({ id: p.id, agentId, direction: p.direction ?? 'received', units: usdcToUnits(p.amount), counted: p.counted, reason: p.excludedReason });
    }
    cursor = page.nextCursor;
  } while (cursor);
}

const USDC_ASSET = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const partner = parseCsv(readFileSync(csvPath, 'utf8')).flatMap((r) => partnerLegs(r, USDC_ASSET)).filter((l) => !receivedOnly || l.direction === 'received');
const { mismatches, totals } = compareLegs(ak, partner);

const usdc = (u: bigint) => `${u / 10_000_000n}.${(u % 10_000_000n).toString().padStart(7, '0')}`;
let sums = [0n, 0n, 0n];
for (const [, [a]] of totals) sums = [sums[0] + a.received, sums[1] + a.sent, sums[2] + a.counted];
console.log(`agents ${totals.size} | AK legs ${ak.length} | partner legs ${partner.length}`);
console.log(`AK totals: received ${usdc(sums[0])} sent ${usdc(sums[1])} counted ${usdc(sums[2])}`);
console.log(`mismatches: ${mismatches.length}`);
for (const m of mismatches.slice(0, 50)) console.log(`  ${m}`);
process.exit(mismatches.length === 0 ? 0 : 1);
