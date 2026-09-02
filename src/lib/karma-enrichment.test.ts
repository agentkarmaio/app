/// <reference types="bun-types" />
/**
 * Enriched score response — pure block builders + the deterministic `explain`
 * generator. Fixture mirrors a live Celo registry-only agent (Toppa, agentId
 * 1870): mirror metadata_score 90, 581 feedbacks, https tokenURI (so the
 * tamper-resistance dimension is 0 and the live recompute must land on 90).
 */
import { describe, expect, test } from 'bun:test';
import {
  buildRegistryBlock,
  buildDeclaredBlock,
  buildFeedbackBlock,
  buildDiscoveryBlock,
  buildExplain,
  pickPrimaryAgent,
  normalizeAddressForChain,
  type EnrichmentAgentRow,
  type EnrichmentFeedbackRow,
  type EnrichmentPayeeRow,
} from './karma-enrichment';
import { AK_VALIDATOR } from '@/config/ak-validator';

const OWNER = '0x558e7bfaf2cf1a494f44e50d92431afc060c9d12';

const TOPPA_REGISTRATION = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Toppa',
  description: 'Airtime, data bundles, bill payments and gift cards for AI agents across 170+ countries. Pay with stablecoins on Celo via x402, MCP or A2A.',
  image: 'https://api.toppa.cc/agent-image.png',
  active: true,
  x402Support: true,
  supportedTrust: ['reputation', 'crypto-economic', 'tee-attestation'],
  services: [
    { name: 'send-airtime', method: 'POST', endpoint: 'https://api.toppa.cc/send-airtime', paymentRequired: true },
    { name: 'MCP', version: '2025-06-18', endpoint: 'https://api.toppa.cc/.well-known/mcp.json', mcpTools: ['a'] },
    { name: 'web', endpoint: 'https://www.toppa.cc', protocol: 'Web' },
  ],
  registrations: [{ agentId: 1870, agentRegistry: 'eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }],
};

const TOPPA: EnrichmentAgentRow = {
  chain: 'celo',
  agent_id: 1870,
  owner: OWNER,
  agent_wallet: OWNER,
  token_uri: 'https://api.toppa.cc/registration.json',
  registration: TOPPA_REGISTRATION,
  registration_status: 'fetched',
  metadata_score: 90,
  feedback_count: 581,
  feedback_avg: '96.72977624784853',
};

const fb = (over: Partial<EnrichmentFeedbackRow>): EnrichmentFeedbackRow => ({
  agent_id: 1870,
  client: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  feedback_index: 1,
  value: '100',
  value_decimals: 0,
  tag1: 'airtime',
  tag2: 'success',
  revoked: false,
  indexed_at: '2026-08-30T10:00:00.000Z',
  ...over,
});

describe('normalizeAddressForChain', () => {
  test('lowercases EVM chains only', () => {
    expect(normalizeAddressForChain('0xABC', 'celo')).toBe('0xabc');
    expect(normalizeAddressForChain('0xABC', 'arc')).toBe('0xabc');
    expect(normalizeAddressForChain('4VRzfgGq', 'solana')).toBe('4VRzfgGq');
    expect(normalizeAddressForChain('GA6OBK', 'stellar')).toBe('GA6OBK');
  });
});

describe('buildRegistryBlock', () => {
  test('projects sanitized agents with explorer links', () => {
    const block = buildRegistryBlock([TOPPA], 1, 'celo');
    expect(block.total).toBe(1);
    expect(block.agents).toHaveLength(1);
    const a = block.agents[0];
    expect(a.agentId).toBe(1870);
    expect(a.name).toBe('Toppa');
    expect(a.registrationStatus).toBe('fetched');
    expect(a.metadataScore).toBe(90);
    expect(a.feedbackCount).toBe(581);
    expect(a.services).toEqual([
      { name: 'send-airtime', endpoint: 'https://api.toppa.cc/send-airtime' },
      { name: 'MCP', endpoint: 'https://api.toppa.cc/.well-known/mcp.json' },
      { name: 'web', endpoint: 'https://www.toppa.cc' },
    ]);
    expect(a.explorer.eightthousandfourscan).toBe('https://8004scan.io/agent/1870');
    expect(a.explorer.agentkarma).toContain('/agent/');
    expect(a.explorer.agentkarma).toContain('agentId=1870');
  });

  test('drops non-string service fields, caps services at 10 and strings by length', () => {
    const services = Array.from({ length: 14 }, (_, i) => ({ name: `s${i}`, endpoint: `https://x/${i}` }));
    const row: EnrichmentAgentRow = {
      ...TOPPA,
      registration: {
        name: 'N'.repeat(500),
        description: 'D'.repeat(1000),
        services: [{ name: 42, endpoint: 'https://x' }, { name: 'ok' }, ...services],
      },
    };
    const a = buildRegistryBlock([row], 1, 'celo').agents[0];
    expect(a.name?.length).toBe(80);
    expect(a.description?.length).toBe(280);
    expect(a.services).toHaveLength(10);
    expect(a.services[0]).toEqual({ name: 's0', endpoint: 'https://x/0' });
  });

  test('caps agents at 10 while reporting the true total', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ ...TOPPA, agent_id: i + 1 }));
    const block = buildRegistryBlock(rows, 37, 'celo');
    expect(block.agents).toHaveLength(10);
    expect(block.total).toBe(37);
  });

  test('tolerates a null / non-object registration', () => {
    const a = buildRegistryBlock([{ ...TOPPA, registration: null }], 1, 'arc').agents[0];
    expect(a.name).toBeNull();
    expect(a.services).toEqual([]);
    expect(a.explorer.eightthousandfourscan).toBeNull();
  });
});

describe('pickPrimaryAgent', () => {
  test("prefers the wallet row's chain agent id when owned, else highest metadata score", () => {
    const rows = [
      { ...TOPPA, agent_id: 5, metadata_score: 95 },
      { ...TOPPA, agent_id: 1870, metadata_score: 90 },
    ];
    expect(pickPrimaryAgent(rows, 1870)?.agent_id).toBe(1870);
    expect(pickPrimaryAgent(rows, 999)?.agent_id).toBe(5);
    expect(pickPrimaryAgent(rows, null)?.agent_id).toBe(5);
    expect(pickPrimaryAgent([], 1870)).toBeNull();
  });
});

describe('buildDeclaredBlock', () => {
  test('live v0.2 recompute equals the mirror score for the Toppa fixture', () => {
    const d = buildDeclaredBlock(TOPPA);
    expect(d).not.toBeNull();
    expect(d!.scheme).toBe(AK_VALIDATOR.scheme.tag1);
    expect(d!.version).toBe('v0.2');
    expect(d!.agentId).toBe(1870);
    expect(d!.score).toBe(90);
    expect(d!.dimensions).toHaveLength(12);
    expect(d!.dimensions.reduce((s, x) => s + x.max, 0)).toBe(100);
    const tamper = d!.dimensions.find((x) => x.key === 'tamperResistance')!;
    expect(tamper.points).toBe(0);
    expect(tamper.passed).toBe(false);
    expect(d!.dimensions.find((x) => x.key === 'name')!.passed).toBe(true);
  });

  test('null when there is no registration to score', () => {
    expect(buildDeclaredBlock({ ...TOPPA, registration: null })).toBeNull();
    expect(buildDeclaredBlock(null)).toBeNull();
  });
});

describe('buildFeedbackBlock', () => {
  test('aggregates from the mirror, samples the window, identifies AK validators', () => {
    const rows = [
      fb({ client: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', feedback_index: 3, indexed_at: '2026-08-30T10:00:00.000Z' }),
      fb({ client: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', feedback_index: 1, value: '850', value_decimals: 1, indexed_at: '2026-08-29T10:00:00.000Z' }),
      fb({ client: AK_VALIDATOR.validator, feedback_index: 1, value: '90', tag1: AK_VALIDATOR.scheme.tag1, tag2: 'v0.2', indexed_at: '2026-08-01T10:00:00.000Z' }),
      fb({ client: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', feedback_index: 2, revoked: true, indexed_at: '2026-07-01T10:00:00.000Z' }),
    ];
    const f = buildFeedbackBlock([TOPPA], rows);
    expect(f.source).toBe('registry-mirror');
    expect(f.count).toBe(581);
    expect(f.average).toBeCloseTo(96.73, 2);
    expect(f.distinctClients).toBe(3);
    expect(f.sampled).toBe(4);
    expect(f.asOf).toBe('2026-08-30T10:00:00.000Z');
    expect(f.records[1].value).toBe(85);
    expect(f.records[3].revoked).toBe(true);
    expect(f.validators).toHaveLength(1);
    expect(f.validators[0]).toMatchObject({ agentId: 1870, value: 90, version: 'v0.2', revoked: false });
  });

  test('count-weighted average across agents; caps records at 10 and validators at 5', () => {
    const agents = [
      { ...TOPPA, agent_id: 1, feedback_count: 3, feedback_avg: '100' },
      { ...TOPPA, agent_id: 2, feedback_count: 1, feedback_avg: '60' },
    ];
    const rows = Array.from({ length: 30 }, (_, i) =>
      fb({
        agent_id: 1,
        client: i < 8 ? AK_VALIDATOR.validator : `0x${String(i).padStart(40, '0')}`,
        tag1: i < 8 ? AK_VALIDATOR.scheme.tag1 : 'x',
        feedback_index: i,
      }),
    );
    const f = buildFeedbackBlock(agents, rows);
    expect(f.count).toBe(4);
    expect(f.average).toBe(90);
    expect(f.records).toHaveLength(10);
    expect(f.validators).toHaveLength(5);
  });

  test('zero rows → count 0, average null, empty arrays', () => {
    const f = buildFeedbackBlock([{ ...TOPPA, feedback_count: 0, feedback_avg: null }], []);
    expect(f).toMatchObject({ count: 0, average: null, distinctClients: 0, sampled: 0, asOf: null, records: [], validators: [] });
  });
});

describe('buildDiscoveryBlock', () => {
  const payee = (over: Partial<EnrichmentPayeeRow>): EnrichmentPayeeRow => ({
    chain: 'celo',
    address: OWNER,
    source_agent_id: 1870,
    endpoint: 'https://api.toppa.cc/send-airtime',
    asset: '0x765de816845861e75a25fca122bb6898b8b1282a',
    network: 'eip155:42220',
    verified: true,
    discovered_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-20T00:00:00.000Z',
    ...over,
  });

  test('projects rows read-only, capped at 10', () => {
    const rows = Array.from({ length: 12 }, (_, i) => payee({ endpoint: `https://x/${i}` }));
    const d = buildDiscoveryBlock(rows);
    expect(d.endpoints).toHaveLength(10);
    expect(d.endpoints[0]).toEqual({
      endpoint: 'https://x/0',
      asset: '0x765de816845861e75a25fca122bb6898b8b1282a',
      network: 'eip155:42220',
      verified: true,
      sourceAgentId: 1870,
      lastSeenAt: '2026-08-20T00:00:00.000Z',
    });
  });
});

describe('buildExplain', () => {
  const base = {
    chain: 'celo' as const,
    provider: { score: 100, trustTier: 'Excellent', confidenceBadge: 'declared' as const },
    consumerHasSignal: false,
    txCount: 0,
    claimed: false,
    rankScore: 70 as number | null,
  };

  test('declared-only registry agent — the Toppa case', () => {
    const lines = buildExplain({
      ...base,
      registry: buildRegistryBlock([TOPPA], 1, 'celo'),
      declared: buildDeclaredBlock(TOPPA),
      feedback: buildFeedbackBlock([TOPPA], [
        fb({ client: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
        fb({ client: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', feedback_index: 2 }),
      ]),
      discovery: undefined,
    });
    expect(lines).toEqual([
      'Provider score 100 (Excellent), declared; no payment receipts on record, so the score comes from declared metadata only.',
      'Unclaimed by its operator.',
      'Owns 1 ERC-8004 agent on celo: "Toppa".',
      'Declared metadata scores 90/100 (11/12 rubric checks passed, scheme agentkarma_metadata v0.2).',
      '581 ERC-8004 feedback records from 2 distinct clients (sampled 2), average 96.7.',
      'Ranks on Explore at 70 (declared evidence is weighted ×0.7).',
      'No consumer (payment-behavior) signal.',
    ]);
  });

  test('receipt-backed Solana wallet with no registry data', () => {
    const lines = buildExplain({
      chain: 'solana',
      provider: { score: 78, trustTier: 'Good', confidenceBadge: 'receipt-backed' },
      consumerHasSignal: true,
      txCount: 12,
      claimed: true,
      rankScore: 78,
      registry: null,
    });
    expect(lines).toEqual([
      'Provider score 78 (Good), receipt-backed, from 12 indexed transactions.',
      'Claimed by its operator.',
      'No ERC-8004 registry identity found for this address on solana.',
    ]);
  });

  test('unverified payee is attributed to another agent, validators are called out, cap 10 lines', () => {
    const lines = buildExplain({
      ...base,
      registry: buildRegistryBlock([TOPPA], 3, 'celo'),
      declared: buildDeclaredBlock(TOPPA),
      feedback: buildFeedbackBlock([TOPPA], [
        fb({ client: AK_VALIDATOR.validator, tag1: AK_VALIDATOR.scheme.tag1, tag2: 'v0.2', value: '90' }),
      ]),
      discovery: buildDiscoveryBlock([{
        chain: 'celo', address: OWNER, source_agent_id: 42, endpoint: 'https://evil/x', asset: null,
        network: null, verified: false, discovered_at: 'a', last_seen_at: 'b',
      }]),
    });
    expect(lines).toContain('Owns 3 ERC-8004 agents on celo, including "Toppa".');
    expect(lines).toContain('1 of these is AK\'s own metadata attestation.');
    expect(lines).toContain('1 unverified x402 payee declaration points at this address from another agent (not attributed to this wallet).');
    expect(lines.length).toBeLessThanOrEqual(10);
  });
});
