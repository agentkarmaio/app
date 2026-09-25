import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  buildProfileActivity, displayTier, formatRawUnits, hasDisplayScore, matchesProfileRegistry,
  readProfileRegistration, unitInterval, PROFILE_SERVICE_LIMIT, profileScoreHistory,
} from './arc-mainnet-profile';
import type { KarmaFaceBlock } from './karma-resolver';
import type { ArcMainnetReceiptObservation } from '@/scoring/arc-mainnet-receipts';

const wallet = `0x${'1'.repeat(40)}`;
const owner = `0x${'2'.repeat(40)}`;
const face: KarmaFaceBlock = { face: 'provider', score: 0, hasSignal: false, trustTier: 'Unrated', confidenceBadge: 'declared', metrics: null, tierAggregates: null };
function receipt(overrides: Partial<ArcMainnetReceiptObservation> = {}): ArcMainnetReceiptObservation {
  const rawTxHash = `0x${'a'.repeat(64)}`;
  return { rawTxHash, logIndex: 0, eventKey: `${rawTxHash}:0`, face: 'provider', counterparty: wallet,
    rawAmount: '1', amountDecimal: '0.000000000000000001', timestamp: '2026-01-01T00:00:00.000Z', ...overrides };
}

describe('Arc mainnet profile score display', () => {
  test('missing and fully discounted evidence are Unrated, not zero', () => {
    assert.equal(hasDisplayScore(face), false);
    assert.equal(displayTier({ ...face, score: 80, trustTier: 'Excellent', metrics: { retainedValueShare: 0 } }), 'Unrated');
  });
  test('a measured zero is displayed when signal exists', () => {
    assert.equal(hasDisplayScore({ ...face, hasSignal: true }), true);
  });
  test('non-finite and out-of-range scores cannot produce rings', () => {
    for (const score of [NaN, Infinity, -1, 101]) assert.equal(hasDisplayScore({ ...face, hasSignal: true, score }), false);
  });
  test('unknown trust tiers fall back safely', () => {
    assert.equal(displayTier({ ...face, hasSignal: true, score: 20, trustTier: 'unknown' }), 'Unrated');
    assert.equal(displayTier({ ...face, hasSignal: true, score: 20, trustTier: 'Fair' }), 'Fair');
  });
  test('missing metric values remain missing, not zero', () => {
    for (const value of [undefined, null, NaN, Infinity]) assert.equal(unitInterval(value), null);
    assert.equal(unitInterval(0), 0);
    assert.equal(unitInterval(-1), 0);
    assert.equal(unitInterval(2), 1);
  });
});

describe('exact USDC and feedback formatting', () => {
  test('preserves one wei and trims only insignificant zeroes', () => {
    assert.equal(formatRawUnits('1', 18), '0.000000000000000001');
    assert.equal(formatRawUnits('1234500000000000000', 18), '1.2345');
    assert.equal(formatRawUnits('0', 18), '0');
  });
  test('does not round amounts beyond Number.MAX_SAFE_INTEGER', () => {
    assert.equal(formatRawUnits('123456789012345678901234567890', 18), '123,456,789,012.34567890123456789');
    assert.equal(formatRawUnits('9007199254740993', 0), '9,007,199,254,740,993');
  });
  test('preserves negative, zero-decimal and high-scale feedback', () => {
    assert.equal(formatRawUnits('-125', 2), '-1.25');
    assert.equal(formatRawUnits(-25, 0), '-25');
    assert.equal(formatRawUnits('1', 255), `0.${'0'.repeat(254)}1`);
    assert.equal(formatRawUnits('-0', 0), '0');
  });
  test('rejects malformed, fractional and unsafe numeric inputs', () => {
    for (const value of ['', '1e18', '1.25', 'nan', '9'.repeat(79), Number.MAX_SAFE_INTEGER + 1]) assert.equal(formatRawUnits(value, 18), null);
    for (const decimals of [-1, 1.5, 256, NaN]) assert.equal(formatRawUnits('1', decimals), null);
  });
});

describe('identity isolation and untrusted registration', () => {
  test('accepts the selected mainnet payment wallet, not its fleet owner', () => {
    const row = { chain: 'arc-mainnet', agent_id: 228, owner, agent_wallet: wallet };
    assert.equal(matchesProfileRegistry(row, wallet, 228), true);
    assert.equal(matchesProfileRegistry(row, owner, 228), false);
    assert.equal(matchesProfileRegistry({ ...row, chain: 'arc' }, wallet, 228), false);
    assert.equal(matchesProfileRegistry(row, wallet, 229), false);
  });
  test('handles the zero-wallet sentinel and address case', () => {
    const row = { chain: 'arc-mainnet', agent_id: 0, owner, agent_wallet: `0x${'0'.repeat(40)}` };
    assert.equal(matchesProfileRegistry(row, owner.toUpperCase(), 0), true);
    assert.equal(matchesProfileRegistry({ ...row, agent_wallet: null }, owner, 0), true);
  });
  test('empty or malformed metadata never crashes', () => {
    for (const value of [null, undefined, [], 2, 'metadata', { services: 'bad' }]) {
      const result = readProfileRegistration(value);
      assert.deepEqual(result.services, []);
      assert.equal(result.image, null);
      assert.equal(result.active, null);
    }
  });
  test('unsafe image and executable endpoint schemes never become links', () => {
    const result = readProfileRegistration({ image: 'data:image/svg+xml,attack', services: [
      { name: 'bad', endpoint: 'javascript:alert(1)' }, { endpoint: 'data:text/html,attack' },
      { name: 'socket', endpoint: 'wss://example.com/agent' }, null, [], { endpoint: 'https://example.com/api' },
    ] });
    assert.equal(result.image, null);
    assert.deepEqual(result.services.map(row => row.endpoint), [null, null, 'wss://example.com/agent', 'https://example.com/api']);
  });
  test('bounds declared services and preserves explicit false flags', () => {
    const result = readProfileRegistration({ active: false, x402Support: false,
      services: Array.from({ length: 100 }, () => ({ name: 's', endpoint: 'https://example.com/' })) });
    assert.equal(result.services.length, PROFILE_SERVICE_LIMIT);
    assert.equal(result.servicesTruncated, true);
    assert.equal(result.active, false);
    assert.equal(result.x402Support, false);
  });
});

describe('validated recent-transfer rollups', () => {
  test('empty activity has real zero observations but invents no rows', () => {
    const model = buildProfileActivity([]);
    assert.deepEqual(model.relationships, []);
    assert.equal(model.receivedRaw, '0');
    assert.equal(model.transactions, 0);
  });
  test('counts logs separately from transaction hashes and preserves exact totals', () => {
    const rows = [receipt({ rawAmount: '9007199254740993' }), receipt({ logIndex: 1, eventKey: 'second-log', rawAmount: '1' }),
      receipt({ logIndex: 2, eventKey: 'third-log', face: 'consumer', rawAmount: '5' })];
    const model = buildProfileActivity(rows);
    assert.equal(model.transactions, 1);
    assert.equal(model.receipts.length, 3);
    assert.equal(model.receivedRaw, '9007199254740994');
    assert.equal(model.sentRaw, '5');
    assert.equal(model.relationships[0].transactions, 1);
    assert.equal(model.relationships[0].transfers, 3);
  });
  test('consumer-only receipts are not attributed to the provider direction', () => {
    const model = buildProfileActivity([receipt({ face: 'consumer' })]);
    assert.equal(model.receivedRaw, '0');
    assert.equal(model.sentRaw, '1');
  });
  test('sorting is deterministic, newest-first and does not mutate inputs', () => {
    const older = receipt();
    const newer = receipt({ rawTxHash: `0x${'b'.repeat(64)}`, eventKey: 'newer', counterparty: owner, timestamp: '2026-01-02T00:00:00.000Z' });
    const input = [older, newer];
    const forward = buildProfileActivity(input);
    const reverse = buildProfileActivity([...input].reverse());
    assert.deepEqual(forward, reverse);
    assert.equal(forward.receipts[0].eventKey, 'newer');
    assert.equal(input[0], older);
    assert.equal(forward.relationships[0].address, owner);
  });
});

describe('recorded score history', () => {
  test('missing or corrupt scores never become zero-valued samples', () => {
    const calculated_at = '2026-01-01T00:00:00Z';
    const rows = [null, undefined, '', ' ', NaN, Infinity, -1, 101, true].map(score => ({ score, calculated_at }));
    assert.deepEqual(profileScoreHistory(rows), []);
    assert.deepEqual(profileScoreHistory([{ score: 5, calculated_at: 'invalid' }]), []);
  });
  test('real zero samples survive and the latest window renders chronologically', () => {
    assert.deepEqual(profileScoreHistory([
      { score: '12.3', calculated_at: '2026-01-02T00:00:00Z' },
      { score: 0, calculated_at: '2026-01-01T00:00:00Z' },
    ]), [
      { score: 0, calculated_at: '2026-01-01T00:00:00.000Z' },
      { score: 12.3, calculated_at: '2026-01-02T00:00:00.000Z' },
    ]);
  });
});
