/// <reference types="bun-types" />
/**
 * Gate tests for the Stellar attestation policy layer.
 *
 * These are the rules that decide what goes on a public, permanent ledger, so
 * each one is pinned by a test rather than by a comment: skipping is always
 * preferable to publishing a score AK cannot stand behind.
 *
 * Run: bun test src/integrations/erc8004-stellar-attest.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  ATTEST_MIN_SCORE,
  MIN_XLM_BALANCE,
  buildStellarAssessment,
  classifyTarget,
  readStellarFeeAccount,
} from './erc8004-stellar-attest';
import { feedbackHashFromJson } from './erc8004-stellar-publish';
import type { StellarAgent } from './erc8004-stellar';

const AK = 'GA6OBKNSBCY2I4PQLGNNQQXRXWXRUBRLSKLM7YP7QBBSRW7LCZFLHODV';
const OTHER = 'GDUY7J7A33TQWOSOQGDO776GGLM3UQERL4J3SPT56F6YS4ID7MLDERI4';

function agentFixture(over: Partial<StellarAgent> = {}): StellarAgent {
  return {
    agentId: 20,
    owner: OTHER,
    agentWallet: OTHER,
    agentURI: 'data:application/json;base64,eyJuYW1lIjoiYSJ9',
    registration: { name: 'a' } as StellarAgent['registration'],
    ...over,
  };
}

describe('classifyTarget', () => {
  test('publishes a resolvable agent at or above the floor', () => {
    expect(classifyTarget({ agent: agentFixture(), score: 70, akAccount: AK }).decision).toBe('publish');
    expect(classifyTarget({ agent: agentFixture(), score: 99, akAccount: AK }).decision).toBe('publish');
  });

  test('never rates AK\'s own registration', () => {
    const v = classifyTarget({ agent: agentFixture({ owner: AK }), score: 100, akAccount: AK });
    expect(v.decision).toBe('skipped_self');
  });

  test('an unregistered agentId is not_registered, not a zero score', () => {
    expect(classifyTarget({ agent: null, score: null, akAccount: AK }).decision).toBe('not_registered');
  });

  // The honesty gate that matters most: ipfs:// / ar:// is OUR fetcher's gap.
  // The rubric REWARDS content-addressed URIs, so attesting a 0 would publish
  // our limitation as the agent's quality — permanently.
  test('refuses an unsupported URI scheme instead of publishing 0', () => {
    const v = classifyTarget({
      agent: agentFixture({
        agentURI: 'ipfs://bafy…',
        registration: null,
        registrationError: 'unsupported URI scheme: ipfs://bafy…',
      }),
      score: 0,
      akAccount: AK,
    });
    expect(v.decision).toBe('unsupported_uri');
    expect(v.reason).toContain('ipfs');
  });

  test('an unreachable https URL is unresolved (skipped), never scored as 0', () => {
    const v = classifyTarget({
      agent: agentFixture({
        agentURI: 'https://gone.example/agent.json',
        registration: null,
        registrationError: 'Horizon 404',
      }),
      score: null,
      akAccount: AK,
    });
    expect(v.decision).toBe('unresolved');
  });

  test('below the floor is silence, not a low broadcast', () => {
    const v = classifyTarget({ agent: agentFixture(), score: 69, akAccount: AK });
    expect(v.decision).toBe('below_threshold');
    expect(v.reason).toContain('69');
  });

  test('identity and readability are checked before the score', () => {
    // A self-owned agent with an unreadable URI must report the SELF reason —
    // a skip that names the wrong cause hides a real problem.
    const v = classifyTarget({
      agent: agentFixture({ owner: AK, registration: null, registrationError: 'unsupported URI scheme: ar://x' }),
      score: 0,
      akAccount: AK,
    });
    expect(v.decision).toBe('skipped_self');
  });

  test('the default floor matches the Celo drip', () => {
    expect(ATTEST_MIN_SCORE).toBe(70);
    expect(classifyTarget({ agent: agentFixture(), score: ATTEST_MIN_SCORE - 1, akAccount: AK }).decision)
      .toBe('below_threshold');
  });
});

describe('buildStellarAssessment', () => {
  const base = {
    agentId: 20,
    akAccount: AK,
    scheme: 'agentkarma_metadata',
    version: 'v0.2',
    score: 87,
    breakdown: { resolves: 20, tamperResistance: 10 },
    notes: ['inline data: URI'],
    now: () => new Date('2026-09-10T00:00:00.000Z'),
  };

  // Parity contract: the URI's decoded CONTENT must be exactly what the hash
  // covers, or a verifier can never reconcile the two.
  test('feedbackUri decodes to the payload the hash covers', () => {
    const { payload, feedbackUri } = buildStellarAssessment(base);
    const b64 = feedbackUri.slice(feedbackUri.indexOf(',') + 1);
    const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    expect(decoded).toEqual(payload);
    expect(feedbackHashFromJson(decoded)).toEqual(feedbackHashFromJson(payload));
  });

  test('carries the disclosed rater identity and rubric version', () => {
    const { payload } = buildStellarAssessment(base);
    expect(payload).toMatchObject({
      rater: 'AgentKarma',
      raterAccount: AK,
      chain: 'stellar',
      target: 20,
      scheme: 'agentkarma_metadata',
      version: 'v0.2',
      score: 87,
    });
  });

  test('is deterministic for a fixed clock', () => {
    expect(buildStellarAssessment(base).feedbackUri).toBe(buildStellarAssessment(base).feedbackUri);
  });
});

describe('readStellarFeeAccount', () => {
  const account = (xlm: string) => async () => ({
    sequence: '273989445714182147',
    balances: [{ asset_type: 'native', balance: xlm }],
  });

  test('above the floor is ok, and reports balance + sequence', async () => {
    const r = await readStellarFeeAccount(AK, { fetchJson: account('34.5017976') });
    expect(r.state).toBe('ok');
    expect(r.xlm).toBeCloseTo(34.5017976);
    expect(r.sequence).toBe('273989445714182147');
  });

  test('below the floor is low — the caller refuses to start', async () => {
    const r = await readStellarFeeAccount(AK, { fetchJson: account('1.5') });
    expect(r.state).toBe('low');
    expect(MIN_XLM_BALANCE).toBe(5);
  });

  // A never-funded signing account is a distinct, actionable state. The prior
  // six-hour Stellar page was a TARGET account 404ing; this is AK's own.
  test('a Horizon 404 is absent, not a thrown outage', async () => {
    const r = await readStellarFeeAccount(AK, {
      fetchJson: async () => {
        throw Object.assign(new Error('Horizon 404 Not Found'), { status: 404 });
      },
    });
    expect(r.state).toBe('absent');
    expect(r.xlm).toBe(0);
  });

  // Not knowing the balance is NOT the same as knowing it is fine.
  test('any other Horizon failure raises', async () => {
    await expect(
      readStellarFeeAccount(AK, {
        fetchJson: async () => {
          throw Object.assign(new Error('Horizon 503'), { status: 503 });
        },
      }),
    ).rejects.toThrow(/503/);
  });
});
