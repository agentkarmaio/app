/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { makeRobinhoodAdapter } from './robinhood';
import { getAdapter } from './registry';
import type { WalletScore } from '@/scoring/index';

const ADDR = '0x823638645f65ad589eA5484a0952B971B20EE0ec';

describe('Robinhood Chain adapter (registry-only)', () => {
  const adapter = makeRobinhoodAdapter();

  test('is registered under the robinhood key', () => {
    expect(getAdapter('robinhood').chain).toBe('robinhood');
  });

  test('validates and lowercases EVM addresses', () => {
    expect(adapter.validateAddress(ADDR)).toBe(true);
    expect(adapter.validateAddress('GC2NIKT6TWLMBZE4TU5ZMMDVV22URFIMJIZ4JYUC3QABBBWNGGZMAFGM')).toBe(false);
    expect(adapter.normalizeAddress(ADDR)).toBe(ADDR.toLowerCase());
  });

  test('has no receipt indexer: a fan-out run is a no-op, never a throw', async () => {
    const run = await adapter.indexReceipts();
    expect(run.fetched).toBe(0);
    expect(run.inserted).toBe(0);
    expect(run.cursors.size).toBe(0);
  });

  test('wallet-keyed attestations are unavailable (agents are keyed by agentId)', async () => {
    expect(await adapter.readAttestation(ADDR)).toBe(0);
    expect([...(await adapter.readAttestations([ADDR])).values()]).toEqual([0]);
    const published = await adapter.publishAttestation(ADDR, {} as WalletScore);
    expect(published).toMatchObject({ address: ADDR, dryRun: true, skipped: true });
  });

  test('links to the Blockscout explorer', () => {
    expect(adapter.explorerAddressUrl(ADDR)).toBe(`https://robinhoodchain.blockscout.com/address/${ADDR}`);
    expect(adapter.explorerTxUrl('0xabc')).toBe('https://robinhoodchain.blockscout.com/tx/0xabc');
  });
});
