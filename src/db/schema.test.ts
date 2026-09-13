/// <reference types="bun-types" />
/**
 * Schema invariants for the multi-chain dimension. Pure-type + const checks —
 * no DB connection. Guards the chain union and the indexer-cursor composite PK.
 */
import { describe, expect, test } from 'bun:test';
import {
  CHAINS, DEFAULT_CHAIN, isChain, indexerCursorsTable, walletsTable,
  LIVENESS_STATUSES, getLivenessStatus,
} from './schema';
import type { IndexerCursor, Wallet } from './schema';

describe('CHAINS dimension', () => {
  test('includes arc alongside solana, celo and stellar', () => {
    expect([...CHAINS]).toEqual(['solana', 'celo', 'stellar', 'arc', 'arc-mainnet']);
  });

  test('isChain accepts stellar, rejects unknown', () => {
    expect(isChain('stellar')).toBe(true);
    expect(isChain('bitcoin')).toBe(false);
  });

  test('DEFAULT_CHAIN stays solana for back-compat', () => {
    expect(DEFAULT_CHAIN).toBe('solana');
  });
});

describe('indexerCursorsTable composite PK', () => {
  test('has both chain and facilitator columns', () => {
    const cols = Object.keys(indexerCursorsTable);
    expect(cols).toContain('chain');
    expect(cols).toContain('facilitator');
  });

  test('IndexerCursor type carries chain', () => {
    const c: IndexerCursor = {
      chain: 'stellar', facilitator: 'CCW…', last_signature: '42',
      last_slot: 42, updated_at: new Date().toISOString(),
    };
    expect(c.chain).toBe('stellar');
  });
});

describe('walletsTable stellar_agent_id', () => {
  test('column exists for ERC-8004 Soroban agentId mapping', () => {
    expect(Object.keys(walletsTable)).toContain('stellar_agent_id');
  });
  test('Wallet type allows nullable stellar_agent_id', () => {
    const w = { stellar_agent_id: null } as Pick<Wallet, 'stellar_agent_id'>;
    expect(w.stellar_agent_id).toBeNull();
  });
});

describe('liveness is derived from OBSERVED activity', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

  // The bug this guards: `last_seen` used to be a row-WRITE timestamp, so a
  // declared-only agent with zero observed activity aged past the 90d threshold
  // and rendered a red "Inactive" — asserting death from no evidence at all.
  test('null last_seen is Unobserved, never Inactive', () => {
    expect(getLivenessStatus(null)).toBe('Unobserved');
    expect(getLivenessStatus(undefined)).toBe('Unobserved');
  });

  test('an unparseable timestamp is Unobserved, not silently Active', () => {
    expect(getLivenessStatus('not-a-date')).toBe('Unobserved');
  });

  test('observed thresholds are unchanged', () => {
    expect(getLivenessStatus(hoursAgo(1))).toBe('Active');
    expect(getLivenessStatus(hoursAgo(48))).toBe('Recent');
    expect(getLivenessStatus(hoursAgo(30 * 24))).toBe('Dormant');
    expect(getLivenessStatus(hoursAgo(120 * 24))).toBe('Inactive');
  });

  test('LIVENESS_STATUSES is the single exhaustive list every renderer keys off', () => {
    expect([...LIVENESS_STATUSES])
      .toEqual(['Active', 'Recent', 'Dormant', 'Inactive', 'Unobserved']);
  });
});

describe('wallets.last_seen nullability', () => {
  test('Wallet type allows null last_seen (nothing observed)', () => {
    const w = { last_seen: null } as Pick<Wallet, 'last_seen'>;
    expect(w.last_seen).toBeNull();
  });

  test('the column is nullable in the Drizzle schema', () => {
    expect(walletsTable.last_seen.notNull).toBe(false);
  });
});
