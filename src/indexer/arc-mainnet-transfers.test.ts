import { afterEach, describe, expect, test } from 'bun:test';
import { __setSupabaseForTest, type TransactionInsert, type InsertSignalEventInput } from '@/db/client';
import { ARC_MAINNET_TRANSFER_EMITTER, ARC_MAINNET_USDC_CONTRACT } from '@/config/arc-mainnet';
import { arcMainnetTransfersIndexer, buildArcMainnetSeedSet, loadArcMainnetSeedRows, parseArcMainnetTransfer, type ArcMainnetTransfersDeps } from './arc-mainnet-transfers';

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
