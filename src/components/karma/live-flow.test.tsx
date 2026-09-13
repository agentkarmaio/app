import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveFlow } from './live-flow';

describe('LiveFlow honest initial rendering', () => {
  test('labels saved counts as indexed activity, not an unconditional streaming feed', () => {
    const html = renderToStaticMarkup(<LiveFlow initial={{ totalAgents: 17, totalTransactions: 42 }} />);
    expect(html).toContain('Indexed activity');
    expect(html).not.toContain('Streaming');
    expect(html).toContain('42');
    expect(html).toContain('17');
    expect(html).toContain('<summary');
    expect(html).not.toContain('pointer-events-none');
  });

  test('missing initial counts never display fabricated zero totals', () => {
    const html = renderToStaticMarkup(<LiveFlow />);
    expect(html).not.toContain('000,000');
    expect(html).not.toContain('00,000');
    expect(html).toContain('Loading counts');
  });

  test('stale initial totals remain visible with an explicit delay message', () => {
    const html = renderToStaticMarkup(<LiveFlow initial={{ totalAgents: 17, totalTransactions: 42, freshness: { stale: true, transactionsUpdatedAt: '2026-09-12T09:00:00Z', agentsUpdatedAt: null } }} />);
    expect(html).toContain('Updates delayed');
    expect(html).toContain('42');
    expect(html).toContain('09:00');
    expect(html).toContain('UTC');
  });
});
