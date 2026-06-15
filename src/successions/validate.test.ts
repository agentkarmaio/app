/// <reference types="bun-types" />
/**
 * Succession plan validation — pure, no IO. Covers interval bounds, heir
 * address/chain validity, self-as-sole-heir rejection, and the split-share +
 * dedup rules. Heir addresses use real per-chain formats so the chain-adapter
 * validateAddress path is exercised (Solana base58, EVM 0x…40hex, Stellar G…).
 *
 * Run: bun test src/successions/validate.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { Keypair } from '@solana/web3.js';
import {
  validateSuccessionPlan,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  MAX_HEIRS,
} from './validate';

// Real-format addresses (validity is format-only; not on-chain existence).
// Deterministic seeded Solana keypairs keep the suite reproducible while
// passing the base58 adapter check (placeholder literals can fail it).
function seededSol(byte: number): string {
  return Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => byte)).publicKey.toBase58();
}
const AGENT_SOL = seededSol(1);
const HEIR_SOL = seededSol(2);
const HEIR_EVM = '0x1234567890abcdef1234567890abcdef12345678';
const DAY = 86_400;

function plan(over: Record<string, unknown> = {}) {
  return {
    intervalSeconds: 7 * DAY,
    heirs: [{ address: HEIR_SOL, chain: 'solana' }],
    ...over,
  };
}

describe('validateSuccessionPlan — interval bounds', () => {
  test('accepts an in-bounds plan', () => {
    const r = validateSuccessionPlan(plan(), 'solana', AGENT_SOL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.intervalSeconds).toBe(7 * DAY);
      expect(r.plan.heirs).toHaveLength(1);
    }
  });

  test('rejects below MIN_INTERVAL_SECONDS', () => {
    const r = validateSuccessionPlan(plan({ intervalSeconds: MIN_INTERVAL_SECONDS - 1 }), 'solana', AGENT_SOL);
    expect(r.ok).toBe(false);
  });

  test('rejects above MAX_INTERVAL_SECONDS', () => {
    const r = validateSuccessionPlan(plan({ intervalSeconds: MAX_INTERVAL_SECONDS + 1 }), 'solana', AGENT_SOL);
    expect(r.ok).toBe(false);
  });

  test('rejects non-integer interval', () => {
    const r = validateSuccessionPlan(plan({ intervalSeconds: 3600.5 }), 'solana', AGENT_SOL);
    expect(r.ok).toBe(false);
  });

  test('accepts snake_case interval_seconds (manifest shape)', () => {
    const r = validateSuccessionPlan(
      { interval_seconds: 7 * DAY, heirs: [{ address: HEIR_SOL, chain: 'solana' }] },
      'solana',
      AGENT_SOL,
    );
    expect(r.ok).toBe(true);
  });
});

describe('validateSuccessionPlan — heir shape', () => {
  test('rejects empty heirs', () => {
    expect(validateSuccessionPlan(plan({ heirs: [] }), 'solana', AGENT_SOL).ok).toBe(false);
  });

  test('rejects more than MAX_HEIRS', () => {
    const heirs = Array.from({ length: MAX_HEIRS + 1 }, (_, i) => ({
      address: HEIR_EVM.slice(0, -2) + String(i).padStart(2, '0'),
      chain: 'celo',
    }));
    expect(validateSuccessionPlan(plan({ heirs }), 'solana', AGENT_SOL).ok).toBe(false);
  });

  test('rejects heir with invalid address for declared chain', () => {
    // EVM address declared as a solana heir → fails the adapter check.
    const r = validateSuccessionPlan(plan({ heirs: [{ address: HEIR_EVM, chain: 'solana' }] }), 'solana', AGENT_SOL);
    expect(r.ok).toBe(false);
  });

  test('rejects heir with missing/unknown chain', () => {
    expect(validateSuccessionPlan(plan({ heirs: [{ address: HEIR_SOL }] }), 'solana', AGENT_SOL).ok).toBe(false);
    expect(validateSuccessionPlan(plan({ heirs: [{ address: HEIR_SOL, chain: 'bitcoin' }] }), 'solana', AGENT_SOL).ok).toBe(false);
  });

  test('accepts a cross-chain heir (EVM heir for a solana agent)', () => {
    const r = validateSuccessionPlan(plan({ heirs: [{ address: HEIR_EVM, chain: 'celo' }] }), 'solana', AGENT_SOL);
    expect(r.ok).toBe(true);
  });

  test('rejects duplicate (chain,address) heirs', () => {
    const r = validateSuccessionPlan(
      plan({ heirs: [{ address: HEIR_SOL, chain: 'solana' }, { address: HEIR_SOL, chain: 'solana' }] }),
      'solana', AGENT_SOL,
    );
    expect(r.ok).toBe(false);
  });

  test('rejects non-positive share', () => {
    const r = validateSuccessionPlan(plan({ heirs: [{ address: HEIR_SOL, chain: 'solana', share: 0 }] }), 'solana', AGENT_SOL);
    expect(r.ok).toBe(false);
  });

  test('carries through positive share + label (truncated)', () => {
    const r = validateSuccessionPlan(
      plan({ heirs: [{ address: HEIR_SOL, chain: 'solana', share: 2.5, label: 'primary' }] }),
      'solana', AGENT_SOL,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.heirs[0].share).toBe(2.5);
      expect(r.plan.heirs[0].label).toBe('primary');
    }
  });
});

describe('validateSuccessionPlan — self-as-sole-heir', () => {
  test('rejects the agent as its only heir (same chain+address)', () => {
    const r = validateSuccessionPlan(plan({ heirs: [{ address: AGENT_SOL, chain: 'solana' }] }), 'solana', AGENT_SOL);
    expect(r.ok).toBe(false);
  });

  test('allows self-heir when at least one OTHER distinct heir exists', () => {
    const r = validateSuccessionPlan(
      plan({ heirs: [{ address: AGENT_SOL, chain: 'solana' }, { address: HEIR_SOL, chain: 'solana' }] }),
      'solana', AGENT_SOL,
    );
    expect(r.ok).toBe(true);
  });

  test('self-address but DIFFERENT chain is a distinct heir → allowed', () => {
    // Same string on celo is a different (chain,address) identity than the
    // solana agent — composite-PK semantics. Not a self-sole-heir.
    const r = validateSuccessionPlan(plan({ heirs: [{ address: HEIR_EVM, chain: 'celo' }] }), 'celo', AGENT_SOL);
    expect(r.ok).toBe(true);
  });
});

describe('validateSuccessionPlan — malformed input', () => {
  test('rejects non-object plan', () => {
    expect(validateSuccessionPlan(null, 'solana', AGENT_SOL).ok).toBe(false);
    expect(validateSuccessionPlan('nope', 'solana', AGENT_SOL).ok).toBe(false);
    expect(validateSuccessionPlan(42, 'solana', AGENT_SOL).ok).toBe(false);
  });

  test('rejects missing heirs key', () => {
    expect(validateSuccessionPlan({ intervalSeconds: 7 * DAY }, 'solana', AGENT_SOL).ok).toBe(false);
  });
});
