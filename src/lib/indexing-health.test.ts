import { describe, expect, test } from 'bun:test';
import { buildIndexingHealth } from './indexing-health';

const now = Date.parse('2026-09-12T12:00:00Z');
const at = new Date(now - 60_000).toISOString();
const row = (chain: string, path: string, more = {}) => ({
  chain,
  path,
  enabled: true,
  status: 'caught_up',
  last_attempt_at: at,
  last_finished_at: at,
  last_success_at: at,
  interval_ms: 300_000,
  lease_until: null,
  owner: null,
  error_code: null,
  checkpoint: '100',
  head: '100',
  checked_count: 10,
  pending_count: 0,
  unresolved_count: 0,
  inserted_count: 0,
  ...more,
});
describe('per-path indexing health', () => {
  test('fresh Solana never masks failed Arc or never-run Stellar', () => {
    const result = buildIndexingHealth(
      [
        row('solana', 'payments'),
        row('arc', 'escrow', {
          status: 'failed',
          error_code: 'rpc_unavailable',
        }),
      ],
      now,
    );
    expect(result.chains.find((c) => c.chain === 'arc')?.status).toBe('failed');
    expect(result.chains.find((c) => c.chain === 'stellar')?.status).toBe(
      'unknown',
    );
    expect(result.status).not.toBe('current');
  });
  test('zero inserts with completed scan is current; recent attempt with old completion is delayed', () => {
    const result = buildIndexingHealth(
      [
        row('stellar', 'transfers'),
        row('celo', 'payments', {
          last_finished_at: new Date(now - 3_600_000).toISOString(),
        }),
      ],
      now,
    );
    expect(
      result.chains
        .find((c) => c.chain === 'stellar')
        ?.paths.find((p) => p.path === 'transfers')?.status,
    ).toBe('current');
    expect(
      result.chains
        .find((c) => c.chain === 'celo')
        ?.paths.find((p) => p.path === 'payments')?.status,
    ).toBe('delayed');
  });
  test('expired worker is delayed and private fields never enter response', () => {
    const result = buildIndexingHealth(
      [
        row('arc', 'transfers', {
          owner: 'SECRET',
          lease_until: new Date(now - 1).toISOString(),
          error_code: 'https://rpc.invalid/?key=SECRET',
        }),
      ],
      now,
    );
    expect(
      result.chains
        .find((c) => c.chain === 'arc')
        ?.paths.find((p) => p.path === 'transfers')?.status,
    ).toBe('delayed');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('rpc.invalid');
  });
  test('a partial run cannot be current despite fresh last_success', () => {
    const result = buildIndexingHealth(
      [row('arc', 'escrow', { pending_count: 8, status: 'catching_up' })],
      now,
    );
    expect(
      result.chains
        .find((c) => c.chain === 'arc')
        ?.paths.find((p) => p.path === 'escrow')?.status,
    ).toBe('catching_up');
  });
});

test('public issue reasons distinguish throttling, retrying records, and unverified history without raw errors', () => {
  const result = buildIndexingHealth([
    row('arc', 'transfers', { status: 'failed', error_code: 'rpc_rate_limited' }),
    row('arc', 'registry', { status: 'failed', error_code: 'registry_read_failure', unresolved_count: 1 }),
    row('solana', 'payments', { status: 'catching_up', gaps_count: 18 }),
    row('celo', 'payments', { status: 'failed', error_code: 'https://rpc.invalid/SECRET' }),
  ], now);
  expect(result.chains.find(c => c.chain === 'arc')?.paths.find(p => p.path === 'transfers')?.issue).toBe('rate_limited');
  expect(result.chains.find(c => c.chain === 'arc')?.paths.find(p => p.path === 'registry')?.issue).toBe('registry_retry');
  expect(result.chains.find(c => c.chain === 'solana')?.paths.find(p => p.path === 'payments')?.issue).toBe('history_gap');
  expect(JSON.stringify(result)).not.toContain('SECRET');
});
