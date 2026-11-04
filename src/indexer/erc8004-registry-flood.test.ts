/// <reference types="bun-types" />
/**
 * A registrar minting one agent per block (Central City on Arc mainnet,
 * 2026-11) must not stop the registry path: excluded hosts cost one identity
 * read, and a scan far behind its tip banks progress instead of restarting.
 */
import { describe, expect, test } from 'bun:test';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, parseAbi } from 'viem';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isExcludedRegistrationUri, ERC8004_REGISTRIES, type Erc8004RegistryConfig } from '../config/erc8004-registries';
import { runIncrementalRegistryScan, type ScannedAgent } from './erc8004-registry';

const OWNER = '0x1111111111111111111111111111111111111111';
const ABI = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)', 'error ERC721NonexistentToken(uint256 tokenId)']);
const absent = () => new ContractFunctionExecutionError(new ContractFunctionRevertedError({
  abi: ABI, functionName: 'ownerOf', data: encodeErrorResult({ abi: ABI, errorName: 'ERC721NonexistentToken', args: [3n] }),
}), { abi: ABI, functionName: 'ownerOf', args: [3n], contractAddress: OWNER });
const BULK = 'https://centralcity.ai/a/abc';
const config = {
  chain: 'celo', viemChain: {}, identityRegistry: '0x0', reputationRegistry: '0x0', rpcEnvVar: 'X',
  excludedRegistrationHosts: ['centralcity.ai'],
} as unknown as Erc8004RegistryConfig;

function client(tip: number, opts: { uri?: (id: number) => string; failIds?: Set<number> } = {}) {
  const feedbackReads: number[] = [];
  return {
    feedbackReads,
    readContract: (async ({ args }: { args: readonly unknown[] }) => {
      const id = Number(args[0]);
      if (id >= 1 && id <= tip) return OWNER;
      throw absent();
    }) as never,
    multicall: (async ({ contracts }: { contracts: { functionName: string; args: readonly unknown[] }[] }) =>
      contracts.map(c => {
        const id = Number(c.args[0]);
        if (c.functionName === 'readAllFeedback') {
          feedbackReads.push(id);
          return { status: 'success', result: [[], [], [], [], [], [], []] };
        }
        if (opts.failIds?.has(id)) return { status: 'failure' };
        if (c.functionName === 'tokenURI') return { status: 'success', result: opts.uri?.(id) ?? 'data:,' };
        return { status: 'success', result: OWNER };
      })) as never,
  };
}

describe('excluded registration hosts', () => {
  test('matches the host and its subdomains only, on any scheme or case', () => {
    const hosts = ['centralcity.ai'];
    expect(isExcludedRegistrationUri('https://centralcity.ai/a/x', hosts)).toBe(true);
    expect(isExcludedRegistrationUri('http://API.CentralCity.ai/a/x', hosts)).toBe(true);
    expect(isExcludedRegistrationUri('https://notcentralcity.ai/a/x', hosts)).toBe(false);
    expect(isExcludedRegistrationUri('https://evil.test/centralcity.ai', hosts)).toBe(false);
    expect(isExcludedRegistrationUri('ipfs://centralcity', hosts)).toBe(false);
    expect(isExcludedRegistrationUri('', hosts)).toBe(false);
    expect(isExcludedRegistrationUri('not a uri', hosts)).toBe(false);
    expect(isExcludedRegistrationUri('https://centralcity.ai/a/x', undefined)).toBe(false);
  });

  test('excluded ids are not persisted, not fetched, not read for feedback, and still advance the cursor', async () => {
    const persisted: ScannedAgent[] = [];
    const fake = client(4, { uri: id => (id % 2 ? BULK : 'data:,') });
    const saved: number[] = [];
    const result = await runIncrementalRegistryScan(config,
      async (_c, rows) => { persisted.push(...rows); return rows.length; },
      async (_c, rows) => rows.length,
      async () => 0, async (_c, tip) => { saved.push(tip); },
      { client: fake, rescanWindow: 1, fetchRemote: true },
    );
    expect([...new Set(persisted.map(a => a.agentId))]).toEqual([2, 4]);
    expect(fake.feedbackReads.sort()).toEqual([2, 4]);
    expect(result.excludedRegistrations).toBe(2);
    expect(result.errors).toBe(0);
    expect(saved.at(-1)).toBe(4);
  });

  test('arc-mainnet excludes the bulk registrar, and the public view hides what is already mirrored', () => {
    const hosts = ERC8004_REGISTRIES['arc-mainnet'].excludedRegistrationHosts ?? [];
    expect(hosts).toContain('centralcity.ai');
    // SQL cannot import the list: this guard is what keeps the two in step.
    const view = readFileSync(join(import.meta.dir, '../db/sql/explore-agents-view.sql'), 'utf8');
    for (const host of hosts) expect(view).toContain(`'https://${host}/%'`);
  });
});

describe('a scan far behind its tip', () => {
  const persist = async (_c: string, rows: unknown[]) => rows.length;

  test('a spent budget banks the clean prefix and the next run resumes there', async () => {
    let clock = 0;
    let cursor = 0;
    const seen: number[] = [];
    const run = () => runIncrementalRegistryScan(config,
      async (_c, rows) => { seen.push(...rows.map(a => a.agentId)); clock += 30; return rows.length; },
      persist, async () => cursor, async (_c, tip) => { cursor = tip; },
      { client: client(25), rescanWindow: 1, fetchRemote: false, identityBatch: 10, timeBudgetMs: 100, now: () => clock },
    );

    const first = await run();
    expect(first.budgetExhausted).toBe(true);
    expect(cursor).toBe(20);
    expect(first.cursorTip).toBe(20);
    expect(first.pendingIds).toBe(5);

    clock = 0;
    const second = await run();
    expect(second.budgetExhausted).toBeFalsy();
    expect(cursor).toBe(25);
    expect(second.pendingIds).toBe(0);
    expect([...new Set(seen)].filter(id => id <= 20)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test('banking stops at the first dirty batch, so a failed member is retried', async () => {
    let cursor = 0;
    const result = await runIncrementalRegistryScan(config, persist, persist,
      async () => cursor, async (_c, tip) => { cursor = tip; },
      { client: client(25, { failIds: new Set([15]) }), rescanWindow: 1, fetchRemote: false, identityBatch: 10 },
    );
    expect(result.errors).toBeGreaterThan(0);
    expect(cursor).toBe(10);
    expect(result.cursorTip).toBe(10);
    expect(result.pendingIds).toBe(15);
  });

  test('after the first dirty batch the run stops spending quota on ids it cannot bank', async () => {
    const fake = client(100, { failIds: new Set([15]) });
    let identityCalls = 0;
    const multicall = fake.multicall as unknown as (p: { contracts: { functionName: string }[] }) => Promise<unknown>;
    const counted = async (p: { contracts: { functionName: string }[] }) => {
      if (p.contracts[0]?.functionName === 'ownerOf') identityCalls++;
      return multicall(p);
    };
    await runIncrementalRegistryScan(config, persist, persist, async () => 0, async () => {},
      { client: { ...fake, multicall: counted as never }, rescanWindow: 1, fetchRemote: false, identityBatch: 10 });
    expect(identityCalls).toBe(2);
  });

  test('a chain whose RPC meters JSON-RPC batch items reads each identity batch as one eth_call', async () => {
    const fake = client(3);
    const sizes: unknown[] = [];
    const multicall = fake.multicall as unknown as (p: { contracts: { functionName: string }[]; batchSize?: number }) => Promise<unknown>;
    const spied = async (p: { contracts: { functionName: string }[]; batchSize?: number }) => {
      if (p.contracts[0]?.functionName === 'ownerOf') sizes.push(p.batchSize);
      return multicall(p);
    };
    await runIncrementalRegistryScan({ ...config, identityMulticallBatchBytes: 0 }, persist, persist, async () => 0, async () => {},
      { client: { ...fake, multicall: spied as never }, rescanWindow: 1, fetchRemote: false });
    expect(sizes).toEqual([0]);
    expect(ERC8004_REGISTRIES['arc-mainnet'].identityMulticallBatchBytes).toBe(0);
  });

  test('a refresh window that finished is saved even when the budget stops the new-id sweep', async () => {
    let clock = 0;
    let refresh = 1;
    await runIncrementalRegistryScan(config,
      async (_c, rows) => { clock += 60; return rows.length; }, persist,
      async () => 20, async () => {},
      {
        client: client(100), rescanWindow: 5, fetchRemote: false, identityBatch: 5, timeBudgetMs: 100,
        now: () => clock,
        refreshCursor: { load: async () => refresh, save: async next => { refresh = next; } },
      },
    );
    expect(refresh).toBe(6);
  });
});
