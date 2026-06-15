/**
 * Stellar facilitator discovery probe.
 *
 * The Stellar x402 indexer matches settlements by the OZ Channels facilitator's
 * `G...` account — the fee-bump outer source (`fee_account`) of every settled
 * x402 payment. That account is not published anywhere; discover it here, then
 * seed STELLAR_FACILITATORS in src/config/stellar-x402.ts (the indexer is a
 * no-op until at least one entry exists).
 *
 * No env needed for testnet (public Horizon + Soroban RPC). For pubnet scans,
 * STELLAR_RPC_URL is used if set, else a public mainnet RPC.
 *
 * ── Modes ────────────────────────────────────────────────────────────────────
 *   bun run src/scripts/stellar-facilitator-probe.ts <TX_HASH> [--pubnet]
 *     Mode A — resolve one settled tx: prints source_account + fee_account.
 *     The facilitator is the fee_account. This is the reliable path: run one
 *     OZ Channels payment (https://channels.openzeppelin.com/testnet/gen),
 *     grab the settlement tx hash from the client's PAYMENT-RESPONSE, pass it.
 *
 *   bun run src/scripts/stellar-facilitator-probe.ts --scan [--pubnet] [--limit=N] [--ledgers=N]
 *     Mode B — scan recent USDC SAC `transfer` events, resolve each tx's
 *     fee_account via Horizon, and rank the most frequent ones (candidate
 *     facilitators) with counts + sample hashes. Needs existing settlement
 *     activity in the lookback window.
 *
 * Default network: testnet. Add --pubnet for mainnet.
 */
import { rpc, xdr } from '@stellar/stellar-sdk';
import { USDC_SAC, type StellarNetwork } from '../config/stellar-x402';

const HORIZON: Record<StellarNetwork, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  pubnet: 'https://horizon.stellar.org',
};

const SOROBAN_RPC: Record<StellarNetwork, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  pubnet: process.env.STELLAR_RPC_URL ?? 'https://mainnet.sorobanrpc.com',
};

interface HorizonTx {
  hash: string;
  successful: boolean;
  source_account: string;
  /** Outer source of the fee-bump envelope — the facilitator on settled x402. */
  fee_account?: string;
}

async function fetchTx(network: StellarNetwork, hash: string): Promise<HorizonTx | null> {
  const res = await fetch(`${HORIZON[network]}/transactions/${hash}`);
  if (!res.ok) return null;
  return (await res.json()) as HorizonTx;
}

async function modeA(network: StellarNetwork, hash: string): Promise<void> {
  const tx = await fetchTx(network, hash);
  if (!tx) {
    console.error(`tx ${hash} not found on ${network}`);
    process.exit(1);
  }
  const facilitator = tx.fee_account ?? tx.source_account;
  console.log(
    JSON.stringify(
      {
        network,
        tx: hash,
        successful: tx.successful,
        source_account: tx.source_account,
        fee_account: tx.fee_account ?? '(none — tx was not fee-bumped)',
        facilitatorCandidate: facilitator,
      },
      null,
      2,
    ),
  );
  console.log(
    `\n→ Seed STELLAR_FACILITATORS:\n  { account: '${facilitator}', name: 'OZ Channels', discoveredAt: '<YYYY-MM-DD>' }`,
  );
  console.log('  Confirm it is stable across several payments before trusting it.');
}

async function modeB(network: StellarNetwork, limit: number, ledgerLookback: number): Promise<void> {
  const sac = USDC_SAC[network];
  const server = new rpc.Server(SOROBAN_RPC[network]);

  const { sequence: latest } = await server.getLatestLedger();
  const startLedger = Math.max(1, latest - ledgerLookback);
  const transferTopic = xdr.ScVal.scvSymbol('transfer').toXDR('base64');

  let page: Awaited<ReturnType<typeof server.getEvents>>;
  try {
    page = await server.getEvents({
      startLedger,
      filters: [{ type: 'contract', contractIds: [sac], topics: [[transferTopic, '*', '*']] }],
      limit,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : JSON.stringify(err);
    console.error(
      `getEvents failed (ledgers ${startLedger}..${latest} on ${network}). The RPC retention window may be ` +
        `shorter than --ledgers=${ledgerLookback}; lower it, or use Mode A with a known tx hash.\n${detail}`,
    );
    process.exit(1);
  }

  console.log(
    `Scanned ${page.events.length} USDC SAC transfer events on ${network} (ledgers ${startLedger}..${latest}, SAC ${sac}).`,
  );

  const txHashes = [...new Set(page.events.map((e) => e.txHash).filter(Boolean))];
  const tally = new Map<string, { count: number; samples: string[] }>();
  for (const hash of txHashes) {
    const tx = await fetchTx(network, hash);
    if (!tx?.successful) continue;
    const acct = tx.fee_account ?? tx.source_account;
    const cur = tally.get(acct) ?? { count: 0, samples: [] };
    cur.count += 1;
    if (cur.samples.length < 3) cur.samples.push(hash);
    tally.set(acct, cur);
  }

  const ranked = [...tally.entries()].sort((a, b) => b[1].count - a[1].count);
  if (ranked.length === 0) {
    console.error(
      'No settled USDC transfers in the window. Run an OZ Channels payment first, or widen --ledgers.',
    );
    process.exit(1);
  }

  console.log('\nCandidate facilitators (most frequent fee/source accounts):');
  for (const [acct, { count, samples }] of ranked.slice(0, 5)) {
    console.log(`  ${acct}  ×${count}   e.g. ${samples.join(', ')}`);
  }
  console.log(
    '\n→ The top account with a high, stable count is the OZ Channels facilitator. Seed it into STELLAR_FACILITATORS.',
  );
}

function numArg(args: string[], flag: string, fallback: number): number {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const args = process.argv.slice(2);
const network: StellarNetwork = args.includes('--pubnet') ? 'pubnet' : 'testnet';
const limit = numArg(args, '--limit', 200);
const ledgerLookback = numArg(args, '--ledgers', 8000); // ~11h at ~5s/ledger
const txHash = args.find((a) => /^[0-9a-f]{64}$/i.test(a));

if (txHash) {
  await modeA(network, txHash);
} else if (args.includes('--scan')) {
  await modeB(network, limit, ledgerLookback);
} else {
  console.log(
    'Usage:\n' +
      '  bun run src/scripts/stellar-facilitator-probe.ts <TX_HASH> [--pubnet]\n' +
      '  bun run src/scripts/stellar-facilitator-probe.ts --scan [--pubnet] [--limit=N] [--ledgers=N]',
  );
  process.exit(1);
}
