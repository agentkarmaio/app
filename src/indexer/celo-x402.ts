/**
 * Celo x402 indexer — skeleton (M2 milestone deliverable).
 *
 * Scans ERC-20 Transfer events for the canonical x402 settlement tokens
 * (USDC, USDT, USDm), filtered by `from` or `to` matching a curated
 * facilitator address. Each matching transfer becomes a candidate Tier-1
 * receipt: facilitator -> payee = "payment delivered to provider", payer ->
 * facilitator = "consumer paid facilitator".
 *
 * v0 surface: discoverFacilitatorTransfers() returns the raw decoded events
 * for a given block range. Persistence into the transactions table + signal
 * generation lives in the full M2 build.
 */

import { createPublicClient, http, parseAbiItem, type Log } from 'viem';
import { celo } from 'viem/chains';
import {
  CELO_X402_TOKENS,
  CELO_X402_FACILITATORS,
  getCeloX402Token,
  type CeloX402Token,
} from '@/config/celo-x402';

const ERC20_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

function makeClient() {
  const rpcUrl = process.env.CELO_RPC_URL;
  return createPublicClient({ chain: celo, transport: http(rpcUrl) });
}

export interface CeloX402Transfer {
  txHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
  token: CeloX402Token;
  from: `0x${string}`;
  to: `0x${string}`;
  /** Raw uint256 token value. Divide by 10^decimals for human units. */
  rawValue: bigint;
  /** Human-units float, derived from rawValue / 10^decimals. */
  value: number;
  /** Direction relative to the facilitator we watched. */
  direction: 'incoming' | 'outgoing';
  /** Which facilitator address this matched on (lowercased). */
  facilitator: `0x${string}`;
}

interface DiscoverOpts {
  fromBlock: bigint;
  toBlock: bigint | 'latest';
  /** Optional subset of facilitator addresses; defaults to the full curated list. */
  facilitators?: `0x${string}`[];
}

/**
 * Read Transfer events for x402 settlement tokens that involve a known Celo
 * facilitator. Returns one record per direction-match. No DB writes; the
 * caller decides what to do with them.
 *
 * Block ranges over ~5k blocks at a time are typically safe on Celo's public
 * RPC. Larger ranges may need a paid RPC (Alchemy / Quicknode / Forno).
 */
export async function discoverFacilitatorTransfers(
  opts: DiscoverOpts,
): Promise<CeloX402Transfer[]> {
  const facilitatorPool =
    opts.facilitators ?? CELO_X402_FACILITATORS.map((f) => f.address);
  if (facilitatorPool.length === 0) {
    return []; // empty curated list — no-op until #15 populates it
  }
  const facilitatorSet = new Set(facilitatorPool.map((a) => a.toLowerCase()));

  const client = makeClient();
  const out: CeloX402Transfer[] = [];

  // Query one token at a time so the topic filter stays simple and the public
  // RPC doesn't reject for unbounded result sets.
  for (const token of CELO_X402_TOKENS) {
    const logs = await client.getLogs({
      address: token.address,
      event: ERC20_TRANSFER,
      fromBlock: opts.fromBlock,
      toBlock: opts.toBlock,
    });

    for (const log of logs) {
      const record = toRecord(log, token, facilitatorSet);
      if (record) out.push(record);
    }
  }

  return out;
}

function toRecord(
  log: Log<bigint, number, false, typeof ERC20_TRANSFER>,
  token: CeloX402Token,
  facilitatorSet: Set<string>,
): CeloX402Transfer | null {
  const { from, to, value } = log.args;
  if (!from || !to || value === undefined) return null;

  const fromLc = from.toLowerCase();
  const toLc = to.toLowerCase();
  let facilitator: `0x${string}` | null = null;
  let direction: 'incoming' | 'outgoing' | null = null;
  if (facilitatorSet.has(fromLc)) {
    facilitator = from as `0x${string}`;
    direction = 'outgoing';
  } else if (facilitatorSet.has(toLc)) {
    facilitator = to as `0x${string}`;
    direction = 'incoming';
  }
  if (!facilitator || !direction) return null;

  return {
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    token,
    from: from as `0x${string}`,
    to: to as `0x${string}`,
    rawValue: value,
    value: Number(value) / 10 ** token.decimals,
    direction,
    facilitator,
  };
}

export { getCeloX402Token, CELO_X402_TOKENS, CELO_X402_FACILITATORS };
