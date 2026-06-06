/**
 * ChainAdapter — the one interface every supported chain implements. Solana
 * (L1), Celo (L2), Stellar (L3) each provide a functional factory returning
 * this shape. The registry keys adapters by Chain. NO classes (AK hard rule).
 */
import type { Chain } from '@/db/schema';
import type { WalletScore } from '@/scoring/index';

export interface IndexRunResult {
  fetched: number;
  inserted: number;
  cursors: Map<string, string>;
}

/**
 * Per-wallet publish outcome. DISTINCT from publish.ts's aggregate
 * PublishRunResult (which spans many wallets). One ChainAdapter.publishAttestation
 * call produces exactly one of these.
 */
export interface PublishResult {
  address: string;
  txId?: string;
  dryRun: boolean;
  skipped: boolean;
  reason?: string;
}

export interface ChainAdapter {
  readonly chain: Chain;
  validateAddress(address: string): boolean;
  normalizeAddress(address: string): string;
  indexReceipts(opts?: { backfill?: boolean; limit?: number }): Promise<IndexRunResult>;
  readAttestation(address: string): Promise<number>;
  readAttestations(addresses: string[]): Promise<Map<string, number>>;
  publishAttestation(address: string, score: WalletScore): Promise<PublishResult>;
  explorerTxUrl(txId: string): string;
  explorerAddressUrl(address: string): string;
}
