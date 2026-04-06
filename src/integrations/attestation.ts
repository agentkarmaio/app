/**
 * 8004 Attestation Reader — Reads on-chain feedback scores for agent wallets.
 *
 * Normalizes the 8004 average score (0–100) to 0–1 for use in the scoring engine.
 * Falls back gracefully if the SDK is unavailable or the agent has no feedback.
 */

import { SolanaSDK } from '8004-solana';
import { PublicKey, Keypair } from '@solana/web3.js';
import type { Cluster } from '8004-solana';

let _sdk: SolanaSDK | null = null;

function getSDK(): SolanaSDK {
  if (_sdk) return _sdk;

  const rpcUrl = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL;
  const cluster: Cluster = 'mainnet-beta';

  // For read-only operations, use env key if available, otherwise generate ephemeral
  const rawKey = process.env.SOLANA_PRIVATE_KEY;
  const keypair = rawKey
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey)))
    : Keypair.generate();

  _sdk = new SolanaSDK({
    signer: keypair,
    cluster,
    ...(rpcUrl ? { rpcUrl } : {}),
  });

  return _sdk;
}

/**
 * Read the 8004 attestation score for a single wallet.
 * Returns a normalized value 0–1, or 0 if no feedback exists.
 */
export async function readAttestation(walletAddress: string): Promise<number> {
  try {
    const sdk = getSDK();
    const pubkey = new PublicKey(walletAddress);
    const summary = await sdk.getSummary(pubkey);

    if (!summary || summary.averageScore == null) return 0;

    // 8004 scores are 0–100, normalize to 0–1
    return Math.min(summary.averageScore / 100, 1);
  } catch {
    return 0;
  }
}

/**
 * Batch-read attestation scores for multiple wallets.
 * Returns a Map of address → normalized score (0–1).
 */
export async function readAttestations(
  walletAddresses: string[],
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  // Process in parallel with concurrency limit
  const BATCH_SIZE = 5;
  for (let i = 0; i < walletAddresses.length; i += BATCH_SIZE) {
    const batch = walletAddresses.slice(i, i + BATCH_SIZE);
    const scores = await Promise.all(
      batch.map(async (addr) => ({
        addr,
        score: await readAttestation(addr),
      })),
    );
    for (const { addr, score } of scores) {
      if (score > 0) results.set(addr, score);
    }
  }

  return results;
}
