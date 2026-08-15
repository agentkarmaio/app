/// <reference types="bun-types" />
/**
 * Solana ERC-8004 (8004-solana) registry scanner — pure-helper + orchestrator tests.
 *
 * No live indexer API: the paged reader is injected. Covers the field mapping
 * into `ScannedAgent` (including the Solana-only `assetAddress`), the pagination
 * loop's stop conditions, and the two ways this scanner can silently corrupt
 * data: rows with no `agent_id` (the PK is `(chain, agent_id)`) and duplicate
 * ids across pages when the upstream offset drifts.
 *
 * Also pins the single most dangerous regression: Solana MUST NOT become a
 * registry-mirror chain, or the canonical agent population collapses from
 * 94,913 indexed wallets to ~1,470 registry rows.
 *
 * Run: bun test src/indexer/solana-registry.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  mapSolanaAgentToScanned,
  scanSolanaRegistry,
  type SolanaIndexedAgent,
  type SolanaRegistryReader,
} from './solana-registry';
import { isRegistryMirrorChain } from '@/lib/chain-meta';

const OWNER = 'Cf6UZkxsg41AczMyVyCQ5TBD5chf3Q2EYHaJfDp8SK9R';
const ASSET = 'ExcRu5WkL4Z79MbUhm3jfFqnodJp1jr1jSHiDYWZKWdE';
const WALLET = 'DuQ4jFMmVABWGxabYHFkGzdyeJgS1hp4wrRuCtsJgT9a';

const REG = {
  type: 'https://schema.org/SoftwareApplication',
  name: 'Test Agent',
  description: 'An agent used in tests',
};
const DATA_URI = `data:application/json,${encodeURIComponent(JSON.stringify(REG))}`;

function row(over: Partial<SolanaIndexedAgent> = {}): SolanaIndexedAgent {
  return {
    agent_id: 1470,
    asset: ASSET,
    owner: OWNER,
    agent_wallet: null,
    agent_uri: DATA_URI,
    feedback_count: 0,
    raw_avg_score: 0,
    ...over,
  };
}

/** Reader over a fixed row list, paging exactly like the upstream indexer API. */
function readerOver(rows: SolanaIndexedAgent[], pageSize = 250): SolanaRegistryReader {
  return {
    page: async (offset, limit) => rows.slice(offset, offset + Math.min(limit, pageSize)),
  };
}

// ─── Guard: Solana is NOT a registry-mirror chain ────────────────────────────

describe('registry-mirror chain guard', () => {
  test('solana is NOT a registry-mirror chain', () => {
    // If this flips to true, the canonical Solana population silently becomes
    // erc8004_agents (~1,470 rows) instead of wallets (94,913) — the homepage
    // counter and Explore both collapse. The mirror is SUPPLEMENTARY.
    expect(isRegistryMirrorChain('solana')).toBe(false);
  });

  test('the three real mirror chains still are', () => {
    expect(isRegistryMirrorChain('celo')).toBe(true);
    expect(isRegistryMirrorChain('arc')).toBe(true);
    expect(isRegistryMirrorChain('stellar')).toBe(true);
  });
});

// ─── Mapping ─────────────────────────────────────────────────────────────────

describe('mapSolanaAgentToScanned', () => {
  test('maps identity fields and carries the asset pubkey', async () => {
    const a = await mapSolanaAgentToScanned(row({ agent_wallet: WALLET }));
    expect(a.agentId).toBe(1470);
    expect(a.owner).toBe(OWNER);
    expect(a.agentWallet).toBe(WALLET);
    expect(a.assetAddress).toBe(ASSET);
    expect(a.tokenURI).toBe(DATA_URI);
    expect(a.registrationStatus).toBe('inline');
    expect(a.registration?.name).toBe('Test Agent');
  });

  test('null agent_wallet falls back to owner (the effective operator)', async () => {
    const a = await mapSolanaAgentToScanned(row({ agent_wallet: null }));
    expect(a.agentWallet).toBe(OWNER);
  });

  test('coerces a string agent_id to a number', async () => {
    const a = await mapSolanaAgentToScanned(row({ agent_id: '1470' }));
    expect(a.agentId).toBe(1470);
  });

  test('empty agent_uri yields status empty, not a throw', async () => {
    const a = await mapSolanaAgentToScanned(row({ agent_uri: null }));
    expect(a.registrationStatus).toBe('empty');
    expect(a.registration).toBeNull();
  });

  test('scores metadata WITH tokenURI — content-addressed beats mutable https', async () => {
    // Regression for feedback_metadata_scorer_needs_tokenuri: passing only
    // `registration` silently drops the 10-point tamperResistance dimension, so
    // a data: URI must outscore an https one for the SAME registration body.
    const inline = await mapSolanaAgentToScanned(row());
    const remote = await mapSolanaAgentToScanned(
      row({ agent_uri: 'https://example.com/agent.json' }),
      { fetchRemote: false },
    );
    expect(inline.metadataScore).toBeGreaterThan(remote.metadataScore);
  });

  test('maps the reputation aggregate from the indexed row', async () => {
    const a = await mapSolanaAgentToScanned(row({ feedback_count: 4, raw_avg_score: 82.5 }));
    expect(a.feedback).toEqual({ count: 4, sum: 330, avg: 82.5 });
  });

  test('zero feedback maps to a null-average aggregate, not 0', async () => {
    // avg 0 and "no feedback" are different claims; conflating them would show
    // an unrated agent as scoring zero.
    const a = await mapSolanaAgentToScanned(row({ feedback_count: 0, raw_avg_score: 0 }));
    expect(a.feedback).toEqual({ count: 0, sum: null, avg: null });
  });
});

// ─── Scan loop ───────────────────────────────────────────────────────────────

describe('scanSolanaRegistry', () => {
  test('pages until a short page ends the sweep', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ agent_id: i, asset: `asset${i}` }));
    const res = await scanSolanaRegistry({ reader: readerOver(rows), pageSize: 5 });
    expect(res.agents).toHaveLength(12);
    expect(res.pagesFetched).toBe(3); // 5 + 5 + 2 (short page stops it)
    expect(res.agents.map((a) => a.agentId)).toEqual([...Array(12).keys()]);
  });

  test('an exactly-full final page still terminates on the next empty page', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ agent_id: i, asset: `asset${i}` }));
    const res = await scanSolanaRegistry({ reader: readerOver(rows), pageSize: 5 });
    expect(res.agents).toHaveLength(10);
    expect(res.pagesFetched).toBe(3); // 5 + 5 + 0
  });

  test('maxAgents caps the sweep', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => row({ agent_id: i, asset: `asset${i}` }));
    const res = await scanSolanaRegistry({ reader: readerOver(rows), pageSize: 10, maxAgents: 25 });
    expect(res.agents).toHaveLength(25);
  });

  test('rows with no agent_id are skipped and counted, never persisted', async () => {
    // The mirror PK is (chain, agent_id). A row without one cannot be written;
    // defaulting it to 0 would collide every such agent onto a single row.
    const rows = [
      row({ agent_id: 1 }),
      row({ agent_id: null, asset: 'no-id' }),
      row({ agent_id: undefined, asset: 'also-no-id' }),
      row({ agent_id: 2 }),
    ];
    const res = await scanSolanaRegistry({ reader: readerOver(rows), pageSize: 10 });
    expect(res.agents.map((a) => a.agentId)).toEqual([1, 2]);
    expect(res.skippedNoAgentId).toBe(2);
  });

  test('non-numeric agent_id is skipped, not coerced to NaN', async () => {
    const rows = [row({ agent_id: 'abc' as unknown as string }), row({ agent_id: 7 })];
    const res = await scanSolanaRegistry({ reader: readerOver(rows), pageSize: 10 });
    expect(res.agents.map((a) => a.agentId)).toEqual([7]);
    expect(res.skippedNoAgentId).toBe(1);
  });

  test('deduplicates ids repeated across pages', async () => {
    // Upstream offset paging can re-serve a row when the table mutates mid-sweep.
    let call = 0;
    const reader: SolanaRegistryReader = {
      page: async () => {
        call++;
        if (call === 1) return [row({ agent_id: 1 }), row({ agent_id: 2 })];
        if (call === 2) return [row({ agent_id: 2 }), row({ agent_id: 3 })];
        return [];
      },
    };
    const res = await scanSolanaRegistry({ reader, pageSize: 2 });
    expect(res.agents.map((a) => a.agentId)).toEqual([1, 2, 3]);
    expect(res.duplicates).toBe(1);
  });

  test('a failing page is recorded and does not abort the sweep', async () => {
    let call = 0;
    const reader: SolanaRegistryReader = {
      page: async (offset) => {
        call++;
        if (call === 2) throw new Error('indexer 503');
        if (call > 3) return [];
        return [row({ agent_id: offset })];
      },
    };
    const res = await scanSolanaRegistry({ reader, pageSize: 1, retries: 0 });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].error).toContain('503');
    expect(res.agents.length).toBeGreaterThan(0);
  });

  test('reports progress per page', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ agent_id: i, asset: `asset${i}` }));
    const seen: number[] = [];
    await scanSolanaRegistry({
      reader: readerOver(rows),
      pageSize: 2,
      onProgress: (total) => seen.push(total),
    });
    expect(seen).toEqual([2, 4, 6, 6]);
  });
});
