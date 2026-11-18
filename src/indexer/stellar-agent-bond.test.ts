import { describe, expect, test } from 'bun:test';
import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import {
  baseUnitsToUsdc,
  decodeAgentBondEvent,
  projectBondState,
  runAgentBondIndexer,
  type AgentBondIndexerDeps,
  type RawAgentBondEvent,
} from './stellar-agent-bond';

const CONTRACT = 'CDJCW763IQ2B2ZTZLMD4WNQPIXT45DVHBZBCDDXPL25VGDJF63EZOR2W';
const OWNER = Keypair.random().publicKey();
const TREASURY = Keypair.random().publicKey();
const U = 10_000_000n;

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const i128 = (v: bigint) => nativeToScVal(v, { type: 'i128' });
const addr = (a: string) => new Address(a).toScVal();
const bytes = (b: number) => xdr.ScVal.scvBytes(Buffer.alloc(32, b));

/** Soroban contracttype struct = map with symbol keys sorted. */
function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields).sort().map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k] })),
  );
}

let seq = 0;
function raw(name: string, agentId: number | null, data: xdr.ScVal, ledger = 100, extra: Partial<RawAgentBondEvent> = {}): RawAgentBondEvent {
  seq++;
  return {
    id: `${String(ledger).padStart(19, '0')}-${String(seq).padStart(10, '0')}`,
    ledger,
    ledgerClosedAt: new Date(Date.UTC(2026, 10, 18) + ledger * 5000).toISOString(),
    contractId: CONTRACT,
    txHash: `tx${seq}`,
    topic: agentId === null ? [sym(name)] : [sym(name), xdr.ScVal.scvU32(agentId)],
    value: data,
    inSuccessfulContractCall: true,
    ...extra,
  };
}

const deposited = (amount: bigint, bonded: bigint, ledger = 100, slashed = 0n) =>
  raw('bond_deposited', 7, struct({ owner: addr(OWNER), amount: i128(amount), bonded: i128(bonded), unbonding: i128(0n), slashed_total: i128(slashed) }), ledger);
const unbond = (amount: bigint, bonded: bigint, unbonding: bigint, unlockAt: number, ledger = 101) =>
  raw('bond_unbond_requested', 7, struct({ owner: addr(OWNER), amount: i128(amount), bonded: i128(bonded), unbonding: i128(unbonding), unlock_at: nativeToScVal(unlockAt, { type: 'u64' }) }), ledger);
const slashedAssay = (amount: bigint, bonded: bigint, unbonding: bigint, total: bigint, ledger = 102) =>
  raw('bond_slashed', 7, struct({
    owner: addr(OWNER), amount: i128(amount), from_unbonding: i128(0n), from_bonded: i128(amount),
    evidence: xdr.ScVal.scvVec([sym('AssayVerdict'), bytes(1), bytes(2)]),
    evidence_id: bytes(9), treasury: addr(TREASURY),
    bonded: i128(bonded), unbonding: i128(unbonding), slashed_total: i128(total),
  }), ledger);

describe('decodeAgentBondEvent', () => {
  test('decodes a deposit with 7-dp amounts', () => {
    const e = decodeAgentBondEvent(deposited(100n * U, 150n * U))!;
    expect(e.kind).toBe('deposited');
    expect(e.agentId).toBe(7);
    expect(e.owner).toBe(OWNER);
    expect(e.amount).toBe('100.0000000');
    expect(e.bonded).toBe('150.0000000');
    expect(e.slashedTotal).toBe('0.0000000');
  });

  test('decodes unbond unlock time and an Assay slash', () => {
    expect(decodeAgentBondEvent(unbond(U, 9n * U, U, 1_800_000_000))!.unlockAt).toBe(1_800_000_000);
    const s = decodeAgentBondEvent(slashedAssay(2n * U, 8n * U, 0n, 2n * U))!;
    expect(s.evidence).toEqual({ kind: 'assay', codeHash: '01'.repeat(32), recordDigest: '02'.repeat(32) });
    expect(s.evidenceId).toBe('09'.repeat(32));
  });

  test('decodes Enactment evidence', () => {
    const r = raw('bond_slashed', 7, struct({
      owner: addr(OWNER), amount: i128(U), from_unbonding: i128(0n), from_bonded: i128(U),
      evidence: xdr.ScVal.scvVec([sym('Enactment'), bytes(3)]), evidence_id: bytes(4), treasury: addr(TREASURY),
      bonded: i128(0n), unbonding: i128(0n), slashed_total: i128(U),
    }));
    expect(decodeAgentBondEvent(r)!.evidence).toEqual({ kind: 'enactment', digest: '03'.repeat(32) });
  });

  test('ignores config events and failed calls', () => {
    expect(decodeAgentBondEvent(raw('cfg_proposed', null, struct({ activates_at: nativeToScVal(1, { type: 'u64' }) })))).toBeNull();
    expect(decodeAgentBondEvent({ ...deposited(U, U), inSuccessfulContractCall: false })).toBeNull();
  });

  test('fails loud on shape drift', () => {
    const bad = deposited(U, U);
    bad.topic = [sym('bond_deposited')];
    expect(() => decodeAgentBondEvent(bad)).toThrow('expected 2 topics');
    const noOwner = raw('bond_deposited', 7, struct({ amount: i128(U) }));
    expect(() => decodeAgentBondEvent(noOwner)).toThrow('data map malformed');
  });

  test('baseUnitsToUsdc keeps exact digits', () => {
    expect(baseUnitsToUsdc(1n)).toBe('0.0000001');
    expect(baseUnitsToUsdc(123_456_789_012_345_678n)).toBe('12345678901.2345678');
  });
});

describe('projectBondState', () => {
  test('folds events into the latest post-state, keeping first deposit time', () => {
    const evs = [deposited(100n * U, 100n * U, 100), unbond(40n * U, 60n * U, 40n * U, 1_800_000_000, 101), slashedAssay(50n * U, 50n * U, 0n, 50n * U, 102)]
      .map((r) => decodeAgentBondEvent(r)!);
    const [row] = projectBondState(evs, new Map());
    expect(row.bonded).toBe('50.0000000');
    expect(row.unbonding).toBe('0.0000000');
    expect(row.unlock_at).toBeNull();
    expect(row.slashed_total).toBe('50.0000000');
    expect(row.first_deposit_at).toBe(evs[0].ledgerClosedAt);
    expect(row.last_ledger).toBe(102);
  });

  test('keeps a stored unlock time and first deposit when an event lacks them', () => {
    const prior = new Map([[`${CONTRACT}:7`, { unlock_at: '2027-01-01T00:00:00.000Z', slashed_total: '1.0000000', first_deposit_at: '2026-01-01T00:00:00.000Z' }]]);
    const withdrawnPartial = raw('bond_withdrawn', 7, struct({ owner: addr(OWNER), amount: i128(U), bonded: i128(5n * U), unbonding: i128(U) }));
    const [row] = projectBondState([decodeAgentBondEvent(withdrawnPartial)!], prior);
    expect(row.unlock_at).toBe('2027-01-01T00:00:00.000Z');
    expect(row.slashed_total).toBe('1.0000000');
    expect(row.first_deposit_at).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('runAgentBondIndexer', () => {
  function fakeDeps(pages: RawAgentBondEvent[][], over: Partial<AgentBondIndexerDeps> = {}) {
    const calls: { req: unknown[]; saved: string[]; dirty: string[][]; rows: number; bonds: number } = { req: [], saved: [], dirty: [], rows: 0, bonds: 0 };
    let i = 0;
    const deps: AgentBondIndexerDeps = {
      contractId: CONTRACT,
      deployLedger: 90,
      pageLimit: 2,
      getOldestLedger: async () => 50,
      getEvents: async (req) => { calls.req.push(req); const events = pages[i] ?? []; i++; return { events, cursor: `c${i}`, oldestLedger: 50, latestLedger: 500 }; },
      loadCursor: async () => null,
      saveCursor: async (c) => { calls.saved.push(c); },
      loadPrior: async () => new Map(),
      ensureWallets: async () => {},
      insertEvents: async (rows) => { calls.rows += rows.length; return rows.length; },
      upsertBonds: async (rows) => { calls.bonds += rows.length; },
      markDirty: async (a) => { calls.dirty.push(a); },
      seasoningOwners: async () => [],
      ...over,
    };
    return { deps, calls };
  }

  test('starts at the deploy ledger, pages by cursor, marks owners dirty', async () => {
    const { deps, calls } = fakeDeps([[deposited(U, U, 100), unbond(U, 0n, U, 1, 101)], [deposited(U, U, 102)]]);
    const r = await runAgentBondIndexer(deps);
    expect(calls.req).toEqual([{ startLedger: 90 }, { cursor: 'c1' }]);
    expect(calls.saved).toEqual(['c1', 'c2']);
    expect(r.inserted).toBe(3);
    expect(calls.dirty).toEqual([[OWNER], [OWNER]]);
    expect(r.coverage.complete).toBe(true);
  });

  test('resumes from a stored cursor', async () => {
    const { deps, calls } = fakeDeps([[]], { loadCursor: async () => 'stored' });
    await runAgentBondIndexer(deps);
    expect(calls.req).toEqual([{ cursor: 'stored' }]);
  });

  test('does not advance the cursor when a write fails', async () => {
    const { deps, calls } = fakeDeps([[deposited(U, U)]], { insertEvents: async () => { throw new Error('db down'); } });
    await expect(runAgentBondIndexer(deps)).rejects.toThrow('db down');
    expect(calls.saved).toEqual([]);
  });

  test('reports a retention gap when the deploy ledger fell out of RPC retention', async () => {
    const { deps } = fakeDeps([[]], { getOldestLedger: async () => 95 });
    const r = await runAgentBondIndexer(deps);
    expect(r.coverage.gaps).toBe(1);
    expect(r.coverage.reason).toBe('retention_gap');
    expect(r.coverage.complete).toBe(false);
  });

  test('re-marks owners whose 30-day seasoning window is still moving', async () => {
    const { deps, calls } = fakeDeps([[]], { seasoningOwners: async () => ['GSEASON'] });
    await runAgentBondIndexer(deps);
    expect(calls.dirty).toContainEqual(['GSEASON']);
  });

  test('ignores events from any other contract', async () => {
    const foreign = { ...deposited(U, U), contractId: 'COTHER' };
    const { deps, calls } = fakeDeps([[foreign]]);
    await runAgentBondIndexer(deps);
    expect(calls.rows).toBe(0);
  });
});
