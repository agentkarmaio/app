/// <reference types="bun-types" />
/**
 * Stellar ERC-8004 registry scanner — pure-helper + orchestrator tests.
 *
 * No live Soroban RPC: every contract read is injected. Covers the field
 * mapping into `ScannedAgent`, the 429 backoff policy (retry rate limits,
 * never retry a contract revert), and the scan loop's missing/error accounting.
 *
 * Run: bun test src/indexer/stellar-registry.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  mapStellarAgentToScanned,
  isRateLimited,
  withRateLimitRetry,
  scanStellarRegistry,
  type StellarRegistryReader,
} from './stellar-registry';

const OWNER = 'GA6OBKNSBCY2I4PQLGNNQQXRXWXRUBRLSKLM7YP7QBBSRW7LCZFLHODV';
const WALLET = 'GCIKP52ZNC4SEPLHKXIA6KBBIBTVRLNDIOTDBHQ3VEPSU4SY7JMCYSDK';

const REG = {
  type: 'https://schema.org/SoftwareApplication',
  name: 'Test Agent',
  description: 'A reasonably substantial description of what this agent does.',
  image: 'https://example.com/a.png',
  services: [{ name: 'summarize', endpoint: 'https://example.com/x402' }],
};

const dataUri = (obj: unknown) =>
  'data:application/json;base64,' + Buffer.from(JSON.stringify(obj)).toString('base64');

describe('mapStellarAgentToScanned', () => {
  test('maps an inline-registration agent', async () => {
    const s = await mapStellarAgentToScanned({
      agentId: 66,
      owner: OWNER,
      agentWallet: WALLET,
      agentURI: dataUri(REG),
    });
    expect(s.agentId).toBe(66);
    expect(s.owner).toBe(OWNER);
    expect(s.agentWallet).toBe(WALLET);
    expect(s.tokenURI).toBe(dataUri(REG));
    expect(s.registrationStatus).toBe('inline');
    expect(s.registration?.name).toBe('Test Agent');
    expect(s.metadataScore).toBeGreaterThan(0);
  });

  // Regression: the first cut passed only { registration } to scoreMetadataQuality,
  // dropping tokenURI. The rubric's 10-point tamperResistance dimension reads that
  // pointer, so every inline agent scored 10 below its wallets-backfill score.
  test('credits tamper-resistance for a content-addressed agentURI', async () => {
    const inline = await mapStellarAgentToScanned({
      agentId: 1, owner: OWNER, agentWallet: OWNER, agentURI: dataUri(REG),
    });
    const hosted = await mapStellarAgentToScanned(
      { agentId: 2, owner: OWNER, agentWallet: OWNER, agentURI: 'https://example.com/agent.json' },
      { fetchRemote: false },
    );
    expect(inline.tokenURI).toContain('data:application/json');
    expect(inline.metadataScore).toBeGreaterThanOrEqual(hosted.metadataScore + 10);
  });

  test('falls back to owner when agentWallet is unset', async () => {
    const s = await mapStellarAgentToScanned({
      agentId: 7,
      owner: OWNER,
      agentWallet: null,
      agentURI: dataUri(REG),
    });
    expect(s.agentWallet).toBe(OWNER);
  });

  test('empty URI → empty status, zero score', async () => {
    const s = await mapStellarAgentToScanned({
      agentId: 8,
      owner: OWNER,
      agentWallet: OWNER,
      agentURI: '',
    });
    expect(s.registrationStatus).toBe('empty');
    expect(s.registration).toBeNull();
    expect(s.metadataScore).toBe(0);
  });

  test('malformed data URI → invalid status', async () => {
    const s = await mapStellarAgentToScanned({
      agentId: 9,
      owner: OWNER,
      agentWallet: OWNER,
      agentURI: 'data:application/json;base64,!!!not-base64!!!',
    });
    expect(s.registrationStatus).toBe('invalid');
    expect(s.registration).toBeNull();
  });

  test('http URI is not fetched when fetchRemote is off → pending', async () => {
    const s = await mapStellarAgentToScanned(
      { agentId: 10, owner: OWNER, agentWallet: OWNER, agentURI: 'https://example.com/agent.json' },
      { fetchRemote: false },
    );
    expect(s.registrationStatus).toBe('pending');
  });
});

describe('isRateLimited', () => {
  test('detects Soroban RPC 429s', () => {
    expect(isRateLimited('Request failed with status code 429')).toBe(true);
    expect(isRateLimited('429 Too Many Requests')).toBe(true);
    expect(isRateLimited('too many requests, slow down')).toBe(true);
  });

  test('does not treat a contract revert as a rate limit', () => {
    expect(isRateLimited('HostError: Error(Contract, #2)')).toBe(false);
    expect(isRateLimited('AgentNotFound')).toBe(false);
    expect(isRateLimited('timed out after 20000ms')).toBe(false);
  });
});

describe('withRateLimitRetry', () => {
  test('retries a 429 and returns the eventual success', async () => {
    let calls = 0;
    const out = await withRateLimitRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('Request failed with status code 429');
        return 'ok';
      },
      { retries: 5, baseMs: 1, jitter: false },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  test('does not retry a contract revert', async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls++;
          throw new Error('HostError: Error(Contract, #2)');
        },
        { retries: 5, baseMs: 1, jitter: false },
      ),
    ).rejects.toThrow('Contract');
    expect(calls).toBe(1);
  });

  test('gives up after the retry budget and rethrows the 429', async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls++;
          throw new Error('429');
        },
        { retries: 2, baseMs: 1, jitter: false },
      ),
    ).rejects.toThrow('429');
    expect(calls).toBe(3); // initial + 2 retries
  });
});

// ─── scanStellarRegistry ─────────────────────────────────────────────────────

function fakeReader(registered: Record<number, { owner: string; wallet: string | null; uri: string }>): StellarRegistryReader {
  return {
    async totalAgents() {
      return Math.max(...Object.keys(registered).map(Number)) + 1;
    },
    async exists(id) {
      return registered[id] != null;
    },
    async read(id) {
      const r = registered[id];
      if (!r) throw new Error('HostError: Error(Contract, #2)');
      return { agentId: id, owner: r.owner, agentWallet: r.wallet, agentURI: r.uri };
    },
  };
}

describe('scanStellarRegistry', () => {
  test('scans the id range and returns one ScannedAgent per registered id', async () => {
    const reader = fakeReader({
      0: { owner: OWNER, wallet: WALLET, uri: dataUri(REG) },
      1: { owner: WALLET, wallet: null, uri: dataUri(REG) },
      3: { owner: OWNER, wallet: OWNER, uri: '' },
    });
    const res = await scanStellarRegistry({ reader, from: 0, to: 3 });
    expect(res.attempted).toBe(4);
    expect(res.agents.map((a) => a.agentId).sort((a, b) => a - b)).toEqual([0, 1, 3]);
    expect(res.missing).toBe(1);
    expect(res.errors).toHaveLength(0);
    // Agent 1 has no bound wallet → owner fallback.
    expect(res.agents.find((a) => a.agentId === 1)!.agentWallet).toBe(WALLET);
  });

  test('resolves the tip from totalAgents when `to` is omitted', async () => {
    const reader = fakeReader({
      0: { owner: OWNER, wallet: OWNER, uri: dataUri(REG) },
      1: { owner: OWNER, wallet: OWNER, uri: dataUri(REG) },
    });
    const res = await scanStellarRegistry({ reader, from: 0 });
    expect(res.attempted).toBe(2);
    expect(res.agents).toHaveLength(2);
  });

  test('records a read failure as an error without dropping the rest of the range', async () => {
    const base = fakeReader({
      0: { owner: OWNER, wallet: OWNER, uri: dataUri(REG) },
      1: { owner: OWNER, wallet: OWNER, uri: dataUri(REG) },
    });
    const reader: StellarRegistryReader = {
      ...base,
      async read(id) {
        if (id === 1) throw new Error('socket hang up');
        return base.read(id);
      },
    };
    const res = await scanStellarRegistry({ reader, from: 0, to: 1, retries: 0 });
    expect(res.agents.map((a) => a.agentId)).toEqual([0]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].agentId).toBe(1);
  });
});
