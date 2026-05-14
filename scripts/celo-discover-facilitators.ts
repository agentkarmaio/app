/**
 * Discover candidate Celo x402 facilitator addresses by heuristic.
 *
 * Scans ERC-20 Transfer events for USDC/USDT/USDm over a block range, then
 * ranks addresses by a "facilitator-likeness" score:
 *   - many distinct counterparties (facilitators route between many wallets)
 *   - bidirectional flow (received + sent in same window)
 *   - high event count
 *
 * Filters out the token contracts themselves and any well-known burn/zero
 * addresses. Output is a ranked candidates list — human review still required
 * before adding to `src/config/celo-x402.ts:CELO_X402_FACILITATORS`.
 *
 * Usage:
 *   bun run scripts/celo-discover-facilitators.ts [blockRange=5000] [topN=15]
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
import { celo } from 'viem/chains';
import { CELO_X402_TOKENS } from '../src/config/celo-x402';

const ERC20_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

const BURN = '0x0000000000000000000000000000000000000000';

const blockRange = BigInt(process.argv[2] ?? '5000');
const topN = Number(process.argv[3] ?? '15');

const client = createPublicClient({ chain: celo, transport: http() });
const tip = await client.getBlockNumber();
const fromBlock = tip - blockRange;
const toBlock = tip;

console.log(`Celo tip: ${tip}`);
console.log(`scanning ${fromBlock}..${toBlock} (${blockRange} blocks)`);
console.log(`tokens: ${CELO_X402_TOKENS.map((t) => t.symbol).join(', ')}`);
console.log('');

interface Stats {
  totalEvents: number;
  asSender: number;
  asReceiver: number;
  /** Distinct counterparties when this address was the sender. */
  outCounterparties: Set<string>;
  /** Distinct counterparties when this address was the receiver. */
  inCounterparties: Set<string>;
  /** Set of token symbols this address touched. */
  tokens: Set<string>;
  /** Volume aggregates per direction, in human-normalized units. */
  volumeSent: number;
  volumeReceived: number;
}

const stats = new Map<string, Stats>();

function getOrInit(addr: string): Stats {
  let s = stats.get(addr);
  if (!s) {
    s = {
      totalEvents: 0,
      asSender: 0,
      asReceiver: 0,
      outCounterparties: new Set(),
      inCounterparties: new Set(),
      tokens: new Set(),
      volumeSent: 0,
      volumeReceived: 0,
    };
    stats.set(addr, s);
  }
  return s;
}

// Public Celo RPC (forno.celo.org) times out on large log-range requests for
// stablecoin contracts. Chunk in 500-block windows. Each chunk is independent;
// occasional flaky responses retry within viem's transport.
// Adaptive chunking: USDT on Celo can blow the public RPC's response-size cap
// even at 500 blocks. Halve and retry on "too large" / timeout failures down
// to a 25-block floor. 100-block start is empirically reliable.
async function fetchRangeAdaptive(
  tokenAddr: `0x${string}`,
  start: bigint,
  end: bigint,
  initialChunk = 100n,
): Promise<Awaited<ReturnType<typeof client.getLogs<typeof ERC20_TRANSFER>>>> {
  const out: Awaited<ReturnType<typeof client.getLogs<typeof ERC20_TRANSFER>>> = [];
  let cursor = start;
  let chunk = initialChunk;

  while (cursor <= end) {
    const stop = cursor + chunk - 1n < end ? cursor + chunk - 1n : end;
    try {
      const logs = await client.getLogs({
        address: tokenAddr,
        event: ERC20_TRANSFER,
        fromBlock: cursor,
        toBlock: stop,
      });
      out.push(...logs);
      cursor = stop + 1n;
      // Grow chunk back up after success, capped at initial.
      if (chunk < initialChunk) chunk = chunk * 2n > initialChunk ? initialChunk : chunk * 2n;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const tooLarge =
        msg.includes('response too large') || msg.includes('timed out') || msg.includes('timeout');
      if (tooLarge && chunk > 25n) {
        chunk = chunk / 2n;
        continue; // retry same cursor with smaller chunk
      }
      throw err;
    }
  }
  return out;
}

async function fetchChunked(tokenAddr: `0x${string}`) {
  return fetchRangeAdaptive(tokenAddr, fromBlock, toBlock);
}

for (const token of CELO_X402_TOKENS) {
  process.stdout.write(`  ${token.symbol}: fetching (chunked)… `);
  const logs = await fetchChunked(token.address);
  console.log(`${logs.length} events`);

  for (const log of logs) {
    const { from, to, value } = log.args;
    if (!from || !to || value === undefined) continue;
    if (from === BURN || to === BURN) continue;

    const fromLc = from.toLowerCase();
    const toLc = to.toLowerCase();
    const amt = Number(value) / 10 ** token.decimals;

    const sender = getOrInit(fromLc);
    sender.totalEvents++;
    sender.asSender++;
    sender.outCounterparties.add(toLc);
    sender.tokens.add(token.symbol);
    sender.volumeSent += amt;

    const receiver = getOrInit(toLc);
    receiver.totalEvents++;
    receiver.asReceiver++;
    receiver.inCounterparties.add(fromLc);
    receiver.tokens.add(token.symbol);
    receiver.volumeReceived += amt;
  }
}

// Drop token contracts themselves (they appear as `from` on mints / `to` on
// burns in some patterns) and any address with <5 events — pure noise.
const tokenAddrs = new Set(CELO_X402_TOKENS.map((t) => t.address.toLowerCase()));

const candidates = [...stats.entries()]
  .filter(([addr, s]) => !tokenAddrs.has(addr) && s.totalEvents >= 5)
  .map(([addr, s]) => {
    const bidirectional = s.asSender > 0 && s.asReceiver > 0;
    const totalCounterparties = new Set([
      ...s.outCounterparties,
      ...s.inCounterparties,
    ]).size;
    // Facilitator-likeness: high distinct counterparties + bidirectional flow.
    // Scale event count by counterparty diversity so a 1000-tx whale paying
    // 1 partner doesn't dominate a 100-tx facilitator routing to 80 partners.
    const score = bidirectional ? totalCounterparties * Math.sqrt(s.totalEvents) : 0;
    return { addr, ...s, totalCounterparties, score };
  })
  .filter((c) => c.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, topN);

console.log('');
console.log(`Top ${candidates.length} facilitator candidates (by counterparty diversity × √events):`);
console.log('');
console.log(
  '  rank  address                                       events    senders  receivers  tokens  vol-out   vol-in    score'.padEnd(
    140,
  ),
);
console.log('  ' + '-'.repeat(138));

for (const [i, c] of candidates.entries()) {
  const rank = String(i + 1).padStart(4);
  const addr = c.addr;
  const events = String(c.totalEvents).padStart(6);
  const senders = String(c.outCounterparties.size).padStart(7);
  const receivers = String(c.inCounterparties.size).padStart(9);
  const tokens = [...c.tokens].join('+').padEnd(7);
  const volOut = c.volumeSent.toFixed(0).padStart(8);
  const volIn = c.volumeReceived.toFixed(0).padStart(8);
  const score = c.score.toFixed(1).padStart(7);
  console.log(
    `  ${rank}  ${addr}  ${events}  ${senders}  ${receivers}  ${tokens}  ${volOut}  ${volIn}  ${score}`,
  );
}

console.log('');
console.log('Inspect each candidate before adding to CELO_X402_FACILITATORS:');
for (const c of candidates.slice(0, 5)) {
  console.log(`  https://celoscan.io/address/${c.addr}`);
}
