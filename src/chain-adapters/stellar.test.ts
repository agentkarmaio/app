/// <reference types="bun-types" />
/**
 * StellarAdapter scaffold — address validation, explorer URLs real; index/read/
 * publish throw notImplemented until later units. readAttestations fans out over
 * readAttestation.
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

  test('indexReceipts throws notImplemented', () => {
    expect(a.indexReceipts()).rejects.toThrow('StellarAdapter.indexReceipts not yet implemented');
  });
  test('readAttestation throws notImplemented', () => {
    expect(a.readAttestation(GOOD)).rejects.toThrow('StellarAdapter.readAttestation not yet implemented');
  });
  test('publishAttestation throws notImplemented', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(a.publishAttestation(GOOD, {} as any)).rejects.toThrow('StellarAdapter.publishAttestation not yet implemented');
  });
  test('readAttestations fans out and surfaces the same notImplemented', () => {
    expect(a.readAttestations([GOOD])).rejects.toThrow('not yet implemented');
  });
});
