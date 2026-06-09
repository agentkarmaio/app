/**
 * ERC-8004 Arc write path — AgentKarma as a 8004 validator.
 *
 * AK's Arc validator wallet signs feedback records on the ReputationRegistry.
 * Contract blocks self-feedback, so AK MUST target a different agentId than
 * its own.
 *
 * ReputationRegistry: 0x8004B663056A597Dffe9eCcC1965A193B7388713
 *
 * Caller's responsibility:
 *  - Pass a target agentId that exists in IdentityRegistry (caller resolves
 *    via readAgent first; otherwise giveFeedback reverts).
 *  - Choose value/valueDecimals/tag1/tag2 per AK's published scheme.
 *
 * Gas note: Arc gas is denominated in USDC with 18-decimal accounting, so
 * formatEther yields the USDC cost figure directly (estimatedCostUsdc).
 *
 * Returns { dryRun, txHash?, gasUsed?, block? }.
 */

import {
  createPublicClient, createWalletClient, http, parseAbi, formatEther,
  keccak256, toBytes,
} from 'viem';
import { arcTestnet } from '@/config/arc-chain';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export const REPUTATION_REGISTRY_ARC = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const;

const REPUTATION_ABI = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);

export interface PublishFeedbackInput {
  agentId: bigint | number;
  /** Integer or signed fixed-point. e.g. value=85, valueDecimals=0 → 85. value=8500, valueDecimals=2 → 85.00 */
  value: bigint | number;
  valueDecimals: number;
  tag1: string;          // primary categorical label, e.g. 'agentkarma_preview'
  tag2: string;          // secondary, e.g. version 'v0.1'
  endpoint?: string;     // optional related endpoint URL
  feedbackURI?: string;  // optional URI to off-chain detail
  feedbackHash?: `0x${string}`; // optional integrity hash; bytes32(0) if absent
}

export interface PublishFeedbackResult {
  dryRun: boolean;
  agentId: string;
  txHash?: `0x${string}`;
  block?: bigint;
  gasUsed?: bigint;
  estimatedCostUsdc?: string;
}

function loadKeypair() {
  const keyfile = resolve('.keys/agentkarma-arc.json');
  const { privateKey } = JSON.parse(readFileSync(keyfile, 'utf-8')) as {
    privateKey: `0x${string}`;
  };
  return privateKeyToAccount(privateKey);
}

function makePublic() {
  const rpcUrl = process.env.ARC_RPC_URL;
  return createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
}

function makeWallet(account: ReturnType<typeof loadKeypair>) {
  const rpcUrl = process.env.ARC_RPC_URL;
  return createWalletClient({ account, chain: arcTestnet, transport: http(rpcUrl) });
}

/**
 * Compute a deterministic bytes32 hash over an off-chain feedback payload.
 * Caller passes the same JSON shape that lives at `feedbackURI`. The hash
 * lets downstream consumers verify the URI content matches what AK signed.
 */
export function feedbackHashFromJson(payload: unknown): `0x${string}` {
  const canonical = JSON.stringify(payload);
  return keccak256(toBytes(canonical));
}

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export async function publishFeedback(
  input: PublishFeedbackInput,
  mode: 'simulate' | 'execute' = 'simulate',
): Promise<PublishFeedbackResult> {
  const account = loadKeypair();
  const publicClient = makePublic();

  const agentId = BigInt(input.agentId);
  const value = BigInt(input.value);
  const feedbackHash = input.feedbackHash ?? ZERO_HASH;

  const args = [
    agentId,
    value,
    input.valueDecimals,
    input.tag1,
    input.tag2,
    input.endpoint ?? '',
    input.feedbackURI ?? '',
    feedbackHash,
  ] as const;

  const { request } = await publicClient.simulateContract({
    account,
    address: REPUTATION_REGISTRY_ARC,
    abi: REPUTATION_ABI,
    functionName: 'giveFeedback',
    args,
  });

  const gas = await publicClient.estimateContractGas({
    account,
    address: REPUTATION_REGISTRY_ARC,
    abi: REPUTATION_ABI,
    functionName: 'giveFeedback',
    args,
  });
  const gasPrice = await publicClient.getGasPrice();
  const cost = formatEther(gas * gasPrice);

  if (mode === 'simulate') {
    return {
      dryRun: true,
      agentId: agentId.toString(),
      gasUsed: gas,
      estimatedCostUsdc: cost,
    };
  }

  const wallet = makeWallet(account);
  const txHash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`giveFeedback tx reverted: ${txHash}`);
  }

  return {
    dryRun: false,
    agentId: agentId.toString(),
    txHash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    estimatedCostUsdc: cost,
  };
}
