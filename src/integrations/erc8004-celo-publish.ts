/**
 * ERC-8004 Celo write path — AgentKarma as a 8004 validator.
 *
 * AK's Celo wallet (agentId 9058, controller 0xCfc0…5b96) signs feedback
 * records on the ReputationRegistry. Contract blocks self-feedback, so AK
 * MUST target a different agentId than its own.
 *
 * ReputationRegistry: 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
 *
 * Caller's responsibility:
 *  - Pass a target agentId that exists in IdentityRegistry (caller resolves
 *    via readAgent first; otherwise giveFeedback reverts).
 *  - Choose value/valueDecimals/tag1/tag2 per AK's published scheme.
 *
 * Returns { dryRun, txHash?, gasUsed?, block? }.
 */

import {
  createPublicClient, createWalletClient, http, parseAbi, formatEther,
  keccak256, toBytes,
} from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export const REPUTATION_REGISTRY_CELO = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const;

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
  estimatedCostCelo?: string;
}

/**
 * Resolve the signing keyfile. Prefers the dedicated, disclosed validator key
 * (keeps routine attestations off the high-value treasury key); falls back to
 * the treasury/controller key when the validator key isn't present. Override
 * with CELO_VALIDATOR_KEYFILE.
 */
function resolveKeyfile(): string {
  const explicit = process.env.CELO_VALIDATOR_KEYFILE;
  if (explicit) return resolve(explicit);
  const validator = resolve('.keys/agentkarma-celo-validator.json');
  if (existsSync(validator)) return validator;
  return resolve('.keys/agentkarma-celo.json');
}

function loadKeypair() {
  const { privateKey } = JSON.parse(readFileSync(resolveKeyfile(), 'utf-8')) as {
    privateKey: `0x${string}`;
  };
  return privateKeyToAccount(privateKey);
}

/** Public address of the wallet that will sign attestations (no key exposure). */
export function activeSignerAddress(): `0x${string}` {
  const { address } = JSON.parse(readFileSync(resolveKeyfile(), 'utf-8')) as {
    address: `0x${string}`;
  };
  return address;
}

function makePublic() {
  const rpcUrl = process.env.CELO_RPC_URL;
  return createPublicClient({ chain: celo, transport: http(rpcUrl) });
}

function makeWallet(account: ReturnType<typeof loadKeypair>) {
  const rpcUrl = process.env.CELO_RPC_URL;
  return createWalletClient({ account, chain: celo, transport: http(rpcUrl) });
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
    address: REPUTATION_REGISTRY_CELO,
    abi: REPUTATION_ABI,
    functionName: 'giveFeedback',
    args,
  });

  const gas = await publicClient.estimateContractGas({
    account,
    address: REPUTATION_REGISTRY_CELO,
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
      estimatedCostCelo: cost,
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
    estimatedCostCelo: cost,
  };
}
