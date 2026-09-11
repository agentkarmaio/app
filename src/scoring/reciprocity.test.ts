/// <reference types="bun-types" />
/**
 * Reciprocity / revenue independence — is inbound value actually earned, or is
 * it the operator cycling USDC through wallets it also pays?
 *
 * Lender-critical → exhaustive. The failure mode that matters is NOT a missed
 * flag, it is a confident "independent" verdict on self-dealt revenue, which is
 * exactly what a credit underwriter would act on. Hence the coverage gate: when
 * the indexer cannot see payees on this chain (503k Solana rows carry a NULL
 * counterparty), the answer is "cannot tell", never "clean".
 *
 */

import { describe, expect, test } from 'bun:test';
import {
  computeReciprocity,
  explainReciprocity,
  COVERAGE_FLOOR,
  CIRCULAR_THRESHOLD,
  MIXED_THRESHOLD,
  type ReciprocityInput,
} from './reciprocity';

/** Fianza's testnet agent, read off Stellar Horizon 2026-09-10. */
const FIANZA_AGENT_INBOUND = [
  { payer: 'CAMF3BS23WXYMA6W6E55VSX577GIPSRKJXJKLL2G46TABUQ4GIRGHIL3', total: 6.7236, count: 37 },
  { payer: 'GCYTUI46TG2CGOGRC73VBD56KIIQHE46EKZ57SUQGZXHRE6MEXWXMMUI', total: 18.5, count: 36 },
  { payer: 'GBFS72AZXSXBZEW3DAQA4OROM6U7TZBL2CZFT3FP3QMXS3MB7YPEVQ6N', total: 0.44, count: 8 },
  { payer: 'GCB62BK5FLF3AFZCP373QGJ7R6WR7TSVCGMWFL7LSJHZ4W47TNCJPK4I', total: 0.9, count: 3 },
  { payer: 'GC654YOQQWSOYVDJKIYY726J3ULZBAQJYJXNUCXZPJ4EBCTFFLNTZOS5', total: 0.9, count: 3 },
  { payer: 'GBHCMJGPCCUSQL46GONRNM6GYZZA7AQGWE7MD6ND7W4FR266H3K5RDJ6', total: 0.6, count: 2 },
  { payer: 'GCXMJIG4OZK6VBM6MN3FV3MITCJ364E66UGRNTOIYSY26IPFQUDGNQXL', total: 0.3, count: 1 },
  { payer: 'GAXXFEVOXZUQYJRF4D4SM6RRYXX7XVYQSHAR4JBVQSKKEJTL4FLUZMRW', total: 0.3, count: 1 },
];

/** The same agent pays back exactly two of those eight. */
const FIANZA_AGENT_OUTBOUND = [
  ...Array.from({ length: 54 }, () => ({
    counterparty: 'GCYTUI46TG2CGOGRC73VBD56KIIQHE46EKZ57SUQGZXHRE6MEXWXMMUI',
    amount: 21.6537 / 54,
  })),
  ...Array.from({ length: 31 }, () => ({
    counterparty: 'CAMF3BS23WXYMA6W6E55VSX577GIPSRKJXJKLL2G46TABUQ4GIRGHIL3',
    amount: 7.0099 / 31,
  })),
];

const stellar = (over: Partial<ReciprocityInput> = {}): ReciprocityInput => ({
  chain: 'stellar',
  outbound: FIANZA_AGENT_OUTBOUND,
  inbound: FIANZA_AGENT_INBOUND,
  ...over,
});

describe('computeReciprocity — golden fixture (Fianza testnet agent)', () => {
  test('flags 88% circular revenue that calculateScore rated 72 "Good"', () => {
    const r = computeReciprocity(stellar());

    expect(r.inboundTotal).toBeCloseTo(28.6636, 4);
    expect(r.reciprocalTotal).toBeCloseTo(25.2236, 4);
    expect(r.reciprocalShare).toBeCloseTo(0.88, 2);
    expect(r.independentShare).toBeCloseTo(0.12, 2);
    expect(r.payerCount).toBe(8);
    expect(r.reciprocalPayerCount).toBe(2);
    expect(r.coverage).toBe(1);
    expect(r.verdict).toBe('circular');
  });

  test('independentShare is the complement of reciprocalShare', () => {
    const r = computeReciprocity(stellar());
    expect(r.reciprocalShare! + r.independentShare!).toBeCloseTo(1, 10);
  });
});

describe('computeReciprocity — verdict boundaries', () => {
  test('no payer overlap reads as independent', () => {
    const r = computeReciprocity(
      stellar({
        outbound: [{ counterparty: 'GDIFFERENTPAYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 5 }],
      }),
    );
    expect(r.reciprocalShare).toBe(0);
    expect(r.independentShare).toBe(1);
    expect(r.reciprocalPayerCount).toBe(0);
    expect(r.verdict).toBe('independent');
  });

  test('a single counterparty on both sides reads as fully circular', () => {
    const r = computeReciprocity({
      chain: 'stellar',
      inbound: [{ payer: 'GONLYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 100, count: 20 }],
      outbound: [{ counterparty: 'GONLYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 90 }],
    });
    expect(r.reciprocalShare).toBe(1);
    expect(r.independentShare).toBe(0);
    expect(r.verdict).toBe('circular');
  });

  test('a share between the thresholds reads as mixed', () => {
    const r = computeReciprocity({
      chain: 'stellar',
      inbound: [
        { payer: 'GCIRCULARAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 50, count: 5 },
        { payer: 'GHONESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 50, count: 5 },
      ],
      outbound: [{ counterparty: 'GCIRCULARAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 10 }],
    });
    expect(r.reciprocalShare).toBeCloseTo(0.5, 10);
    expect(r.verdict).toBe('mixed');
    expect(MIXED_THRESHOLD).toBeLessThan(CIRCULAR_THRESHOLD);
  });
});

describe('computeReciprocity — coverage gate (the lender-safety rule)', () => {
  test('mostly-null outbound counterparties refuse to answer', () => {
    const r = computeReciprocity({
      chain: 'solana',
      // 1 of 5 outbound rows carries a payee → coverage 0.2, under the floor.
      outbound: [
        { counterparty: 'SoLpayeeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 1 },
        { counterparty: null, amount: 1 },
        { counterparty: null, amount: 1 },
        { counterparty: null, amount: 1 },
        { counterparty: null, amount: 1 },
      ],
      inbound: [{ payer: 'SoLpayerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 100, count: 10 }],
    });
    expect(r.coverage).toBeCloseTo(0.2, 10);
    expect(r.verdict).toBe('insufficient-data');
    expect(r.reciprocalShare).toBeNull();
    expect(r.independentShare).toBeNull();
  });

  test('insufficient-data never reads as independent, even when visible inbound is clean', () => {
    const r = computeReciprocity({
      chain: 'solana',
      outbound: [{ counterparty: null, amount: 1 }],
      inbound: [{ payer: 'SoLhonestAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 500, count: 50 }],
    });
    expect(r.verdict).not.toBe('independent');
    expect(r.verdict).toBe('insufficient-data');
  });

  test('coverage exactly at the floor still answers', () => {
    const r = computeReciprocity({
      chain: 'stellar',
      outbound: [
        { counterparty: 'GPAYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 1 },
        { counterparty: null, amount: 1 },
      ],
      inbound: [{ payer: 'GHONESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 10, count: 2 }],
    });
    expect(r.coverage).toBe(COVERAGE_FLOOR);
    expect(r.verdict).toBe('independent');
  });

  test('no inbound at all is insufficient-data, not independent', () => {
    const r = computeReciprocity({
      chain: 'stellar',
      outbound: [{ counterparty: 'GPAYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 1 }],
      inbound: [],
    });
    expect(r.inboundTotal).toBe(0);
    expect(r.verdict).toBe('insufficient-data');
    expect(r.independentShare).toBeNull();
  });

  test('no outbound at all cannot establish reciprocity', () => {
    const r = computeReciprocity({
      chain: 'stellar',
      outbound: [],
      inbound: [{ payer: 'GHONESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 10, count: 2 }],
    });
    expect(r.verdict).toBe('insufficient-data');
    expect(r.reciprocalShare).toBeNull();
  });
});

describe('computeReciprocity — address casing per chain', () => {
  test('EVM payer and payee differing only in case DO intersect', () => {
    const r = computeReciprocity({
      chain: 'celo',
      inbound: [{ payer: '0xAbCdEf0000000000000000000000000000000001', total: 100, count: 10 }],
      outbound: [{ counterparty: '0xabcdef0000000000000000000000000000000001', amount: 50 }],
    });
    expect(r.reciprocalPayerCount).toBe(1);
    expect(r.reciprocalShare).toBe(1);
    expect(r.verdict).toBe('circular');
  });

  test('Stellar StrKeys differing in case do NOT intersect', () => {
    const r = computeReciprocity({
      chain: 'stellar',
      inbound: [{ payer: 'GABCDEFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 100, count: 10 }],
      outbound: [{ counterparty: 'gabcdefaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', amount: 50 }],
    });
    expect(r.reciprocalPayerCount).toBe(0);
    expect(r.verdict).toBe('independent');
  });
});

describe('computeReciprocity — arithmetic safety', () => {
  test('zero-value inbound rows do not divide by zero', () => {
    const r = computeReciprocity({
      chain: 'stellar',
      outbound: [{ counterparty: 'GPAYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 1 }],
      inbound: [{ payer: 'GPAYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 0, count: 3 }],
    });
    expect(Number.isFinite(r.inboundTotal)).toBe(true);
    expect(r.verdict).toBe('insufficient-data');
    expect(r.reciprocalShare).toBeNull();
  });

  test('negative or NaN amounts are ignored rather than poisoning the total', () => {
    const r = computeReciprocity({
      chain: 'stellar',
      outbound: [{ counterparty: 'GPAYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 1 }],
      inbound: [
        { payer: 'GPAYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 10, count: 1 },
        { payer: 'GBADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: Number.NaN, count: 1 },
        { payer: 'GNEGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: -5, count: 1 },
      ],
    });
    expect(r.inboundTotal).toBe(10);
    expect(r.reciprocalShare).toBe(1);
  });
});

describe('explainReciprocity', () => {
  test('names the share and how many addresses, for the golden fixture', () => {
    const line = explainReciprocity(computeReciprocity(stellar()));
    expect(line).toBe('88% of inbound value came from 2 addresses this wallet also pays');
  });

  test('says so plainly when nothing is circular', () => {
    const r = computeReciprocity(
      stellar({ outbound: [{ counterparty: 'GDIFFERENTPAYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 5 }] }),
    );
    expect(explainReciprocity(r)).toBe(
      'none of the inbound value came from addresses this wallet also pays (8 payers)',
    );
  });

  test('singular address reads correctly', () => {
    const r = computeReciprocity({
      chain: 'stellar',
      inbound: [{ payer: 'GONLYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 100, count: 20 }],
      outbound: [{ counterparty: 'GONLYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 90 }],
    });
    expect(explainReciprocity(r)).toContain('1 address this wallet also pays');
  });

  test('low coverage with real revenue says "unknown", never implies clean', () => {
    const r = computeReciprocity({
      chain: 'solana',
      outbound: [{ counterparty: null, amount: 1 }],
      inbound: [{ payer: 'SoLpayerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', total: 100, count: 10 }],
    });
    const line = explainReciprocity(r);
    expect(line).toContain('unknown');
    expect(line).not.toContain('independent value');
  });

  test('stays silent when there is simply no revenue to describe', () => {
    const r = computeReciprocity({
      chain: 'stellar',
      outbound: [{ counterparty: 'GPAYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 1 }],
      inbound: [],
    });
    expect(explainReciprocity(r)).toBeNull();
  });
});
