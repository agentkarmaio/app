/// <reference types="bun-types" />
/**
 * FeedbackRecordsCard — renders the per-record ERC-8004 feedback list. Static
 * markup assertions (no DOM): known raters show a name + internal /agent link,
 * unknown raters keep an explorer link, AK reviews render stars (aria-label),
 * other schemes keep the 0–100 value, and revoked records are greyed + struck
 * and sink to the bottom.
 *
 * Run: bun test src/components/karma/feedback-records-card.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FeedbackRecordsCard } from './feedback-records-card';
import type { FeedbackRecord } from '@/integrations/erc8004-celo';
import type { RaterInfo } from '@/db/client';

function rec(over: Partial<FeedbackRecord>): FeedbackRecord {
  return {
    client: '0x1111111111111111111111111111111111111111',
    feedbackIndex: 0n,
    rawValue: 100n,
    valueDecimals: 0,
    value: 100,
    tag1: 'successRate',
    tag2: '',
    revoked: false,
    ...over,
  };
}

describe('FeedbackRecordsCard', () => {
  test('known rater renders its name + internal /agent link, not the explorer', () => {
    const raters = new Map<string, RaterInfo>([
      ['0x1111111111111111111111111111111111111111', { name: 'Oracle Bot', agentId: 9 }],
    ]);
    const html = renderToStaticMarkup(
      <FeedbackRecordsCard records={[rec({})]} raters={raters} chain="celo" />,
    );
    expect(html).toContain('Oracle Bot');
    expect(html).toContain('/agent/0x1111111111111111111111111111111111111111');
    expect(html).toContain('agentId=9');
    expect(html).not.toContain('celoscan.io');
  });

  test('unknown rater keeps the explorer link + short address', () => {
    const html = renderToStaticMarkup(
      <FeedbackRecordsCard records={[rec({})]} chain="celo" />,
    );
    expect(html).toContain('celoscan.io/address/0x1111111111111111111111111111111111111111');
    expect(html).toContain('0x1111…1111');
  });

  test('AK review renders stars; other schemes keep the 0–100 value', () => {
    const review = rec({ tag1: 'agentkarma_review', value: 80, feedbackIndex: 1n });
    const other = rec({ tag1: 'successRate', value: 45, feedbackIndex: 2n });
    const html = renderToStaticMarkup(
      <FeedbackRecordsCard records={[review, other]} chain="celo" />,
    );
    expect(html).toContain('4 out of 5'); // 80 / 20 = 4 filled stars
    expect(html).toContain('45');
    expect(html).toContain('/ 100');
  });

  test('revoked record is greyed, struck, labelled, and sunk below live ones', () => {
    const live = rec({ feedbackIndex: 1n, value: 90 });
    const dead = rec({ feedbackIndex: 2n, value: 30, revoked: true });
    const html = renderToStaticMarkup(
      <FeedbackRecordsCard records={[dead, live]} chain="celo" />,
    );
    expect(html).toContain('revoked');
    expect(html).toContain('opacity-50');
    expect(html).toContain('line-through');
    // live (90) must appear before revoked (30) in the rendered order
    expect(html.indexOf('90')).toBeLessThan(html.indexOf('30'));
  });

  test('empty record list renders nothing', () => {
    const html = renderToStaticMarkup(
      <FeedbackRecordsCard records={[]} chain="celo" />,
    );
    expect(html).toBe('');
  });
});
