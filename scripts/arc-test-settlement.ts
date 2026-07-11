/**
 * Fire one DISCLOSED, controlled ERC-8183 job settlement on Arc Testnet, end to
 * end, to prove AK's job-settlement indexer (arc-jobs.ts) live for the Circle/Arc
 * grant demo video.
 *
 * AK's validator wallet plays client, provider, AND evaluator — a single-key
 * self-dealt settlement. That's fine because it is disclosed as a test, never
 * presented as organic activity (see project_erc8183_hardening_plan memory: this
 * is exactly the self-dealing pattern AK's own unbuilt filter would flag — never
 * claim otherwise). Cost is gas-only: platformFeeBP and evaluatorFeeBP are both
 * 0 on the current deployment, so the full budget round-trips back to the same
 * wallet on completion.
 *
 * ABI below is transcribed from the VERIFIED implementation source
 * (0xA316fd02827242D537F84730F8a37D0BA5fd351a, "AgenticCommerce", fetched from
 * testnet.arcscan.app) behind the proxy AK already indexes
 * (0x0747EEf0706327138c69792bF28Cd525089e4583) — not the generic EIP-8183 draft
 * text, which omits a few real params (e.g. `hook` is required, not optional;
 * `fund` takes no `expectedBudget`).
 *
 *   bun run scripts/arc-test-settlement.ts            # dry run (simulate createJob only)
 *   bun run scripts/arc-test-settlement.ts --execute   # broadcast all 5 steps
 *
 * Env:
 *   ARC_RPC_URL      optional RPC override (defaults to arcTestnet public RPC)
 *   ARC_TEST_BUDGET  optional budget override in raw USDC units, 6-dec (default 100000 = 0.10 USDC)
 *
 * Reads the validator key from .keys/agentkarma-arc.json (0600).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  decodeEventLog,
  keccak256,
  toBytes,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { arcTestnet } from '@/config/arc-chain';
import { ARC_JOBS_CONTRACT } from '@/indexer/arc-jobs';

const execute = process.argv.includes('--execute');
const budget = BigInt(process.env.ARC_TEST_BUDGET ?? '100000'); // 0.10 USDC, 6-dec

const ACP_ABI = parseAbi([
  'function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256)',
  'function setBudget(uint256 jobId, uint256 amount, bytes optParams)',
  'function fund(uint256 jobId, bytes optParams)',
  'function submit(uint256 jobId, bytes32 deliverable, bytes optParams)',
  'function complete(uint256 jobId, bytes32 reason, bytes optParams)',
  'function paymentToken() view returns (address)',
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)',
  'event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

function loadAccount() {
  const { privateKey } = JSON.parse(
    readFileSync(resolve('.keys/agentkarma-arc.json'), 'utf-8'),
  ) as { privateKey: `0x${string}` };
  return privateKeyToAccount(privateKey);
}

const account = loadAccount();
const rpc = process.env.ARC_RPC_URL;
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) });

console.log(`validator      ${account.address}`);
console.log(`escrow         ${ARC_JOBS_CONTRACT}`);
console.log(`budget         ${budget} raw units (${Number(budget) / 1e6} USDC)`);

const paymentToken = await publicClient.readContract({
  address: ARC_JOBS_CONTRACT,
  abi: ACP_ABI,
  functionName: 'paymentToken',
});
console.log(`paymentToken   ${paymentToken}`);

const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 86400); // +1 day

const { request: createJobRequest, result: simulatedJobId } = await publicClient.simulateContract({
  account,
  address: ARC_JOBS_CONTRACT,
  abi: ACP_ABI,
  functionName: 'createJob',
  args: [account.address, account.address, expiredAt, 'AgentKarma disclosed test settlement — Circle/Arc grant demo', '0x0000000000000000000000000000000000000000'],
});
console.log(`simulate       createJob OK → would mint jobId ${String(simulatedJobId)}`);

if (!execute) {
  console.log('DRY RUN — re-run with --execute to broadcast all 5 steps (createJob → setBudget → approve → fund → submit → complete).');
  process.exit(0);
}

const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) });

async function send(label: string, request: Parameters<typeof walletClient.writeContract>[0]): Promise<Hash> {
  const hash = await walletClient.writeContract(request);
  console.log(`tx             ${label} ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  return hash;
}

// 1. createJob
const createHash = await send('createJob ', createJobRequest);
const createReceipt = await publicClient.getTransactionReceipt({ hash: createHash });
let jobId: bigint | undefined;
for (const log of createReceipt.logs) {
  if (log.address.toLowerCase() !== ARC_JOBS_CONTRACT.toLowerCase()) continue;
  try {
    const decoded = decodeEventLog({ abi: ACP_ABI, data: log.data, topics: log.topics });
    if (decoded.eventName === 'JobCreated') jobId = decoded.args.jobId as bigint;
  } catch {
    // non-JobCreated log — skip
  }
}
if (jobId === undefined) throw new Error('JobCreated log not found — cannot continue');
console.log(`jobId          ${jobId}`);

// 2. setBudget (caller must be provider — same address here)
const { request: setBudgetRequest } = await publicClient.simulateContract({
  account,
  address: ARC_JOBS_CONTRACT,
  abi: ACP_ABI,
  functionName: 'setBudget',
  args: [jobId, budget, '0x'],
});
await send('setBudget ', setBudgetRequest);

// 3. approve (client must approve escrow for the budget before fund())
const allowance = await publicClient.readContract({
  address: paymentToken,
  abi: ERC20_ABI,
  functionName: 'allowance',
  args: [account.address, ARC_JOBS_CONTRACT],
});
if (allowance < budget) {
  const { request: approveRequest } = await publicClient.simulateContract({
    account,
    address: paymentToken,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [ARC_JOBS_CONTRACT, budget],
  });
  await send('approve   ', approveRequest);
} else {
  console.log('approve        skipped — sufficient allowance already');
}

// 4. fund (caller must be client — same address here; pulls `budget` via safeTransferFrom)
const { request: fundRequest } = await publicClient.simulateContract({
  account,
  address: ARC_JOBS_CONTRACT,
  abi: ACP_ABI,
  functionName: 'fund',
  args: [jobId, '0x'],
});
await send('fund      ', fundRequest);

// 5. submit (caller must be provider)
const deliverable = keccak256(toBytes('agentkarma-grant-demo-test-settlement'));
const { request: submitRequest } = await publicClient.simulateContract({
  account,
  address: ARC_JOBS_CONTRACT,
  abi: ACP_ABI,
  functionName: 'submit',
  args: [jobId, deliverable, '0x'],
});
await send('submit    ', submitRequest);

// 6. complete (caller must be evaluator — releases payment)
const reason = keccak256(toBytes('grant-demo-disclosed-test'));
const { request: completeRequest } = await publicClient.simulateContract({
  account,
  address: ARC_JOBS_CONTRACT,
  abi: ACP_ABI,
  functionName: 'complete',
  args: [jobId, reason, '0x'],
});
const completeHash = await send('complete  ', completeRequest);

console.log(`\nDONE           jobId ${jobId} settled.`);
console.log(`explorer       https://testnet.arcscan.app/tx/${completeHash}`);
console.log(`\nNext: set ARC_JOBS_START_BLOCK to a block near ${String(createReceipt.blockNumber)} and run the indexer to pick this up.`);
