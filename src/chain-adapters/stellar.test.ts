/// <reference types="bun-types" />
/**
 * StellarAdapter — address validation, explorer URLs, no-op indexReceipts.
 * The 8004 read/write delegation (readAttestation/publishAttestation) is wired
 * in U3; its pure resolver logic is covered in stellar.attestation.test.ts.
 * Here we only assert the adapter methods are NO LONGER the U1 notImplemented
 * stubs — they reach the real DB getter (getStellarAgentId), which surfaces a
 * missing-Supabase-env error in unit context rather than the stub sentinel.
 */
import { describe, expect, test } from 'bun:test';
import { makeStellarAdapter } from './stellar';

const a = makeStellarAdapter();
const GOOD = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'; // 56-char G…
const BAD_C = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'; // contract C…

describe('makeStellarAdapter', () => {
  test('chain is stellar', () => { expect(a.chain).toBe('stellar'); });

  test('validateAddress accepts a 56-char G… StrKey', () => {
    expect(a.validateAddress(GOOD)).toBe(true);
  });
  test('validateAddress rejects C… contract and junk', () => {
    expect(a.validateAddress(BAD_C)).toBe(false);
    expect(a.validateAddress('not-an-address')).toBe(false);
    expect(a.validateAddress('')).toBe(false);
  });

  test('normalizeAddress is identity (StrKey already uppercase)', () => {
    expect(a.normalizeAddress(GOOD)).toBe(GOOD);
  });

  test('explorer URLs point at stellar.expert public network', () => {
    expect(a.explorerTxUrl('abc')).toBe('https://stellar.expert/explorer/public/tx/abc');
    expect(a.explorerAddressUrl(GOOD)).toBe(`https://stellar.expert/explorer/public/account/${GOOD}`);
  });

  test('indexReceipts is a safe no-op while facilitators are unseeded (U2)', async () => {
    // STELLAR_FACILITATOR_SET + STELLAR_MPP_RECIPIENTS are empty until discovery,
    // so runStellarIndexer short-circuits before any RPC call — no STELLAR_RPC_URL
    // needed, returns the empty IndexRunResult contract.
    const res = await a.indexReceipts();
    expect(res.fetched).toBe(0);
    expect(res.inserted).toBe(0);
    expect(res.cursors.size).toBe(0);
  });
  test('readAttestation is wired (delegates past the U1 stub)', () => {
    // No longer the notImplemented sentinel: it reaches getStellarAgentId, which
    // needs Supabase env. The success path (with injected rpc) lives in
    // stellar.attestation.test.ts::resolveAttestationScore.
    const p = a.readAttestation(GOOD);
    expect(p).rejects.not.toThrow('not yet implemented');
    expect(p).rejects.toThrow();
  });
  test('publishAttestation is wired (delegates past the U1 stub)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = a.publishAttestation(GOOD, {} as any);
    expect(p).rejects.not.toThrow('not yet implemented');
    expect(p).rejects.toThrow();
  });
  test('readAttestations fans out over the wired readAttestation', () => {
    const p = a.readAttestations([GOOD]);
    expect(p).rejects.not.toThrow('not yet implemented');
    expect(p).rejects.toThrow();
  });
});
