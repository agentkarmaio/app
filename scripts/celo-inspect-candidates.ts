/**
 * Inspect top candidates from celo-discover-facilitators for x402 signal.
 *
 * For each address, fetches:
 *  - getCode → EOA vs contract (x402 facilitators are typically EOAs / server wallets)
 *  - 3 most-recent ERC-20 transfers it participated in (sender or receiver)
 *  - tx input-data prefix for those → ERC-3009 transferWithAuthorization
 *    selector indicates x402-shaped usage (x402 relays gasless transfers)
 *
 * Output: pass/fail per signal so we can decide which to add to
 * CELO_X402_FACILITATORS without manual celoscan diving.
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
import { celo } from 'viem/chains';

const ERC20_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

// ERC-3009 transferWithAuthorization function selector (first 4 bytes of
// keccak256("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"))
const ERC3009_SELECTOR = '0xe3ee160e';

// Top candidates from discovery script (1000-block scan):
const CANDIDATES: { addr: `0x${string}`; note: string }[] = [
  { addr: '0xad6cea45f98444a922a2b4fe96b8c90f0862d2f4', note: 'all 3 tokens, 25 senders + 35 receivers' },
  { addr: '0x7f8946b257ad9a8fa55704120957901741a3346c', note: 'all 3 tokens, balanced 12/10' },
  { addr: '0x5dc631ad6c26bea1a59fbf2c2680cf3df43d249f', note: 'USDT+USDm, balanced 9/9, $3.5k vol' },
  { addr: '0x953f87a2c26344d4a667a640758a1fa038eea80e', note: 'USDC+USDT, balanced 10/11' },
  { addr: '0xa1777e082fa1746eb78dd9c1fbb515419cf6e538', note: 'USDC only, 15 senders, $942 vol' },
];

// Celo stablecoin contracts (subset of indexer tokens):
const STABLES = [
  { sym: 'USDC', addr: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as const },
  { sym: 'USDT', addr: '0x48065fBBE25f71C9282ddf5e1cD6D6A887483D5e' as const },
  { sym: 'USDm', addr: '0x765DE816845861e75A25fCa122bb6898B8B1282a' as const },
];

const client = createPublicClient({ chain: celo, transport: http() });
const tip = await client.getBlockNumber();

console.log(`Celo tip: ${tip}`);
console.log('');

for (const c of CANDIDATES) {
  console.log(`────  ${c.addr}  ────`);
  console.log(`  hint: ${c.note}`);

  // 1. EOA vs contract
  const code = await client.getCode({ address: c.addr });
  const isContract = !!code && code !== '0x';
  console.log(`  type: ${isContract ? 'CONTRACT' : 'EOA (server wallet)'}`);

  // 2. Recent stablecoin transfers — scan last 200 blocks across all stables
  let lastFew: Array<{ token: string; tx: `0x${string}`; direction: string }> = [];
  for (const t of STABLES) {
    try {
      const logs = await client.getLogs({
        address: t.addr,
        event: ERC20_TRANSFER,
        fromBlock: tip - BigInt(200),
        toBlock: tip,
        args: { from: c.addr },
      });
      const logs2 = await client.getLogs({
        address: t.addr,
        event: ERC20_TRANSFER,
        fromBlock: tip - BigInt(200),
        toBlock: tip,
        args: { to: c.addr },
      });
      for (const l of logs) lastFew.push({ token: t.sym, tx: l.transactionHash, direction: 'out' });
      for (const l of logs2) lastFew.push({ token: t.sym, tx: l.transactionHash, direction: 'in' });
    } catch {
      /* skip token on RPC error */
    }
  }
  lastFew = lastFew.slice(0, 3);

  if (lastFew.length === 0) {
    console.log('  recent: none in last 200 blocks');
    console.log('');
    continue;
  }

  // 3. Check tx input for ERC-3009 selector (= x402 signature)
  let erc3009Hits = 0;
  for (const f of lastFew) {
    const tx = await client.getTransaction({ hash: f.tx });
    const usesErc3009 = tx.input.startsWith(ERC3009_SELECTOR);
    if (usesErc3009) erc3009Hits++;
    console.log(
      `  recent: ${f.direction.padEnd(3)} ${f.token} ${f.tx.slice(0, 12)}… ` +
        `${usesErc3009 ? '[ERC-3009 ✓]' : `[input ${tx.input.slice(0, 10)}]`}`,
    );
  }

  const verdict =
    !isContract && erc3009Hits > 0
      ? 'LIKELY X402 FACILITATOR ✓'
      : isContract
        ? 'contract — probably not a facilitator EOA'
        : 'EOA but no ERC-3009 in sampled txs — needs deeper check';
  console.log(`  verdict: ${verdict}`);
  console.log('');
}
