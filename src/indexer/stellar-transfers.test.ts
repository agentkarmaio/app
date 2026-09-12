/// <reference types="bun-types" />
/**
 * Stellar plain USDC SAC transfer indexer tests.
 *
 * Mock strategy: DEPENDENCY INJECTION, mirroring arc-transfers.test.ts and
 * celo-x402.test.ts — no live Horizon, no live RPC.
 *
 * The novel cases here (no sibling indexer has them):
 *   - SEED-SET SCOPING. A transfer between two addresses AK has never heard of
 *     must produce zero rows. This is the whole reason the path is affordable;
 *     arc-transfers.ts is paused for lack of exactly this.
 *   - ISSUER-PINNED ASSET IDENTITY. The test that matters is same code
 *     ("USDC"), different issuer — a bare asset_code match is spoofable.
 *   - `invoke_host_function` records, where the transfer lives in
 *     `asset_balance_changes` and the record itself has no from/to.
 *
 * Fixtures 1 and 2 are REAL public mainnet records captured 2026-09-10.
 *
 * Run: bun test src/indexer/stellar-transfers.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { Asset, Networks } from '@stellar/stellar-sdk';
import {
  buildStellarSeedSet,
  extractUsdcTransfers,
  isIntentional,
  toTransactionRow,
  stellarTransfersIndexer,
  stellarTransfersCursorKey,
  walkTargets,
  type HorizonPaymentRecord,
  type StellarTransfersDeps,
} from './stellar-transfers';
import { USDC_ISSUER, USDC_SAC, STELLAR_SEED_EXCLUSIONS } from '../config/stellar-x402';

// ─── Real mainnet addresses (public data) ────────────────────────────────────
const AGENT_A = 'GC2NIKT6TWLMBZE4TU5ZMMDVV22URFIMJIZ4JYUC3QABBBWNGGZMAFGM';
const AGENT_B = 'GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V';
const AGENT_C = 'GBF4LIK2YZQPD72REKLTTAPR67XCMV5VA4JVST2ZB3JFXIHXJFDJ6B6F';
/** Two addresses AK has never heard of. */
const STRANGER_1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
const STRANGER_2 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC';
/** A token coded USDC issued by someone who is not Circle. */
const FAKE_ISSUER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD';

const USDC = { code: 'USDC', issuer: USDC_ISSUER.pubnet };
const SAC = USDC_SAC.pubnet;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** REAL mainnet classic payment (tx 037e838d…, 2026-08-17). */
const CLASSIC_PAYMENT: HorizonPaymentRecord = {
  id: '274824030874775553',
  paging_token: '274824030874775553',
  transaction_successful: true,
  source_account: AGENT_A,
  type: 'payment',
  created_at: '2026-08-17T00:10:59Z',
  transaction_hash: '037e838d03d5e14ad397f7e481b4ddedbe06b7cd42d8872c90a7a094785de1ad',
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: USDC_ISSUER.pubnet,
  from: AGENT_A,
  to: AGENT_B,
  amount: '0.5000000',
};

/** REAL mainnet Soroban SAC transfer (tx c1bb4764…, 2026-08-17). */
const SOROBAN_INVOKE: HorizonPaymentRecord = {
  id: '274835567157374977',
  paging_token: '274835567157374977',
  transaction_successful: true,
  source_account: AGENT_B,
  type: 'invoke_host_function',
  created_at: '2026-08-17T04:21:15Z',
  transaction_hash: 'c1bb4764c1e3e29d1c25ca1b7d1c4ea7788cce36b37f27ed8cf62aacdda62fd4',
  asset_balance_changes: [
    {
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: USDC_ISSUER.pubnet,
      type: 'transfer',
      from: AGENT_B,
      to: AGENT_C,
      amount: '0.0100000',
    },
  ],
};

function classic(over: Partial<HorizonPaymentRecord> = {}): HorizonPaymentRecord {
  return { ...CLASSIC_PAYMENT, ...over };
}

const SEED = new Set([AGENT_A, AGENT_B, AGENT_C]);

function makeDeps(
  pages: Record<string, HorizonPaymentRecord[]>,
  overrides: Partial<StellarTransfersDeps> = {},
) {
  const inserted: Array<Record<string, unknown>> = [];
  const signals: Array<Record<string, unknown>> = [];
  const ensured: string[] = [];
  const cursors: Array<[string, string, number | undefined]> = [];
  let fetchCalls = 0;

  const deps: StellarTransfersDeps = {
    seed: SEED,
    walkTargets: [...SEED],
    asset: USDC,
    sac: SAC,
    fetchPayments: async (address: string) => {
      fetchCalls++;
      return { records: pages[address] ?? [] };
    },
    insertTransactions: async (rows) => { inserted.push(...(rows as Array<Record<string, unknown>>)); return rows.length; },
    insertSignalEvents: async (s) => { signals.push(...(s as unknown as Array<Record<string, unknown>>)); return s.length; },
    ensureWallets: async (addresses: string[]) => { ensured.push(...addresses); },
    getCursor: async () => null,
    upsertCursor: async (key, last, slot) => { cursors.push([key, last, slot]); },
    ...overrides,
  };

  return { deps, state: { inserted, signals, ensured, cursors, get fetchCalls() { return fetchCalls; } } };
}

// ─── Asset identity ───────────────────────────────────────────────────────────

describe('asset identity is pinned CODE:ISSUER', () => {
  // Binds the Horizon-side pin (issuer) to the SAC-side pin (contract id) so a
  // wrong issuer fails here rather than silently matching nothing in prod.
  test('USDC_ISSUER.pubnet derives USDC_SAC.pubnet', () => {
    expect(new Asset('USDC', USDC_ISSUER.pubnet).contractId(Networks.PUBLIC)).toBe(USDC_SAC.pubnet);
  });

  test('USDC_ISSUER.testnet derives USDC_SAC.testnet', () => {
    expect(new Asset('USDC', USDC_ISSUER.testnet).contractId(Networks.TESTNET)).toBe(USDC_SAC.testnet);
  });

  // THE case that matters: anyone can issue a token coded "USDC".
  test('same code, different issuer is rejected', () => {
    const spoof = classic({ asset_issuer: FAKE_ISSUER });
    expect(extractUsdcTransfers(spoof, USDC)).toEqual([]);
  });

  test('a non-USDC asset is rejected', () => {
    const other = classic({ asset_code: 'EURC' });
    expect(extractUsdcTransfers(other, USDC)).toEqual([]);
  });
});

// ─── Record parsing ───────────────────────────────────────────────────────────

describe('extractUsdcTransfers', () => {
  test('classic payment → payer/payee', () => {
    const [t] = extractUsdcTransfers(CLASSIC_PAYMENT, USDC);
    expect(t.from).toBe(AGENT_A);
    expect(t.to).toBe(AGENT_B);
    expect(t.amount).toBe(0.5);
    expect(t.txHash).toBe(CLASSIC_PAYMENT.transaction_hash);
    expect(t.pagingToken).toBe('274824030874775553');
  });

  // Filtering on type === 'payment' drops every Soroban settlement — which is
  // what Stellar agents actually produce. This is the backfillFromHorizon bug.
  test('invoke_host_function → transfer read from asset_balance_changes', () => {
    const [t] = extractUsdcTransfers(SOROBAN_INVOKE, USDC);
    expect(t.from).toBe(AGENT_B);
    expect(t.to).toBe(AGENT_C);
    expect(t.amount).toBeCloseTo(0.01, 9);
    expect(t.txHash).toBe(SOROBAN_INVOKE.transaction_hash);
  });

  test('path_payment matched on the destination asset', () => {
    const pp = classic({
      type: 'path_payment_strict_send',
      source_asset_code: 'XLM',
      source_asset_issuer: undefined,
      amount: '2.5000000',
    });
    const [t] = extractUsdcTransfers(pp, USDC);
    expect(t.from).toBe(AGENT_A);
    expect(t.to).toBe(AGENT_B);
    expect(t.amount).toBe(2.5);
  });

  test('a non-transfer balance change is ignored', () => {
    const minted = {
      ...SOROBAN_INVOKE,
      asset_balance_changes: [{ ...SOROBAN_INVOKE.asset_balance_changes![0], type: 'mint' }],
    };
    expect(extractUsdcTransfers(minted, USDC)).toEqual([]);
  });

  test('an operation with no value movement yields nothing', () => {
    const noop: HorizonPaymentRecord = {
      id: '1', paging_token: '1', transaction_successful: true, source_account: AGENT_A,
      type: 'create_account', created_at: '2026-08-17T00:00:00Z', transaction_hash: '0xdead',
    };
    expect(extractUsdcTransfers(noop, USDC)).toEqual([]);
  });
});

// ─── Row mapping / the counterparty invariant ─────────────────────────────────

describe('toTransactionRow', () => {
  test('wallet_address = payer, counterparty = payee, chain explicit', () => {
    const [t] = extractUsdcTransfers(CLASSIC_PAYMENT, USDC);
    const row = toTransactionRow(t, SAC);
    expect(row.chain).toBe('stellar');
    expect(row.wallet_address).toBe(AGENT_A);
    expect(row.counterparty).toBe(AGENT_B);
    expect(row.facilitator).toBe(SAC);
    expect(row.amount).toBe(0.5);
    expect(row.timestamp).toBe('2026-08-17T00:10:59Z');
    expect(row.success).toBe(true);
    expect(row.tx_signature).toBe(CLASSIC_PAYMENT.transaction_hash);
  });

  // src/scoring/reciprocity.ts reads inbound via `WHERE counterparty = W`.
  // A null counterparty is invisible there and makes a wallet look MORE
  // independent than it is.
  test('every row written by a run carries a non-null counterparty', async () => {
    const { deps, state } = makeDeps({ [AGENT_A]: [CLASSIC_PAYMENT], [AGENT_B]: [SOROBAN_INVOKE] });
    await stellarTransfersIndexer(deps);
    expect(state.inserted.length).toBeGreaterThan(0);
    for (const row of state.inserted) {
      expect(row.counterparty).toBeTruthy();
      expect(row.counterparty).not.toBe(row.wallet_address);
      expect(row.chain).toBe('stellar');
    }
  });
});

// ─── Seed-set scoping ─────────────────────────────────────────────────────────

describe('seed-set filtering', () => {
  test('a transfer between two unknown addresses is skipped', async () => {
    const stranger = classic({ from: STRANGER_1, to: STRANGER_2, transaction_hash: '0xstranger' });
    const { deps, state } = makeDeps({ [AGENT_A]: [stranger] });

    const res = await stellarTransfersIndexer(deps);

    expect(res.fetched).toBe(0);
    expect(state.inserted).toEqual([]);
    expect(state.signals).toEqual([]);
  });

  test('a transfer with one seeded side is kept', async () => {
    const inbound = classic({ from: STRANGER_1, to: AGENT_A, transaction_hash: '0xinbound' });
    const { deps, state } = makeDeps({ [AGENT_A]: [inbound] });

    const res = await stellarTransfersIndexer(deps);

    expect(res.fetched).toBe(1);
    expect(state.inserted[0].wallet_address).toBe(STRANGER_1);
    expect(state.inserted[0].counterparty).toBe(AGENT_A);
  });

  // A Soroban invoke can carry legs between two third parties; only the legs
  // touching a seeded address belong to AK.
  test('third-party legs inside a seeded account’s invoke are dropped', async () => {
    const multi: HorizonPaymentRecord = {
      ...SOROBAN_INVOKE,
      transaction_hash: '0xmulti',
      asset_balance_changes: [
        { ...SOROBAN_INVOKE.asset_balance_changes![0], from: STRANGER_1, to: STRANGER_2 },
      ],
    };
    const { deps, state } = makeDeps({ [AGENT_B]: [multi] });

    const res = await stellarTransfersIndexer(deps);

    expect(res.fetched).toBe(0);
    expect(state.inserted).toEqual([]);
  });

  test('self-transfers are skipped (they would write a null counterparty)', async () => {
    const self = classic({ from: AGENT_A, to: AGENT_A, transaction_hash: '0xself' });
    const { deps, state } = makeDeps({ [AGENT_A]: [self] });

    const res = await stellarTransfersIndexer(deps);

    expect(res.fetched).toBe(0);
    expect(state.inserted).toEqual([]);
  });
});

// ─── Seed-set construction ────────────────────────────────────────────────────

describe('buildStellarSeedSet', () => {
  test('takes BOTH owner and agent_wallet from the registry mirror', () => {
    const seed = buildStellarSeedSet({
      registryRows: [{ owner: AGENT_A, agent_wallet: AGENT_B }],
    });
    expect(seed.has(AGENT_A)).toBe(true);
    expect(seed.has(AGENT_B)).toBe(true);
  });

  test('unions claimed wallets and the documented extension point', () => {
    const seed = buildStellarSeedSet({
      registryRows: [{ owner: AGENT_A, agent_wallet: null }],
      walletRows: [{ address: AGENT_B, claimed: true }],
      extra: [AGENT_C],
    });
    expect([...seed].sort()).toEqual([AGENT_A, AGENT_B, AGENT_C].sort());
  });

  // `wallets` is open-membership — a row can be minted by anything that
  // resolves an address. Circle's USDC issuer is in there today with 145 USDC
  // ops in its first 200; left in, it turns this path into the firehose the
  // seed set exists to prevent.
  test('excludes the USDC issuer and the SAC contract', () => {
    const seed = buildStellarSeedSet({
      walletRows: [
        { address: USDC_ISSUER.pubnet, claimed: true },
        { address: USDC_SAC.pubnet, claimed: true },
        { address: AGENT_A, claimed: true },
      ],
    });
    expect(seed.has(USDC_ISSUER.pubnet)).toBe(false);
    expect(seed.has(USDC_SAC.pubnet)).toBe(false);
    expect(seed.has(AGENT_A)).toBe(true);
  });

  test('STELLAR_SEED_EXCLUSIONS names the issuer and the SAC', () => {
    expect(STELLAR_SEED_EXCLUSIONS.has(USDC_ISSUER.pubnet)).toBe(true);
    expect(STELLAR_SEED_EXCLUSIONS.has(USDC_SAC.pubnet)).toBe(true);
  });

  // Six malformed demo-fixture rows live in `wallets` today.
  test('drops addresses that are not valid StrKey', () => {
    const seed = buildStellarSeedSet({
      walletRows: [
        { address: 'GDEMOBONDTHINAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2222', claimed: true },
        { address: AGENT_A, claimed: true },
      ],
    });
    expect(seed.size).toBe(1);
    expect(seed.has(AGENT_A)).toBe(true);
  });

  // Stellar StrKey is case-SENSITIVE. Lowercasing is EVM-only.
  test('preserves StrKey casing byte-for-byte', () => {
    const seed = buildStellarSeedSet({ walletRows: [{ address: AGENT_A, claimed: true }] });
    expect([...seed][0]).toBe(AGENT_A);
  });

  // Horizon has no /accounts/{C…} endpoint, so contracts can be seed members
  // (matchable as a counterparty) but never walk targets.
  test('contract addresses are seed members but not walk targets', () => {
    const CONTRACT = 'CAMF3BS23WXYMA6W6E55VSX577GIPSRKJXJKLL2G46TABUQ4GIRGHIL3';
    const seed = buildStellarSeedSet({ extra: [CONTRACT, AGENT_A] });
    expect(seed.has(CONTRACT)).toBe(true);
    expect(walkTargets(seed)).toEqual([AGENT_A]);
  });
});

// ─── The feedback loop this indexer would otherwise create ────────────────────
//
// walkAddress ensureWallets() BOTH faces of every kept transfer, so a
// counterparty gets a `wallets` row whether or not it was seeded. If the seed
// set then read every `wallets` row, run N's counterparties would become run
// N+1's walk targets — transitive closure over the USDC payment graph, one hop
// per run, reaching exchange hot wallets within a few 6-hourly ticks.
describe('seed set does not feed back into itself', () => {
  test('a wallet row with no claim or identity marker is NOT seeded', () => {
    const seed = buildStellarSeedSet({
      // Exactly the shape ensureWallets() mints: identity columns only, so
      // `claimed` is the column default (false) and stellar_agent_id is NULL.
      walletRows: [{ address: STRANGER_1, claimed: false, stellar_agent_id: null }],
    });
    expect(seed.has(STRANGER_1)).toBe(false);
    expect(seed.size).toBe(0);
  });

  test('a row this indexer minted is still not seeded after it gets a score', () => {
    // `score > 0` is deliberately not a marker: our own rows dirty the wallet
    // for rescoring, so scoring alone must not readmit it.
    const seed = buildStellarSeedSet({
      walletRows: [{ address: STRANGER_1, claimed: false, stellar_agent_id: null }],
    });
    expect(seed.has(STRANGER_1)).toBe(false);
  });

  test('claimed or stellar_agent_id marks an intentional relationship', () => {
    expect(isIntentional({ address: AGENT_A, claimed: true })).toBe(true);
    expect(isIntentional({ address: AGENT_A, stellar_agent_id: 66 })).toBe(true);
    expect(isIntentional({ address: AGENT_A, claimed: false, stellar_agent_id: null })).toBe(false);
    expect(isIntentional({ address: AGENT_A })).toBe(false);
  });

  // Registry membership is an intentional relationship on its own — the
  // mirror only holds agents that registered on-chain.
  test('registry rows are seeded without needing a wallet marker', () => {
    const seed = buildStellarSeedSet({ registryRows: [{ owner: AGENT_A, agent_wallet: AGENT_B }] });
    expect(seed.has(AGENT_A)).toBe(true);
    expect(seed.has(AGENT_B)).toBe(true);
  });

  test('one run’s counterparty does not become the next run’s walk target', () => {
    // Simulate run 1: STRANGER_1 paid AGENT_A, so ensureWallets minted it.
    const mintedByRun1 = { address: STRANGER_1, claimed: false, stellar_agent_id: null };
    // Run 2 rebuilds the seed set from the DB, now including that row.
    const seed = buildStellarSeedSet({
      registryRows: [{ owner: AGENT_A, agent_wallet: null }],
      walletRows: [{ address: AGENT_A, stellar_agent_id: 66 }, mintedByRun1],
    });
    expect(walkTargets(seed)).toEqual([AGENT_A]);
  });
});

// ─── Cursor discipline ────────────────────────────────────────────────────────

describe('cursor discipline', () => {
  test('advances to the last processed paging_token, last_slot stays null', async () => {
    const second = classic({ paging_token: '999', transaction_hash: '0xsecond' });
    const { deps, state } = makeDeps({ [AGENT_A]: [CLASSIC_PAYMENT, second] });

    await stellarTransfersIndexer(deps);

    const entry = state.cursors.find(([k]) => k === stellarTransfersCursorKey(AGENT_A));
    expect(entry).toBeDefined();
    expect(entry![1]).toBe('999');
    // paging_token ~2.7e17 exceeds INTEGER and Number.MAX_SAFE_INTEGER.
    expect(entry![2]).toBeUndefined();
  });

  test('a deliberately skipped record still advances the cursor', async () => {
    const stranger = classic({ from: STRANGER_1, to: STRANGER_2, paging_token: '555', transaction_hash: '0xs' });
    const { deps, state } = makeDeps({ [AGENT_A]: [stranger] });

    await stellarTransfersIndexer(deps);

    const entry = state.cursors.find(([k]) => k === stellarTransfersCursorKey(AGENT_A));
    expect(entry![1]).toBe('555');
  });

  test('a page fetch failure does NOT advance that address’s cursor', async () => {
    const { deps, state } = makeDeps({}, {
      walkTargets: [AGENT_A],
      fetchPayments: async () => { throw new Error('horizon 503'); },
    });

    const res = await stellarTransfersIndexer(deps);

    expect(state.cursors).toEqual([]);
    expect(res.failed).toContain(AGENT_A);
  });

  test('a write failure does NOT advance the cursor', async () => {
    const { deps, state } = makeDeps({ [AGENT_A]: [CLASSIC_PAYMENT] }, {
      walkTargets: [AGENT_A],
      insertTransactions: async () => { throw new Error('57014 statement timeout'); },
    });

    await stellarTransfersIndexer(deps);

    expect(state.cursors).toEqual([]);
  });

  test('resumes from a persisted cursor', async () => {
    const seen: Array<string | null> = [];
    const { deps } = makeDeps({}, {
      walkTargets: [AGENT_A],
      getCursor: async () => ({ last_signature: '274824030874775553', last_slot: null }),
      fetchPayments: async (_a, cursor) => { seen.push(cursor); return { records: [] }; },
    });

    await stellarTransfersIndexer(deps);

    expect(seen[0]).toBe('274824030874775553');
  });
});

// ─── Resilience + idempotency ─────────────────────────────────────────────────

describe('resilience', () => {
  // Registry agents can reference accounts never funded on mainnet. One such
  // address is in the seed set today. A permanent 404 paging every 6h forever
  // was the 2026-08-26 incident.
  test('a 404 seed address is non-fatal and reported absent', async () => {
    const { deps, state } = makeDeps({}, {
      walkTargets: [AGENT_A, AGENT_B],
      fetchPayments: async (address) => {
        if (address === AGENT_A) {
          throw Object.assign(new Error('Horizon 404 Not Found'), { status: 404 });
        }
        return { records: [CLASSIC_PAYMENT] };
      },
    });

    const res = await stellarTransfersIndexer(deps);

    expect(res.absent).toEqual([AGENT_A]);
    expect(res.failed).toEqual([]);
    expect(state.inserted.length).toBe(1); // the healthy address still ingested
  });

  test('re-running over the same records produces identical rows', async () => {
    const pages = { [AGENT_A]: [CLASSIC_PAYMENT], [AGENT_B]: [SOROBAN_INVOKE] };
    const first = makeDeps(pages);
    const second = makeDeps(pages);

    await stellarTransfersIndexer(first.deps);
    await stellarTransfersIndexer(second.deps);

    expect(second.state.inserted).toEqual(first.state.inserted);
  });

  // tx_signature is UNIQUE, so a tx with two matching legs can only persist
  // one row. Emitting two would overstate `fetched` against what lands.
  test('one row per transaction hash even with multiple matching legs', async () => {
    const twoLegs: HorizonPaymentRecord = {
      ...SOROBAN_INVOKE,
      transaction_hash: '0xtwolegs',
      asset_balance_changes: [
        { ...SOROBAN_INVOKE.asset_balance_changes![0], from: AGENT_B, to: AGENT_C },
        { ...SOROBAN_INVOKE.asset_balance_changes![0], from: AGENT_C, to: AGENT_A },
      ],
    };
    const { deps, state } = makeDeps({ [AGENT_B]: [twoLegs] });

    const res = await stellarTransfersIndexer(deps);

    expect(res.fetched).toBe(1);
    expect(state.inserted.length).toBe(1);
  });

  test('the same transfer seen from both feeds yields one identical row', async () => {
    const { deps, state } = makeDeps({ [AGENT_A]: [CLASSIC_PAYMENT], [AGENT_B]: [CLASSIC_PAYMENT] });

    await stellarTransfersIndexer(deps);

    const rows = state.inserted.filter((r) => r.tx_signature === CLASSIC_PAYMENT.transaction_hash);
    expect(rows.length).toBe(1);
  });

  test('wallet rows are ensured for both faces before inserting', async () => {
    const { deps, state } = makeDeps({ [AGENT_A]: [CLASSIC_PAYMENT] }, { walkTargets: [AGENT_A] });

    await stellarTransfersIndexer(deps);

    expect(state.ensured).toContain(AGENT_A);
    expect(state.ensured).toContain(AGENT_B);
  });

  test('bounded: stops after maxPagesPerAddress', async () => {
    let calls = 0;
    const { deps } = makeDeps({}, {
      walkTargets: [AGENT_A],
      maxPagesPerAddress: 2,
      // A full page keeps the walk going; the bound is what must stop it.
      fetchPayments: async () => {
        calls++;
        return { records: [classic({ paging_token: String(calls), transaction_hash: `0x${calls}` })] };
      },
      pageLimit: 1,
    });

    await stellarTransfersIndexer(deps);

    expect(calls).toBe(2);
  });

  test('signals carry chain stellar on both faces', async () => {
    const { deps, state } = makeDeps({ [AGENT_A]: [CLASSIC_PAYMENT] }, { walkTargets: [AGENT_A] });

    await stellarTransfersIndexer(deps);

    expect(state.signals.length).toBe(2);
    for (const s of state.signals) expect(s.chain).toBe('stellar');
    expect(state.signals.map((s) => s.face).sort()).toEqual(['consumer', 'provider']);
  });
});

// Regression: expiry before an account's first request was counted as walked.
describe('coverage describes the accounts actually checked', () => {
  test('a spent budget leaves unvisited accounts pending, never walked', async () => {
    let elapsed = 0;
    const { deps, state } = makeDeps({}, {
      concurrency: 1,
      timeBudgetMs: 10,
      now: () => elapsed,
      fetchPayments: async () => { elapsed = 10; return { records: [] }; },
    });
    const result = await stellarTransfersIndexer(deps);
    expect(result.walked).toBe(1);
    expect(result.coverage).toMatchObject({ complete: false, checked: 1, pending: 2, unresolved: 0 });
    expect(state.cursors).toEqual([]);
  });

  test('a full final page is incomplete until a later run exhausts the feed', async () => {
    const { deps } = makeDeps({ [AGENT_A]: [CLASSIC_PAYMENT] }, {
      walkTargets: [AGENT_A], pageLimit: 1, maxPagesPerAddress: 1,
    });
    const result = await stellarTransfersIndexer(deps);
    expect(result.coverage).toMatchObject({ complete: false, checked: 1, pending: 1, unresolved: 0 });
    expect(result.cursors.get(stellarTransfersCursorKey(AGENT_A))).toBe(CLASSIC_PAYMENT.paging_token);
  });

  test('empty feeds are checked and complete without inventing a cursor', async () => {
    const { deps, state } = makeDeps({});
    const result = await stellarTransfersIndexer(deps);
    expect(result.coverage).toMatchObject({ complete: true, checked: 3, pending: 0, unresolved: 0 });
    expect(state.cursors).toEqual([]);
  });

  test('failed cursor persistence is local to an address; remaining targets run', async () => {
    const { deps } = makeDeps({ [AGENT_A]: [CLASSIC_PAYMENT] }, {
      upsertCursor: async () => { throw new Error('cursor unavailable'); },
    });
    const result = await stellarTransfersIndexer(deps);
    expect(result.failed).toEqual([AGENT_A]);
    expect(result.coverage).toMatchObject({ complete: false, checked: 3, pending: 0, unresolved: 1 });
  });
});

describe('fair persistent account rotation', () => {
  test('a slow early account does not starve later targets on subsequent runs', async () => {
    let elapsed = 0;
    let checkpoint: string | null = null;
    const visited: string[] = [];
    const { deps } = makeDeps({}, {
      walkTargets: [AGENT_A, AGENT_B], concurrency: 1, timeBudgetMs: 10, now: () => elapsed,
      readTargetCheckpoint: async () => checkpoint,
      writeTargetCheckpoint: async (address) => { checkpoint = address; },
      fetchPayments: async (address) => { visited.push(address); elapsed = 10; return { records: [] }; },
    });
    const first = await stellarTransfersIndexer(deps);
    expect(first.coverage.pending).toBe(1);
    elapsed = 0;
    await stellarTransfersIndexer(deps);
    expect(visited).toEqual([AGENT_A, AGENT_B]);
    expect(await deps.readTargetCheckpoint!()).toBe(AGENT_B);
  });
  test('rotation is keyed by address so removing the previous target cannot shift the next one', async () => {
    let elapsed = 0;
    const visited: string[] = [];
    const { deps } = makeDeps({}, {
      // AGENT_C sorts before A; B after A. A was removed since the last run.
      walkTargets: [AGENT_C, AGENT_B], concurrency: 1, timeBudgetMs: 10, now: () => elapsed,
      readTargetCheckpoint: async () => AGENT_A, writeTargetCheckpoint: async () => {},
      fetchPayments: async (address) => { visited.push(address); elapsed = 10; return { records: [] }; },
    });
    await stellarTransfersIndexer(deps);
    expect(visited).toEqual([AGENT_B]);
  });
  test('new targets before the checkpoint are included after wrapping', async () => {
    const visited: string[] = [];
    const { deps } = makeDeps({}, {
      walkTargets: [AGENT_C, AGENT_A, AGENT_B], concurrency: 1,
      readTargetCheckpoint: async () => AGENT_A, writeTargetCheckpoint: async () => {},
      fetchPayments: async (address) => { visited.push(address); return { records: [] }; },
    });
    await stellarTransfersIndexer(deps);
    expect(visited).toEqual([AGENT_B, AGENT_C, AGENT_A]);
  });
  test('a failed attempted account rotates fairly while its history stays unadvanced', async () => {
    const checkpoints: string[] = [];
    const { deps } = makeDeps({ [AGENT_A]: [CLASSIC_PAYMENT] }, {
      walkTargets: [AGENT_A],
      readTargetCheckpoint: async () => null,
      writeTargetCheckpoint: async (address) => { checkpoints.push(address); },
      insertTransactions: async () => { throw new Error('write unavailable'); },
    });
    const result = await stellarTransfersIndexer(deps);
    expect(result.failed).toEqual([AGENT_A]);
    expect(checkpoints).toEqual([AGENT_A]);
    expect(result.cursors.size).toBe(0);
    expect(result.coverage.unresolved).toBe(1);
  });
});


test('a consistently failing first account cannot starve healthy later accounts', async () => {
  let elapsed = 0;
  let checkpoint: string | null = null;
  const visited: string[] = [];
  const { deps, state } = makeDeps({}, {
    walkTargets: [AGENT_A, AGENT_B], concurrency: 1, timeBudgetMs: 10, now: () => elapsed,
    readTargetCheckpoint: async () => checkpoint,
    writeTargetCheckpoint: async (address) => { checkpoint = address; },
    fetchPayments: async (address) => {
      visited.push(address); elapsed = 10;
      if (address === AGENT_A) throw new Error('Horizon unavailable for A');
      return { records: [] };
    },
  });
  const first = await stellarTransfersIndexer(deps);
  expect(first.failed).toEqual([AGENT_A]);
  expect(first.coverage).toMatchObject({ complete: false, unresolved: 1, pending: 1 });
  expect(state.cursors).toEqual([]);
  elapsed = 0;
  await stellarTransfersIndexer(deps);
  expect(visited).toEqual([AGENT_A, AGENT_B]);
  expect(await deps.readTargetCheckpoint!()).toBe(AGENT_B);
});

describe('Stellar transfer cancellation', () => {
  test('late Horizon page after abort starts no further account calls or writes', async () => {
    const controller = new AbortController(); let calls = 0;
    const { deps, state } = makeDeps({}, {
      signal: controller.signal, concurrency: 1,
      fetchPayments: async () => { calls++; controller.abort(Error('scan_cancelled')); return { records: [CLASSIC_PAYMENT] }; },
    });
    await expect(stellarTransfersIndexer(deps)).rejects.toThrow('scan_cancelled');
    expect(calls).toBe(1); expect(state.inserted).toEqual([]); expect(state.cursors).toEqual([]);
  });
  test('abort plus 404 is cancellation, never an absent account or successful rotation', async () => {
    const controller = new AbortController(); const rotations: string[] = [];
    const { deps } = makeDeps({}, {
      signal: controller.signal, concurrency: 1,
      writeTargetCheckpoint: async (address) => { rotations.push(address); },
      fetchPayments: async () => { controller.abort(Error('scan_cancelled')); throw Object.assign(Error('404'), { status: 404 }); },
    });
    await expect(stellarTransfersIndexer(deps)).rejects.toThrow('scan_cancelled');
    expect(rotations).toEqual([]);
  });
});
