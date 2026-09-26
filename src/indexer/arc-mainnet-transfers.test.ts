import { afterEach, describe, expect, test } from 'bun:test';
import { createClient } from '@supabase/supabase-js';
import { __setSupabaseForTest, type TransactionInsert, type InsertSignalEventInput } from '@/db/client';
import { ARC_MAINNET_TRANSFER_EMITTER, ARC_MAINNET_USDC_CONTRACT } from '@/config/arc-mainnet';
import { arcMainnetTransfersIndexer, buildArcMainnetSeedSet, loadArcMainnetSeedRows, parseArcMainnetTransfer, readArcMainnetSeedCoverage, writeArcMainnetSeedCoverage, type ArcMainnetTransfersDeps } from './arc-mainnet-transfers';

const FROM = `0x${'1'.repeat(40)}` as const;
const TO = `0x${'2'.repeat(40)}` as const;
const HASH = `0x${'a'.repeat(64)}` as const;
const log = (more = {}) => ({ address: ARC_MAINNET_TRANSFER_EMITTER, args: { from: FROM, to: TO, value: 1n }, blockNumber: 10n, transactionHash: HASH, logIndex: 3, removed: false, ...more });

function deps(overrides: Partial<ArcMainnetTransfersDeps> = {}) {
  const writes: TransactionInsert[] = [];
  const signals: InsertSignalEventInput[] = [];
  const calls: string[] = [];
  const value: ArcMainnetTransfersDeps = {
    getChainId: async () => { calls.push('chain'); return 5042; },
    loadSeedRows: async () => { calls.push('seeds'); return { registryRows: [{ chain: 'arc-mainnet', owner: FROM }], walletRows: [] }; },
    getHead: async () => { calls.push('head'); return 10n; },
    getCursor: async () => { calls.push('cursor'); return null; },
    getLogs: async () => { calls.push('logs'); return [parseArcMainnetTransfer(log())!]; },
    blockTimestamp: async () => '2026-09-12T00:00:00Z',
    // Empty batch ⇒ every block takes the single-block path, which is what
    // mainnet wires in production until its RPC's batch support is measured.
    blockTimestamps: async () => new Map<string, string>(),
    ensureWallets: async () => { calls.push('wallets'); },
    insertTransactions: async (rows) => { writes.push(...rows); return rows.length; },
    insertSignalEvents: async (rows) => { signals.push(...rows); return rows.length; },
    upsertCursor: async () => { calls.push('checkpoint'); },
    ...overrides,
  };
  return { value, calls, writes, signals };
}

afterEach(() => __setSupabaseForTest(null));

describe('mainnet native event decoding', () => {
  test('keeps submicro native transfers exact and ignores the duplicate ERC20 emitter', () => {
    const native = parseArcMainnetTransfer(log());
    expect(native?.amountDecimal).toBe('0.000000000000000001');
    expect(native?.amount).toBe(1e-18);
    expect(native?.rawAmount).toBe(1n);
    expect(native?.decimals).toBe(18);
    expect(parseArcMainnetTransfer(log({ address: ARC_MAINNET_USDC_CONTRACT, args: { from: FROM, to: TO, value: 1_000_000n } }))).toBeNull();
  });
  test('requires a stable event identity and rejects removed or malformed system logs', () => {
    for (const more of [{ logIndex: null }, { logIndex: -1 }, { logIndex: 1.5 }, { logIndex: Number.MAX_SAFE_INTEGER + 1 }, { transactionHash: '0xshort' }, { removed: true }, { blockNumber: null }]) {
      expect(() => parseArcMainnetTransfer(log(more))).toThrow('arc_mainnet_transfer_invalid');
    }
    expect(() => parseArcMainnetTransfer(log({ args: { from: FROM, to: TO, value: 10n ** 38n } }))).toThrow('arc_mainnet_transfer_invalid');
  });
});

describe('independent mainnet membership', () => {
  test('never seeds testnet rows, unclaimed minted counterparties, or arc_agent_id alone', () => {
    const seed = buildArcMainnetSeedSet({
      registryRows: [{ chain: 'arc', owner: FROM }, { chain: 'arc-mainnet', owner: TO }],
      walletRows: [{ chain: 'arc-mainnet', address: FROM, claimed: false, arc_agent_id: 4 }, { chain: 'arc', address: FROM, claimed: true }],
    });
    expect([...seed]).toEqual([TO]);
    expect([...buildArcMainnetSeedSet({ registryRows: [], walletRows: [{ chain: 'arc-mainnet', address: FROM, claimed: true }] })]).toEqual([FROM]);
  });
  test('production seed reads are explicitly mainnet-only and claimed-wallet-only', async () => {
    const filters: string[] = [];
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push(`${key}:${value}`); return query; },
      order: () => query,
      range: async () => ({ data: [], error: null }),
    };
    __setSupabaseForTest({ from: (table: string) => { filters.push(table); return query; } });
    await loadArcMainnetSeedRows();
    expect(filters).toEqual(['erc8004_agents', 'chain:arc-mainnet', 'wallets', 'chain:arc-mainnet', 'claimed:true']);
  });
});

describe('mainnet chain admission', () => {
  test('wrong-chain provider fails before seed, cursor, events, or any writes', async () => {
    const { value, calls, writes } = deps({ getChainId: async () => 5042002 });
    await expect(arcMainnetTransfersIndexer(value)).rejects.toThrow('arc_mainnet_chain_mismatch');
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
  });
  test('provider authentication failure is safe and never reports dormant or caught-up', async () => {
    const { value, calls } = deps({ getChainId: async () => { throw new Error('401 https://provider.invalid/SECRET'); } });
    await expect(arcMainnetTransfersIndexer(value)).rejects.toThrow('rpc_authentication_failed');
    expect(calls).toEqual([]);
  });
  test('empty verified membership is dormant after chain verification, with no head/event/cursor calls', async () => {
    const { value, calls } = deps({ loadSeedRows: async () => ({ registryRows: [], walletRows: [] }) });
    const result = await arcMainnetTransfersIndexer(value);
    expect(result.coverage.reason).toBe('empty_seed');
    expect(result.coverage.complete).toBe(false);
    expect(calls).toEqual(['chain']);
  });
  test('admitted reads and all receipt/signal writes use mainnet identities', async () => {
    const { value, calls, writes, signals } = deps();
    const result = await arcMainnetTransfersIndexer(value);
    expect(calls.slice(0, 3)).toEqual(['chain', 'seeds', 'cursor']);
    expect(result.inserted).toBe(1);
    expect(writes[0]).toMatchObject({ chain: 'arc-mainnet', facilitator: ARC_MAINNET_USDC_CONTRACT, amount: '0.000000000000000001', tx_signature: `${HASH}:3` });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.chain === 'arc-mainnet')).toBe(true);
  });
  test('late chain identity after cancellation cannot launch a seed or cursor read', async () => {
    const controller = new AbortController();
    const { value, calls } = deps({ signal: controller.signal, getChainId: async () => { controller.abort(new Error('cancelled')); return 5042; } });
    await expect(arcMainnetTransfersIndexer(value)).rejects.toThrow('cancelled');
    expect(calls).toEqual([]);
  });
});

describe('seed-scoped historical coverage', () => {
  test('a newly discovered seed replays earlier blocks despite a current global cursor', async () => {
    const checkpoints = new Map<string, number>([[FROM, 100]]);
    const historyReads: Array<{ from: bigint; to: bigint; seeds: string[] }> = [];
    const historical = parseArcMainnetTransfer(log({ args: { from: TO, to: FROM, value: 1n } }))!;
    const { value, writes } = deps({
      getHead: async () => 105n,
      getCursor: async () => ({ last_signature: '100', last_slot: 100 }),
      loadSeedRows: async () => ({ registryRows: [{ chain: 'arc-mainnet', owner: FROM }, { chain: 'arc-mainnet', owner: TO }], walletRows: [] }),
      getLogs: async () => [],
      history: {
        read: async () => new Map(checkpoints),
        write: async (rows) => { for (const row of rows) checkpoints.set(row.address, row.block); },
        getLogs: async (from, to, _face, seeds) => {
          historyReads.push({ from, to, seeds: [...seeds] });
          return from <= 10n && to >= 10n ? [historical] : [];
        },
      },
    });
    const result = await arcMainnetTransfersIndexer(value);
    expect(writes).toHaveLength(1);
    expect(writes[0].wallet_address).toBe(TO);
    expect(historyReads).toEqual([
      { from: 0n, to: 105n, seeds: [TO] },
      { from: 0n, to: 105n, seeds: [TO] },
    ]);
    expect(checkpoints).toEqual(new Map([[FROM, 105], [TO, 105]]));
    expect(result.coverage.complete).toBe(true);
  });

  function recovery() {
    const state = {
      seeds: [FROM, TO] as string[], checkpoints: new Map<string, number>(), global: 100,
      reads: [] as Array<{ from: bigint; to: bigint; seeds: string[] }>,
    };
    const fixture = deps({
      getHead: async () => 110n,
      getCursor: async () => ({ last_signature: String(state.global), last_slot: state.global }),
      upsertCursor: async (_key, _last, block) => { state.global = block!; },
      loadSeedRows: async () => ({ registryRows: state.seeds.map(owner => ({ chain: 'arc-mainnet', owner })), walletRows: [] }),
      getLogs: async () => [], windowSize: 50, maxWindows: 1,
      history: {
        read: async seeds => new Map([...state.checkpoints].filter(([address]) => seeds.has(address))),
        write: async rows => { for (const row of rows) state.checkpoints.set(row.address, row.block); },
        getLogs: async (from, to, _face, seeds) => {
          state.reads.push({ from, to, seeds: [...seeds] });
          return [];
        },
      },
    });
    return { ...fixture, state };
  }

  test('unknown existing seeds replay together and new registrations do not reset an in-progress cohort', async () => {
    const { value, state } = recovery();
    const first = await arcMainnetTransfersIndexer(value);
    expect(state.checkpoints).toEqual(new Map([[FROM, 49], [TO, 49]]));
    expect(first.coverage).toMatchObject({ checkpoint: '49', head: '110', pending: 61, complete: false });
    expect(state.global).toBe(110);

    const third = `0x${'3'.repeat(40)}`;
    state.seeds.push(third);
    const second = await arcMainnetTransfersIndexer(value);
    expect(state.reads[2]).toEqual({ from: 50n, to: 99n, seeds: [FROM, TO] });
    expect(state.checkpoints.get(third)).toBeUndefined();
    expect(second.coverage.complete).toBe(false);
    await arcMainnetTransfersIndexer(value);
    expect(state.checkpoints.get(FROM)).toBe(110);
    await arcMainnetTransfersIndexer(value);
    expect(state.reads.at(-2)).toEqual({ from: 0n, to: 49n, seeds: [third] });
    expect(state.checkpoints.get(third)).toBe(49);
    expect(state.global).toBe(110);
  });

  test('removed and re-added seeds resume their proven prefix and empty windows count as coverage', async () => {
    const { value, state } = recovery();
    state.checkpoints.set(FROM, 100);
    state.checkpoints.set(TO, 70);
    state.seeds = [FROM];
    expect((await arcMainnetTransfersIndexer(value)).coverage.complete).toBe(true);
    state.seeds.push(TO);
    const result = await arcMainnetTransfersIndexer(value);
    expect(state.reads[0]).toEqual({ from: 71n, to: 110n, seeds: [TO] });
    expect(state.checkpoints.get(TO)).toBe(110);
    expect(result.coverage.complete).toBe(true);
    expect(result.inserted).toBe(0);
  });

  test('a partial coverage commit is retried without skipping an uncommitted seed', async () => {
    const { value, state } = recovery();
    const write = value.history!.write;
    value.history!.write = async rows => {
      state.checkpoints.set(rows[0].address, rows[0].block);
      throw new Error('DB write failed');
    };
    await expect(arcMainnetTransfersIndexer(value)).rejects.toThrow();
    expect(state.checkpoints).toEqual(new Map([[FROM, 49]]));
    expect(state.global).toBe(110);
    value.history!.write = write;
    await arcMainnetTransfersIndexer(value);
    await arcMainnetTransfersIndexer(value);
    await arcMainnetTransfersIndexer(value);
    expect(state.reads.at(-2)).toEqual({ from: 0n, to: 49n, seeds: [TO] });
    expect(state.checkpoints.get(TO)).toBe(49);
  });

  test('failed historical signal persistence never advances seed coverage', async () => {
    const { value, state } = recovery();
    const historical = parseArcMainnetTransfer(log())!;
    value.history!.getLogs = async () => [historical];
    value.insertSignalEvents = async () => { throw new Error('signal write failed'); };
    await expect(arcMainnetTransfersIndexer(value)).rejects.toThrow();
    expect(state.global).toBe(110);
    expect(state.checkpoints.size).toBe(0);
    const reads: bigint[] = [];
    value.insertSignalEvents = async () => 2;
    value.history!.getLogs = async from => { reads.push(from); return [historical]; };
    await arcMainnetTransfersIndexer(value);
    expect(reads).toEqual([0n, 0n]);
  });

  test('a fresh genesis live scan records membership directly without replaying the same blocks', async () => {
    const { value, state } = recovery();
    state.global = -1;
    await arcMainnetTransfersIndexer(value);
    expect(state.global).toBe(49);
    expect(state.checkpoints).toEqual(new Map([[FROM, 49], [TO, 49]]));
    expect(state.reads).toEqual([]);
  });

  test('rate-limited replay retains unverified coverage even when the live stream is current', async () => {
    const { value, state } = recovery();
    value.history!.getLogs = async () => { throw new Error('429 rate limit'); };
    const result = await arcMainnetTransfersIndexer(value);
    expect(state.global).toBe(110);
    expect(state.checkpoints.size).toBe(0);
    expect(result.coverage).toMatchObject({ checkpoint: '-1', complete: false, pending: 111, reason: 'rate_limited' });
  });

  test('cancellation during historical reads cannot advance that cohort or launch more reads', async () => {
    const { value, state } = recovery();
    const controller = new AbortController();
    value.signal = controller.signal;
    let reads = 0;
    value.history!.getLogs = async () => { reads++; controller.abort(new Error('cancelled')); return []; };
    await expect(arcMainnetTransfersIndexer(value)).rejects.toThrow('cancelled');
    expect(reads).toBe(1);
    expect(state.checkpoints.size).toBe(0);
    expect(state.global).toBe(110);
  });

  test('a provider behind stored seed coverage cannot claim complete or rewind the seed', async () => {
    const { value, state } = recovery();
    state.checkpoints.set(FROM, 120);
    await expect(arcMainnetTransfersIndexer(value)).rejects.toThrow('arc_mainnet_seed_cursor_invalid');
    expect(state.checkpoints.get(FROM)).toBe(120);
    expect(state.reads).toEqual([]);
  });

  test('live throttling before any checkpoint preserves the genesis backlog and cannot report caught up', async () => {
    const { value, state } = recovery();
    state.global = -1;
    value.getLogs = async () => { throw new Error('429 rate limit'); };
    const result = await arcMainnetTransfersIndexer(value);
    expect(result.coverage).toMatchObject({ checkpoint: '-1', head: '110', pending: 111, complete: false });
    expect(state.reads).toEqual([]);
    expect(state.checkpoints.size).toBe(0);
  });

  test('registered seeds without transfers are materialized for settlement before coverage reads', async () => {
    const { value, state } = recovery();
    const ensured: string[][] = [];
    value.ensureWallets = async addresses => { ensured.push(addresses); };
    const read = value.history!.read;
    value.history!.read = async seeds => {
      expect(ensured).toEqual([[FROM, TO]]);
      return read(seeds);
    };
    value.loadSeedRows = async () => ({ registryRows: [
      { chain: 'arc-mainnet', owner: FROM }, { chain: 'arc-mainnet', owner: TO },
      { chain: 'arc-mainnet', owner: '0x0000000000000000000000000000000000000000' },
      { chain: 'arc', owner: `0x${'3'.repeat(40)}` },
    ], walletRows: [] });
    await arcMainnetTransfersIndexer(value);
    expect(ensured).toEqual([[FROM, TO]]);
    expect(state.checkpoints.size).toBe(2);
  });

  test('actual Supabase seed-cursor URLs remain comfortably below the gateway 8KB URI cap', async () => {
    const urls: string[] = [];
    const client = createClient('https://db.example.test', 'test-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch },
    });
    __setSupabaseForTest(client);
    await readArcMainnetSeedCoverage(new Set(Array.from({ length: 201 }, (_, index) => `0x${index.toString(16).padStart(40, '0')}`)));
    expect(urls.length).toBeGreaterThan(1);
    expect(Math.max(...urls.map(url => new TextEncoder().encode(url).length))).toBeLessThan(7000);
  });

  test('production coverage store batches all addresses below the REST response cap and binds writes to mainnet', async () => {
    const addresses = Array.from({ length: 1201 }, (_, index) => `0x${index.toString(16).padStart(40, '0')}`);
    const reads: string[][] = [];
    const writes: Array<Array<{ chain: string; facilitator: string; last_slot: number }>> = [];
    const chains: string[] = [];
    const query = {
      select: () => query,
      eq: (_key: string, chain: string) => { chains.push(chain); return query; },
      in: async (_key: string, keys: string[]) => {
        reads.push(keys);
        return { data: keys.map(facilitator => ({ facilitator, last_slot: 90 })), error: null };
      },
      upsert: async (rows: Array<{ chain: string; facilitator: string; last_slot: number }>) => { writes.push(rows); return { error: null }; },
    };
    __setSupabaseForTest({ from: () => query });
    const saved = await readArcMainnetSeedCoverage(new Set(addresses));
    expect(saved.size).toBe(1201);
    expect(saved.get(addresses[1200])).toBe(90);
    expect(reads.every(batch => batch.length <= 200)).toBe(true);
    expect(chains.every(chain => chain === 'arc-mainnet')).toBe(true);
    await writeArcMainnetSeedCoverage(addresses.map(address => ({ address, block: 100 })));
    expect(writes.flat()).toHaveLength(1201);
    expect(writes.every(batch => batch.length <= 200)).toBe(true);
    expect(writes.flat().every(row => row.chain === 'arc-mainnet' && row.last_slot === 100)).toBe(true);
  });
});
