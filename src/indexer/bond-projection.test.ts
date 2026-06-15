/// <reference types="bun-types" />
/**
 * Bond projection / indexer tests.
 *
 * Mock strategy: DEPENDENCY INJECTION (mirrors arc-jobs.test.ts). The projector
 * core takes injected DB hooks + an event source, so tests drive lifecycle
 * events deterministically and assert on the recorded bonds / underwriters /
 * signals without any live DB.
 *
 * Covers: open → bonds + underwriters + bond_opened signal; resolve(success) →
 * settled underwriters w/ premium + bond_resolved success signal; resolve(failure)
 * → settled, zero premium, failure signal; FK pre-create ordering; chain-agnostic
 * behavior (all four chains); is_demo propagation; idempotent re-index.
 *
 * Run: bun test src/indexer/bond-projection.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  bondProjector,
  resolvedStatus,
  totalStaked,
  type BondLifecycleEvent,
  type BondEventSource,
  type BondProjectorDeps,
} from './bond-projection';
import { SIGNAL_KINDS, PRESENCE_ONLY_KINDS } from '../scoring/signals';
import type { Chain } from '../db/schema';
import type { InsertSignalEventInput } from '../db/client';

// ── Recording test deps ───────────────────────────────────────────────────────

interface Recorded {
  bonds: Array<{ escrowRef: string; status: string; amount: number; isDemo: boolean; chain: Chain; resolutionProofTx?: string | null }>;
  underwriters: Array<{ bondId: string; underwriterWallet: string; stakeAmount: number; settled: boolean; premiumEarned?: number | null; chain: Chain }>;
  signals: InsertSignalEventInput[];
  wallets: Array<{ address: string; chain: Chain }>;
}

function makeDeps(source: BondEventSource): { deps: BondProjectorDeps; rec: Recorded } {
  const rec: Recorded = { bonds: [], underwriters: [], signals: [], wallets: [] };
  // Stable bondId per (chain, escrowRef) so re-upserts return the same id.
  const idByRef = new Map<string, string>();
  let counter = 0;

  const deps: BondProjectorDeps = {
    source,
    upsertBond: async (input) => {
      const key = `${input.chain ?? 'solana'}:${input.escrowRef}`;
      let id = idByRef.get(key);
      if (!id) {
        id = `bond-${++counter}`;
        idByRef.set(key, id);
      }
      rec.bonds.push({
        escrowRef: input.escrowRef,
        status: input.status,
        amount: input.amount,
        isDemo: input.isDemo ?? false,
        chain: input.chain ?? ('solana' as Chain),
        resolutionProofTx: input.resolutionProofTx,
      });
      return id;
    },
    upsertBondUnderwriter: async (input) => {
      rec.underwriters.push({
        bondId: input.bondId,
        underwriterWallet: input.underwriterWallet,
        stakeAmount: input.stakeAmount,
        settled: input.settled ?? false,
        premiumEarned: input.premiumEarned,
        chain: input.chain ?? ('solana' as Chain),
      });
    },
    insertSignalEvents: async (inputs) => {
      rec.signals.push(...inputs);
      return inputs.length;
    },
    ensureWallet: async (address, chain) => {
      rec.wallets.push({ address, chain });
    },
  };
  return { deps, rec };
}

function source(events: BondLifecycleEvent[], isDemo = true): BondEventSource {
  return { events: async () => events, isDemo };
}

const TS = '2026-06-15T00:00:00.000Z';

// ── pure helpers ──────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  test('resolvedStatus maps success flag', () => {
    expect(resolvedStatus(true)).toBe('resolved_success');
    expect(resolvedStatus(false)).toBe('resolved_failure');
  });

  test('totalStaked sums and ignores non-finite', () => {
    expect(totalStaked([{ underwriter: 'a', amount: 100 }, { underwriter: 'b', amount: 50 }])).toBe(150);
    expect(totalStaked([{ underwriter: 'a', amount: NaN }, { underwriter: 'b', amount: 50 }])).toBe(50);
    expect(totalStaked([])).toBe(0);
  });
});

// ── empty ─────────────────────────────────────────────────────────────────────

describe('empty source', () => {
  test('no events → no writes', async () => {
    const { deps, rec } = makeDeps(source([]));
    const res = await bondProjector(deps);
    expect(res.fetched).toBe(0);
    expect(res.inserted).toBe(0);
    expect(rec.bonds).toHaveLength(0);
    expect(rec.signals).toHaveLength(0);
  });
});

// ── open ──────────────────────────────────────────────────────────────────────

describe('bond opened', () => {
  const opened: BondLifecycleEvent = {
    type: 'opened',
    chain: 'solana',
    escrowRef: 'demo-escrow-solana-1',
    bondedAgent: 'AGENT',
    beneficiary: 'BENEF',
    taskRef: 'task-1',
    openTxHash: 'tx-open-1',
    stakes: [
      { underwriter: 'UW1', amount: 250 },
      { underwriter: 'UW2', amount: 150 },
    ],
    observedAt: TS,
  };

  test('upserts open bond, underwriters, and a bond_opened signal', async () => {
    const { deps, rec } = makeDeps(source([opened]));
    const res = await bondProjector(deps);

    expect(res.fetched).toBe(1);
    expect(rec.bonds).toHaveLength(1);
    expect(rec.bonds[0]).toMatchObject({ status: 'open', amount: 400, isDemo: true });

    expect(rec.underwriters).toHaveLength(2);
    expect(rec.underwriters.every((u) => u.settled === false)).toBe(true);

    const sig = rec.signals.find((s) => s.kind === SIGNAL_KINDS.BOND_OPENED);
    expect(sig).toBeDefined();
    expect(sig!.tier).toBe(1);
    expect(sig!.face).toBe('provider');
    expect(sig!.agentWallet).toBe('AGENT');
    expect(sig!.txRef).toBe('bond-1:tx-open-1');
  });

  test('FK pre-creates agent, beneficiary, and every underwriter', async () => {
    const { deps, rec } = makeDeps(source([opened]));
    await bondProjector(deps);
    const addrs = rec.wallets.map((w) => w.address);
    expect(addrs).toContain('AGENT');
    expect(addrs).toContain('BENEF');
    expect(addrs).toContain('UW1');
    expect(addrs).toContain('UW2');
    expect(rec.wallets.every((w) => w.chain === 'solana')).toBe(true);
  });

  test('the emitted kind is presence-only (ceiling discipline)', async () => {
    const { deps, rec } = makeDeps(source([opened]));
    await bondProjector(deps);
    const sig = rec.signals.find((s) => s.kind === SIGNAL_KINDS.BOND_OPENED)!;
    expect(PRESENCE_ONLY_KINDS.has(sig.kind)).toBe(true);
  });
});

// ── resolve success ────────────────────────────────────────────────────────────

describe('bond resolved success', () => {
  const events: BondLifecycleEvent[] = [
    {
      type: 'opened', chain: 'solana', escrowRef: 'demo-escrow-solana-2',
      bondedAgent: 'AGENT', beneficiary: 'BENEF', openTxHash: 'tx-open-2',
      stakes: [{ underwriter: 'UW1', amount: 300 }, { underwriter: 'UW2', amount: 200 }],
      observedAt: TS,
    },
    {
      type: 'resolved', chain: 'solana', escrowRef: 'demo-escrow-solana-2',
      bondedAgent: 'AGENT', beneficiary: 'BENEF', success: true,
      resolveTxHash: 'tx-resolve-2', observedAt: TS,
    },
  ];

  test('marks underwriters settled with premium and emits success signal', async () => {
    const { deps, rec } = makeDeps(source(events));
    await bondProjector(deps);

    // The terminal bond row carries the success status + resolution proof.
    const resolvedRows = rec.bonds.filter((b) => b.status === 'resolved_success');
    expect(resolvedRows.length).toBeGreaterThan(0);
    expect(resolvedRows.some((b) => b.resolutionProofTx === 'tx-resolve-2')).toBe(true);

    // Settled-pass underwriters earn 5% premium on success.
    const settled = rec.underwriters.filter((u) => u.settled);
    expect(settled).toHaveLength(2);
    const uw1 = settled.find((u) => u.underwriterWallet === 'UW1')!;
    expect(uw1.premiumEarned).toBe(15); // 5% of 300

    const sig = rec.signals.find((s) => s.kind === SIGNAL_KINDS.BOND_RESOLVED)!;
    expect(sig.value).toBe(1.0); // success
    expect(sig.face).toBe('provider');
    expect(sig.tier).toBe(1);
  });
});

// ── resolve failure ─────────────────────────────────────────────────────────────

describe('bond resolved failure', () => {
  const events: BondLifecycleEvent[] = [
    {
      type: 'opened', chain: 'arc', escrowRef: 'demo-escrow-arc-3',
      bondedAgent: 'AGENT_T', beneficiary: 'BENEF', openTxHash: 'tx-open-3',
      stakes: [{ underwriter: 'UW3', amount: 500 }],
      observedAt: TS,
    },
    {
      type: 'resolved', chain: 'arc', escrowRef: 'demo-escrow-arc-3',
      bondedAgent: 'AGENT_T', beneficiary: 'BENEF', success: false,
      resolveTxHash: 'tx-resolve-3', observedAt: TS,
    },
  ];

  test('failure → settled, zero premium, value 0 signal, chain preserved', async () => {
    const { deps, rec } = makeDeps(source(events));
    await bondProjector(deps);

    const settled = rec.underwriters.filter((u) => u.settled);
    expect(settled).toHaveLength(1);
    expect(settled[0].premiumEarned).toBe(0);
    expect(settled[0].chain).toBe('arc');

    const sig = rec.signals.find((s) => s.kind === SIGNAL_KINDS.BOND_RESOLVED)!;
    expect(sig.value).toBe(0.0); // failure

    expect(rec.bonds.some((b) => b.status === 'resolved_failure' && b.chain === 'arc')).toBe(true);
  });
});

// ── chain-agnostic ───────────────────────────────────────────────────────────────

describe('chain-agnostic', () => {
  test('projects opens across all four chains with chain preserved', async () => {
    const chains: Chain[] = ['solana', 'celo', 'arc', 'stellar'];
    const events: BondLifecycleEvent[] = chains.map((chain, i) => ({
      type: 'opened', chain, escrowRef: `demo-escrow-${chain}-1`,
      bondedAgent: `AGENT_${chain}`, beneficiary: `BENEF_${chain}`,
      openTxHash: `tx-${i}`, stakes: [{ underwriter: `UW_${chain}`, amount: 100 }],
      observedAt: TS,
    }));
    const { deps, rec } = makeDeps(source(events));
    await bondProjector(deps);

    expect(rec.bonds).toHaveLength(4);
    for (const chain of chains) {
      expect(rec.bonds.some((b) => b.chain === chain)).toBe(true);
    }
    expect(rec.signals.filter((s) => s.kind === SIGNAL_KINDS.BOND_OPENED)).toHaveLength(4);
  });
});

// ── is_demo propagation ──────────────────────────────────────────────────────────

describe('is_demo flagging', () => {
  const opened: BondLifecycleEvent = {
    type: 'opened', chain: 'solana', escrowRef: 'escrow-real-1',
    bondedAgent: 'A', beneficiary: 'B', openTxHash: 'tx', stakes: [{ underwriter: 'U', amount: 10 }],
    observedAt: TS,
  };

  test('real source → is_demo false on the bond row', async () => {
    const { deps, rec } = makeDeps(source([opened], /* isDemo */ false));
    await bondProjector(deps);
    expect(rec.bonds.every((b) => b.isDemo === false)).toBe(true);
  });

  test('demo source → is_demo true on the bond row', async () => {
    const { deps, rec } = makeDeps(source([opened], /* isDemo */ true));
    await bondProjector(deps);
    expect(rec.bonds.every((b) => b.isDemo === true)).toBe(true);
  });
});
