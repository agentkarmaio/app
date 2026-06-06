/// <reference types="bun-types" />
/**
 * Side-by-side score comparison (design note — the product money shot).
 *
 * Two numbers for the SAME Stellar agent, rendered next to each other:
 *   - stellar-8004's DECLARED reputation (their ungated star score — free to
 *     write, anyone can inflate). Read via the 8004 read path WITHOUT the
 *     `agentkarma` tag filter (overall feedback). Always ⚪ Declared.
 *   - AgentKarma's SETTLEMENT-BACKED score — each point traces to a USDC
 *     transfer on the public ledger. 🟢 Receipt-backed when present;
 *     🟡 Behavior-inferred / ⚪ Declared when the agent is unregistered /
 *     badge-gated (NEVER a fabricated number).
 *
 * Tests render the pure presentational view (renderToStaticMarkup) and exercise
 * the async resolver with INJECTED reads — no RPC, no DB, no network.
 *
 * Run: bun test src/components/stellar/score-comparison.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ScoreComparisonView,
  resolveScoreComparison,
  type ScoreComparisonData,
  type ScoreComparisonReads,
} from './score-comparison';

const AGENT = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

// Banned phrases from the copy notes §5 / §7 (must never appear in copy).
const BANNED = [
  'fully trustless',
  'trustless',
  'no oracle',
  'credit bureau',
];

function assertNoBannedPhrase(html: string): void {
  const lower = html.toLowerCase();
  for (const phrase of BANNED) {
    expect(lower.includes(phrase)).toBe(false);
  }
}

describe('ScoreComparisonView — both numbers + badges render', () => {
  test('settlement-backed (present) + declared render side by side with both labels', () => {
    const data: ScoreComparisonData = {
      address: AGENT,
      declared: { score: 98, count: 41, badge: 'declared' },
      settlement: { score: 76, gated: false, badge: 'receipt-backed' },
    };
    const html = renderToStaticMarkup(<ScoreComparisonView data={data} />);

    // Both numbers present.
    expect(html).toContain('98');
    expect(html).toContain('76');

    // Both labels present (exact copy framing).
    expect(html).toContain('Declared trust');
    expect(html).toContain('Settlement-backed trust');

    // Each carries its confidence badge label.
    expect(html).toContain('Declared');        // ⚪ on the stellar-8004 side
    expect(html).toContain('Receipt-backed');  // 🟢 on the AK side

    // Honest one-liner from the copy notes §3.
    expect(html).toContain('One number anyone can inflate for free');
    expect(html).toContain('One number that costs real USDC to move');

    assertNoBannedPhrase(html);
  });
});

describe('ScoreComparisonView — gated case shows a badge, never a fake number', () => {
  test('AK side renders the gate badge + a dash, not a fabricated score', () => {
    const data: ScoreComparisonData = {
      address: AGENT,
      declared: { score: 87, count: 12, badge: 'declared' },
      settlement: {
        score: null,
        gated: true,
        badge: 'behavior-inferred',
        reason: 'no_stellar_agent_id',
      },
    };
    const html = renderToStaticMarkup(<ScoreComparisonView data={data} />);

    // Declared side still shows its number.
    expect(html).toContain('87');

    // AK side shows a dash / em-dash placeholder, NOT a 0 dressed as a score.
    expect(html).toContain('—');

    // Gate badge present (🟡 Behavior-inferred), and NOT the receipt-backed one.
    expect(html).toContain('Behavior-inferred');
    expect(html).not.toContain('Receipt-backed');

    assertNoBannedPhrase(html);
  });

  test('declared-only gate falls back to ⚪ Declared on the AK side', () => {
    const data: ScoreComparisonData = {
      address: AGENT,
      declared: { score: 50, count: 3, badge: 'declared' },
      settlement: { score: null, gated: true, badge: 'declared' },
    };
    const html = renderToStaticMarkup(<ScoreComparisonView data={data} />);
    expect(html).toContain('—');
    // Both faces are 'declared' here; assert the AK column is not receipt-backed.
    expect(html).not.toContain('Receipt-backed');
    assertNoBannedPhrase(html);
  });
});

describe('resolveScoreComparison — injected reads, no network', () => {
  const baseReads = (over: Partial<ScoreComparisonReads> = {}): ScoreComparisonReads => ({
    // stellar-8004 declared (ungated) overall summary.
    readDeclared: async () => ({ score: 98, count: 41 }),
    // AK settlement-backed score (tagged 'agentkarma'); 0 means none.
    readSettlement: async () => 76,
    // agentId resolution for the agent wallet (null → unregistered).
    resolveAgentId: async () => 7,
    ...over,
  });

  test('registered agent with AK feedback → receipt-backed, real numbers', async () => {
    const data = await resolveScoreComparison({ address: AGENT, reads: baseReads() });
    expect(data.declared.score).toBe(98);
    expect(data.declared.badge).toBe('declared');
    expect(data.settlement.score).toBe(76);
    expect(data.settlement.gated).toBe(false);
    expect(data.settlement.badge).toBe('receipt-backed');
  });

  test('unregistered agent (no agentId) → settlement gated, score null, 🟡 badge', async () => {
    const data = await resolveScoreComparison({
      address: AGENT,
      reads: baseReads({ resolveAgentId: async () => null }),
    });
    expect(data.settlement.score).toBeNull();
    expect(data.settlement.gated).toBe(true);
    expect(data.settlement.badge).toBe('behavior-inferred');
    expect(data.settlement.reason).toBe('no_stellar_agent_id');
  });

  test('registered but AK has left no feedback (score 0) → gated, not a 0 score', async () => {
    const data = await resolveScoreComparison({
      address: AGENT,
      reads: baseReads({ readSettlement: async () => 0 }),
    });
    expect(data.settlement.score).toBeNull();
    expect(data.settlement.gated).toBe(true);
    expect(data.settlement.badge).toBe('behavior-inferred');
  });

  test('declared read failure surfaces as 0/0, never throws the whole comparison', async () => {
    const data = await resolveScoreComparison({
      address: AGENT,
      reads: baseReads({
        readDeclared: async () => {
          throw new Error('rpc down');
        },
      }),
    });
    expect(data.declared.score).toBe(0);
    expect(data.declared.count).toBe(0);
  });
});
