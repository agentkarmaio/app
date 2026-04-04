/**
 * ERC-8004 / 8004-solana Integration — Write Karma scores as on-chain feedback
 *
 * Uses the 8004-solana SDK to write structured feedback for agent wallets.
 * Requires SOLANA_PRIVATE_KEY in env; without it, runs in dry-run mode
 * (logs what would be written without touching the chain).
 *
 * SDK docs: https://github.com/8004-protocol/8004-solana
 */

import { SolanaSDK } from '8004-solana';
import { PublicKey, Keypair } from '@solana/web3.js';
import type { Cluster } from '8004-solana';
import type { WalletScore } from '../scoring/index';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FeedbackResult {
  dryRun: boolean;
  agentAsset: string;
  score: number;
  trustTier: string;
  signature?: string;
}

// ─── SDK Init ─────────────────────────────────────────────────────────────────

/**
 * Initialize a SolanaSDK instance with the given private key bytes.
 * @param privateKey — base58 or Uint8Array secret key
 * @param cluster — 'mainnet-beta' | 'devnet' | 'testnet' (default: 'mainnet-beta')
 */
export function initSDK(
  privateKey: Uint8Array | number[],
  cluster: Cluster = 'mainnet-beta'
): SolanaSDK {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(privateKey));
  const rpcUrl = process.env.SOLANA_RPC_URL ?? undefined;

  return new SolanaSDK({
    signer: keypair,
    cluster,
    ...(rpcUrl ? { rpcUrl } : {}),
  });
}

/**
 * Returns a SolanaSDK if SOLANA_PRIVATE_KEY is available, else null.
 * Private key is expected as a comma-separated list of bytes (JSON array format).
 */
export function initSDKFromEnv(cluster: Cluster = 'mainnet-beta'): SolanaSDK | null {
  const rawKey = process.env.SOLANA_PRIVATE_KEY;
  if (!rawKey) {
    console.log('[8004] SOLANA_PRIVATE_KEY not set — running in dry-run mode');
    return null;
  }

  try {
    const keyBytes: number[] = JSON.parse(rawKey);
    return initSDK(keyBytes, cluster);
  } catch {
    console.error('[8004] Failed to parse SOLANA_PRIVATE_KEY (expected JSON array of bytes)');
    return null;
  }
}

// ─── Feedback Write ───────────────────────────────────────────────────────────

/**
 * Write karma score as on-chain 8004 feedback for an agent asset.
 *
 * @param sdk        — initialized SolanaSDK (or null for dry-run)
 * @param agentAsset — the agent's NFT asset address (PublicKey or base58 string)
 * @param score      — WalletScore object containing score + tier + metrics
 * @returns FeedbackResult with on-chain signature (or dry-run marker)
 */
export async function writeFeedback(
  sdk: SolanaSDK | null,
  agentAsset: string | PublicKey,
  score: WalletScore
): Promise<FeedbackResult> {
  const assetAddress = typeof agentAsset === 'string' ? agentAsset : agentAsset.toBase58();

  const params = {
    value: score.score,
    score: Math.round(score.score), // integer 0–100
    tag1: 'karma_score',
    tag2: score.trustTier.toLowerCase(),
  };

  if (!sdk) {
    // Dry-run: just log
    console.log('[8004] [DRY-RUN] Would write feedback:', {
      agent: assetAddress,
      ...params,
      metrics: score.metrics,
    });
    return {
      dryRun: true,
      agentAsset: assetAddress,
      score: score.score,
      trustTier: score.trustTier,
    };
  }

  const assetPubkey = new PublicKey(assetAddress);

  console.log(`[8004] Writing feedback for ${assetAddress} — score: ${score.score}, tier: ${score.trustTier}`);
  const result = await sdk.giveFeedback(assetPubkey, params);

  const signature = 'signature' in result ? (result as { signature: string }).signature : undefined;

  console.log(`[8004] Feedback written. Tx: ${signature ?? '(prepared)'}`);
  return {
    dryRun: false,
    agentAsset: assetAddress,
    score: score.score,
    trustTier: score.trustTier,
    signature,
  };
}

// ─── Score Read ───────────────────────────────────────────────────────────────

/**
 * Read the current karma score for an agent asset from 8004.
 * Returns null if no score exists or SDK is unavailable.
 */
export async function readScore(
  sdk: SolanaSDK | null,
  agentAsset: string | PublicKey
): Promise<number | null> {
  if (!sdk) {
    console.log('[8004] [DRY-RUN] readScore called without SDK — returning null');
    return null;
  }

  const assetPubkey = typeof agentAsset === 'string' ? new PublicKey(agentAsset) : agentAsset;

  try {
    // Use SDK's summary to read current aggregated score
    const summary = await sdk.getSummary(assetPubkey);
    if (!summary) return null;

    return summary.averageScore ?? null;
  } catch (err) {
    console.error('[8004] Failed to read score:', err);
    return null;
  }
}
