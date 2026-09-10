/// <reference types="bun-types" />
/**
 * Arc plain USDC-transfer Tier-1 indexer tests.
 *
 * Mock strategy: DEPENDENCY INJECTION, mirrors arc-jobs.test.ts. Two case
 * families are novel here (arc-jobs has no equivalent of either):
 *
 *   1. The exclusion skip — a Transfer touching the ERC-8183 escrow, the USDC
 *      predeploy or the zero address must produce ZERO signals. arc-jobs.ts
 *      already covers escrow movement at full strength, and the zero address is
 *      USDC mint/burn, which is Circle's issuance, not agent reputation.
 *   2. The seed set — scope is "addresses AgentKarma already cares about", and
 *      the gate that keeps it from growing into a transitive closure over the
 *      payment graph. That failure only manifests ACROSS runs, so there is an
 *      explicit two-run simulation below.
 *
 * Run: bun test src/indexer/arc-transfers.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  parseTransfer,
  arcTransfersIndexer,
  arcTransfersCursorKey,
  buildArcSeedSet,
  isIntentional,
  touchesExcluded,
  ARC_TRANSFER_EXCLUSIONS,
  ARC_USDC_CONTRACT,
  ARC_ZERO_ADDRESS,
  TRANSFER_EVENT,
  type ArcTransfer,
  type TransferFace,
} from './arc-transfers';
import { ARC_JOBS_CONTRACT } from './arc-jobs';
import type { Log } from 'viem';

const FROM = '0x1111111111111111111111111111111111111111' as const;
const TO = '0x2222222222222222222222222222222222222222' as const;
const STRANGER = '0x3333333333333333333333333333333333333333' as const;
const TS = '2026-07-11T00:00:00.000Z';

/** The default scope for tests that are not about scoping. */
const SEED = new Set<string>([FROM, TO]);

function transfer(opts: {
  from?: `0x${string}`; to?: `0x${string}`; rawAmount: bigint;
  block?: bigint; txHash?: `0x${string}`;
}): ArcTransfer {
  return {
    from: opts.from ?? FROM,
    to: opts.to ?? TO,
    rawAmount: opts.rawAmount,
    amount: Number(opts.rawAmount) / 1e6,
    blockNumber: opts.block ?? BigInt(100),
    txHash: opts.txHash ?? '0xtransfer',
  };
}

/**
 * `getLogs` returns the SAME transfers for both the from-side and the to-side
 * call, on purpose: production issues two filtered calls per window and unions
 * them, so every test here also exercises the run-level de-dup. A transfer that
 * matched both filters must still produce exactly one row.
 */
function makeDeps(
  transfers: ArcTransfer[],
  overrides: Partial<Parameters<typeof arcTransfersIndexer>[0]> = {},
) {
  const inserted: unknown[] = [];
  const signals: unknown[] = [];
  const ensured: string[] = [];
  const cursors: Array<[string, string, number | undefined]> = [];
  const faces: TransferFace[] = [];
  let getHeadCalls = 0;

  const deps = {
    usdcContract: ARC_USDC_CONTRACT,
    seed: SEED,
    getHead: async () => { getHeadCalls++; return BigInt(100); },
    getLogs: async (_from: bigint, _to: bigint, face: TransferFace) => {
      faces.push(face);
      return transfers;
    },
    blockTimestamp: async () => TS,
    insertTransactions: async (rows: unknown[]) => { inserted.push(...rows); return rows.length; },
    insertSignalEvents: async (s: unknown[]) => { signals.push(...s); return s.length; },
    ensureWallets: async (addresses: string[]) => { ensured.push(...addresses); },
    getCursor: async () => null,
    upsertCursor: async (key: string, last: string, slot?: number) => { cursors.push([key, last, slot]); },
    ...overrides,
  };

  return {
    deps,
    state: {
      inserted, signals, ensured, cursors, faces,
      get getLogsCalls() { return faces.length; },
      get getHeadCalls() { return getHeadCalls; },
    },
  };
}

describe('parseTransfer', () => {
  test('decodes from/to/value', () => {
    const log = {
      args: { from: FROM, to: TO, value: BigInt(500_000) },
      blockNumber: BigInt(10),
      transactionHash: '0xabc',
    } as unknown as Log<bigint, number, false, typeof TRANSFER_EVENT>;
    const rec = parseTransfer(log);
    expect(rec).not.toBeNull();
    expect(rec!.from).toBe(FROM);
    expect(rec!.to).toBe(TO);
    expect(rec!.amount).toBe(0.5);
  });

  test('returns null on missing value', () => {
    const log = {
      args: { from: FROM, to: TO },
      blockNumber: BigInt(10), transactionHash: '0xabc',
    } as unknown as Log<bigint, number, false, typeof TRANSFER_EVENT>;
    expect(parseTransfer(log)).toBeNull();
  });

  // Regression: 2026-08-17. viem hands back EIP-55 CHECKSUMMED addresses and
  // this parser passed them through, so ingest wrote `wallets` /
  // `transactions` / `signal_events` rows in a casing no read path uses (the
  // profile route, claims and the Arc adapter's normalizeAddress all
  // lowercase). 83,887 of 84,024 arc wallet rows became unreachable orphans.
  // Normalizing in the parser fixes all three tables at once, and stays
  // EVM-scoped — the shared `ensureWalletsExist` must never lowercase, since
  // Solana base58 is case-SENSITIVE.
  describe('addresses are lowercased at the decode boundary', () => {
    const MIXED_FROM = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01' as const;
    const MIXED_TO = '0xFeDcBa9876543210FeDcBa9876543210FeDcBa98' as const;

    test('parseTransfer lowercases from and to', () => {
      const log = {
        args: { from: MIXED_FROM, to: MIXED_TO, value: BigInt(500_000) },
        blockNumber: BigInt(10), transactionHash: '0xabc',
      } as unknown as Log<bigint, number, false, typeof TRANSFER_EVENT>;

      const rec = parseTransfer(log)!;
      expect(rec.from).toBe(MIXED_FROM.toLowerCase() as `0x${string}`);
      expect(rec.to).toBe(MIXED_TO.toLowerCase() as `0x${string}`);
    });

    test('a run writes lowercase into transactions, signals and the wallet set', async () => {
      const { deps, state } = makeDeps(
        [transfer({ from: MIXED_FROM, to: MIXED_TO, rawAmount: BigInt(1_000_000) })],
        { seed: new Set([MIXED_FROM.toLowerCase()]) },
      );

      await arcTransfersIndexer(deps);

      const row = state.inserted[0] as { wallet_address: string; counterparty: string };
      expect(row.wallet_address).toBe(MIXED_FROM.toLowerCase());
      expect(row.counterparty).toBe(MIXED_TO.toLowerCase());
      for (const addr of state.ensured) expect(addr).toBe(addr.toLowerCase());
      for (const s of state.signals as Array<{ agentWallet: string }>) {
        expect(s.agentWallet).toBe(s.agentWallet.toLowerCase());
      }
    });

    // The exclusion filter lowercases both operands; a checksummed escrow
    // address in a log must still be recognised as arc-jobs' territory.
    test('escrow-internal transfers are still filtered when the log is checksummed', async () => {
      const checksummedEscrow = (ARC_JOBS_CONTRACT.slice(0, 2)
        + ARC_JOBS_CONTRACT.slice(2).toUpperCase()) as `0x${string}`;
      const { deps, state } = makeDeps(
        [transfer({ from: checksummedEscrow, to: MIXED_TO, rawAmount: BigInt(1_000_000) })],
        { seed: new Set([MIXED_TO.toLowerCase()]) },
      );

      const res = await arcTransfersIndexer(deps);

      expect(res.fetched).toBe(0);
      expect(state.inserted).toHaveLength(0);
    });
  });
});

// ─── Seed set ─────────────────────────────────────────────────────────────────

describe('buildArcSeedSet', () => {
  test('takes BOTH owner and agent_wallet from a registry row', () => {
    const seed = buildArcSeedSet({
      registryRows: [{ owner: FROM, agent_wallet: TO }],
    });
    expect(seed.has(FROM)).toBe(true);
    expect(seed.has(TO)).toBe(true);
  });

  // EVM: rows are lowercase everywhere (2026-08-17). The seed is compared
  // against lowercased transfer faces AND passed to getLogs, so a checksummed
  // registry row must not become an address the filter can never match.
  test('lowercases every address', () => {
    const seed = buildArcSeedSet({
      registryRows: [{ owner: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01', agent_wallet: null }],
    });
    expect([...seed]).toEqual(['0xabcdef0123456789abcdef0123456789abcdef01']);
  });

  // 25 arc registry rows carry agent_wallet = 0x0 — the EVM IdentityRegistry's
  // "never set a custom wallet" return value, mirrored faithfully. Seeded, it
  // pulls USDC mint/burn: 495 + 952 logs in one 10k-block window at head vs 6
  // for the whole clean seed. The agent is still covered via `owner`.
  test('drops the zero address that a registry row uses for an unset agent_wallet', () => {
    const seed = buildArcSeedSet({
      registryRows: [{ owner: FROM, agent_wallet: ARC_ZERO_ADDRESS }],
    });
    expect(seed.has(ARC_ZERO_ADDRESS)).toBe(false);
    expect(seed.has(FROM)).toBe(true);
  });

  test('drops the USDC predeploy and the ERC-8183 escrow', () => {
    const seed = buildArcSeedSet({
      registryRows: [
        { owner: ARC_USDC_CONTRACT, agent_wallet: null },
        { owner: ARC_JOBS_CONTRACT.toLowerCase(), agent_wallet: null },
        { owner: FROM, agent_wallet: null },
      ],
    });
    expect([...seed]).toEqual([FROM]);
  });

  test('drops values that are not 20-byte hex addresses', () => {
    const seed = buildArcSeedSet({
      registryRows: [
        { owner: 'GDEMOBONDBENEFICIARY', agent_wallet: '0xnothex' },
        { owner: '0x1234', agent_wallet: null },
        { owner: FROM, agent_wallet: null },
      ],
    });
    expect([...seed]).toEqual([FROM]);
  });

  test('folds in the explicit extension list', () => {
    const seed = buildArcSeedSet({ extra: [STRANGER] });
    expect(seed.has(STRANGER)).toBe(true);
  });
});

describe('isIntentional — the gate that breaks the seed feedback loop', () => {
  test('a row in the shape ensureWallets mints is NOT intentional', () => {
    // ensureWalletsExist writes only { chain, address }; every other column
    // takes its schema default. That is exactly this shape.
    expect(isIntentional({ address: STRANGER, claimed: false, arc_agent_id: null })).toBe(false);
  });

  test('claimed = true is intentional', () => {
    expect(isIntentional({ address: FROM, claimed: true, arc_agent_id: null })).toBe(true);
  });

  test('a bound arc_agent_id is intentional', () => {
    expect(isIntentional({ address: FROM, claimed: false, arc_agent_id: 1601 })).toBe(true);
  });

  // score > 0 must never be a marker: this indexer's own rows put a minted
  // wallet on the rescore queue, so scoring would readmit it next run — the
  // loop, reopened by the very gate meant to close it.
  test('a score alone is NOT a marker', () => {
    expect(isIntentional({ address: STRANGER, claimed: false, arc_agent_id: null, score: 90 })).toBe(false);
  });

  test('buildArcSeedSet seeds only intentional wallet rows', () => {
    const seed = buildArcSeedSet({
      walletRows: [
        { address: FROM, claimed: true, arc_agent_id: null },
        { address: TO, claimed: false, arc_agent_id: 42 },
        { address: STRANGER, claimed: false, arc_agent_id: null },
      ],
    });
    expect(seed.has(FROM)).toBe(true);
    expect(seed.has(TO)).toBe(true);
    expect(seed.has(STRANGER)).toBe(false);
  });
});

describe('the seed does not grow across runs (feedback-loop regression)', () => {
  /**
   * The failure this reproduces: `ensureWallets` mints a `wallets` row for both
   * faces of every kept transfer. If the seed then read every `wallets` row,
   * run N's counterparties would be run N+1's filter targets — a transitive
   * closure over the USDC payment graph, one hop per run, reaching exchange hot
   * wallets within a few 6-hourly ticks.
   *
   * Neither a unit test with an injected seed nor a single dry run can see it.
   * It needs two runs, which is what this is.
   */
  test('a counterparty minted by run 1 is not a filter target in run 2', async () => {
    // The DB as it stands before run 1: one registry-bound agent.
    const walletRows: Array<{ address: string; claimed: boolean; arc_agent_id: number | null }> = [
      { address: FROM, claimed: false, arc_agent_id: 1601 },
    ];

    const run1Seed = buildArcSeedSet({ walletRows });
    expect([...run1Seed]).toEqual([FROM]);

    const { deps, state } = makeDeps(
      [transfer({ from: FROM, to: STRANGER, rawAmount: BigInt(1_000_000) })],
      {
        seed: run1Seed,
        // ensureWallets mints rows exactly as production does: identity only.
        ensureWallets: async (addresses: string[]) => {
          for (const address of addresses) {
            if (!walletRows.some((w) => w.address === address)) {
              walletRows.push({ address, claimed: false, arc_agent_id: null });
            }
          }
        },
      },
    );

    const run1 = await arcTransfersIndexer(deps);
    expect(run1.fetched).toBe(1);
    // The stranger is now in `wallets` — that part is correct and expected.
    expect(walletRows.map((w) => w.address)).toEqual([FROM, STRANGER]);
    void state;

    // Run 2 rebuilds the seed from the SAME table, now containing the mint.
    const run2Seed = buildArcSeedSet({ walletRows });
    expect([...run2Seed]).toEqual([FROM]);
    expect(run2Seed.has(STRANGER)).toBe(false);
    expect(run2Seed.size).toBe(run1Seed.size);
  });
});

describe('touchesExcluded', () => {
  test('mint (zero address → seeded agent) is excluded', () => {
    expect(touchesExcluded(transfer({ from: ARC_ZERO_ADDRESS, to: TO, rawAmount: BigInt(1) }))).toBe(true);
  });

  test('burn (seeded agent → zero address) is excluded', () => {
    expect(touchesExcluded(transfer({ from: FROM, to: ARC_ZERO_ADDRESS, rawAmount: BigInt(1) }))).toBe(true);
  });

  test('the USDC predeploy on either side is excluded', () => {
    expect(touchesExcluded(transfer({ from: ARC_USDC_CONTRACT, to: TO, rawAmount: BigInt(1) }))).toBe(true);
    expect(touchesExcluded(transfer({ from: FROM, to: ARC_USDC_CONTRACT, rawAmount: BigInt(1) }))).toBe(true);
  });

  test('a plain agent-to-agent transfer is not excluded', () => {
    expect(touchesExcluded(transfer({ rawAmount: BigInt(1) }))).toBe(false);
  });

  test('the exclusion set is lowercase, so log casing cannot slip past it', () => {
    for (const address of ARC_TRANSFER_EXCLUSIONS) expect(address).toBe(address.toLowerCase());
  });
});

// ─── Core ─────────────────────────────────────────────────────────────────────

describe('arcTransfersIndexer — scope', () => {
  test('issues one from-side and one to-side call per window', async () => {
    const { deps, state } = makeDeps([]);
    await arcTransfersIndexer(deps);
    expect(state.faces).toEqual(['from', 'to']);
  });

  test('a transfer matching both calls yields exactly one row', async () => {
    // makeDeps returns the same transfer for both faces — the union case.
    const { deps, state } = makeDeps([transfer({ rawAmount: BigInt(1_000_000) })]);
    const result = await arcTransfersIndexer(deps);

    expect(result.fetched).toBe(1);
    expect(state.inserted).toHaveLength(1);
    expect(state.signals).toHaveLength(2); // one provider + one consumer, not four
  });

  /**
   * `getLogs` is a DI seam, so a decoded record can reach the write loop
   * without ever having passed through the topic filter. The core must not
   * trust it — the same lesson as the 2026-08-17 casing split, where
   * normalizing in the parser alone left the core writing checksummed rows.
   */
  test('drops a transfer neither side of which is seeded, even when getLogs returns it', async () => {
    const { deps, state } = makeDeps(
      [transfer({ from: STRANGER, to: '0x4444444444444444444444444444444444444444', rawAmount: BigInt(1_000_000) })],
    );
    const result = await arcTransfersIndexer(deps);

    expect(result.fetched).toBe(0);
    expect(state.inserted).toHaveLength(0);
    expect(state.ensured).toHaveLength(0);
  });

  test('keeps a transfer when only the payee is seeded', async () => {
    const { deps, state } = makeDeps(
      [transfer({ from: STRANGER, to: TO, rawAmount: BigInt(1_000_000) })],
    );
    const result = await arcTransfersIndexer(deps);

    expect(result.fetched).toBe(1);
    const row = state.inserted[0] as { wallet_address: string; counterparty: string };
    expect(row.wallet_address).toBe(STRANGER); // payer face, seeded or not
    expect(row.counterparty).toBe(TO);
  });

  /**
   * An empty seed must be a no-op, never an unfiltered scan. It is unverified
   * what a node does with an empty topic OR-array, and "match everything" is a
   * plausible answer — that is the firehose the seed exists to prevent, arriving
   * because a DB read returned nothing.
   */
  test('an empty seed performs ZERO RPC calls and writes nothing', async () => {
    const { deps, state } = makeDeps(
      [transfer({ rawAmount: BigInt(1_000_000) })],
      { seed: new Set<string>() },
    );

    const result = await arcTransfersIndexer(deps);

    expect(result.fetched).toBe(0);
    expect(result.inserted).toBe(0);
    expect(state.getHeadCalls).toBe(0);
    expect(state.getLogsCalls).toBe(0);
    expect(state.cursors).toHaveLength(0);
  });

  test('self-transfers are skipped (a null counterparty degrades the independence read)', async () => {
    const { deps, state } = makeDeps(
      [transfer({ from: FROM, to: FROM, rawAmount: BigInt(1_000_000) })],
    );
    const result = await arcTransfersIndexer(deps);

    expect(result.fetched).toBe(0);
    expect(state.inserted).toHaveLength(0);
  });

  test('every persisted row carries a counterparty', async () => {
    const { deps, state } = makeDeps([
      transfer({ rawAmount: BigInt(1_000_000), txHash: '0xa' }),
      transfer({ from: STRANGER, to: TO, rawAmount: BigInt(2_000_000), txHash: '0xb' }),
    ]);
    await arcTransfersIndexer(deps);

    expect(state.inserted).toHaveLength(2);
    for (const row of state.inserted as Array<{ counterparty: string | null }>) {
      expect(row.counterparty).toBeTruthy();
    }
  });
});

describe('arcTransfersIndexer — block-timestamp prefetch', () => {
  // Timestamps were this indexer's dominant RPC cost while it scanned the whole
  // token contract: one getBlock per distinct block, up to 500 per window.
  // Fetching them lazily inside the per-transfer loop meant ~500 SEQUENTIAL
  // round trips (~13s/window), which held catch-up to ~18k blocks/day against a
  // chain producing ~166k. Seed scoping makes a window cheap, but the prefetch
  // stays correct and is what keeps a dense backfill window bounded.
  test('fetches each distinct block ONCE and overlaps the lookups', async () => {
    // 40 transfers spread over 8 distinct blocks, 5 transfers per block.
    const transfers = Array.from({ length: 40 }, (_, i) =>
      transfer({
        rawAmount: BigInt(1_000_000),
        block: BigInt(100 + (i % 8)),
        txHash: `0xtx${i}` as `0x${string}`,
      }),
    );

    const seen: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const { deps } = makeDeps(transfers, {
      getHead: async () => BigInt(107),
      blockTimestamp: async (b: bigint) => {
        seen.push(b.toString());
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return TS;
      },
    });

    await arcTransfersIndexer(deps);

    // Deduped: 8 distinct blocks, not 40 transfers — and not 80, though the
    // from- and to-side calls each returned all 40.
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    // Overlapped rather than awaited one at a time — the whole point.
    expect(peakInFlight).toBeGreaterThan(1);
  });
});

describe('arcTransfersIndexer', () => {
  test('emits a provider + consumer signal pair for a plain transfer', async () => {
    const { deps, state } = makeDeps([transfer({ rawAmount: BigInt(1_000_000) })]);
    const result = await arcTransfersIndexer(deps);

    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(2);
    expect(state.signals).toHaveLength(2);
    expect(state.ensured).toEqual(expect.arrayContaining([FROM, TO]));

    expect(state.inserted).toHaveLength(1);
    const row = state.inserted[0] as any;
    expect(row.wallet_address).toBe(FROM);
    expect(row.counterparty).toBe(TO);
    expect(row.facilitator).toBe(ARC_USDC_CONTRACT);
    expect(row.amount).toBe(1);

    const provider = state.signals.find((s: any) => s.face === 'provider') as any;
    const consumer = state.signals.find((s: any) => s.face === 'consumer') as any;
    expect(provider.agentWallet).toBe(TO);
    expect(provider.chain).toBe('arc');
    expect(provider.kind).toBe('usdc_transfer_settled');
    expect(provider.weight).toBe(0.6);
    expect(consumer.agentWallet).toBe(FROM);
    expect(consumer.chain).toBe('arc');
  });

  test('skips a transfer where the escrow contract is either side (arc-jobs already covers it)', async () => {
    // Distinct tx hashes: the run-level de-dup keys on txHash, and sharing one
    // between the excluded and the genuine transfer would test the wrong thing.
    const escrowFunding = transfer({ from: FROM, to: ARC_JOBS_CONTRACT as `0x${string}`, rawAmount: BigInt(1_000_000), txHash: '0xfund' });
    const escrowPayout = transfer({ from: ARC_JOBS_CONTRACT as `0x${string}`, to: TO, rawAmount: BigInt(1_000_000), block: BigInt(101), txHash: '0xpayout' });
    const genuine = transfer({ rawAmount: BigInt(2_000_000), block: BigInt(102), txHash: '0xgenuine' });

    const { deps, state } = makeDeps([escrowFunding, escrowPayout, genuine]);
    const result = await arcTransfersIndexer(deps);

    expect(result.fetched).toBe(1); // only the genuine transfer counts
    expect(state.signals).toHaveLength(2);
    expect((state.signals[0] as any).payload.amount).toBe(2);
  });

  test('skips mint and burn by a seeded agent', async () => {
    const mint = transfer({ from: ARC_ZERO_ADDRESS, to: TO, rawAmount: BigInt(1_000_000), txHash: '0xmint' });
    const burn = transfer({ from: FROM, to: ARC_ZERO_ADDRESS, rawAmount: BigInt(1_000_000), txHash: '0xburn' });
    const genuine = transfer({ rawAmount: BigInt(2_000_000), txHash: '0xgenuine' });

    const { deps, state } = makeDeps([mint, burn, genuine]);
    const result = await arcTransfersIndexer(deps);

    expect(result.fetched).toBe(1);
    expect(state.inserted).toHaveLength(1);
    expect((state.inserted[0] as any).tx_signature).toBe('0xgenuine');
  });

  test('no-op when cursor already at head', async () => {
    const { deps, state } = makeDeps([transfer({ rawAmount: BigInt(1_000_000) })], {
      getCursor: async () => ({ last_signature: '100', last_slot: 100 }),
      getHead: async () => BigInt(100),
    });
    const result = await arcTransfersIndexer(deps);
    expect(result.fetched).toBe(0);
    expect(state.signals).toHaveLength(0);
  });

  test('advances cursor to head even with zero transfers', async () => {
    const { deps, state } = makeDeps([]);
    const result = await arcTransfersIndexer(deps);
    expect(result.fetched).toBe(0);
    expect(state.cursors).toHaveLength(1);
    expect(state.cursors[0][1]).toBe('100');
  });

  /**
   * 2026-08-10: a getLogs rejection propagated out of the window loop, so
   * `advanceCursor` never ran and every window already read was discarded.
   * `maxBlock` is now assigned only after a successful read — and with two
   * calls per window, only after BOTH succeed. Failing on the second call must
   * not bank the window, or the next run skips blocks it never read.
   */
  test('a rate-limit on the to-side call does not advance the cursor past that window', async () => {
    let call = 0;
    const { deps, state } = makeDeps([transfer({ rawAmount: BigInt(1_000_000) })], {
      getHead: async () => BigInt(100),
      getCursor: async () => ({ last_signature: '0', last_slot: 0 }),
      windowSize: 50,
      getLogs: async (_from: bigint, _to: bigint, face: TransferFace) => {
        call++;
        // window 1: from-side ok, to-side throttled.
        if (call === 2) throw Object.assign(new Error('Request exceeds defined limit'), { code: -32005 });
        return face === 'from' ? [transfer({ rawAmount: BigInt(1_000_000) })] : [];
      },
    });

    const result = await arcTransfersIndexer(deps);

    // Nothing banked for the window whose second call failed: the cursor must
    // stay behind block 1, not jump to 50.
    expect(result.fetched).toBe(0);
    expect(state.cursors).toHaveLength(1);
    expect(Number(state.cursors[0][1])).toBeLessThan(1);
  });
});

describe('arcTransfersCursorKey', () => {
  test('is namespaced by the USDC contract, distinct from arc-jobs', () => {
    const key = arcTransfersCursorKey(ARC_USDC_CONTRACT);
    expect(key).toBe(`arc-transfers:${ARC_USDC_CONTRACT}`);
    expect(key).not.toContain(ARC_JOBS_CONTRACT);
  });
});
