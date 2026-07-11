/// <reference types="bun-types" />
/**
 * scoreMetadataQuality (v0.2) — DETERMINISTIC metadata-quality rubric.
 *
 * Asserts the contract that the /celo page advertises: a PURE function of the
 * registration JSON (+ the agentURI for tamper-resistance), max 100, same input
 * → same score, no network. Covers each v0.2 dimension's pass + fail path, the
 * graded description-substance band, the rubric/score consistency, and the
 * determinism guarantee.
 */
import { describe, expect, test } from 'bun:test';
import {
  scoreMetadataQuality,
  METADATA_RUBRIC,
  METADATA_SCHEME_VERSION,
  type MetadataAgent,
} from './celo-metadata';
import type { AgentRegistrationFile } from '@/integrations/erc8004-celo';

const SPEC_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

/** A registration that earns FULL marks on every dimension (score 100). */
function perfectRegistration(): AgentRegistrationFile {
  return {
    type: SPEC_TYPE,
    name: 'Loopuman',
    description:
      'Loopuman is an autonomous market-making agent operating across Solana and Celo. ' +
      'It quotes two-sided liquidity and settles via x402 receipts. Uptime is monitored continuously.',
    image: 'ipfs://bafkreigh2akiscaildc',
    x402Support: true,
    active: true,
    supportedTrust: ['feedback', 'inference-validation'],
    services: [
      { name: 'x402 quote', endpoint: 'https://api.loopuman.xyz/quote', version: '1.0' },
      { name: 'mcp', endpoint: 'https://api.loopuman.xyz/mcp' },
    ],
    registrations: [{ agentId: 9058, agentRegistry: '0x8004' }],
  };
}

/** A content-addressed agentURI → full tamper-resistance credit. */
function perfectAgent(): MetadataAgent {
  return { registration: perfectRegistration(), tokenURI: 'ipfs://bafyregistration' };
}

describe('scoreMetadataQuality v0.2 — rubric invariants', () => {
  test('rubric sums to exactly 100', () => {
    expect(METADATA_RUBRIC.reduce((s, d) => s + d.max, 0)).toBe(100);
  });

  test('breakdown keys match the rubric keys exactly', () => {
    const result = scoreMetadataQuality(perfectAgent());
    expect(Object.keys(result.breakdown).sort()).toEqual(
      METADATA_RUBRIC.map((d) => d.key).sort(),
    );
  });

  test('a perfect registration scores 100', () => {
    const { score, breakdown } = scoreMetadataQuality(perfectAgent());
    expect(score).toBe(100);
    for (const dim of METADATA_RUBRIC) {
      expect(breakdown[dim.key]).toBe(dim.max);
    }
  });

  test('score never exceeds 100 and equals the breakdown sum', () => {
    const { score, breakdown } = scoreMetadataQuality(perfectAgent());
    expect(score).toBe(Object.values(breakdown).reduce((a, b) => a + b, 0));
    expect(score).toBeLessThanOrEqual(100);
  });

  test('scheme version constant is v0.2', () => {
    expect(METADATA_SCHEME_VERSION).toBe('v0.2');
  });
});

describe('scoreMetadataQuality v0.2 — determinism', () => {
  test('same input yields the same score across repeated calls', () => {
    const agent = perfectAgent();
    const a = scoreMetadataQuality(agent);
    const b = scoreMetadataQuality(agent);
    const c = scoreMetadataQuality({ ...agent, registration: { ...agent.registration } });
    expect(a.score).toBe(b.score);
    expect(b.score).toBe(c.score);
    expect(a.breakdown).toEqual(b.breakdown);
  });

  test('missing registration scores 0', () => {
    expect(scoreMetadataQuality({ registration: null }).score).toBe(0);
    expect(scoreMetadataQuality({ registration: undefined }).score).toBe(0);
  });
});

describe('scoreMetadataQuality v0.2 — per-dimension pass/fail', () => {
  test('resolves: present vs missing', () => {
    expect(scoreMetadataQuality({ registration: {} }).breakdown.resolves).toBe(15);
    expect(scoreMetadataQuality({ registration: null }).breakdown.resolves).toBe(0);
  });

  test('typeCorrect: spec URL passes, anything else fails', () => {
    expect(scoreMetadataQuality({ registration: { type: SPEC_TYPE } }).breakdown.typeCorrect).toBe(10);
    expect(scoreMetadataQuality({ registration: { type: 'something/else' } }).breakdown.typeCorrect).toBe(0);
    expect(scoreMetadataQuality({ registration: {} }).breakdown.typeCorrect).toBe(0);
  });

  test('name: non-empty passes, blank/whitespace fails', () => {
    expect(scoreMetadataQuality({ registration: { name: 'Bot' } }).breakdown.name).toBe(8);
    expect(scoreMetadataQuality({ registration: { name: '   ' } }).breakdown.name).toBe(0);
    expect(scoreMetadataQuality({ registration: {} }).breakdown.name).toBe(0);
  });

  test('descriptionSubstance: full / partial / none', () => {
    // Full: long + multi-sentence.
    const full = scoreMetadataQuality({
      registration: {
        description:
          'This agent provides automated liquidity provisioning on decentralized exchanges. ' +
          'It rebalances positions hourly and reports settlement via receipts.',
      },
    });
    expect(full.breakdown.descriptionSubstance).toBe(12);

    // Partial: present but thin — ≥30 chars yet under the full-substance bar
    // (single sentence and < 120 chars).
    const partial = scoreMetadataQuality({
      registration: { description: 'A helpful automated trading bot for DEX liquidity' },
    });
    expect(partial.breakdown.descriptionSubstance).toBe(6);

    // None: empty / too short.
    expect(scoreMetadataQuality({ registration: { description: 'bot' } }).breakdown.descriptionSubstance).toBe(0);
    expect(scoreMetadataQuality({ registration: {} }).breakdown.descriptionSubstance).toBe(0);
  });

  test('image + imageUrlValid: declared+valid, declared+malformed, absent', () => {
    const ipfs = scoreMetadataQuality({ registration: { image: 'ipfs://bafkqaaa' } });
    expect(ipfs.breakdown.image).toBe(7);
    expect(ipfs.breakdown.imageUrlValid).toBe(3);

    const httpsOk = scoreMetadataQuality({ registration: { image: 'https://cdn.example.com/logo.png' } });
    expect(httpsOk.breakdown.imageUrlValid).toBe(3);

    // Declared but plain http:// (mutable + insecure) → no validity credit.
    const httpBad = scoreMetadataQuality({ registration: { image: 'http://insecure.example/logo.png' } });
    expect(httpBad.breakdown.image).toBe(7);
    expect(httpBad.breakdown.imageUrlValid).toBe(0);

    // Declared but garbage → no validity credit.
    const garbage = scoreMetadataQuality({ registration: { image: 'not a url' } });
    expect(garbage.breakdown.image).toBe(7);
    expect(garbage.breakdown.imageUrlValid).toBe(0);

    const absent = scoreMetadataQuality({ registration: {} });
    expect(absent.breakdown.image).toBe(0);
    expect(absent.breakdown.imageUrlValid).toBe(0);
  });

  test('services: ≥1 valid service passes, none fails', () => {
    const one = scoreMetadataQuality({
      registration: { services: [{ name: 'api', endpoint: 'https://x.example/api' }] },
    });
    expect(one.breakdown.services).toBe(8);
    expect(scoreMetadataQuality({ registration: { services: [] } }).breakdown.services).toBe(0);
    // Endpoint-less entry is not a valid service.
    expect(
      scoreMetadataQuality({
        registration: { services: [{ name: 'api', endpoint: '' }] },
      }).breakdown.services,
    ).toBe(0);
  });

  test('serviceRichness: multiple services / typed capability / x402Support pass; single untyped fails', () => {
    // ≥2 services.
    expect(
      scoreMetadataQuality({
        registration: {
          services: [
            { name: 'a', endpoint: 'https://x.example/a' },
            { name: 'b', endpoint: 'https://x.example/b' },
          ],
        },
      }).breakdown.serviceRichness,
    ).toBe(8);

    // Single service but versioned (typed capability).
    expect(
      scoreMetadataQuality({
        registration: { services: [{ name: 'quote', endpoint: 'https://x.example/q', version: '2.1' }] },
      }).breakdown.serviceRichness,
    ).toBe(8);

    // Single MCP-named service.
    expect(
      scoreMetadataQuality({
        registration: { services: [{ name: 'MCP server', endpoint: 'https://x.example/mcp' }] },
      }).breakdown.serviceRichness,
    ).toBe(8);

    // Single untyped service + declared x402Support flag still earns richness.
    expect(
      scoreMetadataQuality({
        registration: { x402Support: true, services: [{ name: 'api', endpoint: 'https://x.example/a' }] },
      }).breakdown.serviceRichness,
    ).toBe(8);

    // Single untyped service, no x402 flag → no richness.
    expect(
      scoreMetadataQuality({
        registration: { services: [{ name: 'api', endpoint: 'https://x.example/a' }] },
      }).breakdown.serviceRichness,
    ).toBe(0);

    // No services → no richness.
    expect(scoreMetadataQuality({ registration: {} }).breakdown.serviceRichness).toBe(0);
  });

  test('endpointUrlValid: all valid passes, any malformed fails', () => {
    expect(
      scoreMetadataQuality({
        registration: {
          services: [
            { name: 'a', endpoint: 'https://x.example/a' },
            { name: 'b', endpoint: 'ipfs://bafyendpoint' },
          ],
        },
      }).breakdown.endpointUrlValid,
    ).toBe(6);

    // One plain-http endpoint poisons the credit.
    expect(
      scoreMetadataQuality({
        registration: {
          services: [
            { name: 'a', endpoint: 'https://x.example/a' },
            { name: 'b', endpoint: 'http://insecure.example/b' },
          ],
        },
      }).breakdown.endpointUrlValid,
    ).toBe(0);

    // No services → no credit.
    expect(scoreMetadataQuality({ registration: {} }).breakdown.endpointUrlValid).toBe(0);
  });

  test('activeAndTrust: needs BOTH active:true and non-empty supportedTrust', () => {
    expect(
      scoreMetadataQuality({ registration: { active: true, supportedTrust: ['feedback'] } }).breakdown.activeAndTrust,
    ).toBe(8);
    // active but no trust.
    expect(scoreMetadataQuality({ registration: { active: true, supportedTrust: [] } }).breakdown.activeAndTrust).toBe(0);
    // trust but not active.
    expect(scoreMetadataQuality({ registration: { supportedTrust: ['feedback'] } }).breakdown.activeAndTrust).toBe(0);
  });

  test('tamperResistance: content-addressed URI passes, mutable https fails', () => {
    expect(scoreMetadataQuality({ registration: {}, tokenURI: 'ipfs://bafyx' }).breakdown.tamperResistance).toBe(10);
    expect(scoreMetadataQuality({ registration: {}, tokenURI: 'ar://abc' }).breakdown.tamperResistance).toBe(10);
    expect(
      scoreMetadataQuality({ registration: {}, tokenURI: 'data:application/json;base64,e30=' }).breakdown.tamperResistance,
    ).toBe(10);
    // Mutable https → no credit.
    expect(
      scoreMetadataQuality({ registration: {}, tokenURI: 'https://example.com/agent.json' }).breakdown.tamperResistance,
    ).toBe(0);
    // No URI at all → no credit (and no crash).
    expect(scoreMetadataQuality({ registration: {} }).breakdown.tamperResistance).toBe(0);
    // agentURI alias also honored.
    expect(scoreMetadataQuality({ registration: {}, agentURI: 'ipfs://bafyz' }).breakdown.tamperResistance).toBe(10);
  });

  test('crossChain: ≥1 registration entry passes, none fails', () => {
    expect(
      scoreMetadataQuality({ registration: { registrations: [{ agentId: 1, agentRegistry: '0x1' }] } }).breakdown.crossChain,
    ).toBe(5);
    expect(scoreMetadataQuality({ registration: { registrations: [] } }).breakdown.crossChain).toBe(0);
    expect(scoreMetadataQuality({ registration: {} }).breakdown.crossChain).toBe(0);
  });
});
