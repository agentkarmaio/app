/**
 * Register AgentKarma in the Celo IdentityRegistry (ERC-8004).
 *
 * Calls `register(string agentURI)` on the IdentityRegistry at
 * 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 — mints an agent NFT owned by
 * the AgentKarma Celo wallet, with the agentURI pointing at the public
 * registration JSON served from agentkarma.io.
 *
 * The URI MUST resolve at the time of registration. Deploy first; this
 * script verifies the URL returns HTTP 200 before sending the tx.
 *
 * Modes:
 *   --simulate   estimate gas + log the call, no on-chain action (default)
 *   --execute    actually send the tx
 *
 * Reads the keyfile at .keys/agentkarma-celo.json. Never logs the private key.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEventLogs,
  formatEther,
} from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;
const AGENT_URI = 'https://agentkarma.io/.well-known/agent.json';

// Minimal ABI — only the overload we use + Transfer event for agentId extraction
const ABI = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

const mode = process.argv.includes('--execute') ? 'execute' : 'simulate';

// ── Verify the agentURI resolves before sending the tx. Skipped in --simulate
//    mode so we can validate the contract call before agentkarma.io is deployed.
if (mode === 'execute') {
  console.log(`[1/4] verifying ${AGENT_URI} resolves…`);
  const probe = await fetch(AGENT_URI, { method: 'GET' });
  if (!probe.ok) {
    console.error(`✖ agent URI returns HTTP ${probe.status}. Deploy first.`);
    process.exit(1);
  }
  const body = await probe.json();
  if (body?.type !== 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1') {
    console.error(`✖ unexpected JSON at ${AGENT_URI}:`, body);
    process.exit(1);
  }
  console.log(`    ✓ HTTP 200, type=${body.type}`);
} else {
  console.log(`[1/4] simulate mode: skipping URL probe (will enforce on --execute)`);
}

// ── Load keypair ─────────────────────────────────────────────────────────────
const keyfile = resolve('.keys/agentkarma-celo.json');
const { privateKey } = JSON.parse(readFileSync(keyfile, 'utf-8')) as {
  privateKey: `0x${string}`;
};
const account = privateKeyToAccount(privateKey);
console.log(`[2/4] loaded keypair for ${account.address}`);

// ── Estimate gas via simulation ──────────────────────────────────────────────
const publicClient = createPublicClient({ chain: celo, transport: http() });

const { request, result: estimatedAgentId } = await publicClient.simulateContract({
  account,
  address: IDENTITY_REGISTRY,
  abi: ABI,
  functionName: 'register',
  args: [AGENT_URI],
});

const gasEstimate = await publicClient.estimateContractGas({
  account,
  address: IDENTITY_REGISTRY,
  abi: ABI,
  functionName: 'register',
  args: [AGENT_URI],
});

const gasPrice = await publicClient.getGasPrice();
const estCost = gasEstimate * gasPrice;

console.log(`[3/4] simulation succeeded`);
console.log(`    estimated agentId: ${estimatedAgentId}`);
console.log(`    gas:               ${gasEstimate.toString()}`);
console.log(`    gas price:         ${gasPrice.toString()} wei`);
console.log(`    estimated cost:    ${formatEther(estCost)} CELO`);

if (mode === 'simulate') {
  console.log(`[4/4] --simulate mode: nothing sent. Re-run with --execute to register.`);
  process.exit(0);
}

// ── Execute ──────────────────────────────────────────────────────────────────
const walletClient = createWalletClient({ account, chain: celo, transport: http() });
console.log(`[4/4] sending tx…`);
const txHash = await walletClient.writeContract(request);
console.log(`    tx submitted: ${txHash}`);
console.log(`    waiting for receipt…`);

const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== 'success') {
  console.error(`✖ tx reverted. Receipt:`, receipt);
  process.exit(1);
}

const transferLogs = parseEventLogs({
  abi: ABI,
  logs: receipt.logs,
  eventName: 'Transfer',
});
const minted = transferLogs.find((l) => l.args.from === '0x0000000000000000000000000000000000000000');
if (!minted) {
  console.error(`✖ no mint Transfer event found in receipt`);
  process.exit(1);
}
const agentId = minted.args.tokenId.toString();

console.log(``);
console.log(`✓ AgentKarma registered on Celo`);
console.log(`  agentId:     ${agentId}`);
console.log(`  tokenOwner:  ${account.address}`);
console.log(`  agentURI:    ${AGENT_URI}`);
console.log(`  tx:          ${txHash}`);
console.log(`  block:       ${receipt.blockNumber}`);
console.log(`  gas used:    ${receipt.gasUsed.toString()}`);
console.log(`  explorer:    https://celoscan.io/tx/${txHash}`);
console.log(`  8004scan:    https://8004scan.io/agent/${agentId}`);
