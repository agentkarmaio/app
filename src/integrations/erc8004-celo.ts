/**
 * ERC-8004 Celo adapter — read IdentityRegistry + ReputationRegistry on Celo
 * mainnet via viem.
 *
 * Mirrors the surface area of `erc8004.ts` (Solana) but targets EVM 8004
 * contracts. Read paths are exposed here; the write path for AK acting as a
 * 8004 validator lives in `erc8004-celo-publish.ts` (task #6).
 *
 * Mainnet contracts:
 *   IdentityRegistry:   0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 *   ReputationRegistry: 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
 *
 * Spec: https://github.com/erc-8004/erc-8004-contracts/blob/master/ERC8004SPEC.md
 */

import { createPublicClient, http, parseAbi } from 'viem';
import { celo } from 'viem/chains';
import { gunzipSync } from 'zlib';
import { safeFetchJson } from '@/lib/ssrf-guard';

export const IDENTITY_REGISTRY_CELO = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;
export const REPUTATION_REGISTRY_CELO = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const;

// ─── Minimal ABIs ─────────────────────────────────────────────────────────────
// Read-only surface only. Write paths are colocated with their tx scripts.

const IDENTITY_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)',
]);

const REPUTATION_ABI = parseAbi([
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)',
]);

// ─── Client ───────────────────────────────────────────────────────────────────

function makeClient() {
  const rpcUrl = process.env.CELO_RPC_URL; // optional override; viem defaults to celo public RPC
  return createPublicClient({
    chain: celo,
    transport: http(rpcUrl),
  });
}

let _client: ReturnType<typeof makeClient> | null = null;
function getClient(): ReturnType<typeof makeClient> {
  if (!_client) _client = makeClient();
  return _client;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CeloAgent {
  agentId: bigint;
  owner: `0x${string}`;
  agentWallet: `0x${string}`; // = owner unless setAgentWallet was used
  tokenURI: string;
  registration?: AgentRegistrationFile | null;
  registrationError?: string;
}

/**
 * Shape of the JSON document an agentURI points at, per ERC-8004 spec.
 * All fields optional in practice — agents in the wild publish varying
 * subsets. The `type` discriminator should equal the v1 spec URL when valid.
 */
export interface AgentRegistrationFile {
  type?: string;
  name?: string;
  description?: string;
  image?: string;
  x402Support?: boolean;
  active?: boolean;
  supportedTrust?: string[];
  services?: Array<{ name: string; endpoint: string; version?: string }>;
  registrations?: Array<{ agentId: number; agentRegistry: string }>;
}

export interface FeedbackRecord {
  client: `0x${string}`;
  feedbackIndex: bigint;
  rawValue: bigint;
  valueDecimals: number;
  /** Normalized value = rawValue / 10^valueDecimals */
  value: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
}

export interface FeedbackSummary {
  count: number;
  rawSummaryValue: bigint;
  summaryValueDecimals: number;
  /** Normalized aggregate — meaning depends on the registry's summary semantics */
  summaryValue: number;
}

// ─── IdentityRegistry reads ───────────────────────────────────────────────────

export async function readAgent(agentId: bigint | number): Promise<CeloAgent | null> {
  const client = getClient();
  const id = BigInt(agentId);

  try {
    const [owner, tokenURI, agentWallet] = await Promise.all([
      client.readContract({
        address: IDENTITY_REGISTRY_CELO,
        abi: IDENTITY_ABI,
        functionName: 'ownerOf',
        args: [id],
      }),
      client.readContract({
        address: IDENTITY_REGISTRY_CELO,
        abi: IDENTITY_ABI,
        functionName: 'tokenURI',
        args: [id],
      }),
      client.readContract({
        address: IDENTITY_REGISTRY_CELO,
        abi: IDENTITY_ABI,
        functionName: 'getAgentWallet',
        args: [id],
      }),
    ]);

    const agent: CeloAgent = {
      agentId: id,
      owner: owner as `0x${string}`,
      agentWallet: agentWallet as `0x${string}`,
      tokenURI: tokenURI as string,
    };

    // Fetch and parse registration JSON best-effort. Network errors don't
    // invalidate the agent — just attach the error and return.
    try {
      const reg = await fetchRegistration(tokenURI as string);
      agent.registration = reg;
    } catch (err) {
      agent.registrationError = err instanceof Error ? err.message : String(err);
    }

    return agent;
  } catch (err) {
    // ownerOf reverts for non-existent tokens — treat as null
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ERC721NonexistentToken') || msg.includes('invalid token ID')) return null;
    throw err;
  }
}

async function fetchRegistration(uri: string): Promise<AgentRegistrationFile | null> {
  // data:application/json[;enc=gzip[;level=N]];base64,XXXX — fully on-chain
  // encoded metadata. Gas-optimized agents commonly use this pattern. Parse
  // inline rather than treating as unsupported.
  if (uri.startsWith('data:application/json')) {
    const commaIdx = uri.indexOf(',');
    if (commaIdx < 0) throw new Error('data URI missing comma separator');
    const header = uri.slice(5, commaIdx); // strip 'data:'
    const body = uri.slice(commaIdx + 1);
    const params = header.split(';');
    const isBase64 = params.includes('base64');
    const isGzip = params.some((p) => p.startsWith('enc=gzip'));

    let buf: Buffer;
    if (isBase64) {
      buf = Buffer.from(body, 'base64');
    } else {
      buf = Buffer.from(decodeURIComponent(body), 'utf-8');
    }
    if (isGzip) buf = gunzipSync(buf);
    return JSON.parse(buf.toString('utf-8')) as AgentRegistrationFile;
  }

  if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
    // ipfs:// and ar:// can be added later when the demand shows up.
    throw new Error(`unsupported URI scheme: ${uri.slice(0, 32)}…`);
  }
  // SSRF guard: uri is an attacker-controlled on-chain registration URL —
  // validate the host (and every redirect hop) is public before fetching.
  return (await safeFetchJson(uri, { timeoutMs: 8000 })) as AgentRegistrationFile;
}

// ─── ReputationRegistry reads ─────────────────────────────────────────────────

/**
 * Aggregate reputation summary scoped to a SPECIFIC set of client raters.
 * The contract reverts if `clientAddresses` is empty — use `aggregateFeedback`
 * for a global aggregate derived from readAllFeedback.
 */
export async function readFeedbackSummary(
  agentId: bigint | number,
  clientAddresses: [`0x${string}`, ...`0x${string}`[]],
  tag1 = '',
  tag2 = '',
): Promise<FeedbackSummary> {
  const client = getClient();
  const id = BigInt(agentId);

  const [count, summaryValue, summaryValueDecimals] = await client.readContract({
    address: REPUTATION_REGISTRY_CELO,
    abi: REPUTATION_ABI,
    functionName: 'getSummary',
    args: [id, clientAddresses, tag1, tag2],
  });

  return {
    count: Number(count),
    rawSummaryValue: summaryValue,
    summaryValueDecimals,
    summaryValue: Number(summaryValue) / 10 ** summaryValueDecimals,
  };
}

/**
 * Global feedback aggregate derived from readAllFeedback (no client filter).
 * Use this when you want "what does anyone say about this agent" rather than
 * "what does a specific validator set say". Normalizes per-record valueDecimals
 * before averaging so heterogeneous fixed-point scales mix cleanly.
 */
export async function aggregateFeedback(
  agentId: bigint | number,
  opts: { tag1?: string; tag2?: string; includeRevoked?: boolean } = {},
): Promise<{
  count: number;
  average: number | null;
  records: FeedbackRecord[];
}> {
  const records = await readAllFeedback(agentId, opts);
  const live = opts.includeRevoked ? records : records.filter((r) => !r.revoked);
  if (live.length === 0) return { count: 0, average: null, records };
  const sum = live.reduce((acc, r) => acc + r.value, 0);
  return { count: live.length, average: sum / live.length, records };
}

/**
 * Full feedback list for an agent. Useful for the agent profile page and for
 * publishing AK's own ratings back into UI without re-querying per record.
 */
export async function readAllFeedback(
  agentId: bigint | number,
  opts: {
    clientAddresses?: `0x${string}`[];
    tag1?: string;
    tag2?: string;
    includeRevoked?: boolean;
  } = {},
): Promise<FeedbackRecord[]> {
  const client = getClient();
  const id = BigInt(agentId);

  const [clients, indexes, values, decimals, tag1s, tag2s, revoked] = await client.readContract({
    address: REPUTATION_REGISTRY_CELO,
    abi: REPUTATION_ABI,
    functionName: 'readAllFeedback',
    args: [
      id,
      opts.clientAddresses ?? [],
      opts.tag1 ?? '',
      opts.tag2 ?? '',
      opts.includeRevoked ?? false,
    ],
  });

  const out: FeedbackRecord[] = [];
  for (let i = 0; i < clients.length; i++) {
    const rawValue = values[i];
    const dec = decimals[i];
    out.push({
      client: clients[i],
      feedbackIndex: indexes[i],
      rawValue,
      valueDecimals: dec,
      value: Number(rawValue) / 10 ** dec,
      tag1: tag1s[i],
      tag2: tag2s[i],
      revoked: revoked[i],
    });
  }
  return out;
}
