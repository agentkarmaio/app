import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KarmaSnapshot } from '@/lib/karma-resolver';
import { buildProfileActivity } from '@/lib/arc-mainnet-profile';
import { ArcMainnetActivityDetails, ArcMainnetProfileOverview, ArcMainnetRegistryFeedback } from './arc-mainnet-profile-details';

const address = `0x${'1'.repeat(40)}`;
const owner = `0x${'2'.repeat(40)}`;
function snapshot(): KarmaSnapshot {
  const face = { score: 0, hasSignal: false, trustTier: 'Unrated', confidenceBadge: 'declared' as const, metrics: null, tierAggregates: null };
  return { address, found: true, agentId: 228, identity: { claimed: false, displayName: 'AgentKarma' }, txCount: 0, lastActive: null,
    provider: { ...face, face: 'provider' }, consumer: { ...face, face: 'consumer' }, confidenceBadge: 'declared',
    autonomy: { score: null, label: null, signals: null, effectiveWeights: null, txCount: 0, lastUpdated: null },
    receiptEvidence: { model: 'arc-mainnet-transfers-v1', received: 0, sent: 0, invalid: 0, sampledEvents: 0,
      sampleLimit: 10000, saturated: false, windowStart: null, windowEnd: null, matchedReciprocalRawAmount: '0' } };
}
const overview = (value = snapshot(), registry: Record<string, unknown> | null = null, registryUnavailable = false) =>
  renderToStaticMarkup(<ArcMainnetProfileOverview snapshot={value} registry={registry} registryUnavailable={registryUnavailable} />);

describe('Arc rich profile rendering', () => {
  test('registry-only agents retain all overview sections without fake score rings', () => {
    const html = overview();
    for (const title of ['Provider Karma', 'Consumer Karma', 'Score Breakdown', 'Summary', 'Autonomy Confidence', 'Evidence &amp; Coverage', 'Registry Identity &amp; Services']) assert.ok(html.includes(title), title);
    assert.doesNotMatch(html, /aria-label="[^"]*Karma score:/);
    assert.match(html, /Unrated does not mean a score of zero/);
    assert.match(html, /At least 10 unique transactions/);
  });
  test('incoming and outgoing ratings remain independent and a measured zero renders', () => {
    const value = snapshot();
    value.provider = { ...value.provider, hasSignal: true, score: 0 };
    const html = overview(value);
    assert.equal((html.match(/aria-label="Provider Karma score:/g) ?? []).length, 1);
    assert.equal((html.match(/aria-label="Consumer Karma score:/g) ?? []).length, 0);
    assert.match(html, /0\.0 \/ 100/);
  });
  test('the shared profile shell carries the header: both faces, embed badge and structured data', () => {
    const value = snapshot();
    value.provider = { ...value.provider, hasSignal: true, score: 12.3, trustTier: 'Fair' };
    value.consumer = { ...value.consumer, hasSignal: true, score: 4.5, trustTier: 'Poor' };
    const html = overview(value, { chain: 'arc-mainnet', agent_id: 228, owner, agent_wallet: address, registration: {} });
    assert.equal((html.match(/aria-label="(Provider|Consumer) Karma score:/g) ?? []).length, 2);
    assert.match(html, /aria-label="Provider Karma score: 12\.3"/);
    assert.match(html, /aria-label="Consumer Karma score: 4\.5"/);
    assert.match(html, /Arc coverage/);
    assert.match(html, /href="\/arc\/mainnet"/);
    assert.match(html, /Agent #228/);
    assert.match(html, /application\/ld\+json/);
    assert.match(html, /"@type":"BreadcrumbList"/);
    assert.match(html, /"name":"Provider Karma"/);
  });
  test('uses resolver scores verbatim rather than a metadata score', () => {
    const value = snapshot();
    value.provider = { ...value.provider, hasSignal: true, score: 12.3, trustTier: 'Fair' };
    const html = overview(value, { chain: 'arc-mainnet', agent_id: 228, owner, agent_wallet: address, metadata_score: 99, registration: {} });
    assert.match(html, /12\.3 \/ 100/);
    assert.doesNotMatch(html, /99\.0 \/ 100/);
    assert.match(html, new RegExp(`https://explorer.arc.io/address/${address}`));
    assert.doesNotMatch(html, /testnet\.arc|solscan\.io|celoscan\.io/);
  });
  test('registry read failures do not become no-identity statements', () => {
    const html = overview(snapshot(), null, true);
    assert.match(html, /Registry details could not be loaded/);
    assert.doesNotMatch(html, /No registry identity is associated/);
  });
  test('escapes descriptions and rejects executable metadata URLs', () => {
    const value = snapshot();
    value.identity.description = '<script>alert(1)</script>';
    value.identity.website = 'javascript:alert(1)';
    const html = overview(value, { owner, registration: { image: 'data:image/svg+xml,bad', services: [{ name: 'bad', endpoint: 'javascript:alert(1)' }] } });
    assert.doesNotMatch(html, /<script>|href="javascript:|src="data:/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /No supported endpoint URL declared/);
  });
  test('discloses saturated scoring coverage and missing autonomy components', () => {
    const value = snapshot();
    value.receiptEvidence!.saturated = true;
    value.autonomy = { score: 50, label: 'mixed', txCount: 10, lastUpdated: null,
      signals: { cadence_regularity: 0.5, memo_determinism: null }, effectiveWeights: { cadence_regularity: 0.375 } };
    const html = overview(value);
    assert.match(html, /Older activity is outside this score/);
    assert.match(html, /Not indexed/);
    assert.match(html, /38%/);
  });
  test('empty activity stays distinct from failed reads', () => {
    const html = renderToStaticMarkup(<ArcMainnetActivityDetails activity={buildProfileActivity([])} sampled={0} saturated={false} invalid={0} />);
    assert.match(html, /Payment Relationships/);
    assert.match(html, /Recent mainnet receipts/);
    assert.match(html, /No valid mainnet receipts are indexed/);
    assert.doesNotMatch(html, /could not be loaded/);
  });
  test('small receipts retain precision, correct mainnet links and log identities', () => {
    const hash = `0x${'a'.repeat(64)}`;
    const activity = buildProfileActivity([{ rawTxHash: hash, eventKey: `${hash}:7`, logIndex: 7, face: 'consumer',
      counterparty: owner, rawAmount: '1', amountDecimal: '0.000000000000000001', timestamp: '2026-01-01T00:00:00.000Z' }]);
    const html = renderToStaticMarkup(<ArcMainnetActivityDetails activity={activity} sampled={1} saturated={true} invalid={0} />);
    assert.match(html, /0\.000000000000000001/);
    assert.ok(html.includes(`https://explorer.arc.io/tx/${hash}`));
    assert.ok(!html.includes(`/tx/${hash}:7`));
    assert.match(html, /chain=arc-mainnet/);
    assert.match(html, /older transfers and relationships are not included/);
  });
  test('revoked feedback and heterogeneous units are explicit', () => {
    const html = renderToStaticMarkup(<ArcMainnetRegistryFeedback rows={[{
      agent_id: 228, client: owner, feedback_index: 1, value: '-125', value_decimals: 2,
      tag1: 'quality', tag2: 'v1', revoked: true, indexed_at: '2026-01-01T00:00:00.000Z',
    }]} />);
    assert.match(html, /-1\.25/);
    assert.match(html, /Revoked · excluded/);
    assert.match(html, /not averaged together or included in Karma/);
  });
});
