import { describe, expect, test } from 'bun:test';
import { makeArcMainnetAdapter } from './arc-mainnet';
import type { WalletScore } from '@/scoring/index';
const ADDRESS = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

describe('Arc mainnet adapter', () => {
  test('reports a separate chain with no testnet explorer and resolves event receipt links', () => {
    const adapter = makeArcMainnetAdapter();
    expect(adapter.chain).toBe('arc-mainnet');
    expect(adapter.validateAddress(ADDRESS)).toBe(true);
    expect(adapter.explorerTxUrl(`${HASH}:3`)).toBe(`https://arc-scan.org/tx/${HASH}`);
    expect(() => adapter.explorerTxUrl(`${HASH}:invalid`)).toThrow('arc_mainnet_receipt_invalid');
  });
  test('unavailable registry reads are explicit and publication cannot use a testnet implementation', async () => {
    const adapter = makeArcMainnetAdapter();
    await expect(adapter.readAttestation(ADDRESS)).rejects.toThrow('arc_mainnet_registry_unavailable');
    await expect(adapter.readAttestations([ADDRESS])).rejects.toThrow('arc_mainnet_registry_unavailable');
    const result = await adapter.publishAttestation(ADDRESS, {} as WalletScore);
    expect(result).toEqual({ address: ADDRESS, dryRun: true, skipped: true, reason: 'arc_mainnet_registry_unavailable' });
  });
  test('indexing uses managed outcomes without claiming block counts as receipt counts', async () => {
    const adapter = makeArcMainnetAdapter(async () => ({ status: 'caught_up', insertedCount: 2, checkpoint: '100' }));
    const result = await adapter.indexReceipts();
    expect(result.inserted).toBe(2);
    expect(result.fetched).toBe(2);
    expect([...result.cursors.keys()][0]).toStartWith('arc-mainnet-transfers:');
    await expect(makeArcMainnetAdapter(async () => ({ status: 'failed' })).indexReceipts()).rejects.toThrow('arc_mainnet_indexing_unavailable');
    expect((await makeArcMainnetAdapter(async () => ({ status: 'busy' })).indexReceipts()).inserted).toBe(0);
  });
});
