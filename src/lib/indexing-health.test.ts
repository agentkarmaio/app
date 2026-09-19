import { describe, expect, test } from 'bun:test';
import { buildIndexingHealth, INDEXING_PATHS } from './indexing-health';

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
  // A worker that died without releasing leaves `owner` set until the next
  // acquire steals it — up to a full interval. That orphan says nothing about
  // freshness, so only `last_finished_at` may decide it.
  test('an orphaned lease over fresh data is not delayed, and private fields never enter response', () => {
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
    ).toBe('current');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('rpc.invalid');
  });
  test('an orphaned lease over stale data is still delayed', () => {
    const result = buildIndexingHealth(
      [
        row('arc', 'transfers', {
          owner: 'worker-1',
          lease_until: new Date(now - 1).toISOString(),
          last_finished_at: new Date(now - 3_600_000).toISOString(),
        }),
      ],
      now,
    );
    expect(
      result.chains
        .find((c) => c.chain === 'arc')
        ?.paths.find((p) => p.path === 'transfers')?.status,
    ).toBe('delayed');
  });
  test('a live lease is still running', () => {
    const result = buildIndexingHealth(
      [
        row('arc', 'transfers', {
          owner: 'worker-1',
          lease_until: new Date(now + 60_000).toISOString(),
          last_finished_at: new Date(now - 3_600_000).toISOString(),
        }),
      ],
      now,
    );
    expect(
      result.chains
        .find((c) => c.chain === 'arc')
        ?.paths.find((p) => p.path === 'transfers')?.status,
    ).toBe('running');
  });
  // `gaps_count` is a permanent ledger entry — retained by greatest(), cleared
  // only by operator recovery. Letting it drive the freshness verdict means a
  // path that ever recorded one reads "catching up" forever, which says nothing
  // about whether today's data is current. It is disclosed as an issue instead.
  test('a recorded history gap alone does not make fresh data read as behind', () => {
    const result = buildIndexingHealth(
      [row('celo', 'payments', { gaps_count: 19, error_code: 'archive_gap' })],
      now,
    );
    const path = result.chains
      .find((c) => c.chain === 'celo')
      ?.paths.find((p) => p.path === 'payments');
    expect(path?.status).toBe('current');
    expect(path?.issue).toBe('history_gap'); // still disclosed, just not as staleness
  });
  test('a history gap with real backlog behind it is still catching up', () => {
    const result = buildIndexingHealth(
      [row('celo', 'payments', { gaps_count: 19, pending_count: 7, unresolved_count: 101 })],
      now,
    );
    expect(
      result.chains
        .find((c) => c.chain === 'celo')
        ?.paths.find((p) => p.path === 'payments')?.status,
    ).toBe('catching_up');
  });
  // finish_indexing_run rewrites caught_up → catching_up whenever gaps survive,
  // so the stored status cannot distinguish "behind" from "complete but holed".
  test('the SQL gap downgrade does not survive as a freshness verdict', () => {
    const result = buildIndexingHealth(
      [row('celo', 'payments', {
        status: 'catching_up', gaps_count: 3, last_success_at: null,
      })],
      now,
    );
    expect(
      result.chains
        .find((c) => c.chain === 'celo')
        ?.paths.find((p) => p.path === 'payments')?.status,
    ).toBe('current');
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

test('a retained registry retry backlog stays disclosed even though it no longer pages', () => {
  const result = buildIndexingHealth([
    row('arc', 'registry', { status: 'catching_up', error_code: 'retry_backlog', unresolved_count: 1397 }),
  ], now);
  expect(result.chains.find(c => c.chain === 'arc')?.paths.find(p => p.path === 'registry')?.issue).toBe('registry_retry');
});


test('archived testnet health never downgrades active chain health', () => {
  const rows = INDEXING_PATHS.map(def => row(def.chain, def.path, { enabled: def.chain !== 'arc' }));
  const result = buildIndexingHealth(rows, now);
  expect(result.chains.find(chain => chain.chain === 'arc')?.status).toBe('disabled');
  expect(result.status).toBe('current');
});
