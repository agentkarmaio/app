/// <reference types="bun-types" />
/**
 * Schema invariants for the multi-chain dimension. Pure-type + const checks —
 * no DB connection. Guards the chain union and the indexer-cursor composite PK.
 */
import { describe, expect, test } from 'bun:test';
import { CHAINS, DEFAULT_CHAIN, isChain, indexerCursorsTable, walletsTable } from './schema';
import type { IndexerCursor, Wallet } from './schema';

describe('CHAINS dimension', () => {
  test('includes stellar alongside solana and celo', () => {
    expect([...CHAINS]).toEqual(['solana', 'celo', 'stellar']);
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
