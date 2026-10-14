/// <reference types="bun-types" />
/**
 * stellar-testnet must not be reachable from any public UI input: the chain
 * switcher, explore/leaderboard chain params, MCP tool enums or the agent
 * page's ?chain= hint. (DB-level exclusions: db/stellar-testnet-isolation.test.ts.)
 */
import { describe, expect, test } from 'bun:test';
import { activeChainFromPath, chainOptions } from './chain-meta';
import { parseChain } from './leaderboard-params';
import { chainFilterSchema, chainSchema } from '@/app/mcp/route';
import { isSiteChain } from '@/db/schema';

describe('public surfaces never offer stellar-testnet', () => {
  test('chain switcher / filter pill options', () => {
    expect(chainOptions()).not.toContain('stellar-testnet');
    expect(chainOptions()).toContain('stellar');
  });
  test('/stellar stays the mainnet context page', () => {
    expect(activeChainFromPath('/stellar')).toBe('stellar');
  });
  test('leaderboard/graph ?chain= ignores it', () => {
    expect(parseChain('stellar-testnet')).toBeUndefined();
    expect(parseChain('stellar')).toBe('stellar');
  });
  test('MCP tool enums reject it', () => {
    expect(chainSchema.safeParse('stellar-testnet').success).toBe(false);
    expect(chainFilterSchema.safeParse('stellar-testnet').success).toBe(false);
  });
  test('page/UI chain hints reject it but keep the Arc archive', () => {
    expect(isSiteChain('stellar-testnet')).toBe(false);
    expect(isSiteChain('arc')).toBe(true);
  });
});
