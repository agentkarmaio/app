/// <reference types="bun-types" />
/**
 * Serializer + invariant tests for the succession / bond / surety API blocks.
 *
 * These shapes are consumed by the UI + SDK and by both the dedicated endpoints
 * and the additive /api/v2/score blocks — so they encode the OBSERVE-ONLY,
 * demo-flagging, and orthogonality invariants.
 *
 * Run: bun test src/lib/succession-view.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  buildSuccessionView, buildBondView, buildSuretyView,
  isBondSettled, toSuretyPosition,
} from './succession-view';
import { deriveSuccessionLiveness } from '@/scoring/succession';
import { computeSurety } from '@/scoring/surety';
import type { Succession, Bond, BondUnderwriter } from '@/db/schema';

const NOW = new Date('2026-06-15T00:00:00Z');

function succession(over: Partial<Succession> = {}): Succession {
  return {
    chain: 'solana',
    agent_wallet: 'AGENT',
    source_type: 'claim_form',
    interval_seconds: 86_400,
    heirs: [
      { address: 'HEIR1', chain: 'solana', share: 0.6, label: 'main' },
      { address: 'HEIR2', chain: 'solana', share: 0.4 },
    ],
    status: 'declared',
    will_hash: null,
    declared_at: '2026-06-01T00:00:00Z',
    last_heartbeat_at: null,
    lapsed_at: null,
    executed_at: null,
    revoked_at: null,
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

function bond(over: Partial<Bond> = {}): Bond {
  return {
    id: 'b1',
    chain: 'solana',
    bonded_agent_wallet: 'AGENT',
    beneficiary: 'BENEF',
    task_ref: 'task:1',
    amount: 100,
    currency: 'USDC',
    status: 'open',
    escrow_ref: 'escrow:1',
    resolution_proof_tx: null,
    is_demo: false,
    opened_at: '2026-06-10T00:00:00Z',
    resolved_at: null,
    ...over,
  };
}

describe('buildSuccessionView', () => {
  test('derives live status + heartbeat from a recent tx, exposes heir count', () => {
    const s = succession();
    const liveness = deriveSuccessionLiveness({
      succession: { status: s.status, interval_seconds: s.interval_seconds },
      lastMeaningfulTxAt: '2026-06-14T18:00:00Z', // 6h ago < 24h interval → live
      now: NOW,
    });
    const v = buildSuccessionView(s, liveness);
    expect(v.status).toBe('live');
    expect(v.declaredStatus).toBe('declared');
    expect(v.heirCount).toBe(2);
    expect(v.heirs).toHaveLength(2);
    expect(v.lastHeartbeatAt).toBe('2026-06-14T18:00:00.000Z');
    expect(v.deadlineAt).not.toBeNull();
  });

  test('terminal executed status passes through unchanged', () => {
    const s = succession({ status: 'executed', executed_at: '2026-06-12T00:00:00Z' });
    const liveness = deriveSuccessionLiveness({
      succession: { status: s.status, interval_seconds: s.interval_seconds },
      lastMeaningfulTxAt: '2026-06-01T00:00:00Z',
      now: NOW,
    });
    const v = buildSuccessionView(s, liveness);
    expect(v.status).toBe('executed');
    expect(v.executedAt).toBe('2026-06-12T00:00:00Z');
  });

  test('tolerates non-array heirs (heirCount 0)', () => {
    const s = succession({ heirs: null as unknown as Succession['heirs'] });
    const liveness = deriveSuccessionLiveness({
      succession: { status: s.status, interval_seconds: s.interval_seconds },
      lastMeaningfulTxAt: null,
      now: NOW,
    });
    const v = buildSuccessionView(s, liveness);
    expect(v.heirCount).toBe(0);
    expect(v.heirs).toEqual([]);
  });
});

describe('buildBondView — demo flagging is preserved', () => {
  test('isDemo true survives serialization (UI MUST label it)', () => {
    const v = buildBondView(bond({ is_demo: true }));
    expect(v.isDemo).toBe(true);
    expect(v.amount).toBe(100);
    expect(v.currency).toBe('USDC');
  });

  test('real bond carries isDemo false', () => {
    expect(buildBondView(bond()).isDemo).toBe(false);
  });

  test('numeric amount is coerced from string', () => {
    const v = buildBondView(bond({ amount: '250.5' as unknown as number }));
    expect(v.amount).toBe(250.5);
  });
});

describe('isBondSettled', () => {
  test('resolved_success and resolved_failure are settled', () => {
    expect(isBondSettled('resolved_success')).toBe(true);
    expect(isBondSettled('resolved_failure')).toBe(true);
  });
  test('open and expired are NOT settled', () => {
    expect(isBondSettled('open')).toBe(false);
    expect(isBondSettled('expired')).toBe(false);
  });
});

describe('toSuretyPosition → computeSurety (orthogonal axis)', () => {
  function underwriter(b: Bond | null, stake = 50): BondUnderwriter & { bond: Bond | null } {
    return {
      id: 'u1', bond_id: b?.id ?? 'x', chain: 'solana',
      underwriter_wallet: 'UW', stake_amount: stake, premium_earned: null,
      settled: b ? isBondSettled(b.status) : false, created_at: '2026-06-10T00:00:00Z',
      bond: b,
    };
  }

  test('open bond → unsettled, not counted in success rate', () => {
    const pos = toSuretyPosition(underwriter(bond({ status: 'open' })));
    expect(pos.settled).toBe(false);
    expect(pos.success).toBe(false);
  });

  test('resolved_success → settled + success', () => {
    const pos = toSuretyPosition(underwriter(bond({ status: 'resolved_success' })));
    expect(pos.settled).toBe(true);
    expect(pos.success).toBe(true);
  });

  test('resolved_failure → settled but not success', () => {
    const pos = toSuretyPosition(underwriter(bond({ status: 'resolved_failure' })));
    expect(pos.settled).toBe(true);
    expect(pos.success).toBe(false);
  });

  test('clean 3/3 record reads reliable through the view', () => {
    const positions = [
      toSuretyPosition(underwriter(bond({ id: 'a', status: 'resolved_success' }))),
      toSuretyPosition(underwriter(bond({ id: 'b', status: 'resolved_success' }))),
      toSuretyPosition(underwriter(bond({ id: 'c', status: 'resolved_success' }))),
    ];
    const r = computeSurety(positions);
    expect(r).not.toBeNull();
    const v = buildSuretyView(r!);
    expect(v.settledCount).toBe(3);
    expect(v.successCount).toBe(3);
    expect(v.label).toBe('reliable');
  });

  test('null bond (orphaned position) → unsettled', () => {
    const pos = toSuretyPosition(underwriter(null));
    expect(pos.settled).toBe(false);
    expect(pos.success).toBe(false);
  });
});
