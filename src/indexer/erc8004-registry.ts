/**
 * Generic ERC-8004 registry scanner — mirrors an EVM IdentityRegistry +
 * ReputationRegistry into AgentKarma's `erc8004_agents` / `erc8004_feedback`
 * tables so AK can match 8004scan's per-network agent + feedback totals and
 * scan every registered agent (not just unique owner addresses).
 *
 * Strategy (Celo tip ≈ 9.5k agents, ~23k feedbacks):
 *   1. Binary-search the registry tip — largest agentId whose ownerOf() does
 *      not revert. ERC-8004 mints sequential ids from 1 with no totalSupply().
 *   2. Multicall owner + agentWallet + tokenURI across the id range (allowFailure
 *      so burned/gapped ids skip cleanly). Multicall3 is live on Celo + Arc at
 *      the canonical 0xcA11… address, so ~19k reads collapse to ~20 eth_calls.
 *   3. Decode registration: ~84% of Celo agents publish inline data:/raw-JSON
 *      (instant), the rest are http/ipfs (bounded best-effort fetch).
 *   4. Multicall readAllFeedback per agent → per-record feedback rows.
 *   5. Batch-upsert agents (identity first so the feedback FK target exists),
 *      then feedback, then re-upsert agents with the denormalized
 *      feedback_count/sum/avg so the registry stat is a cheap COUNT/SUM.
 *
 * Pure helpers (decode/parse/chunk) are exported for unit tests; the I/O
 * orchestrator takes injected persist fns so it runs against a fake in tests.
 */

import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { gunzipSync } from 'zlib';
import type { Erc8004RegistryConfig } from '@/config/erc8004-registries';
import type { AgentRegistrationFile } from '@/integrations/erc8004-celo';
import type { Erc8004RegistrationStatus } from '@/db/schema';
import { scoreMetadataQuality } from '@/scoring/celo-metadata';
import { safeFetchJson, type DnsLookup } from '@/lib/ssrf-guard';

const ONE = BigInt(1);
const TWO = BigInt(2);

// ─── ABIs ───────────────────────────────────────────────────────────────────

const IDENTITY_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
]);

const REPUTATION_ABI = parseAbi([
  'function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)',
]);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FeedbackAgg {
  count: number;
  sum: number | null;
  avg: number | null;
}

export interface ScannedAgent {
  agentId: number;
  owner: string;
  agentWallet: string | null;
  tokenURI: string | null;
  registration: AgentRegistrationFile | null;
  registrationStatus: Erc8004RegistrationStatus;
  metadataScore: number;
  /** Denormalized reputation aggregate, set during the feedback pass. */
  feedback?: FeedbackAgg;
}

export interface ScannedFeedback {
  agentId: number;
  client: string;
  feedbackIndex: number;
  rawValue: string;
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
}

export interface RegistryScanResult {
  chain: string;
  tip: number;
  agentsScanned: number;
  agentsPersisted: number;
  feedbackScanned: number;
  feedbackPersisted: number;
  errors: number;
}

export type PersistAgents = (chain: string, agents: ScannedAgent[]) => Promise<number>;
export type PersistFeedback = (chain: string, feedback: ScannedFeedback[]) => Promise<number>;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Decode an ERC-8004 registration tokenURI. Handles every scheme seen in the
 * wild on Celo: inline data: URIs (base64 / gzip / utf8), bare raw JSON, http(s),
 * and ipfs://. `fetchRemote=false` skips network schemes (marks 'pending') for a
 * fast first pass — remote enrichment can run in a bounded second sweep.
 */
export async function decodeRegistration(
  uri: string | null | undefined,
  opts: { fetchRemote?: boolean; timeoutMs?: number; ipfsGateway?: string; lookup?: DnsLookup } = {},
): Promise<{ registration: AgentRegistrationFile | null; status: Erc8004RegistrationStatus }> {
  const { fetchRemote = true, timeoutMs = 6000, ipfsGateway = 'https://ipfs.io/ipfs/', lookup } = opts;
  if (!uri || uri.trim().length === 0) return { registration: null, status: 'empty' };

  // Inline, fully on-chain metadata: data:application/json[;base64][;enc=gzip],…
  if (uri.startsWith('data:')) {
    try {
      const commaIdx = uri.indexOf(',');
      if (commaIdx < 0) return { registration: null, status: 'invalid' };
      const header = uri.slice(5, commaIdx);
      const body = uri.slice(commaIdx + 1);
      const params = header.split(';');
      const isBase64 = params.includes('base64');
      const isGzip = params.some((p) => p.startsWith('enc=gzip'));
      let buf = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf-8');
      if (isGzip) buf = Buffer.from(gunzipSync(buf));
      return { registration: JSON.parse(buf.toString('utf-8')) as AgentRegistrationFile, status: 'inline' };
    } catch {
      return { registration: null, status: 'invalid' };
    }
  }

  // Bare raw JSON published directly as the tokenURI (no data: prefix).
  const trimmed = uri.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      return { registration: JSON.parse(trimmed) as AgentRegistrationFile, status: 'inline' };
    } catch {
      return { registration: null, status: 'invalid' };
    }
  }

  // Network schemes — only when fetchRemote is on.
  let fetchUrl: string | null = null;
  if (uri.startsWith('http://') || uri.startsWith('https://')) fetchUrl = uri;
  else if (uri.startsWith('ipfs://')) fetchUrl = ipfsGateway + uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
  else return { registration: null, status: 'invalid' }; // ar:// etc — unsupported for now

  if (!fetchRemote) return { registration: null, status: 'pending' };

  // SSRF guard: validate host (incl. every redirect hop) is public before any
  // request and cap the body — tokenURIs are attacker-controlled on-chain data.
  try {
    const json = (await safeFetchJson(fetchUrl, { timeoutMs, lookup })) as AgentRegistrationFile;
    return { registration: json, status: 'fetched' };
  } catch {
    return { registration: null, status: 'unreachable' };
  }
}

/**
 * Flatten the 7 parallel arrays readAllFeedback returns into per-record rows.
 * One row per array index = one feedback record (matches 8004scan's count).
 */
export function parseFeedbackArrays(agentId: number, result: readonly unknown[]): ScannedFeedback[] {
  const [clients, indexes, values, decimals, tag1s, tag2s, revoked] = result as [
    readonly string[], readonly bigint[], readonly bigint[], readonly number[],
    readonly string[], readonly string[], readonly boolean[],
  ];
  const out: ScannedFeedback[] = [];
  for (let i = 0; i < clients.length; i++) {
    const dec = Number(decimals[i] ?? 0);
    const raw = values[i] ?? BigInt(0);
    out.push({
      agentId,
      client: clients[i].toLowerCase(),
      feedbackIndex: Number(indexes[i]),
      rawValue: raw.toString(),
      value: Number(raw) / 10 ** dec,
      valueDecimals: dec,
      tag1: tag1s[i] ?? '',
      tag2: tag2s[i] ?? '',
      revoked: Boolean(revoked[i]),
    });
  }
  return out;
}

/** Aggregate a per-agent feedback list into the denormalized agent columns.
 *  Only finite, non-revoked values feed sum/avg so one malformed outlier can't
 *  NaN the aggregate; `count` still reflects every record (parity with 8004scan). */
export function aggregateAgentFeedback(records: ScannedFeedback[]): FeedbackAgg {
  const live = records.filter((r) => !r.revoked && Number.isFinite(r.value));
  if (live.length === 0) return { count: records.length, sum: null, avg: null };
  const sum = live.reduce((a, r) => a + r.value, 0);
  return { count: records.length, sum, avg: sum / live.length };
}

// ─── Client + chain reads ──────────────────────────────────────────────────────

export function makeRegistryClient(config: Erc8004RegistryConfig): PublicClient {
  const rpcUrl = process.env[config.rpcEnvVar];
  return createPublicClient({
    chain: config.viemChain,
    transport: http(rpcUrl, { batch: true, retryCount: 3, retryDelay: 400 }),
  }) as PublicClient;
}

/** Largest agentId whose ownerOf() does not revert (registry tip). 0 = empty. */
export async function findRegistryTip(
  client: Pick<PublicClient, 'readContract'>,
  identityRegistry: `0x${string}`,
): Promise<number> {
  const exists = async (id: bigint): Promise<boolean> => {
    try {
      await client.readContract({ address: identityRegistry, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [id] });
      return true;
    } catch {
      return false;
    }
  };
  if (!(await exists(ONE))) return 0;
  let lo = ONE, hi = TWO;
  while (await exists(hi)) { lo = hi; hi *= TWO; }
  while (lo + ONE < hi) {
    const mid = (lo + hi) / TWO;
    if (await exists(mid)) lo = mid; else hi = mid;
  }
  return Number(lo);
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

export interface RegistryScanOptions {
  fromId?: number;            // default 1
  toId?: number;              // default = discovered tip
  identityBatch?: number;     // ids per identity multicall (default 250)
  feedbackBatch?: number;     // agents per feedback multicall (default 40)
  fetchRemote?: boolean;      // fetch http/ipfs registrations (default true)
  remoteConcurrency?: number; // parallel remote fetches (default 16)
  scanFeedback?: boolean;     // read ReputationRegistry (default true)
  onProgress?: (msg: string) => void;
  /** Inject a client (tests). Defaults to makeRegistryClient(config). */
  client?: Pick<PublicClient, 'readContract' | 'multicall'>;
}

export async function runRegistryScan(
  config: Erc8004RegistryConfig,
  persistAgents: PersistAgents,
  persistFeedback: PersistFeedback,
  opts: RegistryScanOptions = {},
): Promise<RegistryScanResult> {
  const client = opts.client ?? makeRegistryClient(config);
  const log = opts.onProgress ?? (() => {});
  const identityBatch = opts.identityBatch ?? 250;
  const feedbackBatch = opts.feedbackBatch ?? 40;
  const fetchRemote = opts.fetchRemote ?? true;
  const scanFeedback = opts.scanFeedback ?? true;

  const tip = opts.toId ?? (await findRegistryTip(client, config.identityRegistry));
  const from = Math.max(1, opts.fromId ?? 1);
  log(`tip=${tip} scanning ids ${from}..${tip}`);

  const result: RegistryScanResult = {
    chain: config.chain, tip, agentsScanned: 0, agentsPersisted: 0,
    feedbackScanned: 0, feedbackPersisted: 0, errors: 0,
  };
  if (tip < from) return result;

  const ids: number[] = [];
  for (let i = from; i <= tip; i++) ids.push(i);

  for (const batch of chunk(ids, identityBatch)) {
    // ── Identity multicall: ownerOf + getAgentWallet + tokenURI per id ──
    const calls = batch.flatMap((id) => [
      { address: config.identityRegistry, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [BigInt(id)] } as const,
      { address: config.identityRegistry, abi: IDENTITY_ABI, functionName: 'getAgentWallet', args: [BigInt(id)] } as const,
      { address: config.identityRegistry, abi: IDENTITY_ABI, functionName: 'tokenURI', args: [BigInt(id)] } as const,
    ]);
    let reads: { status: 'success' | 'failure'; result?: unknown }[];
    try {
      reads = await client.multicall({ contracts: calls, allowFailure: true });
    } catch (err) {
      result.errors++;
      log(`identity multicall failed for ${batch[0]}..${batch[batch.length - 1]}: ${errMsg(err)}`);
      continue;
    }

    const live: ScannedAgent[] = [];
    const remoteQueue: ScannedAgent[] = [];
    for (let i = 0; i < batch.length; i++) {
      const id = batch[i];
      const ownerR = reads[i * 3], walletR = reads[i * 3 + 1], uriR = reads[i * 3 + 2];
      if (ownerR.status !== 'success') continue; // unminted / burned id
      const owner = (ownerR.result as string).toLowerCase();
      const agentWallet = walletR.status === 'success' ? (walletR.result as string).toLowerCase() : null;
      const tokenURI = uriR.status === 'success' ? (uriR.result as string) : null;

      const dec = await decodeRegistration(tokenURI, { fetchRemote: false });
      const agent: ScannedAgent = {
        agentId: id, owner, agentWallet, tokenURI,
        registration: dec.registration,
        registrationStatus: dec.status,
        metadataScore: scoreMetadataQuality({ registration: dec.registration }).score,
      };
      if (dec.status === 'pending' && fetchRemote) remoteQueue.push(agent);
      live.push(agent);
    }

    // ── Bounded remote-registration enrichment for http/ipfs agents ──
    if (remoteQueue.length > 0) {
      await mapWithConcurrency(remoteQueue, opts.remoteConcurrency ?? 16, async (agent) => {
        const dec = await decodeRegistration(agent.tokenURI, { fetchRemote: true });
        agent.registration = dec.registration;
        agent.registrationStatus = dec.status;
        agent.metadataScore = scoreMetadataQuality({ registration: dec.registration }).score;
      });
    }

    // Persist identities first so the feedback FK target (chain, agent_id) exists.
    result.agentsScanned += live.length;
    result.agentsPersisted += await persistAgents(config.chain, live);

    // ── Feedback pass for this batch's live agents ──
    if (scanFeedback && live.length > 0) {
      const enriched: ScannedAgent[] = [];
      for (const fbIds of chunk(live.map((a) => a.agentId), feedbackBatch)) {
        const fbCalls = fbIds.map((id) => ({
          address: config.reputationRegistry, abi: REPUTATION_ABI,
          functionName: 'readAllFeedback' as const,
          args: [BigInt(id), [] as `0x${string}`[], '', '', true] as const,
        }));
        let fbReads: { status: 'success' | 'failure'; result?: unknown }[];
        try {
          fbReads = await client.multicall({ contracts: fbCalls, allowFailure: true });
        } catch {
          result.errors++;
          continue;
        }
        const records: ScannedFeedback[] = [];
        const aggById = new Map<number, FeedbackAgg>();
        for (let i = 0; i < fbIds.length; i++) {
          if (fbReads[i].status !== 'success') continue;
          const recs = parseFeedbackArrays(fbIds[i], fbReads[i].result as readonly unknown[]);
          records.push(...recs);
          aggById.set(fbIds[i], aggregateAgentFeedback(recs));
        }
        result.feedbackScanned += records.length;
        if (records.length > 0) result.feedbackPersisted += await persistFeedback(config.chain, records);
        // Attach aggregate to the in-memory agent for the re-upsert.
        for (const a of live) {
          const agg = aggById.get(a.agentId);
          if (agg) { a.feedback = agg; enriched.push(a); }
        }
      }
      // Re-upsert only the agents that gained a feedback aggregate.
      if (enriched.length > 0) await persistAgents(config.chain, enriched);
    }

    log(`progress: ${result.agentsScanned} agents, ${result.feedbackScanned} feedback (id ${batch[batch.length - 1]}/${tip})`);
  }

  return result;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}
