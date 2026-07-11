/// <reference types="bun-types" />
/**
 * Templated-identity detection tests.
 *
 * See project_arc_registry_synthetic memory: Arc Testnet's bulk-minted identity
 * space (~845k ids) includes a farmed range (10k+) whose on-chain `data:` JSON
 * `name` field is auto-generated from the owner address, e.g. "Trader-Bf70ab",
 * "Bridge-21De32" — literally "Role-<6 hex chars>". A counterparty presenting
 * one of these names is not an independent identity; it should never count
 * toward settlement-quality's distinct-counterparty gate.
 *
 * Run: bun test src/scoring/identity-fingerprint.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { isTemplatedIdentity } from './identity-fingerprint';

function dataUri(json: unknown, encoding: 'base64' | 'url' = 'base64'): string {
  const body = JSON.stringify(json);
  if (encoding === 'base64') return `data:application/json;base64,${Buffer.from(body).toString('base64')}`;
  return `data:application/json,${encodeURIComponent(body)}`;
}

describe('isTemplatedIdentity', () => {
  test('flags the documented Role-<6hex> template pattern (base64 data URI)', () => {
    expect(isTemplatedIdentity(dataUri({ name: 'Trader-Bf70ab' }))).toBe(true);
    expect(isTemplatedIdentity(dataUri({ name: 'Bridge-21De32' }))).toBe(true);
  });

  test('flags the same pattern in a URL-encoded (non-base64) data URI', () => {
    expect(isTemplatedIdentity(dataUri({ name: 'Trader-Bf70ab' }, 'url'))).toBe(true);
  });

  test('does not flag a real descriptive agent name', () => {
    expect(isTemplatedIdentity(dataUri({ name: 'AgentKarma Validator' }))).toBe(false);
  });

  test('does not flag a name that merely contains a hyphen without a 6-hex suffix', () => {
    expect(isTemplatedIdentity(dataUri({ name: 'Multi-Agent-System' }))).toBe(false);
  });

  test('does not flag http(s) or ipfs tokenURIs (out of scope — no fetch performed)', () => {
    expect(isTemplatedIdentity('https://example.com/metadata/1.json')).toBe(false);
    expect(isTemplatedIdentity('ipfs://bafkreibdi6xyz')).toBe(false);
  });

  test('does not flag a missing name field', () => {
    expect(isTemplatedIdentity(dataUri({ description: 'no name here' }))).toBe(false);
  });

  test('never throws on malformed input', () => {
    expect(isTemplatedIdentity('data:application/json;base64,not-valid-base64-json')).toBe(false);
    expect(isTemplatedIdentity('')).toBe(false);
    expect(isTemplatedIdentity(null)).toBe(false);
    expect(isTemplatedIdentity(undefined)).toBe(false);
  });
});
