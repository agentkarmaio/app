/**
 * Generic ERC-8004 registry scanner — mirrors an EVM IdentityRegistry +
 * ReputationRegistry into AgentKarma's `erc8004_agents` / `erc8004_feedback`
 * tables so AK can match 8004scan's per-network agent + feedback totals and
 * scan every registered agent (not just unique owner addresses).
 *
 * Strategy (Celo tip ≈ 9.5k agents, ~23k feedbacks):
 *   1. Binary-search the registry tip — largest agentId whose ownerOf() does
 *      not revert. Registries mint sequential ids from their configured first ID.
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

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  parseAbi,
  type PublicClient,
} from 'viem';
import { decodeDataUriJson } from '@/lib/data-uri';
import type { Erc8004RegistryConfig } from '@/config/erc8004-registries';
import { ARC_MAINNET_CHAIN_ID, parseArcMainnetRpcUrl } from '@/config/arc-mainnet';
import type { AgentRegistrationFile } from '@/integrations/erc8004-celo';
import type { Erc8004RegistrationStatus } from '@/db/schema';
import { scoreMetadataQuality } from '@/scoring/celo-metadata';
import {
  safeFetchJson,
  InvalidJsonError,
  isRetryableFetchError,
  type DnsLookup,
} from '@/lib/ssrf-guard';
import { isRateLimitedError, withRateLimitRetry } from '@/lib/rpc-retry';

const ONE = BigInt(1);
const TWO = BigInt(2);

// ─── ABIs ───────────────────────────────────────────────────────────────────

const IDENTITY_ABI = parseAbi([
  'error ERC721NonexistentToken(uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
]);

const REPUTATION_ABI = parseAbi([
  'function getIdentityRegistry() view returns (address)',
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
  /**
   * Chain-native identity-object address, when the chain has one distinct from
   * the agentId. Solana's ERC-8004 identity is the asset NFT pubkey, and
   * `giveFeedback` cannot be built without it. Undefined on EVM/Stellar, where
   * the agentId alone identifies the agent.
   */
  assetAddress?: string | null;
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

export type RegistryFailureStage = 'identity' | 'registration' | 'feedback' | 'unknown';
export interface RegistryFailedMember { agentId: number; stages: RegistryFailureStage[] }

export interface RegistryScanResult {
  chain: string;
  tip: number;
  agentsScanned: number;
  agentsPersisted: number;
  feedbackScanned: number;
  feedbackPersisted: number;
  errors: number;
  /**
   * Members whose off-chain metadata host was unreachable. This is a per-member
   * content verdict (dead operator host), not a run fault: the member is
   * persisted with its on-chain identity and registration_status 'unreachable'
   * (upsertErc8004Agents retains any previously fetched registration), and it
   * does NOT count into `errors`, so it cannot hold the discovery cursor.
   */
  registrationUnreachable: number;
  /** Exhaustive failed members for explicit agentIds scans; absent for discovery. */
  failedMembers?: RegistryFailedMember[];
  /**
   * Failed members the contract itself cannot serve, so no later run will read
   * them either. Run-scoped: callers classify this run's fault with it and MUST
   * NOT persist it — the Arc refresh cursor's shape is read by deployed code.
   */
  unreadableMembers?: number[];
}

export type PersistAgents = (chain: string, agents: ScannedAgent[]) => Promise<number>;
export type PersistFeedback = (chain: string, feedback: ScannedFeedback[]) => Promise<number>;

/**
 * True when the chain answered and the answer was "this call cannot succeed".
 *
 * A revert is a property of the call, not of the connection: Arc id 1's
 * 1,315-client `readAllFeedback` exhausts the eth_call gas limit on every
 * endpoint, forever (measured 2026-09-17; paging by client address does not
 * help — 10 of its 14 pages revert too). Retrying it as though an RPC hiccup
 * will clear is what let one member pin a whole chain to "Scan failed".
 *
 * viem's transport retries transport errors, never reverts, so this verdict is
 * stable rather than a race with a backoff.
 */
const MEMBER_RETRY_CONCURRENCY = 4;
/** Distinct from `undefined`, which a contract may legitimately decode to. */
const MISSING = Symbol('unread');

export function isUnreadableMember(err: unknown): boolean {
  return err instanceof BaseError
    && Boolean(err.walk((cause) => cause instanceof ContractFunctionRevertedError));
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Default recent re-scan window for incremental runs. Re-reads the most recent
 *  ~500 ids every run so feedback ADDED to already-mirrored agents is caught —
 *  a pure new-ids-only sweep would miss it (existing agents keep their id). */
export const DEFAULT_RESCAN_WINDOW = 500;

export interface IncrementalRange {
  /** First id to scan (inclusive). 0 ⇒ nothing to do (empty registry). */
  from: number;
  /** Last id to scan (inclusive) = current registry tip. */
  to: number;
}

/**
 * Compute the id range an `--incremental` scan covers: every NEW id since the
 * last sweep (`lastTip+1 .. currentTip`) UNIONED with a bounded recent re-scan
 * window (the most recent `window` ids). The two ranges always overlap or abut,
 * so their union is the single contiguous span starting at the LOWER of the two
 * lower bounds — no need to scan twice. Clamped to [firstAgentId, currentTip] so a
 * shrunk/empty registry or a window larger than the tip can't produce a bad id.
 *
 *   lastTip=9000 currentTip=9100 window=500 → from=8601 (re-scan window wins)
 *   lastTip=9000 currentTip=9700 window=500 → from=9001 (new-ids window wins)
 *   lastTip=0    currentTip=300  window=500 → from=1    (clamped to 1)
 *   lastTip=9100 currentTip=9100 window=500 → from=8601 (re-scan only, no new)
 *   currentTip=0 (empty registry)           → from=0,to=0 (nothing to do)
 */
export function incrementalScanRange(
  lastTip: number,
  currentTip: number,
  window: number = DEFAULT_RESCAN_WINDOW,
  firstAgentId: 0 | 1 = 1,
): IncrementalRange {
  if (currentTip < firstAgentId) return { from: 0, to: currentTip };
  // Cursor zero also means never scanned; include mainnet agent zero on bootstrap.
  const newIdsFrom = lastTip === 0 ? firstAgentId : lastTip + 1;
  const rescanFrom = currentTip - window + 1; // start of the recent re-scan window
  const from = Math.max(firstAgentId, Math.min(newIdsFrom, rescanFrom));
  return { from, to: currentTip };
}

/**
 * ipfs.io retired its path gateway on 2026-09-13 and now answers every request
 * with 429, which banked 1,949 agents across arc/celo/solana as `unreachable`
 * (48% of a sampled 52 were valid registrations). Filebase serves the same CIDs
 * in ~100ms. Overridable so a dedicated gateway can be swapped in without a
 * release.
 */
export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.filebase.io/ipfs/';

function defaultIpfsGateway(): string {
  const configured = process.env.IPFS_GATEWAY_URL?.trim();
  if (!configured) return DEFAULT_IPFS_GATEWAY;
  return configured.endsWith('/') ? configured : `${configured}/`;
}

/**
 * Decode an ERC-8004 registration tokenURI. Handles every scheme seen in the
 * wild on Celo: inline data: URIs (base64 / gzip / utf8), bare raw JSON, http(s),
 * and ipfs://. `fetchRemote=false` skips network schemes (marks 'pending') for a
 * fast first pass — remote enrichment can run in a bounded second sweep.
 */
export async function decodeRegistration(
  uri: string | null | undefined,
  opts: { fetchRemote?: boolean; timeoutMs?: number; ipfsGateway?: string; lookup?: DnsLookup; signal?: AbortSignal } = {},
): Promise<{ registration: AgentRegistrationFile | null; status: Erc8004RegistrationStatus; retryable?: boolean }> {
  opts.signal?.throwIfAborted();
  const { fetchRemote = true, timeoutMs = 6000, ipfsGateway = defaultIpfsGateway(), lookup } = opts;
  if (!uri || uri.trim().length === 0) return { registration: null, status: 'empty' };

  // Inline, fully on-chain metadata: data:application/json[;base64][;enc=gzip],…
  if (uri.startsWith('data:')) {
    try {
      return { registration: decodeDataUriJson(uri) as AgentRegistrationFile, status: 'inline' };
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
    opts.signal?.throwIfAborted();
    const json = (await safeFetchJson(fetchUrl, { timeoutMs, lookup })) as AgentRegistrationFile;
    opts.signal?.throwIfAborted();
    return { registration: json, status: 'fetched', retryable: false };
  } catch (error) {
    opts.signal?.throwIfAborted();
    // A served body that is not JSON is usually a verdict about the content
    // (a README, an image) — retrying can only produce the same bytes. An HTML
    // body is the exception: that is a gateway error page wearing a 200, and
    // settling it would erase a registration that read fine yesterday.
    if (error instanceof InvalidJsonError && !isRetryableFetchError(error))
      return { registration: null, status: 'invalid', retryable: false };
    return {
      registration: null,
      status: 'unreachable',
      retryable: isRetryableFetchError(error),
    };
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
  const rpcUrl = config.chain === 'arc-mainnet'
    ? parseArcMainnetRpcUrl(process.env.ARC_MAINNET_RPC_URL)
    : process.env[config.rpcEnvVar];
  return createPublicClient({
    chain: config.viemChain,
    transport: http(rpcUrl, { batch: true, retryCount: 3, retryDelay: 400 }),
  }) as PublicClient;
}

type RegistryClient = Pick<PublicClient, 'readContract' | 'multicall'>
  & Partial<Pick<PublicClient, 'getChainId' | 'getBytecode'>>;

/** Mainnet admission is per run and applies equally to injected clients. */
async function admittedRegistryClient(config: Erc8004RegistryConfig, opts: RegistryScanOptions): Promise<RegistryClient> {
  opts.signal?.throwIfAborted();
  if (config.chain === 'arc-mainnet') {
    parseArcMainnetRpcUrl(process.env.ARC_MAINNET_RPC_URL);
    if (config.viemChain.id !== ARC_MAINNET_CHAIN_ID || config.rpcEnvVar !== 'ARC_MAINNET_RPC_URL') {
      throw new Error('configuration_invalid');
    }
  }
  const client = opts.client ?? makeRegistryClient(config);
  if (config.chain !== 'arc-mainnet') return client;
  const rpc = async <T>(read: () => Promise<T>): Promise<T> => {
    const result = await withRateLimitRetry(() => { opts.signal?.throwIfAborted(); return read(); });
    opts.signal?.throwIfAborted();
    return result;
  };
  try {
    if (!client.getChainId || !client.getBytecode) throw new Error('registry_read_failure');
    if (await rpc(() => client.getChainId!()) !== ARC_MAINNET_CHAIN_ID) throw new Error('arc_mainnet_chain_mismatch');
    const multicall = config.viemChain.contracts?.multicall3?.address;
    if (!multicall) throw new Error('registry_read_failure');
    for (const address of [config.identityRegistry, config.reputationRegistry, multicall]) {
      const code = await rpc(() => client.getBytecode!({ address }));
      if (!code || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) throw new Error('registry_read_failure');
    }
    const identity = await rpc(() => client.readContract({
      address: config.reputationRegistry, abi: REPUTATION_ABI, functionName: 'getIdentityRegistry',
    }));
    if (typeof identity !== 'string' || identity.toLowerCase() !== config.identityRegistry.toLowerCase()) {
      throw new Error('registry_read_failure');
    }
  } catch (error) {
    opts.signal?.throwIfAborted();
    if (error instanceof Error && ['arc_mainnet_chain_mismatch', 'registry_read_failure'].includes(error.message)) throw error;
    // Provider errors can carry credential-bearing URLs. Emit only stable codes.
    const seen = new Set<unknown>();
    let current = error;
    while (current && !seen.has(current)) {
      seen.add(current);
      const record = current as { status?: unknown; statusCode?: unknown; message?: unknown; details?: unknown; cause?: unknown };
      const message = [record.message, record.details].filter(value => typeof value === 'string').join(' ');
      if (record.status === 401 || record.status === 403 || record.statusCode === 401 || record.statusCode === 403
        || /\b(?:401|403)\b|unauthorized|forbidden/i.test(message)) throw new Error('rpc_authentication_failed');
      current = record.cause;
    }
    throw new Error(isRateLimitedError(error) ? 'rpc_rate_limited' : 'rpc_unavailable');
  }
  return client;
}

/** A failed transport, empty return data, or unrelated revert proves no absence. */
function isNonexistentTokenError(error: unknown): boolean {
  const revert = error instanceof BaseError
    ? error.walk(cause => cause instanceof ContractFunctionRevertedError)
    : error;
  if (revert instanceof ContractFunctionRevertedError) {
    return revert.data?.errorName === 'ERC721NonexistentToken'
      || /^ERC721: (?:invalid token ID|owner query for nonexistent token)$/i.test(revert.reason ?? '');
  }
  return false;
}

/** Largest minted ID; empty returns firstAgentId - 1 (legacy default: 0). */
export async function findRegistryTip(
  client: Pick<PublicClient, 'readContract'>,
  identityRegistry: `0x${string}`,
  signal?: AbortSignal,
  firstAgentId: 0 | 1 = 1,
): Promise<number> {
  // Classify actual absence before retrying: a decoded token ID can itself
  // contain "429", which is otherwise recognized as a throttle by the helper.
  const exists = (id: bigint): Promise<boolean> => withRateLimitRetry(async () => {
    signal?.throwIfAborted();
    try {
      await client.readContract({ address: identityRegistry, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [id] });
      signal?.throwIfAborted();
      return true;
    } catch (err) {
      signal?.throwIfAborted();
      if (isNonexistentTokenError(err)) return false;
      throw err;
    }
  });
  const first = BigInt(firstAgentId);
  if (!(await exists(first))) return firstAgentId - 1;
  let lo = first, hi = first + ONE;
  while (await exists(hi)) { lo = hi; hi *= TWO; }
  while (lo + ONE < hi) {
    const mid = (lo + hi) / TWO;
    if (await exists(mid)) lo = mid; else hi = mid;
  }
  return Number(lo);
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

export interface RegistryScanOptions {
  signal?: AbortSignal;
  /** Refresh this exact membership, without tip discovery or filling ID gaps. */
  agentIds?: readonly number[];
  fromId?: number;            // default config.firstAgentId (otherwise 1)
  toId?: number;              // default = discovered tip
  identityBatch?: number;     // ids per identity multicall (default 250)
  feedbackBatch?: number;     // agents per feedback multicall (default 40)
  fetchRemote?: boolean;      // fetch http/ipfs registrations (default true)
  remoteConcurrency?: number; // parallel remote fetches (default 16)
  scanFeedback?: boolean;     // read ReputationRegistry (default true)
  onProgress?: (msg: string) => void;
  /** Inject a client (tests). Defaults to makeRegistryClient(config). */
  client?: RegistryClient;
}

export async function runRegistryScan(
  config: Erc8004RegistryConfig,
  persistAgents: PersistAgents,
  persistFeedback: PersistFeedback,
  opts: RegistryScanOptions = {},
): Promise<RegistryScanResult> {
  const client = await admittedRegistryClient(config, opts);
  return scanRegistry(config, persistAgents, persistFeedback, client, opts);
}

/** Only the exported entry points admit clients; no public admission bypass. */
async function scanRegistry(
  config: Erc8004RegistryConfig,
  persistAgents: PersistAgents,
  persistFeedback: PersistFeedback,
  client: RegistryClient,
  opts: RegistryScanOptions,
): Promise<RegistryScanResult> {
  opts.signal?.throwIfAborted();
  const log = opts.onProgress ?? (() => {});
  const identityBatch = opts.identityBatch ?? 250;
  const feedbackBatch = opts.feedbackBatch ?? 40;
  const fetchRemote = opts.fetchRemote ?? true;
  const scanFeedback = opts.scanFeedback ?? true;

  const firstAgentId = config.firstAgentId ?? 1;
  const explicitIds = opts.agentIds === undefined ? undefined : [...new Set(opts.agentIds)].sort((a, b) => a - b);
  if (explicitIds?.some((id) => !Number.isSafeInteger(id) || id < firstAgentId)) {
    throw new Error(`registry agent IDs must be safe integers >= ${firstAgentId}`);
  }
  const tip = explicitIds ? (explicitIds.at(-1) ?? 0)
    : opts.toId ?? (await findRegistryTip(client, config.identityRegistry, opts.signal, config.firstAgentId ?? 1));
  opts.signal?.throwIfAborted();
  const from = Math.max(firstAgentId, opts.fromId ?? firstAgentId);
  log(`tip=${tip} scanning ids ${from}..${tip}`);

  const result: RegistryScanResult = {
    chain: config.chain, tip, agentsScanned: 0, agentsPersisted: 0,
    feedbackScanned: 0, feedbackPersisted: 0, errors: 0, registrationUnreachable: 0,
  };
  if (explicitIds) { result.failedMembers = []; result.unreadableMembers = []; }
  const unreadable = new Set<number>();
  const failed = (agentIds: number[], stage: RegistryFailureStage) => {
    if (!result.failedMembers) return;
    for (const agentId of agentIds) {
      const previous = result.failedMembers.find(member => member.agentId === agentId);
      if (previous) { if (!previous.stages.includes(stage)) previous.stages.push(stage); }
      else result.failedMembers.push({ agentId, stages: [stage] });
    }
  };
  if (tip < from) return result;

  const ids: number[] = explicitIds ?? [];
  if (!explicitIds) for (let i = from; i <= tip; i++) ids.push(i);

  for (const batch of chunk(ids, identityBatch)) {
    opts.signal?.throwIfAborted();
    // ── Identity multicall: ownerOf + getAgentWallet + tokenURI per id ──
    const calls = batch.flatMap((id) => [
      { address: config.identityRegistry, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [BigInt(id)] } as const,
      { address: config.identityRegistry, abi: IDENTITY_ABI, functionName: 'getAgentWallet', args: [BigInt(id)] } as const,
      { address: config.identityRegistry, abi: IDENTITY_ABI, functionName: 'tokenURI', args: [BigInt(id)] } as const,
    ]);
    let reads: { status: 'success' | 'failure'; result?: unknown; error?: unknown }[];
    try {
      reads = await client.multicall({ contracts: calls, allowFailure: true });
      opts.signal?.throwIfAborted();
    } catch (err) {
      opts.signal?.throwIfAborted();
      result.errors++;
      failed(batch, 'identity');
      log(`identity multicall failed for ${batch[0]}..${batch[batch.length - 1]}: ${errMsg(err)}`);
      continue;
    }

    const live: ScannedAgent[] = [];
    const remoteQueue: ScannedAgent[] = [];
    for (let i = 0; i < batch.length; i++) {
      opts.signal?.throwIfAborted();
      const id = batch[i];
      const ownerR = reads[i * 3], walletR = reads[i * 3 + 1], uriR = reads[i * 3 + 2];
      if (ownerR?.status !== 'success' && !explicitIds && isNonexistentTokenError(ownerR?.error)) continue;
      if (ownerR?.status !== 'success' || walletR?.status !== 'success' || uriR?.status !== 'success'
        || typeof ownerR.result !== 'string' || typeof walletR.result !== 'string' || typeof uriR.result !== 'string') {
        // In discovery too, an unknown read failure is not a gap or evidence
        // that saved wallet/URI/registration data should be cleared.
        result.errors++;
        failed([id], 'identity');
        continue;
      }
      const owner = ownerR.result.toLowerCase();
      const agentWallet = walletR.result.toLowerCase();
      const tokenURI = uriR.result;

      const dec = await decodeRegistration(tokenURI, { fetchRemote: false, signal: opts.signal });
      const agent: ScannedAgent = {
        agentId: id, owner, agentWallet, tokenURI,
        registration: dec.registration,
        registrationStatus: dec.status,
        // tokenURI carries the tamper-resistance credit (10/100) for a
        // content-addressed pointer — omitting it under-scored every
        // ipfs:/data: agent by enough to cross ATTEST_MIN_SCORE.
        metadataScore: scoreMetadataQuality({
          registration: dec.registration,
          tokenURI: tokenURI ?? undefined,
        }).score,
      };
      if (dec.status === 'pending' && fetchRemote) remoteQueue.push(agent);
      live.push(agent);
    }

    // ── Bounded remote-registration enrichment for http/ipfs agents ──
    if (remoteQueue.length > 0) {
      await mapWithConcurrency(remoteQueue, opts.remoteConcurrency ?? 16, async (agent) => {
        const dec = await decodeRegistration(agent.tokenURI, { fetchRemote: true, signal: opts.signal });
        agent.registration = dec.registration;
        agent.registrationStatus = dec.status;
        agent.metadataScore = scoreMetadataQuality({
          registration: dec.registration,
          tokenURI: agent.tokenURI ?? undefined,
        }).score;
        if (dec.status === 'unreachable') {
          // A dead metadata host is the operator's content debt, not a run
          // fault: persist the member (the upsert retains any previously
          // fetched registration) and let the run complete.
          result.registrationUnreachable++;
          failed([agent.agentId], 'registration');
        }
      }, opts.signal);
    }

    // Persist identities first so the feedback FK target (chain, agent_id) exists.
    opts.signal?.throwIfAborted();
    result.agentsScanned += live.length;
    if (live.length > 0) result.agentsPersisted += await persistAgents(config.chain, live);
    opts.signal?.throwIfAborted();

    // ── Feedback pass for this batch's live agents ──
    if (scanFeedback && live.length > 0) {
      const enriched: ScannedAgent[] = [];
      for (const fbIds of chunk(live.map((a) => a.agentId), feedbackBatch)) {
        opts.signal?.throwIfAborted();
        const fbCalls = fbIds.map((id) => ({
          address: config.reputationRegistry, abi: REPUTATION_ABI,
          functionName: 'readAllFeedback' as const,
          args: [BigInt(id), [] as `0x${string}`[], '', '', true] as const,
        }));
        let fbReads: { status: 'success' | 'failure'; result?: unknown }[];
        try {
          fbReads = await client.multicall({ contracts: fbCalls, allowFailure: true });
          opts.signal?.throwIfAborted();
        } catch {
          opts.signal?.throwIfAborted();
          result.errors++;
          failed(fbIds, 'feedback');
          continue;
        }
        // aggregate3 shares ONE gas budget across its members, so a single
        // oversized member fails every sibling in the sub-batch — `failure` here
        // means "not read", not "unreadable". Re-ask each one on its own before
        // recording a verdict; only a member that fails alone has really failed.
        // Defending known membership is the whole point, so discovery mode,
        // where a failure legitimately means unminted, does not pay for this.
        const values: unknown[] = fbIds.map((_, i) => (fbReads[i]?.status === 'success' ? fbReads[i].result : MISSING));
        if (explicitIds) {
          const unread = fbIds.map((_, i) => i).filter((i) => values[i] === MISSING);
          await mapWithConcurrency(unread, MEMBER_RETRY_CONCURRENCY, async (i) => {
            try {
              values[i] = await client.readContract({
                address: config.reputationRegistry, abi: REPUTATION_ABI,
                functionName: 'readAllFeedback',
                args: [BigInt(fbIds[i]), [] as `0x${string}`[], '', '', true],
              });
            } catch (err) {
              if (isUnreadableMember(err)) unreadable.add(fbIds[i]);
            }
          }, opts.signal);
          opts.signal?.throwIfAborted();
        }
        const records: ScannedFeedback[] = [];
        const aggById = new Map<number, FeedbackAgg>();
        for (let i = 0; i < fbIds.length; i++) {
          if (values[i] === MISSING) {
            result.errors++;
            failed([fbIds[i]], 'feedback');
            continue;
          }
          let recs: ScannedFeedback[];
          try {
            const reply = values[i];
            if (!Array.isArray(reply) || reply.length !== 7
              || !reply.every(Array.isArray) || reply.some(array => array.length !== reply[0].length)) {
              throw Error('Invalid registry feedback arrays');
            }
            recs = parseFeedbackArrays(fbIds[i], reply as readonly unknown[]);
          } catch {
            result.errors++;
            failed([fbIds[i]], 'feedback');
            continue;
          }
          records.push(...recs);
          aggById.set(fbIds[i], aggregateAgentFeedback(recs));
        }
        result.feedbackScanned += records.length;
        opts.signal?.throwIfAborted();
        if (records.length > 0) result.feedbackPersisted += await persistFeedback(config.chain, records);
        opts.signal?.throwIfAborted();
        // Attach aggregate to the in-memory agent for the re-upsert.
        for (const a of live) {
          const agg = aggById.get(a.agentId);
          if (agg) { a.feedback = agg; enriched.push(a); }
        }
      }
      // Re-upsert only the agents that gained a feedback aggregate.
      opts.signal?.throwIfAborted();
      if (enriched.length > 0) await persistAgents(config.chain, enriched);
    }

    log(`progress: ${result.agentsScanned} agents, ${result.feedbackScanned} feedback (id ${batch[batch.length - 1]}/${tip})`);
  }

  opts.signal?.throwIfAborted();
  result.failedMembers?.sort((a, b) => a.agentId - b.agentId);
  if (explicitIds) result.unreadableMembers = [...unreadable].sort((a, b) => a - b);
  return result;
}

// ─── Incremental scan (cursor-driven, for scheduled runs) ──────────────────────

/** Reads the last scanned tip for a chain (0 = never scanned). */
export type GetCursorTip = (chain: string) => Promise<number>;
/** Persists the tip reached by a successful incremental scan. */
export type SetCursorTip = (chain: string, tip: number) => Promise<void>;

export interface IncrementalScanOptions extends RegistryScanOptions {
  /** Recent re-scan window — re-reads the most recent N ids so feedback added to
   *  already-mirrored agents is caught (default DEFAULT_RESCAN_WINDOW = 500). */
  rescanWindow?: number;
}

/**
 * Cursor-driven incremental scan, the cheap path for a schedule. Discovers the
 * current tip, reads the persisted last tip, scans only `incrementalScanRange`
 * (new ids + a bounded recent re-scan window), then advances the cursor to the
 * tip — but ONLY after a clean run (errors === 0). A run that hit RPC errors
 * leaves the cursor where it was so the missed ids are retried next run rather
 * than silently skipped. The full firstAgentId..tip sweep stays `runRegistryScan`.
 */
export async function runIncrementalRegistryScan(
  config: Erc8004RegistryConfig,
  persistAgents: PersistAgents,
  persistFeedback: PersistFeedback,
  getCursorTip: GetCursorTip,
  setCursorTip: SetCursorTip,
  opts: IncrementalScanOptions = {},
): Promise<RegistryScanResult> {
  opts.signal?.throwIfAborted();
  const client = await admittedRegistryClient(config, opts);
  const log = opts.onProgress ?? (() => {});
  const window = opts.rescanWindow ?? DEFAULT_RESCAN_WINDOW;

  const currentTip = await findRegistryTip(client, config.identityRegistry, opts.signal, config.firstAgentId ?? 1);
  opts.signal?.throwIfAborted();
  const lastTip = await getCursorTip(config.chain);
  opts.signal?.throwIfAborted();
  const { from, to } = incrementalScanRange(lastTip, currentTip, window, config.firstAgentId ?? 1);
  log(`incremental: lastTip=${lastTip} currentTip=${currentTip} window=${window} → scan ${from}..${to}`);

  if (to < (config.firstAgentId ?? 1)) {
    return {
      chain: config.chain, tip: currentTip, agentsScanned: 0, agentsPersisted: 0,
      feedbackScanned: 0, feedbackPersisted: 0, errors: 0, registrationUnreachable: 0,
    };
  }

  const result = await scanRegistry(config, persistAgents, persistFeedback, client, {
    ...opts,
    client,
    fromId: from,
    toId: to,
  });

  // Advance the cursor only on a clean run so error-skipped ids are retried.
  // Registration unreachability does not count as an error — dead metadata
  // hosts are persisted per-member and re-attempted by the re-scan window
  // instead of freezing the whole chain's registry cursor (2026-09-25).
  opts.signal?.throwIfAborted();
  if (result.errors === 0) {
    await setCursorTip(config.chain, currentTip);
    opts.signal?.throwIfAborted();
    log(`incremental: cursor advanced to ${currentTip}`
      + (result.registrationUnreachable > 0 ? ` (${result.registrationUnreachable} registration(s) unreachable)` : ''));
  } else {
    log(`incremental: ${result.errors} error(s) — cursor held at ${lastTip} for retry`);
  }
  return result;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      signal?.throwIfAborted();
      const i = cursor++;
      await fn(items[i]);
      signal?.throwIfAborted();
    }
  });
  await Promise.all(workers);
}
