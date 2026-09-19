/**
 * Retired Arc testnet feedback publisher. Kept as a fail-closed compatibility
 * entry point for old operational scripts; historical payload hashes remain
 * available for verification. No keys are loaded and no RPC calls are made.
 */
import { keccak256, toBytes } from 'viem';

export const REPUTATION_REGISTRY_ARC = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const;

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

/**
 * Compute a deterministic bytes32 hash over an off-chain feedback payload.
 * Caller passes the same JSON shape that lives at `feedbackURI`. The hash
 * lets downstream consumers verify the URI content matches what AK signed.
 */
export function feedbackHashFromJson(payload: unknown): `0x${string}` {
  const canonical = JSON.stringify(payload);
  return keccak256(toBytes(canonical));
}

export async function publishFeedback(
  _input: PublishFeedbackInput,
  _mode: 'simulate' | 'execute' = 'simulate',
): Promise<PublishFeedbackResult> {
  throw new Error('Arc testnet is retired. Historical profiles remain read-only.');
}
