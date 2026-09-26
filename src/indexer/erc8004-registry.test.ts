/// <reference types="bun-types" />
/**
 * ERC-8004 registry scanner — pure-helper tests.
 *
 * No live RPC: registration decode, feedback array flattening, per-agent
 * aggregation, tip binary-search (fake readContract), and the full orchestrator
 * against an in-memory persist sink. Verifies the count semantics that let AK
 * match 8004scan (sum of per-agent feedback_count === total records persisted).
 *
 * Run: bun test src/indexer/erc8004-registry.test.ts
 */

import { describe, expect, mock, test } from 'bun:test';
import { gzipSync } from 'zlib';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, encodeErrorResult, parseAbi } from 'viem';
import {
  decodeRegistration,
  parseFeedbackArrays,
  aggregateAgentFeedback,
  findRegistryTip,
  chunk,
  runRegistryScan,
  incrementalScanRange,
  runIncrementalRegistryScan,
  makeRegistryClient,
  DEFAULT_RESCAN_WINDOW,
  type ScannedAgent,
  type ScannedFeedback,
  type RegistryScanOptions,
} from './erc8004-registry';
import { ERC8004_REGISTRIES, type Erc8004RegistryConfig } from '../config/erc8004-registries';
import { scoreMetadataQuality } from '../scoring/celo-metadata';

const SAMPLE_REG = { type: 'x', name: 'Agent', description: 'd', services: [{ name: 's', endpoint: 'https://e' }] };

const OWNER = '0x1111111111111111111111111111111111111111';
const TOKEN_ERRORS = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'error ERC721NonexistentToken(uint256 tokenId)',
  'error RegistryPaused()',
]);
type FixtureMulticall = (params: { contracts: readonly { functionName: string; args?: readonly unknown[] }[] }) => Promise<{ status: string; result?: unknown; error?: unknown }[]>;

function contractRevert(errorName: 'ERC721NonexistentToken' | 'RegistryPaused') {
  const data = errorName === 'ERC721NonexistentToken'
    ? encodeErrorResult({ abi: TOKEN_ERRORS, errorName, args: [3n] })
    : encodeErrorResult({ abi: TOKEN_ERRORS, errorName });
  return new ContractFunctionExecutionError(new ContractFunctionRevertedError({
    abi: TOKEN_ERRORS, functionName: 'ownerOf', data,
  }), { abi: TOKEN_ERRORS, functionName: 'ownerOf', args: [3n], contractAddress: OWNER });
}

async function withMainnetRpc<T>(raw: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.ARC_MAINNET_RPC_URL;
  if (raw === undefined) delete process.env.ARC_MAINNET_RPC_URL;
  else process.env.ARC_MAINNET_RPC_URL = raw;
  try { return await fn(); }
  finally {
    if (previous === undefined) delete process.env.ARC_MAINNET_RPC_URL;
    else process.env.ARC_MAINNET_RPC_URL = previous;
  }
}

function registryFixture(config = ERC8004_REGISTRIES.celo) {
  const events: string[] = [];
  const agents = new Map<number, ScannedAgent>([[1, {
    agentId: 1, owner: OWNER, agentWallet: OWNER, tokenURI: 'old-uri',
    registration: { ...SAMPLE_REG, name: 'Previously fetched' }, registrationStatus: 'fetched',
    metadataScore: 80, feedback: { count: 3, sum: 240, avg: 80 },
  }]]);
  const cursors = new Map<string, number>([['arc', 77], ['celo', 0], ['arc-mainnet', 0]]);
  const writes: { chain: string; rows: ScannedAgent[] }[] = [];
  const feedback = new Map<string, ScannedFeedback>();
  const persistAgents = mock(async (chain: string, rows: ScannedAgent[]) => {
    events.push(`agents:${chain}`);
    writes.push({ chain, rows: structuredClone(rows) });
    for (const row of rows) agents.set(row.agentId, { ...agents.get(row.agentId), ...structuredClone(row) });
    return rows.length;
  });
  const persistFeedback = mock(async (chain: string, rows: ScannedFeedback[]) => {
    events.push(`feedback:${chain}`);
    for (const row of rows) feedback.set(`${chain}:${row.agentId}:${row.client}:${row.feedbackIndex}`, row);
    return rows.length;
  });
  const getCursor = mock(async (chain: string) => { events.push(`cursor-read:${chain}`); return cursors.get(chain) ?? 0; });
  const setCursor = mock(async (chain: string, tip: number) => { events.push(`cursor-write:${chain}`); cursors.set(chain, tip); });
  const client = {
    getChainId: mock(async () => { events.push('chain-id'); return 5042; }),
    getBytecode: mock(async ({ address }: { address: string }) => { events.push(`code:${address.toLowerCase()}`); return '0x6000' as const; }),
    readContract: (async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      events.push(functionName);
      if (functionName === 'getIdentityRegistry') return config.identityRegistry;
      if (Number(args?.[0]) <= 2) return OWNER;
      throw contractRevert('ERC721NonexistentToken');
    }) as never,
    multicall: (async ({ contracts }: { contracts: { functionName: string; args: readonly unknown[] }[] }) => contracts.map(c => ({
      status: 'success', result: c.functionName === 'readAllFeedback'
        ? [[OWNER], [1n], [85n], [0], ['quality'], [''], [false]]
        : c.functionName === 'tokenURI' ? JSON.stringify(SAMPLE_REG) : OWNER,
    }))) as never,
  };
  return {
    client, agents, cursors, writes, feedback, events, persistAgents, persistFeedback, getCursor, setCursor,
    run: (opts: RegistryScanOptions = {}) => runIncrementalRegistryScan(
      config, persistAgents, persistFeedback, getCursor, setCursor, { client, ...opts },
    ),
  };
}

describe('registry discovery fails closed', () => {
  test.each([
    Error('HTTP 401 Unauthorized'), Error('fetch failed'), Error('socket ECONNRESET'),
    new ContractFunctionZeroDataError({ functionName: 'ownerOf' }),
    contractRevert('RegistryPaused'),
    new ContractFunctionRevertedError({ abi: TOKEN_ERRORS, functionName: 'ownerOf', message: 'upstream internal error' }),
    Error('HTTP 503: upstream execution reverted'), Error('reverted'),
  ])('a failed tip probe is not an absent token: %s', async error => {
    const readContract = mock(async () => { throw error; });
    await expect(findRegistryTip({ readContract: readContract as never }, OWNER)).rejects.toBe(error);
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  test('a decoded viem nonexistent-token revert is absence', async () => {
    expect(await findRegistryTip({ readContract: (async () => { throw contractRevert('ERC721NonexistentToken'); }) as never }, OWNER)).toBe(0);
  });

  test.each(['ownerOf', 'getAgentWallet', 'tokenURI', 'readAllFeedback'])('%s failure holds the cursor and retains saved fields until replay', async stage => {
    const f = registryFixture();
    const clean = f.client.multicall as FixtureMulticall;
    f.client.multicall = (async (params: Parameters<typeof clean>[0]) => {
      const rows = await clean(params);
      return rows.map((row, i) => params.contracts[i].functionName === stage && Number(params.contracts[i].args?.[0]) === 1
        ? { status: 'failure', error: Error('HTTP 503 upstream unavailable') } : row);
    }) as never;
    const result = await f.run();
    expect(result.errors).toBeGreaterThan(0);
    expect(f.setCursor).not.toHaveBeenCalled();
    expect(f.agents.get(1)?.feedback).toEqual({ count: 3, sum: 240, avg: 80 });
    if (stage !== 'readAllFeedback') expect(f.agents.get(1)?.registration?.name).toBe('Previously fetched');
    expect(f.agents.has(2)).toBe(true);
    f.client.multicall = clean as never;
    expect((await f.run()).errors).toBe(0);
    expect(f.cursors.get('celo')).toBe(2);
    expect(f.agents.get(1)?.feedback?.count).toBe(1);
    expect(f.feedback.size).toBe(2);
  });

  test('remote outage marks the member unreachable without holding the run', async () => {
    const f = registryFixture();
    const clean = f.client.multicall as FixtureMulticall;
    f.client.multicall = (async (params: Parameters<typeof clean>[0]) => {
      const rows = await clean(params);
      return rows.map((row, i) => params.contracts[i].functionName === 'tokenURI' && Number(params.contracts[i].args?.[0]) === 1
        ? { status: 'success', result: 'https://93.184.216.34/agent.json' } : row);
    }) as never;
    const previousFetch = globalThis.fetch;
    const fetch = mock(async () => new Response('gateway unavailable', { status: 503 }));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      const result = await f.run();
      expect(fetch).toHaveBeenCalledTimes(1);
      // A dead metadata host is the operator's content debt, not a run fault —
      // it is counted separately and cannot hold the discovery cursor.
      expect(result.errors).toBe(0);
      expect(result.registrationUnreachable).toBe(1);
      expect(f.setCursor).toHaveBeenCalled();
      expect(f.cursors.get('celo')).toBe(2);
      // The member still flows to the mirror with fresh on-chain identity;
      // protecting a previously fetched registration is upsertErc8004Agents's job.
      const persisted = f.writes.flatMap(w => w.rows).find(r => r.agentId === 1)!;
      expect(persisted.registrationStatus).toBe('unreachable');
      expect(persisted.tokenURI).toBe('https://93.184.216.34/agent.json');
      expect(persisted.registration).toBeNull();
      expect(f.agents.has(2)).toBe(true);
    } finally { globalThis.fetch = previousFetch; }
  });

  test('explicit-id scans count registration unreachability per member and keep reading feedback', async () => {
    const f = registryFixture();
    const clean = f.client.multicall as FixtureMulticall;
    f.client.multicall = (async (params: Parameters<typeof clean>[0]) => {
      const rows = await clean(params);
      return rows.map((row, i) => params.contracts[i].functionName === 'tokenURI' && Number(params.contracts[i].args?.[0]) === 1
        ? { status: 'success', result: 'https://93.184.216.34/agent.json' } : row);
    }) as never;
    const previousFetch = globalThis.fetch;
    const fetch = mock(async () => new Response('gateway unavailable', { status: 503 }));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      const result = await runRegistryScan(ERC8004_REGISTRIES.celo, f.persistAgents, f.persistFeedback, {
        client: f.client, agentIds: [1, 2],
      });
      expect(result.registrationUnreachable).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.failedMembers).toEqual([{ agentId: 1, stages: ['registration'] }]);
      expect(result.agentsScanned).toBe(2);
      // Feedback does not depend on registration — the unreachable member's
      // feedback is still read and persisted.
      expect([...f.feedback.keys()].filter(k => k.startsWith('celo:1:')).length).toBeGreaterThan(0);
    } finally { globalThis.fetch = previousFetch; }
  });

  test('malformed discovery feedback cannot replace an existing aggregate or advance the cursor', async () => {
    const f = registryFixture();
    const clean = f.client.multicall as FixtureMulticall;
    f.client.multicall = (async (params: Parameters<typeof clean>[0]) => {
      const rows = await clean(params);
      return rows.map((row, i) => params.contracts[i].functionName === 'readAllFeedback'
        ? { status: 'success', result: [[OWNER], [], [], [], [], [], []] } : row);
    }) as never;
    const result = await f.run();
    expect(result.errors).toBe(2);
    expect(f.setCursor).not.toHaveBeenCalled();
    expect(f.persistFeedback).not.toHaveBeenCalled();
    expect(f.agents.get(1)?.feedback).toEqual({ count: 3, sum: 240, avg: 80 });
  });
});

describe('Arc registry admission', () => {
  const config = ERC8004_REGISTRIES['arc-mainnet'];
  const rpc = 'https://rpc.example.invalid/mainnet';

  test.each([undefined, '', 'rpc.example.invalid', 'http://rpc.example.invalid'])('requires an explicit HTTPS RPC even with an injected client: %s', async raw => {
    await withMainnetRpc(raw, async () => {
      expect(() => makeRegistryClient(config)).toThrow(/arc_mainnet_rpc_/);
      const f = registryFixture(config);
      await expect(f.run()).rejects.toThrow(/arc_mainnet_rpc_/);
      expect(f.client.getChainId).not.toHaveBeenCalled();
      expect(f.getCursor).not.toHaveBeenCalled();
      expect(f.persistAgents).not.toHaveBeenCalled();
      expect(f.setCursor).not.toHaveBeenCalled();
    });
  });

  test.each(['incremental', 'bounded', 'explicit'] as const)('%s scanning cannot bypass the actual chain ID with a test client', async mode => {
    await withMainnetRpc(rpc, async () => {
      const f = registryFixture(config);
      f.client.getChainId.mockImplementation(async () => 5042002);
      const scan = mode === 'incremental' ? f.run() : runRegistryScan(config, f.persistAgents, f.persistFeedback, {
        client: f.client, ...(mode === 'bounded' ? { toId: 2 } : { agentIds: [1] }),
      });
      await expect(scan).rejects.toThrow('arc_mainnet_chain_mismatch');
      expect(f.client.getChainId).toHaveBeenCalledTimes(1);
      expect(f.getCursor).not.toHaveBeenCalled();
      expect(f.persistAgents).not.toHaveBeenCalled();
      expect(f.persistFeedback).not.toHaveBeenCalled();
      expect(f.setCursor).not.toHaveBeenCalled();
    });
  });

  test('a client without admission methods cannot persist mainnet membership', async () => {
    await withMainnetRpc(rpc, async () => {
      const f = registryFixture(config);
      await expect(f.run({ client: { readContract: f.client.readContract, multicall: f.client.multicall } })).rejects.toThrow();
      expect(f.persistAgents).not.toHaveBeenCalled();
      expect(f.setCursor).not.toHaveBeenCalled();
    });
  });

  test.each(['chain', 'identity-code', 'reputation-code', 'multicall-code', 'linkage'] as const)('admission rejects RPC failures at %s before any membership or cursor writes', async stage => {
    await withMainnetRpc(rpc, async () => {
      const f = registryFixture(config);
      const error = Error('HTTP 401 Unauthorized');
      const addresses = {
        'identity-code': config.identityRegistry,
        'reputation-code': config.reputationRegistry,
        'multicall-code': config.viemChain.contracts!.multicall3!.address,
      };
      if (stage === 'chain') f.client.getChainId.mockImplementation(async () => { throw error; });
      else if (stage === 'linkage') f.client.readContract = (async () => { throw error; }) as never;
      else f.client.getBytecode.mockImplementation(async ({ address }) => {
        if (address === addresses[stage]) throw error;
        return '0x6000';
      });
      await expect(f.run()).rejects.toThrow();
      expect(f.getCursor).not.toHaveBeenCalled();
      expect(f.persistAgents).not.toHaveBeenCalled();
      expect(f.persistFeedback).not.toHaveBeenCalled();
      expect(f.setCursor).not.toHaveBeenCalled();
    });
  });

  test.each(['identity', 'reputation', 'multicall', 'linkage'] as const)('rejects an undeployed or unrelated %s contract', async stage => {
    await withMainnetRpc(rpc, async () => {
      const f = registryFixture(config);
      if (stage === 'linkage') {
        const read = f.client.readContract as (params: { functionName: string; args?: readonly unknown[] }) => Promise<unknown>;
        f.client.readContract = (async (params: Parameters<typeof read>[0]) => params.functionName === 'getIdentityRegistry' ? OWNER : read(params)) as never;
      }
      else {
        const missing = stage === 'identity' ? config.identityRegistry : stage === 'reputation'
          ? config.reputationRegistry : config.viemChain.contracts!.multicall3!.address;
        f.client.getBytecode = mock(async ({ address }: { address: string }) => address === missing ? '0x' : '0x6000') as typeof f.client.getBytecode;
      }
      await expect(f.run()).rejects.toThrow();
      expect(f.getCursor).not.toHaveBeenCalled();
      expect(f.persistAgents).not.toHaveBeenCalled();
      expect(f.setCursor).not.toHaveBeenCalled();
    });
  });

  test('admitted incremental scans isolate mainnet membership, feedback and cursor from testnet', async () => {
    await withMainnetRpc(rpc, async () => {
      const f = registryFixture(config);
      expect((await f.run()).errors).toBe(0);
      expect(f.events[0]).toBe('chain-id');
      expect(f.events.indexOf('getIdentityRegistry')).toBeLessThan(f.events.indexOf('cursor-read:arc-mainnet'));
      expect(f.client.getBytecode.mock.calls.map(([{ address }]) => address.toLowerCase())).toEqual(expect.arrayContaining([
        config.identityRegistry.toLowerCase(), config.reputationRegistry.toLowerCase(), config.viemChain.contracts!.multicall3!.address.toLowerCase(),
      ]));
      expect(f.writes.every(write => write.chain === 'arc-mainnet')).toBe(true);
      expect([...f.feedback.keys()].every(key => key.startsWith('arc-mainnet:'))).toBe(true);
      expect(f.cursors.get('arc-mainnet')).toBe(2);
      expect(f.cursors.get('arc')).toBe(77);
      f.client.getChainId.mockImplementation(async () => 5042002);
      f.persistAgents.mockClear(); f.setCursor.mockClear();
      await expect(f.run()).rejects.toThrow('arc_mainnet_chain_mismatch');
      expect(f.persistAgents).not.toHaveBeenCalled();
      expect(f.setCursor).not.toHaveBeenCalled();
    });
  });

  test.each(['incremental', 'bounded', 'explicit'] as const)('%s scans include mainnet agent zero', async mode => {
    await withMainnetRpc(rpc, async () => {
      const f = registryFixture(config);
      const result = mode === 'incremental' ? await f.run() : await runRegistryScan(config, f.persistAgents, f.persistFeedback, {
        client: f.client, ...(mode === 'bounded' ? { toId: 2 } : { agentIds: [0, 1, 2] }),
      });
      expect(result.errors).toBe(0);
      expect([...f.agents.keys()].sort()).toEqual([0, 1, 2]);
      expect([...f.feedback.keys()].some(key => key.startsWith('arc-mainnet:0:'))).toBe(true);
    });
  });

  test('a mainnet registry containing only agent zero is not empty', async () => {
    await withMainnetRpc(rpc, async () => {
      const f = registryFixture(config);
      const clean = f.client.readContract as (params: { functionName: string; args?: readonly unknown[] }) => Promise<unknown>;
      f.client.readContract = (async (params: Parameters<typeof clean>[0]) => {
        if (params.functionName === 'ownerOf' && Number(params.args?.[0]) !== 0) throw contractRevert('ERC721NonexistentToken');
        return clean(params);
      }) as never;
      const result = await f.run();
      expect(result.agentsScanned).toBe(1);
      expect(f.agents.has(0)).toBe(true);
      expect(f.setCursor).toHaveBeenCalledWith('arc-mainnet', 0);
    });
  });

  test('an empty mainnet registry neither writes membership nor advances its cursor', async () => {
    await withMainnetRpc(rpc, async () => {
      const f = registryFixture(config);
      const clean = f.client.readContract as (params: { functionName: string; args?: readonly unknown[] }) => Promise<unknown>;
      f.client.readContract = (async (params: Parameters<typeof clean>[0]) => {
        if (params.functionName === 'ownerOf') throw contractRevert('ERC721NonexistentToken');
        return clean(params);
      }) as never;
      expect((await f.run()).agentsScanned).toBe(0);
      expect(f.persistAgents).not.toHaveBeenCalled();
      expect(f.setCursor).not.toHaveBeenCalled();
    });
  });

  test('cancellation during admission prevents all later work', async () => {
    await withMainnetRpc(rpc, async () => {
      const controller = new AbortController();
      const f = registryFixture(config);
      f.client.getChainId.mockImplementation(async () => { controller.abort(Error('stop_registry')); return 5042; });
      await expect(f.run({ signal: controller.signal })).rejects.toThrow('stop_registry');
      expect(f.client.getBytecode).not.toHaveBeenCalled();
      expect(f.getCursor).not.toHaveBeenCalled();
      expect(f.persistAgents).not.toHaveBeenCalled();
      expect(f.setCursor).not.toHaveBeenCalled();
    });
  });
});

describe('decodeRegistration', () => {
  test('data: base64 json', async () => {
    const uri = 'data:application/json;base64,' + Buffer.from(JSON.stringify(SAMPLE_REG)).toString('base64');
    const r = await decodeRegistration(uri);
    expect(r.status).toBe('inline');
    expect(r.registration?.name).toBe('Agent');
  });

  test('data: gzip base64 json', async () => {
    const gz = gzipSync(Buffer.from(JSON.stringify(SAMPLE_REG)));
    const uri = 'data:application/json;enc=gzip;base64,' + gz.toString('base64');
    const r = await decodeRegistration(uri);
    expect(r.status).toBe('inline');
    expect(r.registration?.name).toBe('Agent');
  });

  test('data: utf8 (non-base64) json', async () => {
    const uri = 'data:application/json,' + encodeURIComponent(JSON.stringify(SAMPLE_REG));
    const r = await decodeRegistration(uri);
    expect(r.status).toBe('inline');
    expect(r.registration?.name).toBe('Agent');
  });

  test('bare raw JSON without data: prefix', async () => {
    const r = await decodeRegistration(JSON.stringify(SAMPLE_REG));
    expect(r.status).toBe('inline');
    expect(r.registration?.name).toBe('Agent');
  });

  test('empty / null URI', async () => {
    expect((await decodeRegistration('')).status).toBe('empty');
    expect((await decodeRegistration(null)).status).toBe('empty');
    expect((await decodeRegistration('   ')).status).toBe('empty');
  });

  test('malformed data: URI → invalid', async () => {
    const r = await decodeRegistration('data:application/json;base64,@@not-base64-json@@');
    expect(r.status).toBe('invalid');
    expect(r.registration).toBeNull();
  });

  test('http with fetchRemote=false → pending (no network)', async () => {
    const r = await decodeRegistration('https://example.com/agent.json', { fetchRemote: false });
    expect(r.status).toBe('pending');
    expect(r.registration).toBeNull();
  });

  test('ipfs with fetchRemote=false → pending', async () => {
    const r = await decodeRegistration('ipfs://bafy.../agent.json', { fetchRemote: false });
    expect(r.status).toBe('pending');
  });

  test('unsupported scheme → invalid', async () => {
    const r = await decodeRegistration('ar://something', { fetchRemote: false });
    expect(r.status).toBe('invalid');
  });
});

describe('decodeRegistration SSRF guard', () => {
  function spyFetch(body = '{}', status = 200) {
    const spy = mock(async () => new Response(body, { status }));
    const orig = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    return { spy, restore: () => { globalThis.fetch = orig; } };
  }

  test('link-local metadata IP is blocked without issuing a fetch', async () => {
    const { spy, restore } = spyFetch();
    try {
      const r = await decodeRegistration('http://169.254.169.254/latest/meta-data/iam', { fetchRemote: true });
      expect(spy).not.toHaveBeenCalled();
      expect(r.status).toBe('unreachable');
      expect(r.registration).toBeNull();
    } finally {
      restore();
    }
  });

  test.each([
    ['http://127.0.0.1:8545/', 'loopback v4'],
    ['http://10.1.2.3/agent.json', 'private 10/8'],
    ['http://172.16.5.4/agent.json', 'private 172.16/12'],
    ['http://192.168.0.1/agent.json', 'private 192.168/16'],
    ['http://[::1]/agent.json', 'loopback v6'],
    ['http://0.0.0.0/agent.json', 'unspecified v4'],
  ])('blocks %s (%s) without fetching', async (uri) => {
    const { spy, restore } = spyFetch();
    try {
      const r = await decodeRegistration(uri, { fetchRemote: true });
      expect(spy).not.toHaveBeenCalled();
      expect(r.status).toBe('unreachable');
    } finally {
      restore();
    }
  });

  test('DNS name resolving to a private IP is blocked without fetching', async () => {
    const { spy, restore } = spyFetch();
    try {
      const r = await decodeRegistration('http://internal.evil.test/agent.json', {
        fetchRemote: true,
        lookup: async () => [{ address: '10.0.0.7', family: 4 }],
      });
      expect(spy).not.toHaveBeenCalled();
      expect(r.status).toBe('unreachable');
    } finally {
      restore();
    }
  });

  test('public host is allowed and fetched', async () => {
    const { restore } = spyFetch(JSON.stringify(SAMPLE_REG), 200);
    try {
      const r = await decodeRegistration('https://example.com/agent.json', {
        fetchRemote: true,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      });
      expect(r.status).toBe('fetched');
      expect(r.registration?.name).toBe('Agent');
    } finally {
      restore();
    }
  });

  test('redirect to a private host is blocked', async () => {
    const orig = globalThis.fetch;
    const spy = mock(async (input: string | URL) => {
      const u = String(input);
      if (u.startsWith('https://example.com')) {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
      }
      return new Response('{}', { status: 200 });
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const r = await decodeRegistration('https://example.com/agent.json', {
        fetchRemote: true,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      });
      expect(r.status).toBe('unreachable');
      // only the first hop is fetched; the private redirect target is never requested
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('parseFeedbackArrays', () => {
  test('flattens parallel arrays into per-record rows, lowercases client', () => {
    const result = [
      ['0xAAaa', '0xBBbb'],
      [BigInt(1), BigInt(2)],
      [BigInt(85), BigInt(100)],
      [0, 0],
      ['perf', 'security'],
      ['v2', 'community'],
      [false, true],
    ];
    const rows = parseFeedbackArrays(7, result);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ agentId: 7, client: '0xaaaa', feedbackIndex: 1, value: 85, tag1: 'perf', revoked: false });
    expect(rows[1]).toMatchObject({ client: '0xbbbb', feedbackIndex: 2, value: 100, revoked: true });
  });

  test('applies valueDecimals to normalize value', () => {
    const rows = parseFeedbackArrays(1, [['0xa'], [BigInt(1)], [BigInt(8500)], [2], ['t'], ['u'], [false]]);
    expect(rows[0].value).toBe(85);
    expect(rows[0].rawValue).toBe('8500');
  });
});

describe('aggregateAgentFeedback', () => {
  test('counts all records but averages only live (non-revoked)', () => {
    const recs: ScannedFeedback[] = [
      { agentId: 1, client: 'a', feedbackIndex: 1, rawValue: '80', value: 80, valueDecimals: 0, tag1: '', tag2: '', revoked: false },
      { agentId: 1, client: 'b', feedbackIndex: 1, rawValue: '100', value: 100, valueDecimals: 0, tag1: '', tag2: '', revoked: false },
      { agentId: 1, client: 'c', feedbackIndex: 1, rawValue: '0', value: 0, valueDecimals: 0, tag1: '', tag2: '', revoked: true },
    ];
    const agg = aggregateAgentFeedback(recs);
    expect(agg.count).toBe(3);
    expect(agg.avg).toBe(90); // (80+100)/2
    expect(agg.sum).toBe(180);
  });

  test('all-revoked → count kept, avg/sum null', () => {
    const agg = aggregateAgentFeedback([
      { agentId: 1, client: 'a', feedbackIndex: 1, rawValue: '50', value: 50, valueDecimals: 0, tag1: '', tag2: '', revoked: true },
    ]);
    expect(agg.count).toBe(1);
    expect(agg.avg).toBeNull();
    expect(agg.sum).toBeNull();
  });
});

describe('findRegistryTip', () => {
  function fakeClient(maxId: number) {
    return {
      readContract: (async ({ args }: { args: readonly unknown[] }) => {
        const id = Number(args[0] as bigint);
        if (id >= 1 && id <= maxId) return '0xowner';
        throw contractRevert('ERC721NonexistentToken');
      }) as never,
    };
  }

  test('finds the exact contiguous tip via binary search', async () => {
    expect(await findRegistryTip(fakeClient(9527), '0x0')).toBe(9527);
    expect(await findRegistryTip(fakeClient(1), '0x0')).toBe(1);
    expect(await findRegistryTip(fakeClient(7), '0x0')).toBe(7);
  });

  test('empty registry → 0', async () => {
    expect(await findRegistryTip(fakeClient(0), '0x0')).toBe(0);
  });
});

describe('chunk', () => {
  test('splits into size-bounded groups', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('runRegistryScan (orchestrator, injected fake client)', () => {
  test('persists one agent row per id; feedback rows total = sum of per-agent counts', async () => {
    // 3 agents; agent 1 has 2 feedback, agent 2 has 1, agent 3 has 0. id 4 is
    // past the tip (ownerOf reverts) and must be skipped.
    const owners: Record<number, string> = { 1: '0xAA', 2: '0xBB', 3: '0xAA' };
    const feedback: Record<number, unknown[]> = {
      1: [['0xC1', '0xC2'], [BigInt(1), BigInt(1)], [BigInt(90), BigInt(80)], [0, 0], ['a', 'b'], ['x', 'y'], [false, false]],
      2: [['0xC3'], [BigInt(1)], [BigInt(70)], [0], ['a'], ['x'], [false]],
      3: [[], [], [], [], [], [], []],
    };
    const fakeClient = {
      readContract: (async ({ args }: { args: readonly unknown[] }) => {
        const id = Number(args[0] as bigint);
        if (owners[id]) return owners[id];
        throw contractRevert('ERC721NonexistentToken');
      }) as never,
      multicall: (async ({ contracts }: { contracts: { functionName: string; args: readonly unknown[] }[] }) =>
        contracts.map((c) => {
          const id = Number(c.args[0] as bigint);
          if (c.functionName === 'readAllFeedback') return { status: 'success', result: feedback[id] };
          if (!owners[id]) return { status: 'failure' };
          if (c.functionName === 'ownerOf') return { status: 'success', result: owners[id] };
          if (c.functionName === 'getAgentWallet') return { status: 'success', result: owners[id] };
          if (c.functionName === 'tokenURI') return { status: 'success', result: '' };
          return { status: 'failure' };
        })) as never,
    };

    const config = {
      chain: 'celo', viemChain: {},
      identityRegistry: '0x0', reputationRegistry: '0x0', rpcEnvVar: 'X',
    } as unknown as Erc8004RegistryConfig;

    const agentsSink = new Map<number, ScannedAgent>();
    const feedbackSink: ScannedFeedback[] = [];
    const persistAgents = async (_c: string, a: ScannedAgent[]) => { for (const x of a) agentsSink.set(x.agentId, x); return a.length; };
    const persistFeedback = async (_c: string, f: ScannedFeedback[]) => { feedbackSink.push(...f); return f.length; };

    const result = await runRegistryScan(config, persistAgents, persistFeedback, {
      toId: 4, // claims tip=4 but id 4 reverts → 3 live agents
      client: fakeClient,
      fetchRemote: false,
    });

    expect(agentsSink.size).toBe(3);             // one row per minted id
    expect(result.agentsScanned).toBe(3);
    expect(feedbackSink.length).toBe(3);          // 2 + 1 + 0
    expect(result.feedbackScanned).toBe(3);
    // Count parity: sum of denormalized per-agent counts === total feedback rows.
    const sumCounts = [...agentsSink.values()].reduce((s, a) => s + (a.feedback?.count ?? 0), 0);
    expect(sumCounts).toBe(feedbackSink.length);
    expect(agentsSink.get(1)?.feedback?.avg).toBe(85); // (90+80)/2
  });
});

describe('incrementalScanRange', () => {
  test('re-scan window wins when few new ids were added', () => {
    // 100 new ids since last sweep, but the 500-id window reaches further back.
    expect(incrementalScanRange(9000, 9100, 500)).toEqual({ from: 8601, to: 9100 });
  });

  test('new-ids window wins when a large backlog of new ids accrued', () => {
    // 700 new ids — older than the 500 re-scan window, so we must start at the
    // first un-scanned id, not just the window, or new ids would be missed.
    expect(incrementalScanRange(9000, 9700, 500)).toEqual({ from: 9001, to: 9700 });
  });

  test('no new ids → re-scan window only (catches feedback on existing agents)', () => {
    expect(incrementalScanRange(9100, 9100, 500)).toEqual({ from: 8601, to: 9100 });
  });

  test('clamps from to 1 when the window or new-range underflows', () => {
    expect(incrementalScanRange(0, 300, 500)).toEqual({ from: 1, to: 300 });
    expect(incrementalScanRange(0, 9100, 500)).toEqual({ from: 1, to: 9100 });
  });

  test('mainnet bootstrap includes agent zero even beyond the rescan window', () => {
    expect(incrementalScanRange(0, 9000, 500, 0)).toEqual({ from: 0, to: 9000 });
    expect(incrementalScanRange(0, 0, 500, 0)).toEqual({ from: 0, to: 0 });
    expect(incrementalScanRange(9000, 9100, 500, 0)).toEqual({ from: 8601, to: 9100 });
  });

  test('empty registry (tip 0) → nothing to do', () => {
    expect(incrementalScanRange(0, 0, 500)).toEqual({ from: 0, to: 0 });
    expect(incrementalScanRange(50, 0, 500)).toEqual({ from: 0, to: 0 });
  });

  test('default window is DEFAULT_RESCAN_WINDOW', () => {
    expect(incrementalScanRange(9000, 9100)).toEqual(
      incrementalScanRange(9000, 9100, DEFAULT_RESCAN_WINDOW),
    );
  });
});

describe('runIncrementalRegistryScan (cursor-driven)', () => {
  // A fake client whose registry tip is `maxId`; every id 1..maxId has an owner
  // and zero feedback. Lets us assert which id range the scan actually touched.
  function fakeClient(maxId: number, scannedIds: Set<number>, firstId = 1) {
    return {
      readContract: (async ({ args }: { args: readonly unknown[] }) => {
        const id = Number(args[0] as bigint);
        if (id >= firstId && id <= maxId) return '0xowner';
        throw contractRevert('ERC721NonexistentToken');
      }) as never,
      multicall: (async ({ contracts }: { contracts: { functionName: string; args: readonly unknown[] }[] }) =>
        contracts.map((c) => {
          const id = Number(c.args[0] as bigint);
          if (c.functionName === 'readAllFeedback') return { status: 'success', result: [[], [], [], [], [], [], []] };
          if (id < firstId || id > maxId) return { status: 'failure' };
          if (c.functionName === 'ownerOf') { scannedIds.add(id); return { status: 'success', result: '0xowner' }; }
          if (c.functionName === 'getAgentWallet') return { status: 'success', result: '0xowner' };
          if (c.functionName === 'tokenURI') return { status: 'success', result: '' };
          return { status: 'failure' };
        })) as never,
    };
  }

  const config = {
    chain: 'celo', viemChain: {},
    identityRegistry: '0x0', reputationRegistry: '0x0', rpcEnvVar: 'X',
  } as unknown as Erc8004RegistryConfig;

  const noopPersist = async (_c: string, items: unknown[]) => items.length;

  test('rotates through older identities without dropping the recent discovery window', async () => {
    let next = 1;
    const all = new Set<number>();
    for (let run = 0; run < 8; run++) {
      const scanned = new Set<number>();
      await runIncrementalRegistryScan(config, noopPersist, noopPersist,
        async () => 40, async () => {}, {
          client: fakeClient(40, scanned), rescanWindow: 5, fetchRemote: false,
          refreshCursor: { load: async () => next, save: async (value: number) => { next = value; } },
        });
      expect([...scanned]).toEqual(expect.arrayContaining([36, 37, 38, 39, 40]));
      expect(scanned.size).toBeLessThanOrEqual(10);
      scanned.forEach(id => all.add(id));
    }
    expect([...all].sort((a,b) => a-b)).toEqual(Array.from({ length: 40 }, (_,i) => i+1));
    expect(next).toBe(1);
  });

  test('refresh rotation includes ID zero and clamps a cursor beyond the current tip', async () => {
    const scanned = new Set<number>();
    let next = 900;
    await runIncrementalRegistryScan({ ...config, firstAgentId: 0 }, noopPersist, noopPersist,
      async () => 40, async () => {}, {
        client: fakeClient(40, scanned, 0), rescanWindow: 5, fetchRemote: false,
        refreshCursor: { load: async () => next, save: async value => { next = value; } },
      });
    expect([...scanned]).toEqual([0, 1, 2, 3, 4, 36, 37, 38, 39, 40]);
    expect(next).toBe(5);
  });

  test('failed refresh retains its old-member cursor for retry', async () => {
    const client = fakeClient(40, new Set());
    client.multicall = (async () => { throw new Error('network unavailable'); }) as never;
    let writes = 0;
    const result = await runIncrementalRegistryScan(config, noopPersist, noopPersist,
      async () => 40, async () => { writes++; }, {
        client, rescanWindow: 5, fetchRemote: false,
        refreshCursor: { load: async () => 1, save: async () => { writes++; } },
      });
    expect(result.errors).toBeGreaterThan(0);
    expect(writes).toBe(0);
  });

  test('scans only [new-ids ∪ window] and advances the cursor on a clean run', async () => {
    const scanned = new Set<number>();
    const savedTips: number[] = [];
    const result = await runIncrementalRegistryScan(
      config, noopPersist, noopPersist,
      async () => 30,                       // lastTip = 30
      async (_c, tip) => { savedTips.push(tip); },
      { client: fakeClient(40, scanned), rescanWindow: 5, fetchRemote: false },
    );
    // window=5, currentTip=40 → from = min(31, 36) = 31. Scans 31..40.
    expect([...scanned].sort((a, b) => a - b)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
    expect(savedTips).toEqual([40]);       // cursor advanced to the discovered tip
    expect(result.errors).toBe(0);
    expect(result.tip).toBe(40);
  });

  test('re-scan window reaches back past new ids to catch feedback on old agents', async () => {
    const scanned = new Set<number>();
    await runIncrementalRegistryScan(
      config, noopPersist, noopPersist,
      async () => 40,                       // lastTip == currentTip: no NEW ids
      async () => {},
      { client: fakeClient(40, scanned), rescanWindow: 5, fetchRemote: false },
    );
    // No new ids, but window=5 still re-scans the most recent 5 (36..40).
    expect([...scanned].sort((a, b) => a - b)).toEqual([36, 37, 38, 39, 40]);
  });

  test('does NOT advance the cursor when the scan hit RPC errors', async () => {
    // readContract bounds the tip (so findRegistryTip terminates at 20); the
    // identity multicall throws → result.errors > 0 → cursor must be held.
    const erroringClient = {
      readContract: (async ({ args }: { args: readonly unknown[] }) => {
        const id = Number(args[0] as bigint);
        if (id >= 1 && id <= 20) return '0xowner';
        throw contractRevert('ERC721NonexistentToken');
      }) as never,
      multicall: (async () => { throw new Error('rpc down'); }) as never,
    };
    let saved = false;
    const result = await runIncrementalRegistryScan(
      config, noopPersist, noopPersist,
      async () => 10,
      async () => { saved = true; },
      { client: erroringClient, rescanWindow: 5, fetchRemote: false },
    );
    expect(result.errors).toBeGreaterThan(0);
    expect(saved).toBe(false);             // cursor NOT advanced → ids retried next run
  });

  test('empty registry (tip 0) → no scan, no cursor write', async () => {
    const emptyClient = {
      readContract: (async () => { throw contractRevert('ERC721NonexistentToken'); }) as never,
      multicall: (async () => []) as never,
    };
    let saved = false;
    const result = await runIncrementalRegistryScan(
      config, noopPersist, noopPersist,
      async () => 0,
      async () => { saved = true; },
      { client: emptyClient, rescanWindow: 5, fetchRemote: false },
    );
    expect(result.tip).toBe(0);
    expect(result.agentsScanned).toBe(0);
    expect(saved).toBe(false);
  });
});

describe('explicit registry membership', () => {
  const config = { chain: 'arc', identityRegistry: '0x0', reputationRegistry: '0x0', rpcEnvVar: 'X', viemChain: {} } as unknown as Erc8004RegistryConfig;
  test('refreshes sparse known IDs without discovering or filling the gap', async () => {
    const seen: number[] = [];
    const client = {
      readContract: (async () => { throw new Error('tip discovery forbidden'); }) as never,
      multicall: (async ({ contracts }: { contracts: { functionName: string; args: bigint[] }[] }) => contracts.map((c) => {
        if (c.functionName === 'ownerOf') seen.push(Number(c.args[0]));
        return { status: 'success', result: c.functionName === 'tokenURI' ? '' : '0xAA' };
      })) as never,
    };
    await runRegistryScan(config, async (_chain, rows) => rows.length, async () => 0, {
      agentIds: [72, 845_000], scanFeedback: false, fetchRemote: false, client,
    });
    expect(seen).toEqual([72, 845_000]);
  });
  test('failed read on a known ID is an error, not an assumed unminted gap', async () => {
    const result = await runRegistryScan(config, async () => 0, async () => 0, {
      agentIds: [72], scanFeedback: false, client: {
        readContract: (async () => { throw new Error('tip discovery forbidden'); }) as never,
        multicall: (async () => [{ status: 'failure' }, { status: 'failure' }, { status: 'failure' }]) as never,
      },
    });
    expect(result.errors).toBe(1);
    expect(result.failedMembers).toEqual([{ agentId: 72, stages: ['identity'] }]);
  });
  test('identity and feedback batch failures name every affected explicit member', async () => {
    for (const stage of ['identity', 'feedback'] as const) {
      const result = await runRegistryScan(config, async (_chain, rows) => rows.length, async () => 0, {
        agentIds: [2, 70], fetchRemote: false, client: {
          readContract: (async () => { throw Error('tip forbidden'); }) as never,
          multicall: (async ({ contracts }: { contracts: { functionName: string }[] }) => {
            if (stage === 'identity' || contracts[0].functionName === 'readAllFeedback') throw Error('RPC failed');
            return contracts.map(c => ({ status: 'success', result: c.functionName === 'tokenURI' ? '' : '0xAA' }));
          }) as never,
        },
      });
      expect(result.failedMembers).toEqual([{ agentId: 2, stages: [stage] }, { agentId: 70, stages: [stage] }]);
    }
  });
  test('failed remote metadata persists the member unreachable while valid empty and invalid metadata are observed', async () => {
    const persisted: ScannedAgent[] = [];
    const result = await runRegistryScan(config, async (_chain, rows) => { persisted.push(...rows); return rows.length; }, async () => 0, {
      agentIds: [2, 70, 80], scanFeedback: false, fetchRemote: true,
      client: {
        readContract: (async () => { throw Error('tip forbidden'); }) as never,
        multicall: (async ({ contracts }: { contracts: { functionName: string; args: bigint[] }[] }) => contracts.map(c => ({
          status: 'success', result: c.functionName !== 'tokenURI' ? '0xAA'
            : Number(c.args[0]) === 2 ? 'http://127.0.0.1/private.json' : Number(c.args[0]) === 70 ? '' : 'data:application/json,{broken',
        }))) as never,
      },
    });
    expect(result.failedMembers).toEqual([{ agentId: 2, stages: ['registration'] }]);
    expect(result.registrationUnreachable).toBe(1);
    expect(result.errors).toBe(0);
    expect(persisted.map(row => [row.agentId, row.registrationStatus])).toEqual(
      [[2, 'unreachable'], [70, 'empty'], [80, 'invalid']],
    );
  });
  test.each([
    { reply: [] }, { reply: [[], [], [], [], [], []] }, { reply: [['0xAA'], [], [], [], [], [], []] },
  ])('a malformed known-member feedback reply %j is retained without blocking later members', async ({ reply }) => {
    const result = await runRegistryScan(config, async (_chain, rows) => rows.length, async () => 0, {
      agentIds: [2, 70], fetchRemote: false,
      client: {
        readContract: (async () => { throw Error('tip forbidden'); }) as never,
        multicall: (async ({ contracts }: { contracts: { functionName: string; args: bigint[] }[] }) => contracts.map(c => ({
          status: 'success', result: c.functionName === 'readAllFeedback'
            ? (Number(c.args[0]) === 2 ? reply : [[], [], [], [], [], [], []])
            : c.functionName === 'tokenURI' ? '' : '0xAA',
        }))) as never,
      },
    });
    expect(result.failedMembers).toEqual([{ agentId: 2, stages: ['feedback'] }]);
    expect(result.agentsPersisted).toBe(2);
  });
});

describe('EVM registry cancellation', () => {
  test('abort during tip discovery is not swallowed as a missing token', async () => {
    const controller = new AbortController(); let calls = 0;
    await expect(findRegistryTip({ readContract: (async () => {
      calls++; controller.abort(Error('stop_registry')); throw Error('RPC unavailable');
    }) as never }, '0x0', controller.signal)).rejects.toThrow('stop_registry');
    expect(calls).toBe(1);
  });
  test('abort after identity reads prevents writes, metadata and feedback reads', async () => {
    const controller = new AbortController(); let reads = 0; let writes = 0;
    const config = { chain: 'arc', identityRegistry: '0x0', reputationRegistry: '0x0', rpcEnvVar: 'X', viemChain: {} } as unknown as Erc8004RegistryConfig;
    await expect(runRegistryScan(config, async () => { writes++; return 1; }, async () => { writes++; return 1; }, {
      agentIds: [72], signal: controller.signal, fetchRemote: false,
      client: {
        readContract: (async () => { throw Error('tip forbidden'); }) as never,
        multicall: (async () => { reads++; controller.abort(Error('stop_registry')); return [
          { status: 'success', result: '0xAA' }, { status: 'success', result: '0xAA' },
          { status: 'success', result: 'https://example.com/agent.json' },
        ]; }) as never,
      },
    })).rejects.toThrow('stop_registry');
    expect(reads).toBe(1); expect(writes).toBe(0);
  });
});

/**
 * 2026-09-13: ipfs.io retired its path gateway and began answering every
 * request with 429, so 1,949 agents across arc/celo/solana were banked as
 * `unreachable` — 48% of a 52-CID sample were in fact valid registrations.
 * The gateway must be configurable, and a throttled read must never be
 * recorded with the same finality as a 404 or a body that is not JSON.
 */
describe('decodeRegistration gateway + failure classification', () => {
  function spyFetch(handler: (url: string) => Response) {
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      calls.push(String(input));
      return handler(String(input));
    }) as unknown as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = orig; } };
  }
  const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

  test('ipfs:// resolves through the configured gateway, not the retired ipfs.io', async () => {
    const { calls, restore } = spyFetch(() => new Response(JSON.stringify(SAMPLE_REG), { status: 200 }));
    try {
      const r = await decodeRegistration('ipfs://bafyTEST', {
        fetchRemote: true, lookup: publicDns,
        ipfsGateway: 'https://ipfs.filebase.io/ipfs/',
      });
      expect(r.status).toBe('fetched');
      expect(calls[0]).toBe('https://ipfs.filebase.io/ipfs/bafyTEST');
    } finally { restore(); }
  });

  test('default gateway is not the retired ipfs.io path gateway', async () => {
    const { calls, restore } = spyFetch(() => new Response(JSON.stringify(SAMPLE_REG), { status: 200 }));
    try {
      await decodeRegistration('ipfs://bafyTEST', { fetchRemote: true, lookup: publicDns });
      expect(calls[0]).not.toStartWith('https://ipfs.io/');
    } finally { restore(); }
  });

  test('HTTP 429 is retryable, never a settled verdict', async () => {
    const { restore } = spyFetch(() => new Response('rate limited', { status: 429 }));
    try {
      const r = await decodeRegistration('https://example.com/a.json', { fetchRemote: true, lookup: publicDns });
      expect(r.status).toBe('unreachable');
      expect(r.retryable).toBe(true);
    } finally { restore(); }
  });

  test('HTTP 404 is a permanent verdict', async () => {
    const { restore } = spyFetch(() => new Response('nope', { status: 404 }));
    try {
      const r = await decodeRegistration('https://example.com/a.json', { fetchRemote: true, lookup: publicDns });
      expect(r.status).toBe('unreachable');
      expect(r.retryable).toBe(false);
    } finally { restore(); }
  });

  test('a 200 body that is not JSON is invalid, not unreachable', async () => {
    // Real case: Arc agent 2's tokenURI serves a JPEG.
    const { restore } = spyFetch(() => new Response('\xff\xd8\xff\xe0JFIF', { status: 200 }));
    try {
      const r = await decodeRegistration('https://example.com/a.json', { fetchRemote: true, lookup: publicDns });
      expect(r.status).toBe('invalid');
      expect(r.retryable).toBe(false);
    } finally { restore(); }
  });

  test('a 200 HTML error page is retryable, never settled as invalid', async () => {
    // A gateway answering a throttle with an HTML page must not erase a
    // registration that decoded fine on an earlier run.
    const { restore } = spyFetch(
      () => new Response('<html><body>rate limited</body></html>', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    try {
      const r = await decodeRegistration('https://example.com/a.json', { fetchRemote: true, lookup: publicDns });
      expect(r.status).toBe('unreachable');
      expect(r.retryable).toBe(true);
    } finally { restore(); }
  });

  test('a served README (text/plain) is a settled invalid', async () => {
    // Real case: 135 Solana agents point tokenURI at an OpenClaw README.md.
    const { restore } = spyFetch(
      () => new Response('# OpenClaw\n\nA readme.', {
        status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );
    try {
      const r = await decodeRegistration('https://example.com/a.json', { fetchRemote: true, lookup: publicDns });
      expect(r.status).toBe('invalid');
      expect(r.retryable).toBe(false);
    } finally { restore(); }
  });

  test('a blocked private address stays permanent, not retryable', async () => {
    const { restore } = spyFetch(() => new Response('{}', { status: 200 }));
    try {
      const r = await decodeRegistration('http://169.254.169.254/', { fetchRemote: true });
      expect(r.status).toBe('unreachable');
      expect(r.retryable).toBe(false);
    } finally { restore(); }
  });

  test('HTTP 503 is retryable', async () => {
    const { restore } = spyFetch(() => new Response('down', { status: 503 }));
    try {
      const r = await decodeRegistration('https://example.com/a.json', { fetchRemote: true, lookup: publicDns });
      expect(r.retryable).toBe(true);
    } finally { restore(); }
  });
});

/**
 * `tamperResistance` is worth 10 of 100 and is earned by the tokenURI being
 * content-addressed (ipfs:/ar:/data:), so the scorer must be given the URI.
 * The scanner passed only `{ registration }`, scoring every ipfs-hosted agent
 * 10 points light — enough to cross ATTEST_MIN_SCORE (70) in either direction.
 */
describe('scanner metadata score includes the tokenURI', () => {
  const REG = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Agent', description: 'a'.repeat(120),
    image: 'https://e/i.png',
    services: [{ name: 's', endpoint: 'https://e', description: 'd'.repeat(40) }],
  };

  test('an ipfs tokenURI scores strictly higher than the same registration without one', () => {
    const withUri = scoreMetadataQuality({ registration: REG, tokenURI: 'ipfs://bafyX' });
    const without = scoreMetadataQuality({ registration: REG });
    expect(withUri.breakdown.tamperResistance).toBe(10);
    expect(without.breakdown.tamperResistance).toBe(0);
    expect(withUri.score).toBeGreaterThan(without.score);
  });

  test('runRegistryScan credits tamper-resistance for an ipfs agent', async () => {
    const persisted: ScannedAgent[] = [];
    await runRegistryScan(
      { chain: 'celo', viemChain: {}, identityRegistry: '0x1', reputationRegistry: '0x2', rpcEnvVar: 'X' } as unknown as Erc8004RegistryConfig,
      async (_c, agents) => { persisted.push(...agents); return agents.length; },
      async () => 0,
      {
        agentIds: [1],
        fetchRemote: false,
        client: {
          multicall: async ({ contracts }: { contracts: { functionName: string }[] }) =>
            contracts.map((c) => ({
              status: 'success',
              result:
                c.functionName === 'ownerOf' ? '0xowner'
                : c.functionName === 'tokenURI' ? `data:application/json,${encodeURIComponent(JSON.stringify(REG))}`
                : '0xwallet',
            })),
          readContract: async () => '0xowner',
        } as never,
      },
    );
    const agent = persisted.find((a) => a.agentId === 1);
    expect(agent).toBeDefined();
    // A data: URI is content-addressed too, so the credit must be present.
    expect(agent!.metadataScore).toBe(
      scoreMetadataQuality({ registration: agent!.registration, tokenURI: agent!.tokenURI ?? undefined }).score,
    );
  });
});

describe('a poisoned multicall sub-batch is not a member verdict', () => {
  const config = { chain: 'arc', identityRegistry: '0x0', reputationRegistry: '0xREP', rpcEnvVar: 'X', viemChain: {} } as unknown as Erc8004RegistryConfig;
  // aggregate3 shares one gas budget: Arc id 1's 1,315-client feedback list
  // exhausts it and every member of its sub-batch comes back `failure` —
  // ids 2 and 3 included, though both read fine on their own (measured against
  // rpc.testnet.arc.io, 2026-09-17). Re-ask each one before calling it failed.
  const identity = (functionName: string) => (functionName === 'tokenURI' ? '' : '0xAA');
  const feedbackReply = (client: string) => [[client], [1n], [100n], [2], [''], [''], [false]];

  function client(overrides: {
    onFeedbackMulticall?: () => { status: string; result?: unknown }[] | never;
    onRetry?: (agentId: number) => unknown;
  }) {
    const retried: number[] = [];
    const impl = {
      readContract: (async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        if (functionName !== 'readAllFeedback') throw Error('tip discovery forbidden');
        const agentId = Number(args[0]);
        retried.push(agentId);
        if (!overrides.onRetry) throw Error('unexpected retry');
        return overrides.onRetry(agentId);
      }) as never,
      multicall: (async ({ contracts }: { contracts: { functionName: string; args: readonly unknown[] }[] }) => {
        if (contracts[0].functionName !== 'readAllFeedback') {
          return contracts.map((c) => ({ status: 'success', result: identity(c.functionName) }));
        }
        return overrides.onFeedbackMulticall?.() ?? contracts.map(() => ({ status: 'failure' }));
      }) as never,
    };
    return { impl, retried };
  }

  test('a member whose individual retry succeeds is scanned, persisted and not recorded as failed', async () => {
    const persistedFeedback: ScannedFeedback[] = [];
    const persistedAgents: ScannedAgent[][] = [];
    const c = client({
      onFeedbackMulticall: () => [{ status: 'failure' }, { status: 'success', result: feedbackReply('0xCD') }],
      onRetry: () => feedbackReply('0xAB'),
    });
    const result = await runRegistryScan(
      config,
      async (_chain, rows) => { persistedAgents.push([...rows]); return rows.length; },
      async (_chain, rows) => { persistedFeedback.push(...rows); return rows.length; },
      { agentIds: [2, 3], fetchRemote: false, client: c.impl },
    );
    expect(c.retried).toEqual([2]);
    expect(result.failedMembers).toEqual([]);
    expect(result.errors).toBe(0);
    // A recovered read that never reaches the consumer is a silent no-op.
    expect(persistedFeedback.map((row) => row.agentId).sort()).toEqual([2, 3]);
    expect(persistedAgents.at(-1)?.map((a) => a.agentId).sort()).toEqual([2, 3]);
    expect(persistedAgents.at(-1)?.every((a) => a.feedback !== undefined)).toBe(true);
    expect(result.feedbackScanned).toBe(2);
  });

  test('a retry that reverts marks the member unreadable, not a read failure that will heal', async () => {
    const c = client({
      onRetry: () => { throw new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({ abi: [], functionName: 'readAllFeedback', data: '0x' }),
        { abi: [], functionName: 'readAllFeedback' },
      ); },
    });
    const result = await runRegistryScan(config, async (_c, rows) => rows.length, async () => 0, {
      agentIds: [1], fetchRemote: false, client: c.impl,
    });
    expect(result.failedMembers).toEqual([{ agentId: 1, stages: ['feedback'] }]);
    expect(result.errors).toBe(1);
    expect(result.unreadableMembers).toEqual([1]);
  });

  test('a retry that fails on transport stays a retryable read failure', async () => {
    const c = client({ onRetry: () => { throw Error('fetch failed'); } });
    const result = await runRegistryScan(config, async (_c, rows) => rows.length, async () => 0, {
      agentIds: [1], fetchRemote: false, client: c.impl,
    });
    expect(result.failedMembers).toEqual([{ agentId: 1, stages: ['feedback'] }]);
    expect(result.errors).toBe(1);
    expect(result.unreadableMembers).toEqual([]);
  });

  test('a multicall that throws wholesale is a batch transport fault, retried by nobody', async () => {
    const c = client({ onFeedbackMulticall: () => { throw Error('RPC failed'); } });
    const result = await runRegistryScan(config, async (_c, rows) => rows.length, async () => 0, {
      agentIds: [2, 3], fetchRemote: false, client: c.impl,
    });
    expect(c.retried).toEqual([]);
    expect(result.failedMembers).toEqual([{ agentId: 2, stages: ['feedback'] }, { agentId: 3, stages: ['feedback'] }]);
  });

  test('discovery mode has no membership to defend and never retries', async () => {
    const c = client({});
    await runRegistryScan(config, async (_c, rows) => rows.length, async () => 0, {
      fromId: 2, toId: 3, fetchRemote: false, client: c.impl,
    });
    expect(c.retried).toEqual([]);
  });
});
