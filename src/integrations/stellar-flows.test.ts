/// <reference types="bun-types" />
/**
 * Stellar payment flows read from Horizon at request time.
 *
 * These feed `computeReciprocity`, so the failure that matters is a flow
 * attributed to the wrong side or counted from the wrong asset — either one
 * silently changes an independence verdict a lender may act on. Injected
 * transport throughout: no test here touches the network.
 *
 */

import { describe, expect, test } from 'bun:test';
import { Asset, Networks } from '@stellar/stellar-sdk';
import {
  foldHorizonPayments,
  fetchStellarFlows,
  USDC_ISSUER,
  STELLAR_FLOW_PAGE_LIMIT,
  type HorizonJsonFetch,
} from './stellar-flows';
import { USDC_SAC } from '@/config/stellar-x402';
import { computeReciprocity } from '@/scoring/reciprocity';

const ME = 'GDJDMZDLOUQL3ZGOXOIGBQIX7SYQDIXDJ5DC3IQN4JYZ4EJY4WXMDJDC';
const PAYER = 'GCYTUI46TG2CGOGRC73VBD56KIIQHE46EKZ57SUQGZXHRE6MEXWXMMUI';
const OTHER = 'GBFS72AZXSXBZEW3DAQA4OROM6U7TZBL2CZFT3FP3QMXS3MB7YPEVQ6N';
const T_ISSUER = USDC_ISSUER.testnet;

/** A Soroban SAC transfer as Horizon renders it on /payments. */
const sorobanTransfer = (from: string, to: string, amount: string, issuer = T_ISSUER) => ({
  type: 'invoke_host_function',
  created_at: '2026-09-01T00:00:00Z',
  asset_balance_changes: [{ type: 'transfer', from, to, amount, asset_code: 'USDC', asset_issuer: issuer }],
});

/** A classic payment operation. */
const classicPayment = (from: string, to: string, amount: string, issuer = T_ISSUER) => ({
  type: 'payment',
  created_at: '2026-09-01T00:00:00Z',
  from,
  to,
  amount,
  asset_code: 'USDC',
  asset_issuer: issuer,
});

describe('USDC_ISSUER pins to the already-pinned SAC', () => {
  // The issuers are duplicated out of src/config/stellar-x402.ts on purpose
  // (see spec). This is what stops the copy drifting: a wrong issuer no longer
  // silently yields an empty flow set, it fails here.
  test.each([
    ['pubnet', Networks.PUBLIC] as const,
    ['testnet', Networks.TESTNET] as const,
  ])('%s issuer derives the pinned USDC SAC', (network, passphrase) => {
    const derived = new Asset('USDC', USDC_ISSUER[network]).contractId(passphrase);
    expect(derived).toBe(USDC_SAC[network]);
  });
});

describe('foldHorizonPayments — attribution', () => {
  test('a Soroban transfer INTO the account is inbound, credited to its payer', () => {
    const f = foldHorizonPayments([sorobanTransfer(PAYER, ME, '10.5')], ME, 'testnet');
    expect(f.inbound).toEqual([{ payer: PAYER, total: 10.5, count: 1 }]);
    expect(f.outbound).toEqual([]);
  });

  test('a Soroban transfer OUT of the account is outbound, keyed to its payee', () => {
    const f = foldHorizonPayments([sorobanTransfer(ME, PAYER, '3.25')], ME, 'testnet');
    expect(f.outbound).toEqual([{ counterparty: PAYER, amount: 3.25 }]);
    expect(f.inbound).toEqual([]);
  });

  test('classic payments fold identically to Soroban transfers', () => {
    const soroban = foldHorizonPayments([sorobanTransfer(PAYER, ME, '7')], ME, 'testnet');
    const classic = foldHorizonPayments([classicPayment(PAYER, ME, '7')], ME, 'testnet');
    expect(classic).toEqual(soroban);
  });

  test('repeat payers are aggregated, not listed twice', () => {
    const f = foldHorizonPayments(
      [sorobanTransfer(PAYER, ME, '1'), sorobanTransfer(PAYER, ME, '2'), sorobanTransfer(OTHER, ME, '4')],
      ME,
      'testnet',
    );
    expect(f.inbound).toHaveLength(2);
    expect(f.inbound.find((r) => r.payer === PAYER)).toEqual({ payer: PAYER, total: 3, count: 2 });
    expect(f.inbound.find((r) => r.payer === OTHER)).toEqual({ payer: OTHER, total: 4, count: 1 });
  });

  test('a transfer between two other parties is ignored entirely', () => {
    const f = foldHorizonPayments([sorobanTransfer(PAYER, OTHER, '99')], ME, 'testnet');
    expect(f.inbound).toEqual([]);
    expect(f.outbound).toEqual([]);
  });
});

describe('foldHorizonPayments — a self-swap is not revenue', () => {
  // A strict-send path payment to oneself is how you trade on the Stellar DEX.
  // Folded naively it lands in `inbound` keyed to the account itself, and the
  // account reads as having a paying customer. Three of these on a real mainnet
  // agent (GC2NIKT6…) moved its verdict from insufficient-data to independent.
  const selfSwap = (account: string, amount: string) => ({
    type: 'path_payment_strict_send',
    created_at: '2026-09-01T00:00:00Z',
    from: account,
    to: account,
    amount,
    asset_code: 'USDC',
    asset_issuer: T_ISSUER,
    source_asset_code: 'XLM',
  });

  test('a DEX self-swap produces no flow in either direction', () => {
    const f = foldHorizonPayments([selfSwap(ME, '1.03')], ME, 'testnet');
    expect(f.inbound).toEqual([]);
    expect(f.outbound).toEqual([]);
  });

  test('a real payment alongside a self-swap still counts', () => {
    const f = foldHorizonPayments([selfSwap(ME, '1.03'), classicPayment(PAYER, ME, '2')], ME, 'testnet');
    expect(f.inbound).toEqual([{ payer: PAYER, total: 2, count: 1 }]);
  });
});

describe('foldHorizonPayments — asset identity (the impersonation guard)', () => {
  test('USDC from the WRONG issuer does not count', () => {
    const impostor = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const f = foldHorizonPayments([sorobanTransfer(PAYER, ME, '1000', impostor)], ME, 'testnet');
    expect(f.inbound).toEqual([]);
  });

  test('the mainnet issuer does not count while reading testnet', () => {
    const f = foldHorizonPayments([sorobanTransfer(PAYER, ME, '1000', USDC_ISSUER.pubnet)], ME, 'testnet');
    expect(f.inbound).toEqual([]);
  });

  test('a non-USDC asset does not count', () => {
    const eurc = { ...sorobanTransfer(PAYER, ME, '500') };
    eurc.asset_balance_changes[0].asset_code = 'EURC';
    const f = foldHorizonPayments([eurc], ME, 'testnet');
    expect(f.inbound).toEqual([]);
  });

  test('malformed records are skipped rather than throwing', () => {
    const f = foldHorizonPayments(
      [null, {}, { type: 'payment' }, { asset_balance_changes: 'nope' }, sorobanTransfer(PAYER, ME, '2')],
      ME,
      'testnet',
    );
    expect(f.inbound).toEqual([{ payer: PAYER, total: 2, count: 1 }]);
  });

  test('a non-numeric amount does not poison the total', () => {
    const bad = { ...sorobanTransfer(PAYER, ME, 'not-a-number') };
    const f = foldHorizonPayments([bad, sorobanTransfer(PAYER, ME, '5')], ME, 'testnet');
    expect(f.inbound).toEqual([{ payer: PAYER, total: 5, count: 1 }]);
  });
});

// --- fetchStellarFlows: network resolution + paging -------------------------

const MAINNET = 'https://horizon.stellar.org';
const TESTNET = 'https://horizon-testnet.stellar.org';
// TESTNET is used by the pagination regression test below.

/** Fake Horizon: `accounts` decides existence, `payments` supplies records. */
function fakeHorizon(cfg: {
  existsOn?: ('pubnet' | 'testnet')[];
  records?: Record<string, unknown[]>;
  throwOn?: string;
}): { fetchJson: HorizonJsonFetch; calls: string[] } {
  const calls: string[] = [];
  const exists = new Set(cfg.existsOn ?? []);
  const fetchJson: HorizonJsonFetch = async (url) => {
    calls.push(url);
    if (cfg.throwOn && url.includes(cfg.throwOn)) throw new Error('horizon down');
    const net = url.startsWith(MAINNET) ? 'pubnet' : 'testnet';
    if (url.includes('/payments')) {
      return { _embedded: { records: cfg.records?.[net] ?? [] } };
    }
    if (!exists.has(net)) throw new Error('404 not found');
    return { id: 'acct' };
  };
  return { fetchJson, calls };
}

describe('fetchStellarFlows — network resolution', () => {
  test('prefers mainnet when the account exists on both', async () => {
    const { fetchJson } = fakeHorizon({
      existsOn: ['pubnet', 'testnet'],
      records: {
        pubnet: [sorobanTransfer(PAYER, ME, '1', USDC_ISSUER.pubnet)],
        testnet: [sorobanTransfer(PAYER, ME, '999')],
      },
    });
    const r = await fetchStellarFlows(ME, { fetchJson });
    expect(r?.network).toBe('pubnet');
    expect(r?.flows.inbound).toEqual([{ payer: PAYER, total: 1, count: 1 }]);
  });

  test('falls back to testnet only when mainnet has no such account, and says so', async () => {
    const { fetchJson } = fakeHorizon({
      existsOn: ['testnet'],
      records: { testnet: [sorobanTransfer(PAYER, ME, '4')] },
    });
    const r = await fetchStellarFlows(ME, { fetchJson });
    expect(r?.network).toBe('testnet');
    expect(r?.flows.inbound).toEqual([{ payer: PAYER, total: 4, count: 1 }]);
  });

  test('an account on neither network resolves to null', async () => {
    const { fetchJson } = fakeHorizon({ existsOn: [] });
    expect(await fetchStellarFlows(ME, { fetchJson })).toBeNull();
  });

  test('the resolved chain is always stellar', async () => {
    const { fetchJson } = fakeHorizon({ existsOn: ['testnet'], records: { testnet: [] } });
    const r = await fetchStellarFlows(ME, { fetchJson });
    expect(r?.flows.chain).toBe('stellar');
  });
});

describe('fetchStellarFlows — bounded reads and failure', () => {
  test('exhausting the page cap with more to read reports saturated', async () => {
    const page = Array.from({ length: STELLAR_FLOW_PAGE_LIMIT }, () => sorobanTransfer(PAYER, ME, '1'));
    const { fetchJson } = fakeHorizon({ existsOn: ['testnet'], records: { testnet: page } });
    const r = await fetchStellarFlows(ME, { fetchJson, maxPages: 1 });
    expect(r?.saturated).toBe(true);
  });

  test('a full page that turns out to be the LAST page is not saturated', async () => {
    // Regression: a first page of exactly PAGE_LIMIT used to mark the read
    // windowed even when the next page finished the history, which told
    // consumers the figures were a sample when they were complete.
    const full = Array.from({ length: STELLAR_FLOW_PAGE_LIMIT }, () => sorobanTransfer(PAYER, ME, '1'));
    let call = 0;
    const fetchJson: HorizonJsonFetch = async (url) => {
      if (!url.includes('/payments')) {
        if (url.startsWith(MAINNET)) throw new Error('404 not found');
        return { id: 'acct' };
      }
      call += 1;
      return call === 1
        ? { _embedded: { records: full }, _links: { next: { href: `${TESTNET}/accounts/x/payments?cursor=next` } } }
        : { _embedded: { records: [sorobanTransfer(PAYER, ME, '1')] } };
    };
    const r = await fetchStellarFlows(ME, { fetchJson, maxPages: 5 });
    expect(r?.saturated).toBe(false);
    expect(r?.flows.inbound[0]?.count).toBe(STELLAR_FLOW_PAGE_LIMIT + 1);
  });

  test('a short page is not saturated', async () => {
    const { fetchJson } = fakeHorizon({
      existsOn: ['testnet'],
      records: { testnet: [sorobanTransfer(PAYER, ME, '1')] },
    });
    const r = await fetchStellarFlows(ME, { fetchJson, maxPages: 1 });
    expect(r?.saturated).toBe(false);
  });

  test('a Horizon failure on the payments read returns null instead of throwing', async () => {
    const { fetchJson } = fakeHorizon({ existsOn: ['pubnet'], throwOn: '/payments' });
    expect(await fetchStellarFlows(ME, { fetchJson })).toBeNull();
  });

  test('an account with no payments at all still resolves, with empty flows', async () => {
    const { fetchJson } = fakeHorizon({ existsOn: ['pubnet'], records: { pubnet: [] } });
    const r = await fetchStellarFlows(ME, { fetchJson });
    expect(r?.flows.inbound).toEqual([]);
    expect(r?.flows.outbound).toEqual([]);
  });
});

describe('end to end: the Fianza agent reproduces its known verdict', () => {
  test('folded flows through computeReciprocity read as circular', async () => {
    // Two counterparties on both sides (circular), plus one payer that only pays.
    const records = [
      sorobanTransfer(PAYER, ME, '18.5'),
      sorobanTransfer(ME, PAYER, '21.65'),
      sorobanTransfer(OTHER, ME, '0.44'),
    ];
    const { fetchJson } = fakeHorizon({ existsOn: ['testnet'], records: { testnet: records } });
    const r = await fetchStellarFlows(ME, { fetchJson });

    const verdict = computeReciprocity(r!.flows);
    expect(verdict.verdict).toBe('circular');
    expect(verdict.reciprocalShare).toBeCloseTo(18.5 / 18.94, 3);
    expect(verdict.coverage).toBe(1);
  });
});
