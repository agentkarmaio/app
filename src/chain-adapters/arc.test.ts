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
  test('publishAttestation skips when no agentId can be resolved from address', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await a.publishAttestation(GOOD, { score: 80, trustTier: 'Good' } as any);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no_arc_agent_id');
    expect(r.dryRun).toBe(true);
  });
  test('indexReceipts is a no-op (fetched:0) when ARC_JOBS_START_BLOCK is unset', async () => {
    const prev = process.env.ARC_JOBS_START_BLOCK;
    delete process.env.ARC_JOBS_START_BLOCK;
    try {
      const r = await a.indexReceipts();
      expect(r.fetched).toBe(0);
      expect(r.inserted).toBe(0);
      expect(r.cursors.size).toBe(0);
    } finally {
      if (prev !== undefined) process.env.ARC_JOBS_START_BLOCK = prev;
    }
  });
});
