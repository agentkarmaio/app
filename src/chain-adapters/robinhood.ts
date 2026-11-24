/**
 * Robinhood Chain ChainAdapter — registry-only. Agents are ERC-8004 identities
 * mirrored by the registry scan (keyed by agentId, not wallet), so there is no
 * receipt indexer and no wallet-keyed attestation read or write. NO class.
 */
import { isAddress } from 'viem';
import type { ChainAdapter } from './types';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/explorer-urls';

export function makeRobinhoodAdapter(): ChainAdapter {
  return {
    chain: 'robinhood',
    validateAddress: (address) => isAddress(address),
    normalizeAddress: (address) => address.toLowerCase(),
    // Fan-out (keep-fresh) calls every public adapter: no receipt source exists.
    indexReceipts: async () => ({ fetched: 0, inserted: 0, cursors: new Map() }),
    readAttestation: async () => 0,
    readAttestations: async (addresses) => new Map(addresses.map((address) => [address, 0])),
    publishAttestation: async (address) => ({ address, dryRun: true, skipped: true, reason: 'robinhood_registry_only' }),
    explorerTxUrl: (txId) => explorerTxUrl('robinhood', txId),
    explorerAddressUrl: (address) => explorerAddressUrl('robinhood', address),
  };
}
