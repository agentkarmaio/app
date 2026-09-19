/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { makeArcAdapter } from './arc';

const a = makeArcAdapter();
const GOOD = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

describe('makeArcAdapter', () => {
  test('chain is arc', () => { expect(a.chain).toBe('arc'); });
  test('validateAddress accepts checksummed 0x…40hex, rejects junk', () => {
    expect(a.validateAddress(GOOD)).toBe(true);
    expect(a.validateAddress('0xnothex')).toBe(false);
    expect(a.validateAddress('GABC')).toBe(false);
  });
  test('normalizeAddress lowercases the hex', () => {
    expect(a.normalizeAddress(GOOD)).toBe(GOOD.toLowerCase());
  });
  test('explorer URLs target arcscan testnet', () => {
    expect(a.explorerTxUrl('0xtx')).toBe('https://testnet.arcscan.app/tx/0xtx');
    expect(a.explorerAddressUrl(GOOD)).toBe(`https://testnet.arcscan.app/address/${GOOD}`);
  });
  test('retired testnet publishing skips before resolving identity', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await a.publishAttestation(GOOD, { score: 80, trustTier: 'Good' } as any);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('arc_testnet_retired');
    expect(r.dryRun).toBe(true);
  });
  test('retired testnet indexing refuses even when legacy start-block flags are set', async () => {
    const previous = process.env.ARC_TRANSFERS_START_BLOCK;
    process.env.ARC_TRANSFERS_START_BLOCK = '1';
    try { await expect(a.indexReceipts()).rejects.toThrow('arc_testnet_retired'); }
    finally {
      if (previous === undefined) delete process.env.ARC_TRANSFERS_START_BLOCK;
      else process.env.ARC_TRANSFERS_START_BLOCK = previous;
    }
  });
});
