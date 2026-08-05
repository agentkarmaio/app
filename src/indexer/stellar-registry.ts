/**
 * Stellar (trionlabs/stellar-8004) IdentityRegistry → `erc8004_agents` mirror.
 *
 * The Soroban counterpart to `erc8004-registry.ts`. Same destination table, same
 * `ScannedAgent` shape, same `upsertErc8004Agents` persistence — only the read
 * path differs, because Soroban has no multicall and no `eth_call`: every field
 * is its own `simulateTransaction` round-trip.
 *
 * WHY a per-agentId mirror instead of the `wallets` backfill that already
 * exists: `wallets` is keyed `(chain, address)`, and on Stellar one owner
 * commonly registers many agents (measured 2026-08-05 — 67 registered agentIds
 * collapse to 11 owner rows, hiding 56 agents). The mirror is keyed
 * `(chain, agent_id)`, so it represents the real population, exactly as it
 * already does for Celo (9757 rows) and Arc (2752).
 *
 * Registration decoding is delegated to `decodeRegistration` from the EVM
 * scanner — it is chain-agnostic URI handling (data:/raw-JSON/http(s)/ipfs,
 * SSRF-guarded) and gives Stellar ipfs:// support for free. Nothing is
 * duplicated; only the transport is Stellar-specific.
 *
 * Rate limiting: the public Soroban RPC throttles hard. Measured at concurrency
 * 3, a full 0..66 sweep 429s after ~15 agents and every later id fails
 * instantly. Each agent read is 4 round-trips (exists + owner + wallet + uri),
 * so request rate is ~4x agent rate. Every read goes through
 * `withRateLimitRetry`.
 */

import type { rpc } from '@stellar/stellar-sdk';
import type { Erc8004RegistrationStatus } from '@/db/schema';
import { scoreMetadataQuality } from '@/scoring/celo-metadata';
import { decodeRegistration, type ScannedAgent } from './erc8004-registry';
import {
  getStellarTotalAgents,
  readStellarAgentOwner,
  readStellarAgentUri,
  readStellarAgentWallet,
  stellarAgentExists,
} from '@/integrations/erc8004-stellar';

// ─── Rate-limit handling ────────────────────────────────────────────────────

/**
 * Distinguish an RPC throttle from a contract revert. A revert means "this
 * agentId does not exist" and must NEVER be retried; a 429 means "ask again
 * later" and must never be counted as missing.
 */
export function isRateLimited(message: string): boolean {
  return message.includes('429') || message.toLowerCase().includes('too many requests');
}

export interface RateLimitRetryOpts {
  /** Retries AFTER the initial attempt. Default 5. */
  retries?: number;
  /** First backoff step in ms; doubles each retry. Default 1500. */
  baseMs?: number;
  /** ±25% jitter so pool workers don't retry in lockstep. Default true. */
  jitter?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying ONLY on rate-limit errors with exponential backoff. */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: RateLimitRetryOpts = {},
): Promise<T> {
  const { retries = 5, baseMs = 1500, jitter = true } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRateLimited(msg) || attempt >= retries) throw err;
      const factor = jitter ? 0.75 + Math.random() * 0.5 : 1;
      await sleep(baseMs * 2 ** attempt * factor);
    }
  }
}

// ─── Reader abstraction ─────────────────────────────────────────────────────

/** Raw identity-registry fields for one agentId, before registration decoding. */
export interface StellarAgentIdentity {
  agentId: number;
  owner: string;
  /** null when `set_agent_wallet` was never called — callers fall back to owner. */
  agentWallet: string | null;
  agentURI: string;
}

/**
 * The three registry reads the scanner needs, injectable so the scan loop is
 * testable without a live Soroban RPC.
 */
export interface StellarRegistryReader {
  totalAgents(): Promise<number>;
  exists(agentId: number): Promise<boolean>;
  read(agentId: number): Promise<StellarAgentIdentity>;
}

/** Live reader backed by Soroban `simulateTransaction` view calls. */
export function makeStellarRegistryReader(server: rpc.Server): StellarRegistryReader {
  return {
    totalAgents: () => getStellarTotalAgents(server),
    exists: (agentId) => stellarAgentExists(server, agentId),
    async read(agentId) {
      const [owner, agentWallet, agentURI] = await Promise.all([
        readStellarAgentOwner(server, agentId),
        readStellarAgentWallet(server, agentId),
        readStellarAgentUri(server, agentId),
      ]);
      if (!owner) throw new Error(`agent ${agentId}: find_owner returned null`);
      return { agentId, owner, agentWallet, agentURI };
    },
  };
}

// ─── Mapping ────────────────────────────────────────────────────────────────

export interface MapOpts {
  /** Fetch http(s)/ipfs registrations. Off = mark 'pending' for a fast pass. */
  fetchRemote?: boolean;
  timeoutMs?: number;
}

/**
 * Project raw identity fields + the decoded registration into the `ScannedAgent`
 * row shape `upsertErc8004Agents` persists. Pure apart from the registration
 * fetch, which `decodeRegistration` performs (and SSRF-guards).
 *
 * Stellar has no zero-address sentinel: `get_agent_wallet` returns
 * `Option<Address>`, so an unset wallet is `null` and the agent's effective
 * operator IS the owner.
 */
export async function mapStellarAgentToScanned(
  identity: StellarAgentIdentity,
  opts: MapOpts = {},
): Promise<ScannedAgent> {
  const { registration, status } = await decodeRegistration(identity.agentURI, {
    fetchRemote: opts.fetchRemote ?? true,
    timeoutMs: opts.timeoutMs ?? 8000,
  });
  const registrationStatus: Erc8004RegistrationStatus = status;
  // tokenURI is load-bearing, not decoration: the rubric's 10-point
  // `tamperResistance` dimension checks whether the pointer is content-addressed
  // (data:/ipfs:/ar:) rather than a mutable https URL. Omitting it silently
  // under-scores every inline agent by 10.
  const metadataScore = scoreMetadataQuality({
    registration,
    tokenURI: identity.agentURI,
  }).score;

  return {
    agentId: identity.agentId,
    owner: identity.owner,
    agentWallet: identity.agentWallet ?? identity.owner,
    tokenURI: identity.agentURI || null,
    registration,
    registrationStatus,
    metadataScore,
  };
}

// ─── Scan loop ──────────────────────────────────────────────────────────────

export interface ScanStellarOpts extends MapOpts, RateLimitRetryOpts {
  reader: StellarRegistryReader;
  /** First agentId. Stellar ids are sequential from 0. */
  from?: number;
  /** Last agentId inclusive. Defaults to `totalAgents() - 1`. */
  to?: number;
  /** Parallel workers. Default 2 — the public RPC throttles above that. */
  concurrency?: number;
  onProgress?: (agentId: number, outcome: 'scanned' | 'missing' | 'error') => void;
}

export interface ScanStellarResult {
  agents: ScannedAgent[];
  /** agentIds probed (registered + unregistered). */
  attempted: number;
  /** Ids the registry reports as unregistered — a gap, not a failure. */
  missing: number;
  errors: Array<{ agentId: number; error: string }>;
}

export async function scanStellarRegistry(opts: ScanStellarOpts): Promise<ScanStellarResult> {
  const { reader, from = 0, concurrency = 2, onProgress } = opts;
  const retryOpts: RateLimitRetryOpts = {
    retries: opts.retries,
    baseMs: opts.baseMs,
    jitter: opts.jitter,
  };

  const to = opts.to ?? (await withRateLimitRetry(() => reader.totalAgents(), retryOpts)) - 1;

  const agents: ScannedAgent[] = [];
  const errors: Array<{ agentId: number; error: string }> = [];
  let missing = 0;
  let attempted = 0;
  let cursor = from;

  async function worker() {
    for (;;) {
      const id = cursor++;
      if (id > to) return;
      attempted++;
      try {
        const exists = await withRateLimitRetry(() => reader.exists(id), retryOpts);
        if (!exists) {
          missing++;
          onProgress?.(id, 'missing');
          continue;
        }
        const identity = await withRateLimitRetry(() => reader.read(id), retryOpts);
        agents.push(await mapStellarAgentToScanned(identity, opts));
        onProgress?.(id, 'scanned');
      } catch (err) {
        errors.push({ agentId: id, error: err instanceof Error ? err.message : String(err) });
        onProgress?.(id, 'error');
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  agents.sort((a, b) => a.agentId - b.agentId);
  return { agents, attempted, missing, errors };
}
