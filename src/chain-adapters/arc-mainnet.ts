import { isAddress } from 'viem';
import { arcMainnet } from '@/config/arc-chain';
import { ARC_MAINNET_USDC_CONTRACT } from '@/config/arc-mainnet';
import { arcTransfersCursorKey } from '@/indexer/arc-transfers';
import type { ChainAdapter } from './types';

interface MainnetManagedOutcome { status: string; insertedCount?: number; checkpoint?: string | null }
async function runManagedMainnet(): Promise<MainnetManagedOutcome> {
  const { runIndexingJob } = await import('@/lib/indexing-jobs');
  return runIndexingJob('arc-mainnet', 'transfers');
}
function rawTransactionHash(receiptId: string): string {
  const match = /^(0x[0-9a-fA-F]{64})(?::(\d+))?$/.exec(receiptId);
  if (!match || (match[2] !== undefined && !Number.isSafeInteger(Number(match[2])))) throw new Error('arc_mainnet_receipt_invalid');
  return match[1];
}

/** A separate network; no registry/escrow implementation is borrowed from testnet. */
export function makeArcMainnetAdapter(run: () => Promise<MainnetManagedOutcome> = runManagedMainnet): ChainAdapter {
  const explorer = arcMainnet.blockExplorers.default.url;
  return {
    chain: 'arc-mainnet',
    validateAddress: isAddress,
    normalizeAddress: (address) => address.toLowerCase(),
    indexReceipts: async () => {
      const outcome = await run();
      if (outcome.status === 'failed' || outcome.status === 'lease_lost') throw new Error('arc_mainnet_indexing_unavailable');
      const inserted = outcome.insertedCount ?? 0;
      const cursors = new Map<string, string>();
      if (outcome.checkpoint) cursors.set(arcTransfersCursorKey(ARC_MAINNET_USDC_CONTRACT, 'arc-mainnet'), outcome.checkpoint);
      // Managed health carries newly inserted receipts, not total decoded events.
      // This lower bound never mistakes scanned block counts for transactions.
      return { fetched: inserted, inserted, cursors };
    },
    readAttestation: async () => { throw new Error('arc_mainnet_registry_unavailable'); },
    readAttestations: async () => { throw new Error('arc_mainnet_registry_unavailable'); },
    publishAttestation: async (address) => ({ address, dryRun: true, skipped: true, reason: 'arc_mainnet_registry_unavailable' }),
    explorerTxUrl: (receiptId) => `${explorer}/tx/${rawTransactionHash(receiptId)}`,
    explorerAddressUrl: (address) => `${explorer}/address/${address}`,
  };
}
