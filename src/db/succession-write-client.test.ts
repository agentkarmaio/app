/// <reference types="bun-types" />
/**
 * DB write-path helper tests for the Dead Man's Switch: upsertSuccession,
 * applySuccessionLiveness, getLastMeaningfulTxAt, listSuccessionsForHeartbeat,
 * and the new optional `chain` field on the signal_events insert path. Uses the
 * __setSupabaseForTest seam (no live connection).
 *
 * Run: bun test src/db/succession-write-client.test.ts
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  __setSupabaseForTest,
  upsertSuccession,
  applySuccessionLiveness,
  getLastMeaningfulTxAt,
  listSuccessionsForHeartbeat,
  insertSignalEvents,
} from './client';

interface Op {
  table: string;
  kind: 'upsert' | 'update' | 'select';
  payload?: Record<string, unknown> | Record<string, unknown>[];
  filters: Record<string, unknown>;
  onConflict?: string;
}

/**
 * Fake Supabase recording every op. `successionRow` seeds the getSuccession read
 * inside upsertSuccession; `txRows` seeds the transactions read.
 */
function makeFake(opts: {
  ops: Op[];
  successionRow?: unknown;
  successionList?: unknown[];
  txRows?: { timestamp: string }[];
}) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (col: string, val: unknown) => { filters[col] = val; return builder; };
      builder.in = (col: string, val: unknown) => { filters[col] = val; return builder; };
      builder.not = (col: string, _op: string, val: unknown) => { filters[`not_${col}`] = val; return builder; };
      builder.order = () => builder;
      builder.maybeSingle = async () => {
        opts.ops.push({ table, kind: 'select', filters });
        return { data: opts.successionRow ?? null, error: null };
      };
      builder.limit = async () => {
        opts.ops.push({ table, kind: 'select', filters });
        if (table === 'transactions') return { data: opts.txRows ?? [], error: null };
        if (table === 'successions') return { data: opts.successionList ?? [], error: null };
        return { data: [], error: null };
      };
      builder.upsert = (payload: Record<string, unknown> | Record<string, unknown>[], cfg?: { onConflict?: string }) => {
        opts.ops.push({ table, kind: 'upsert', payload, filters, onConflict: cfg?.onConflict });
        const result = { data: (Array.isArray(payload) ? payload : [payload]).map(() => ({ id: 'x' })), error: null };
        // insertSignalEvents chains .select('id'); single-row upserts await directly.
        const out: Record<string, unknown> = {
          select: async () => result,
          then: (resolve: (v: typeof result) => void) => resolve(result),
        };
        return out;
      };
      builder.update = (payload: Record<string, unknown>) => {
        const updFilters: Record<string, unknown> = {};
        const updBuilder: Record<string, unknown> = {
          eq: (col: string, val: unknown) => { updFilters[col] = val; return updBuilder; },
        };
        (updBuilder as { then: unknown }).then = (resolve: (v: { error: null }) => void) => {
          opts.ops.push({ table, kind: 'update', payload, filters: updFilters });
          return resolve({ error: null });
        };
        return updBuilder;
      };
      return builder;
    },
  };
}

describe('upsertSuccession', () => {
  let ops: Op[];
  beforeEach(() => { ops = []; });

  test('first declaration seeds declared_at + wallet succession_status=declared', async () => {
    __setSupabaseForTest(makeFake({ ops, successionRow: null }));
    await upsertSuccession({
      agentWallet: 'A', chain: 'celo', sourceType: 'claim_form',
      intervalSeconds: 604800, heirs: [{ address: 'H', chain: 'celo' }],
    });
    const succUpsert = ops.find((o) => o.table === 'successions' && o.kind === 'upsert');
    expect(succUpsert?.onConflict).toBe('chain,agent_wallet');
    const payload = succUpsert?.payload as Record<string, unknown>;
    expect(payload.status).toBe('declared');
    expect(payload.declared_at).toBeDefined();
    expect(payload.chain).toBe('celo');
    const walletUpdate = ops.find((o) => o.table === 'wallets' && o.kind === 'update');
    expect((walletUpdate?.payload as Record<string, unknown>).succession_status).toBe('declared');
    expect((walletUpdate?.payload as Record<string, unknown>).heartbeat_interval_seconds).toBe(604800);
  });

  test('re-declare does NOT resurrect a terminal (executed) will', async () => {
    __setSupabaseForTest(makeFake({ ops, successionRow: { chain: 'solana', agent_wallet: 'A', status: 'executed' } }));
    await upsertSuccession({
      agentWallet: 'A', sourceType: 'claim_form',
      intervalSeconds: 604800, heirs: [{ address: 'H', chain: 'solana' }],
    });
    const succUpsert = ops.find((o) => o.table === 'successions' && o.kind === 'upsert');
    expect((succUpsert?.payload as Record<string, unknown>).status).toBe('executed');
    // no declared_at re-stamp (existing row), and wallet status not reseeded.
    const walletUpdate = ops.find((o) => o.table === 'wallets' && o.kind === 'update');
    expect((walletUpdate?.payload as Record<string, unknown>).succession_status).toBeUndefined();
  });

  test('re-declare on a live will resets status to declared (fresh plan)', async () => {
    __setSupabaseForTest(makeFake({ ops, successionRow: { chain: 'solana', agent_wallet: 'A', status: 'live' } }));
    await upsertSuccession({
      agentWallet: 'A', sourceType: 'self_hosted',
      intervalSeconds: 86400, heirs: [{ address: 'H', chain: 'solana' }],
    });
    const succUpsert = ops.find((o) => o.table === 'successions' && o.kind === 'upsert');
    expect((succUpsert?.payload as Record<string, unknown>).status).toBe('declared');
  });
});

describe('applySuccessionLiveness', () => {
  test('writes successions + wallets in lockstep, chain-scoped', async () => {
    const ops: Op[] = [];
    __setSupabaseForTest(makeFake({ ops }));
    await applySuccessionLiveness({
      agentWallet: 'A', chain: 'arc', status: 'live', heartbeatLastAt: '2026-06-15T00:00:00Z',
    });
    const succUpdate = ops.find((o) => o.table === 'successions');
    const walletUpdate = ops.find((o) => o.table === 'wallets');
    expect(succUpdate?.filters.chain).toBe('arc');
    expect(succUpdate?.filters.agent_wallet).toBe('A');
    expect((succUpdate?.payload as Record<string, unknown>).last_heartbeat_at).toBe('2026-06-15T00:00:00Z');
    expect(walletUpdate?.filters.address).toBe('A');
    expect((walletUpdate?.payload as Record<string, unknown>).succession_status).toBe('live');
  });

  test('stamps lapsed_at only when status is lapsed', async () => {
    const opsLive: Op[] = [];
    __setSupabaseForTest(makeFake({ ops: opsLive }));
    await applySuccessionLiveness({ agentWallet: 'A', status: 'live', heartbeatLastAt: null });
    expect((opsLive.find((o) => o.table === 'successions')?.payload as Record<string, unknown>).lapsed_at).toBeUndefined();

    const opsLapsed: Op[] = [];
    __setSupabaseForTest(makeFake({ ops: opsLapsed }));
    await applySuccessionLiveness({ agentWallet: 'A', status: 'lapsed', heartbeatLastAt: null });
    expect((opsLapsed.find((o) => o.table === 'successions')?.payload as Record<string, unknown>).lapsed_at).toBeDefined();
  });
});

describe('getLastMeaningfulTxAt is chain-scoped', () => {
  test('reads transactions pinned by (chain, wallet_address)', async () => {
    const ops: Op[] = [];
    __setSupabaseForTest(makeFake({ ops, txRows: [{ timestamp: '2026-06-14T10:00:00Z' }] }));
    const ts = await getLastMeaningfulTxAt('A', 'celo');
    expect(ts).toBe('2026-06-14T10:00:00.000Z');
    const read = ops.find((o) => o.table === 'transactions');
    expect(read?.filters.chain).toBe('celo');
    expect(read?.filters.wallet_address).toBe('A');
  });

  test('returns null when no tx', async () => {
    const ops: Op[] = [];
    __setSupabaseForTest(makeFake({ ops, txRows: [] }));
    expect(await getLastMeaningfulTxAt('A', 'solana')).toBeNull();
  });
});

describe('listSuccessionsForHeartbeat', () => {
  test('excludes terminal states and optionally chain-filters', async () => {
    const ops: Op[] = [];
    __setSupabaseForTest(makeFake({ ops, successionList: [{ chain: 'solana', agent_wallet: 'A', status: 'live' }] }));
    const rows = await listSuccessionsForHeartbeat(100, 'solana');
    expect(rows).toHaveLength(1);
    const read = ops.find((o) => o.table === 'successions');
    expect(read?.filters.chain).toBe('solana');
    // the .not('status','in', ...) filter is recorded under not_status.
    expect(read?.filters.not_status).toContain('executed');
    expect(read?.filters.not_status).toContain('revoked');
  });
});

describe('insertSignalEvents carries optional chain', () => {
  test('omitting chain keeps it off the row (DB default solana) — back-compat', async () => {
    const ops: Op[] = [];
    __setSupabaseForTest(makeFake({ ops }));
    await insertSignalEvents([{ agentWallet: 'A', tier: 2, kind: 'heartbeat_observed' }], { overwrite: true });
    const row = (ops.find((o) => o.table === 'signal_events')?.payload as Record<string, unknown>[])[0];
    expect('chain' in row).toBe(false);
  });

  test('explicit chain is written onto the row', async () => {
    const ops: Op[] = [];
    __setSupabaseForTest(makeFake({ ops }));
    await insertSignalEvents([{ agentWallet: 'A', chain: 'arc', tier: 2, kind: 'heartbeat_lapsed' }], { overwrite: true });
    const row = (ops.find((o) => o.table === 'signal_events')?.payload as Record<string, unknown>[])[0];
    expect(row.chain).toBe('arc');
  });
});
