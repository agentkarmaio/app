/**
 * Parameterized ERC-8004 read + write for EVM chains.
 *
 * Third instance of the identical per-chain module: `erc8004-celo.ts` and
 * `erc8004-arc.ts` (testnet) are near-byte-identical except for registry
 * constants, the viem chain object and the RPC env var name. Arc
 * becomes the first consumer of this shared shape; Celo and retired Arc
 * testnet keep their own modules untouched (Celo's publish path is ARMED in
 * the celo-attest workflow — migrating it is a later, separate chore).
 *
 * Canonical ERC-8004 registries are deployed at the same vanity-prefixed
 * addresses on every EVM chain, so only the viem chain, RPC endpoint and the
 * gas-token name actually differ between instances.
 *
 * Spec: https://github.com/erc-8004/erc-8004-contracts/blob/master/ERC8004SPEC.md
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatEther,
  parseEther,
  keccak256,
  toBytes,
} from 'viem';
import type { Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeDataUriJson } from '@/lib/data-uri';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { safeFetchJson } from '@/lib/ssrf-guard';
import { feeCeilingError } from '@/lib/attest-policy';

// ─── Minimal ABIs (same reference deployment on every chain) ─────────────────

const IDENTITY_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
]);

const REPUTATION_ABI = parseAbi([
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)',
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);

export interface Evm8004Config {
  /** viem chain object (e.g. arcMainnet from @/config/arc-chain). */
  chain: Chain;
  identityRegistry: `0x${string}`;
  reputationRegistry: `0x${string}`;
  /** Env var holding the RPC override; empty or unset falls back to defaultRpcUrl. */
  rpcEnv: string;
  /** Last-resort endpoint when the env var is unset — required for chains like arc-mainnet whose viem chain object declares no rpcUrls. */
  defaultRpcUrl?: string;
  /** Human name of the native gas token for fee messages ('CELO', 'USDC'). */
  gasToken: string;
}

/** Resolve the RPC endpoint: env override (scheme-normalized) → default → chain URLs. */
export function resolveEvmRpcUrl(config: Evm8004Config): string | undefined {
  const raw = process.env[config.rpcEnv];
  if (raw) return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  return config.defaultRpcUrl;
}

// ─── Shared types ────────────────────────────────────────────────────────────

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

export interface EvmAgent {
  agentId: bigint;
  owner: `0x${string}`;
  agentWallet: `0x${string}`; // = owner unless setAgentWallet was used
  tokenURI: string;
  registration?: AgentRegistrationFile | null;
  registrationError?: string;
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
  summaryValue: number;
}

// ─── Read factory ────────────────────────────────────────────────────────────

export interface Evm8004Reads {
  readAgent(agentId: bigint | number): Promise<EvmAgent | null>;
  readFeedbackSummary(
    agentId: bigint | number,
    clientAddresses: [`0x${string}`, ...`0x${string}`[]],
    tag1?: string,
    tag2?: string,
  ): Promise<FeedbackSummary>;
  aggregateFeedback(
    agentId: bigint | number,
    opts?: { tag1?: string; tag2?: string; includeRevoked?: boolean },
  ): Promise<{ count: number; average: number | null; records: FeedbackRecord[] }>;
  readAllFeedback(
    agentId: bigint | number,
    opts?: {
      clientAddresses?: `0x${string}`[];
      tag1?: string;
      tag2?: string;
      includeRevoked?: boolean;
    },
  ): Promise<FeedbackRecord[]>;
}

/**
 * Build the read surface for one EVM chain. Identity-gated at the caller: a
 * bare address can't resolve an agentId, so agent-page reads that already hold
 * an agentId call these directly.
 */
export function makeEvm8004Reads(config: Evm8004Config): Evm8004Reads {
  // Bounded: viem's defaults (10s × 3 retries) let a wedged RPC hold a
  // profile render for ~40s. One retry, then fail fast to the DB fallback.
  const client = createPublicClient({
    chain: config.chain,
    transport: http(resolveEvmRpcUrl(config), { timeout: 10_000, retryCount: 1 }),
  });

  async function readAgent(agentId: bigint | number): Promise<EvmAgent | null> {
    const id = BigInt(agentId);
    try {
      const [owner, tokenURI, agentWallet] = await Promise.all([
        client.readContract({ address: config.identityRegistry, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [id] }),
        client.readContract({ address: config.identityRegistry, abi: IDENTITY_ABI, functionName: 'tokenURI', args: [id] }),
        client.readContract({ address: config.identityRegistry, abi: IDENTITY_ABI, functionName: 'getAgentWallet', args: [id] }),
      ]);

      const agent: EvmAgent = {
        agentId: id,
        owner: owner as `0x${string}`,
        agentWallet: agentWallet as `0x${string}`,
        tokenURI: tokenURI as string,
      };

      // Fetch and parse registration JSON best-effort. Network errors don't
      // invalidate the agent — just attach the error and return.
      try {
        agent.registration = await fetchRegistration(tokenURI as string);
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

  async function readFeedbackSummary(
    agentId: bigint | number,
    clientAddresses: [`0x${string}`, ...`0x${string}`[]],
    tag1 = '',
    tag2 = '',
  ): Promise<FeedbackSummary> {
    const id = BigInt(agentId);
    const [count, summaryValue, summaryValueDecimals] = await client.readContract({
      address: config.reputationRegistry,
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

  async function readAllFeedback(
    agentId: bigint | number,
    opts: { clientAddresses?: `0x${string}`[]; tag1?: string; tag2?: string; includeRevoked?: boolean } = {},
  ): Promise<FeedbackRecord[]> {
    const id = BigInt(agentId);
    const [clients, indexes, values, decimals, tag1s, tag2s, revoked] = await client.readContract({
      address: config.reputationRegistry,
      abi: REPUTATION_ABI,
      functionName: 'readAllFeedback',
      args: [id, opts.clientAddresses ?? [], opts.tag1 ?? '', opts.tag2 ?? '', opts.includeRevoked ?? false],
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

  /**
   * Global feedback aggregate derived from readAllFeedback (no client filter).
   * `count` / `average` ALWAYS exclude revoked records — a retracted rating
   * must never move the headline aggregate; `includeRevoked` only surfaces
   * revoked records in `.records`.
   */
  async function aggregateFeedback(
    agentId: bigint | number,
    opts: { tag1?: string; tag2?: string; includeRevoked?: boolean } = {},
  ): Promise<{ count: number; average: number | null; records: FeedbackRecord[] }> {
    const records = await readAllFeedback(agentId, opts);
    const live = records.filter((r) => !r.revoked);
    if (live.length === 0) return { count: 0, average: null, records };
    const sum = live.reduce((acc, r) => acc + r.value, 0);
    return { count: live.length, average: sum / live.length, records };
  }

  return { readAgent, readFeedbackSummary, aggregateFeedback, readAllFeedback };
}

async function fetchRegistration(uri: string): Promise<AgentRegistrationFile | null> {
  // data:application/json[;enc=gzip[;level=N]];base64,XXXX — fully on-chain
  // encoded metadata. Gas-optimized agents commonly use this pattern.
  if (uri.startsWith('data:application/json')) {
    return decodeDataUriJson(uri) as AgentRegistrationFile;
  }

  if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
    // ipfs:// and ar:// can be added later when the demand shows up.
    throw new Error(`unsupported URI scheme: ${uri.slice(0, 32)}…`);
  }
  // SSRF guard: uri is an attacker-controlled on-chain registration URL —
  // validate the host (and every redirect hop) is public before fetching.
  return (await safeFetchJson(uri, { timeoutMs: 8000 })) as AgentRegistrationFile;
}

// ─── Fee account ─────────────────────────────────────────────────────────────

export interface EvmFeeAccount {
  state: 'ok' | 'low';
  /** Human-readable balance of the native gas token. */
  balance: string;
  wei: bigint;
}

/**
 * Read the signer's native balance. On EVM chains the native gas token is
 * always an 18-decimal wei view (even Arc, whose gas IS USDC), so formatEther
 * is correct everywhere.
 *
 * Raises on an RPC failure rather than assuming health: not knowing the
 * balance is not the same as knowing it is fine. An unfunded address simply
 * reads zero, which lands in `low`.
 */
export async function readEvmFeeAccount(
  config: Evm8004Config,
  address: `0x${string}`,
  opts: { rpcUrl?: string; minBalance?: number; getBalance?: (a: `0x${string}`) => Promise<bigint> } = {},
): Promise<EvmFeeAccount> {
  const getBalance =
    opts.getBalance ??
    ((a: `0x${string}`) =>
      createPublicClient({
        chain: config.chain,
        transport: http(opts.rpcUrl ?? resolveEvmRpcUrl(config)),
      }).getBalance({ address: a }));

  const wei = await getBalance(address);
  const floor = parseEther(String(opts.minBalance ?? 0));
  return { state: wei >= floor ? 'ok' : 'low', balance: formatEther(wei), wei };
}

/**
 * Effective per-transaction fee ceiling in wei: the policy cap, further
 * limited by the balance actually held. BigInt throughout — wei is exact.
 */
export function evmFeeCeilingWei(balanceWei: bigint, maxFee: number): bigint {
  const cap = parseEther(String(maxFee));
  return balanceWei < cap ? balanceWei : cap;
}

// ─── Write factory ───────────────────────────────────────────────────────────

export interface Evm8004PublishConfig extends Evm8004Config {
  /** Preferred dedicated validator keyfile (routine attestations off the controller key). */
  validatorKeyfile: string;
  /** Fallback keyfile when the validator keyfile isn't present. */
  controllerKeyfile?: string;
  /** Env var holding the signing key (0x-prefixed) — the only way a scheduled CI run can sign. */
  privateKeyEnv: string;
  /** Disclosed validator address — the unarmed-run fallback when no key exists anywhere. */
  disclosedSigner: `0x${string}`;
}

export interface PublishFeedbackInput {
  agentId: bigint | number;
  /** Integer or signed fixed-point. e.g. value=85, valueDecimals=0 → 85. value=8500, valueDecimals=2 → 85.00 */
  value: bigint | number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint?: string;
  feedbackURI?: string;
  feedbackHash?: `0x${string}`;
}

export interface PublishFeedbackResult {
  dryRun: boolean;
  agentId: string;
  txHash?: `0x${string}`;
  block?: bigint;
  gasUsed?: bigint;
  /** Exact estimated cost, human units of the chain's native gas token. */
  estimatedCost?: string;
  /** Exact estimated cost in wei — what the fee ceiling compares against. */
  feeWei?: bigint;
}

export interface PublishFeedbackDeps {
  /**
   * Signer address for a SIMULATE-only run, when no private key is available.
   * viem simulates against an address, so a dry run must not require the key —
   * that is what lets a scheduled job exercise the whole path before arming.
   */
  signer?: `0x${string}`;
  /**
   * Refuse to sign when the estimated fee exceeds this many wei. Checked in
   * BOTH modes: a dry run that ignores the fee cannot warn that the cadence
   * has become unaffordable, which is the whole point of a daily canary.
   */
  maxFeeWei?: bigint;
}

/** The contract blocks self-feedback, so a run must target a different agentId than its own. */
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

/**
 * Compute a deterministic bytes32 hash over an off-chain feedback payload.
 * Caller passes the same JSON shape that lives at `feedbackURI`. The hash
 * lets downstream consumers verify the URI content matches what AK signed.
 */
export function feedbackHashFromJson(payload: unknown): `0x${string}` {
  const canonical = JSON.stringify(payload);
  return keccak256(toBytes(canonical));
}

export interface Evm8004Publish {
  activeSignerAddress(): `0x${string}`;
  publishFeedback(
    input: PublishFeedbackInput,
    mode?: 'simulate' | 'execute',
    deps?: PublishFeedbackDeps,
  ): Promise<PublishFeedbackResult>;
}

export function makeEvm8004Publish(config: Evm8004PublishConfig): Evm8004Publish {
  function resolveKeyfile(): string {
    const validator = resolve(config.validatorKeyfile);
    if (existsSync(validator)) return validator;
    if (config.controllerKeyfile) {
      const controller = resolve(config.controllerKeyfile);
      if (existsSync(controller)) return controller;
    }
    throw new Error(`no keyfile found: ${config.validatorKeyfile}${config.controllerKeyfile ? ` or ${config.controllerKeyfile}` : ''}`);
  }

  function loadKeypair() {
    // An unset GitHub secret arrives as an EMPTY STRING, so the env branch
    // tests truthiness rather than presence — an empty value falls through to
    // the keyfile and fails loudly there instead of building a malformed account.
    const fromEnv = process.env[config.privateKeyEnv];
    if (fromEnv) return privateKeyToAccount(fromEnv as `0x${string}`);
    const { privateKey } = JSON.parse(readFileSync(resolveKeyfile(), 'utf-8')) as {
      privateKey: `0x${string}`;
    };
    return privateKeyToAccount(privateKey);
  }

  /**
   * Public address of the wallet that will sign attestations (no key exposure).
   * Reading the address must NOT require the private key: the unarmed scheduled
   * run simulates the whole path and needs only an address. Precedence:
   * signing key → keyfile → the disclosed validator constant.
   */
  function activeSignerAddress(): `0x${string}` {
    const fromEnv = process.env[config.privateKeyEnv];
    if (fromEnv) return privateKeyToAccount(fromEnv as `0x${string}`).address;
    for (const keyfile of [config.validatorKeyfile, config.controllerKeyfile]) {
      if (!keyfile) continue;
      const path = resolve(keyfile);
      if (!existsSync(path)) continue;
      const { address } = JSON.parse(readFileSync(path, 'utf-8')) as { address: `0x${string}` };
      return address;
    }
    return config.disclosedSigner;
  }

  async function publishFeedback(
    input: PublishFeedbackInput,
    mode: 'simulate' | 'execute' = 'simulate',
    deps: PublishFeedbackDeps = {},
  ): Promise<PublishFeedbackResult> {
    // Simulate never signs, so it never needs the key.
    const account = mode === 'execute' ? loadKeypair() : null;
    const caller = account ?? deps.signer ?? activeSignerAddress();
    const publicClient = createPublicClient({
      chain: config.chain,
      transport: http(resolveEvmRpcUrl(config)),
    });

    const agentId = BigInt(input.agentId);
    const value = BigInt(input.value);
    const feedbackHash = input.feedbackHash ?? ZERO_HASH;

    const args = [
      agentId,
      value,
      input.valueDecimals,
      input.tag1,
      input.tag2,
      input.endpoint ?? '',
      input.feedbackURI ?? '',
      feedbackHash,
    ] as const;

    const { request } = await publicClient.simulateContract({
      account: caller,
      address: config.reputationRegistry,
      abi: REPUTATION_ABI,
      functionName: 'giveFeedback',
      args,
    });

    const gas = await publicClient.estimateContractGas({
      account: caller,
      address: config.reputationRegistry,
      abi: REPUTATION_ABI,
      functionName: 'giveFeedback',
      args,
    });
    const gasPrice = await publicClient.getGasPrice();
    const feeWei = gas * gasPrice;
    const cost = formatEther(feeWei);

    // Last gate before a signature, and it applies to the dry run too: the fee
    // is a property of network state, so a run that ignores it reports green
    // while a real write would be refused.
    if (deps.maxFeeWei !== undefined && feeWei > deps.maxFeeWei) {
      throw feeCeilingError(
        `fee ceiling exceeded (agent ${agentId}): estimated ${cost} ${config.gasToken} ` +
          `> ceiling ${formatEther(deps.maxFeeWei)} ${config.gasToken}. Nothing signed, nothing sent.`,
        feeWei,
        deps.maxFeeWei,
      );
    }

    if (mode === 'simulate') {
      return { dryRun: true, agentId: agentId.toString(), estimatedCost: cost, feeWei };
    }
    if (!account) {
      throw new Error(`execute mode requires a key (${config.privateKeyEnv} or ${config.validatorKeyfile})`);
    }

    const wallet = createWalletClient({ account, chain: config.chain, transport: http(resolveEvmRpcUrl(config)) });
    const txHash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`giveFeedback tx reverted: ${txHash}`);
    }

    return {
      dryRun: false,
      agentId: agentId.toString(),
      txHash,
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      estimatedCost: cost,
      feeWei,
    };
  }

  return { activeSignerAddress, publishFeedback };
}