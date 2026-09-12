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
import {
  decodeRegistration,
  parseFeedbackArrays,
  aggregateAgentFeedback,
  findRegistryTip,
  chunk,
  runRegistryScan,
  incrementalScanRange,
  runIncrementalRegistryScan,
  DEFAULT_RESCAN_WINDOW,
  type ScannedAgent,
  type ScannedFeedback,
} from './erc8004-registry';
import type { Erc8004RegistryConfig } from '../config/erc8004-registries';

const SAMPLE_REG = { type: 'x', name: 'Agent', description: 'd', services: [{ name: 's', endpoint: 'https://e' }] };

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
        throw new Error('reverted: ERC721NonexistentToken');
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
        throw new Error('reverted');
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
  function fakeClient(maxId: number, scannedIds: Set<number>) {
    return {
      readContract: (async ({ args }: { args: readonly unknown[] }) => {
        const id = Number(args[0] as bigint);
        if (id >= 1 && id <= maxId) return '0xowner';
        throw new Error('reverted');
      }) as never,
      multicall: (async ({ contracts }: { contracts: { functionName: string; args: readonly unknown[] }[] }) =>
        contracts.map((c) => {
          const id = Number(c.args[0] as bigint);
          if (c.functionName === 'readAllFeedback') return { status: 'success', result: [[], [], [], [], [], [], []] };
          if (id < 1 || id > maxId) return { status: 'failure' };
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
        throw new Error('reverted');
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
      readContract: (async () => { throw new Error('reverted'); }) as never,
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
  test('failed remote metadata keeps prior metadata untouched while valid empty and invalid metadata are observed', async () => {
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
    expect(result.errors).toBe(1);
    expect(persisted.map(row => [row.agentId, row.registrationStatus])).toEqual([[70, 'empty'], [80, 'invalid']]);
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
