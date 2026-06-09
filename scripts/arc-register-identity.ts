/**
 * Register AgentKarma's ERC-8004 identity on Arc Testnet.
 *
 * Mints AK's agent NFT on the Arc IdentityRegistry, binding its validator
 * wallet to the published agentURI. Mirrors the Stellar/Celo on-chain-write
 * pattern: simulate first, broadcast only behind --execute.
 *
 *   bun run scripts/arc-register-identity.ts            # dry run (simulate)
 *   bun run scripts/arc-register-identity.ts --execute  # broadcast the mint
 *
 * Env:
 *   ARC_RPC_URL    optional RPC override (defaults to arcTestnet public RPC)
 *   ARC_AGENT_URI  optional agentURI override (defaults to AK's hosted agent.json)
 *
 * Reads the validator key from .keys/agentkarma-arc.json (0600). The agentId is
 * read back from the ERC-721 Transfer(0x0 → owner) log, not the simulated value,
 * so it is authoritative even if another registration lands between sim + send.
 */
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from '@/config/arc-chain';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const IDENTITY_REGISTRY_ARC = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;
const DEFAULT_AGENT_URI = 'https://agentkarma.io/.well-known/agent.json';

const agentURI = process.env.ARC_AGENT_URI ?? DEFAULT_AGENT_URI;
const execute = process.argv.includes('--execute');

const registerAbi = parseAbi(['function register(string tokenURI) returns (uint256)']);
const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
);

function loadAccount() {
  const { privateKey } = JSON.parse(
    readFileSync(resolve('.keys/agentkarma-arc.json'), 'utf-8'),
  ) as { privateKey: `0x${string}` };
  return privateKeyToAccount(privateKey);
}

const account = loadAccount();
const rpc = process.env.ARC_RPC_URL;
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) });

console.log(`validator   ${account.address}`);
console.log(`agentURI    ${agentURI}`);

const { request, result } = await publicClient.simulateContract({
  account,
  address: IDENTITY_REGISTRY_ARC,
  abi: registerAbi,
  functionName: 'register',
  args: [agentURI],
});
console.log(`simulate    OK → would mint agentId ${String(result)}`);

if (!execute) {
  console.log('DRY RUN — re-run with --execute to broadcast the mint.');
  process.exit(0);
}

const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) });
const hash = await walletClient.writeContract(request);
console.log(`tx          ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') {
  throw new Error(`register() reverted: ${hash}`);
}

let agentId: bigint | undefined;
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== IDENTITY_REGISTRY_ARC.toLowerCase()) continue;
  try {
    const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
    if (decoded.eventName === 'Transfer') agentId = decoded.args.tokenId as bigint;
  } catch {
    // non-Transfer log from the registry — skip
  }
}

console.log(`status      success (block ${String(receipt.blockNumber)}, gas ${String(receipt.gasUsed)})`);
console.log(`AGENT_ID    ${agentId !== undefined ? String(agentId) : '(unresolved — read ownerOf to confirm)'}`);
console.log(`explorer    https://testnet.arcscan.app/tx/${hash}`);
