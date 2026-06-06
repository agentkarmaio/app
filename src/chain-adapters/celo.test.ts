/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { makeCeloAdapter } from './celo';

const a = makeCeloAdapter();
const GOOD = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

describe('makeCeloAdapter', () => {
  test('chain is celo', () => { expect(a.chain).toBe('celo'); });
  test('validateAddress accepts checksummed 0x…40hex, rejects junk', () => {
    expect(a.validateAddress(GOOD)).toBe(true);
    expect(a.validateAddress('0xnothex')).toBe(false);
    expect(a.validateAddress('GABC')).toBe(false);
  });
  test('normalizeAddress lowercases the hex', () => {
    expect(a.normalizeAddress(GOOD)).toBe(GOOD.toLowerCase());
  });
  test('explorer URLs target celoscan', () => {
    expect(a.explorerTxUrl('0xtx')).toBe('https://celoscan.io/tx/0xtx');
    expect(a.explorerAddressUrl(GOOD)).toBe(`https://celoscan.io/address/${GOOD}`);
  });
  test('publishAttestation skips when no agentId can be resolved from address', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await a.publishAttestation(GOOD, { score: 80, trustTier: 'Good' } as any);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no_celo_agent_id');
    expect(r.dryRun).toBe(true);
  });
});
