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
  // indexReceipts has TWO independent gates (arc.ts:35,38). Both must be closed
  // for the no-op, and both must be cleared here: bun test loads .env, which on
  // a developer machine sets ARC_TRANSFERS_START_BLOCK and would otherwise run
  // the transfers branch for real.
  test('indexReceipts is a no-op (fetched:0) when neither start-block env is set', async () => {
    const prevJobs = process.env.ARC_JOBS_START_BLOCK;
    const prevTransfers = process.env.ARC_TRANSFERS_START_BLOCK;
    delete process.env.ARC_JOBS_START_BLOCK;
    delete process.env.ARC_TRANSFERS_START_BLOCK;
    try {
      const r = await a.indexReceipts();
      expect(r.fetched).toBe(0);
      expect(r.inserted).toBe(0);
      expect(r.cursors.size).toBe(0);
    } finally {
      if (prevJobs !== undefined) process.env.ARC_JOBS_START_BLOCK = prevJobs;
      if (prevTransfers !== undefined) process.env.ARC_TRANSFERS_START_BLOCK = prevTransfers;
    }
  });
  // Guards the gate itself: with the jobs gate closed but the transfers gate
  // OPEN, the transfers branch must actually run. runArcTransfersIndexer calls
  // makeClient() before any DB/seed read, so dropping ARC_RPC_URL makes this
  // offline and deterministic — it raises there and never reaches the network.
  test('indexReceipts runs the transfers branch when only ARC_TRANSFERS_START_BLOCK is set', async () => {
    const prevJobs = process.env.ARC_JOBS_START_BLOCK;
    const prevTransfers = process.env.ARC_TRANSFERS_START_BLOCK;
    const prevRpc = process.env.ARC_RPC_URL;
    delete process.env.ARC_JOBS_START_BLOCK;
    delete process.env.ARC_RPC_URL;
    process.env.ARC_TRANSFERS_START_BLOCK = '1'; // any truthy value opens the gate
    try {
      await expect(a.indexReceipts()).rejects.toThrow(/ARC_RPC_URL/);
    } finally {
      if (prevJobs !== undefined) process.env.ARC_JOBS_START_BLOCK = prevJobs;
      if (prevRpc !== undefined) process.env.ARC_RPC_URL = prevRpc;
      if (prevTransfers !== undefined) process.env.ARC_TRANSFERS_START_BLOCK = prevTransfers;
      else delete process.env.ARC_TRANSFERS_START_BLOCK;
    }
  });
});
