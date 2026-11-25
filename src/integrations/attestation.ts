/**
 * 8004 Attestation Reader — reads on-chain feedback scores for agent wallets.
 *
 * Normalizes the 8004 average score (0–100) to 0–1 for the scoring engine.
 *
 * Two properties this module has to hold, both learned the hard way on
 * 2026-09-19:
 *
 * 1. **A read failure must be distinguishable from "no feedback".** The SDK's
 *    `getSummary` wraps its whole body in `try { … } catch { return
 *    { averageScore: 0, … } }`, so a throttled endpoint returns a
 *    valid-looking ZERO instead of an error. Downstream, `calculateScore`
 *    treats `attestation === 0` as *absent* and redistributes Tier-1 weight —
 *    so while an endpoint is unavailable, every wallet that really does have
 *    8004 feedback is scored as though it has none, and nothing says so. The
 *    SDK cannot be relied on to report this, so availability is established
 *    OUT OF BAND, with a raw JSON-RPC probe the SDK never gets to swallow.
 *
 * 2. **A dead endpoint must cost one probe, not N × the read deadline.** The
 *    2026-09-19 keep-fresh run spent ~226 s of its 600 s lease waiting 5 s at a
 *    time for 221 wallets against an endpoint that was rejecting every call.
 *
 * Endpoint preference is the shared one (`lib/solana-rpc`): a free standard RPC
 * first, metered credentials as fallback. This read is a plain `getAccountInfo`
 * on the AtomStats PDA — any RPC serves it, so there is no reason to spend a
 * metered credential, and no reason for the live score path to depend on one.
 */

import { SolanaSDK } from '8004-solana';
import { Keypair } from '@solana/web3.js';
import type { Cluster } from '8004-solana';
import { solanaReadRpcUrls } from '@/lib/solana-rpc';
import { getSolanaAgentAssets } from '@/db/client';
import { readAgentFeedbackVia, thirdPartyFeedbackScore, type AgentFeedback } from './solana-agent-feedback';

const CLUSTER: Cluster = 'mainnet-beta';
/** The SDK read has no timeout of its own; a wedged RPC would block live pages. */
const READ_TIMEOUT_MS = 5_000;
/** How long a probe verdict is trusted before the endpoint is re-tested. */
export const ENDPOINT_COOLDOWN_MS = 5 * 60_000;
/** Bounded so one slow endpoint cannot stall a batch behind its own probe. */
const PROBE_TIMEOUT_MS = 3_000;

interface Endpoint {
  url: string;
  sdk: SolanaSDK | null;
  /** Epoch ms until which this endpoint is considered unusable. 0 = untested/usable. */
  coldUntil: number;
}

/** Probe a URL with raw JSON-RPC. Injected in tests; never routed through the SDK. */
export type EndpointProbe = (url: string) => Promise<boolean>;

let _endpoints: Endpoint[] | null = null;

/**
 * Raw JSON-RPC `getSlot`.
 *
 * Deliberately not `Connection.getSlot`: `@solana/web3.js` retries 429s
 * internally with backoff, which is exactly the latency this probe exists to
 * avoid, and it normalizes away the status code we need. A non-2xx response
 * (429 rate limited, 401/402/403 dead credential) or a JSON-RPC `error` member
 * both mean "this endpoint will not serve us right now".
 */
async function defaultProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { error?: unknown };
    return !body?.error;
  } catch {
    return false;
  }
}

function endpoints(): Endpoint[] {
  if (!_endpoints) {
    _endpoints = solanaReadRpcUrls().map((url) => ({ url, sdk: null, coldUntil: 0 }));
  }
  return _endpoints;
}

function sdkFor(endpoint: Endpoint): SolanaSDK {
  if (endpoint.sdk) return endpoint.sdk;
  // Read-only: an ephemeral keypair is fine, and avoids requiring a key to read.
  const rawKey = process.env.SOLANA_PRIVATE_KEY;
  const signer = rawKey
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey)))
    : Keypair.generate();
  endpoint.sdk = new SolanaSDK({ signer, cluster: CLUSTER, rpcUrl: endpoint.url });
  return endpoint.sdk;
}

/**
 * First endpoint that answers a probe, or null when every one is cold.
 *
 * A cold verdict is cached for `ENDPOINT_COOLDOWN_MS` so a sustained outage
 * costs one probe per endpoint per window rather than one per wallet. Nothing
 * records a *warm* verdict for longer than the call: an endpoint that starts
 * failing mid-batch is caught by the next probe, and probes are cheap.
 */
async function pickEndpoint(
  probe: EndpointProbe,
  now: number,
): Promise<Endpoint | null> {
  for (const endpoint of endpoints()) {
    if (endpoint.coldUntil > now) continue;
    if (await probe(endpoint.url)) return endpoint;
    endpoint.coldUntil = now + ENDPOINT_COOLDOWN_MS;
  }
  return null;
}

/** Test seam: drop cached endpoints, SDKs and cooldowns. */
export function resetAttestationEndpoints(): void {
  _endpoints = null;
}

export interface AttestationBatch {
  /** address → normalized score, only for wallets with a score above zero. */
  scores: Map<string, number>;
  /**
   * True when NO endpoint would serve us, so every score in this batch is
   * "unknown", not "zero". Callers that PERSIST a score must not write one
   * computed from a Tier-1 signal they could not read.
   */
  unavailable: boolean;
}

/**
 * Read the 8004 attestation score for a single wallet.
 *
 * Returns 0 both for "no feedback" and for "could not read" — the historical
 * contract, kept because every caller of this single-wallet form renders a
 * value rather than persisting one. Callers that WRITE scores use
 * `readAttestationsDetailed`, which reports availability explicitly.
 */
export async function readAttestation(walletAddress: string): Promise<number> {
  const endpoint = await pickEndpoint(defaultProbe, Date.now());
  if (!endpoint) return 0;
  return readVia(endpoint, walletAddress);
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`8004 ${what} timed out`)), READ_TIMEOUT_MS);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Tier-1 attestation for a wallet: third-party 8004 feedback on the agent
 * assets it controls, AK's own karma_score excluded (solana-agent-feedback.ts).
 * A wallet with no registered agent has no 8004 feedback — 0 without an RPC.
 */
async function readVia(endpoint: Endpoint, walletAddress: string): Promise<number> {
  try {
    const assets = await getSolanaAgentAssets(walletAddress);
    if (assets.length === 0) return 0;
    const records: AgentFeedback[] = [];
    for (const asset of assets) {
      records.push(...await withTimeout(readAgentFeedbackVia(sdkFor(endpoint), asset), 'feedback read'));
    }
    return thirdPartyFeedbackScore(records);
  } catch {
    return 0;
  }
}

/** All 8004 feedback records on one Solana agent asset, via a probed endpoint. */
export async function readAgentFeedback(asset: string): Promise<AgentFeedback[]> {
  const endpoint = await pickEndpoint(defaultProbe, Date.now());
  if (!endpoint) throw new Error('no Solana read endpoint available');
  return withTimeout(readAgentFeedbackVia(sdkFor(endpoint), asset), 'feedback read');
}

/**
 * Batch-read attestation scores, reporting whether the read was possible at all.
 *
 * `deps` is injectable so the probe/clock can be driven in tests without an RPC.
 */
export async function readAttestationsDetailed(
  walletAddresses: string[],
  deps: { probe?: EndpointProbe; now?: () => number } = {},
): Promise<AttestationBatch> {
  const scores = new Map<string, number>();
  if (walletAddresses.length === 0) return { scores, unavailable: false };

  const probe = deps.probe ?? defaultProbe;
  const now = deps.now ?? Date.now;

  const endpoint = await pickEndpoint(probe, now());
  if (!endpoint) {
    console.warn(
      `[attestation] no Solana read endpoint available — ${walletAddresses.length} ` +
      'attestation read(s) are UNKNOWN, not zero. Scores computed from them would ' +
      'silently drop a Tier-1 signal.',
    );
    return { scores, unavailable: true };
  }

  // Bounded concurrency against a single, probed endpoint.
  const BATCH_SIZE = 5;
  for (let i = 0; i < walletAddresses.length; i += BATCH_SIZE) {
    const batch = walletAddresses.slice(i, i + BATCH_SIZE);
    const read = await Promise.all(
      batch.map(async (addr) => ({ addr, score: await readVia(endpoint, addr) })),
    );
    for (const { addr, score } of read) {
      if (score > 0) scores.set(addr, score);
    }
  }

  return { scores, unavailable: false };
}

