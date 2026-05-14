/**
 * One-shot probe of the Celo x402 indexer skeleton.
 *
 * Usage:
 *   bun run scripts/celo-x402-probe.ts [fromBlock] [toBlock]
 *
 * Defaults to the most recent ~2000 blocks. Prints any matching settlement
 * transfers from the curated facilitator list. Empty curated list → 0 matches
 * (expected until M2 onboards facilitators).
 */

import { createPublicClient, http } from 'viem';
import { celo } from 'viem/chains';
import {
  discoverFacilitatorTransfers,
  CELO_X402_FACILITATORS,
} from '../src/indexer/celo-x402';

const client = createPublicClient({ chain: celo, transport: http() });
const tip = await client.getBlockNumber();

const fromBlock = process.argv[2] ? BigInt(process.argv[2]) : tip - BigInt(2000);
const toBlock = process.argv[3] ? BigInt(process.argv[3]) : tip;

console.log(`Celo tip: ${tip}`);
console.log(`scanning blocks ${fromBlock}..${toBlock} (${toBlock - fromBlock} blocks)`);
console.log(`curated facilitators: ${CELO_X402_FACILITATORS.length}`);

if (CELO_X402_FACILITATORS.length === 0) {
  console.log('');
  console.log('No facilitators curated yet — skeleton compiles and runs.');
  console.log('Populate src/config/celo-x402.ts:CELO_X402_FACILITATORS to');
  console.log('start indexing real settlements (M2 milestone activity).');
  process.exit(0);
}

const matches = await discoverFacilitatorTransfers({ fromBlock, toBlock });

console.log(`matches: ${matches.length}`);
for (const m of matches.slice(0, 20)) {
  console.log(
    `  ${m.direction.padEnd(8)} ${m.token.symbol} ${m.value.toFixed(2).padStart(10)} ` +
      `${m.from.slice(0, 6)}…→${m.to.slice(0, 6)}… block ${m.blockNumber} tx ${m.txHash.slice(0, 10)}…`,
  );
}
if (matches.length > 20) console.log(`  …and ${matches.length - 20} more`);
