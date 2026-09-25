import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentProfileShell } from './agent-profile-shell';

const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const render = (props: Partial<Parameters<typeof AgentProfileShell>[0]> = {}) =>
  renderToStaticMarkup(
    <AgentProfileShell
      back={{ href: '/', label: 'Back to Leaderboard' }}
      address={address}
      chain="solana"
      {...props}
    >
      <p>body</p>
    </AgentProfileShell>,
  );

describe('AgentProfileShell', () => {
  test('renders every caller-supplied slot in one frame', () => {
    const html = render({
      name: 'Karma Agent',
      avatarSrc: null,
      chips: <span>Chip A</span>,
      actions: <button type="button">Embed</button>,
      lastSeen: '2026-09-25T00:00:00.000Z',
      description: 'Does a thing.',
      category: 'ai',
      website: 'https://example.com/deep/path',
      score: <div data-testid="score">ring</div>,
    });
    assert.match(html, /href="\/"/);
    assert.match(html, /Back to Leaderboard/);
    assert.match(html, /Karma Agent/);
    assert.match(html, /Chip A/);
    assert.match(html, /Embed/);
    assert.match(html, /Does a thing\./);
    assert.match(html, /AI \/ ML/);
    assert.match(html, /href="https:\/\/example\.com\/deep\/path"/);
    assert.match(html, /example\.com/);
    assert.match(html, /data-testid="score"/);
    assert.match(html, /<p>body<\/p>/);
    assert.match(html, new RegExp(`href="[^"]*${address}"`));
  });

  test('a null name falls back to a neutral heading instead of blank space', () => {
    assert.match(render(), /Agent Profile/);
  });

  test('omits the optional blocks entirely when the wallet declares nothing', () => {
    const html = render();
    // Only the back link and the explorer link survive; no description
    // paragraph, no category/website row.
    assert.equal((html.match(/<a /g) ?? []).length, 2);
    assert.doesNotMatch(html, /text-\[14px\] text-\[#8a8f98\]/);
  });

  test('an unknown category slug passes through rather than disappearing', () => {
    assert.match(render({ category: 'oracle' }), /oracle/);
  });

  test('rejects a website that cannot become an http(s) href', () => {
    for (const website of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'not a url']) {
      const html = render({ website });
      assert.doesNotMatch(html, /javascript:|data:/, website);
      assert.equal((html.match(/<a /g) ?? []).length, 2, website);
    }
  });
});
