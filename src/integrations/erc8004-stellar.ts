/**
 * ERC-8004 Stellar adapter (read path) — reads the IdentityRegistry +
 * ReputationRegistry on the trionlabs/stellar-8004 LIVE mainnet contracts via
 * Soroban RPC `simulateTransaction` (view calls). D1 decision (spec §2).
 *
 * Mirrors the surface of `erc8004-celo.ts` (Celo/viem). Differences inherent
 * to Soroban:
 *   - agentId is u32 (not uint256);
 *   - feedback value is i128, the summary is WAD-normalized;
 *   - reads are simulate-only contract calls, not eth_call.
 *
 * Method signatures verified 2026-06-06 against trionlabs/stellar-8004:
 *   - reputation-registry/src/contract.rs::get_summary(agent_id, clients, tag1, tag2)
 *     → SummaryResult { count: u64, summary_value: i128, summary_value_decimals: u32 }
 *     (caps at 5 clients, reverts on empty client list).
 *   - identity-registry/src/contract.rs::get_agent_wallet(agent_id) → Option<Address>
 *     (the reserved `agentWallet` binding; also reachable via get_metadata/find_owner).
 *
 * Env: STELLAR_RPC_URL (optional override; resolveStellarRpcUrl falls back to
 * the mainnet Soroban RPC default).
 */
import {
  rpc,
  Contract,
  TransactionBuilder,
  Account,
  BASE_FEE,
  Address,
  scValToNative,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import {
  STELLAR_IDENTITY_REGISTRY,
  STELLAR_REPUTATION_REGISTRY,
  STELLAR_NETWORK_PASSPHRASE,
  resolveStellarRpcUrl,
} from './stellar-config';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Raw shape of the Soroban `SummaryResult` struct (scValToNative output). */
export interface RawSummaryResult {
  count: bigint;
  summary_value: bigint;
  summary_value_decimals: number;
}

export interface FeedbackSummary {
  count: number;
  rawSummaryValue: bigint;
  summaryValueDecimals: number;
  /** Normalized aggregate = summary_value / 10^summary_value_decimals. */
  summaryValue: number;
}

// ─── Pure decoder (unit-testable without RPC) ───────────────────────────────

/**
 * Normalize a raw Soroban SummaryResult into a JS-friendly FeedbackSummary.
 * Pure — no RPC. Mirrors `erc8004-celo.ts`'s readFeedbackSummary mapping.
 */
export function decodeSummary(raw: RawSummaryResult): FeedbackSummary {
  return {
    count: Number(raw.count),
    rawSummaryValue: raw.summary_value,
    summaryValueDecimals: raw.summary_value_decimals,
    summaryValue: Number(raw.summary_value) / 10 ** raw.summary_value_decimals,
  };
}

// ─── RPC client ─────────────────────────────────────────────────────────────

let _rpc: rpc.Server | null = null;

/** Build a fresh Soroban RPC server pointed at the resolved mainnet URL. */
export function makeStellarRpc(): rpc.Server {
  return new rpc.Server(resolveStellarRpcUrl());
}

/** Process-cached RPC server (mirrors erc8004-celo.ts's getClient singleton). */
export function getStellarRpc(): rpc.Server {
  if (!_rpc) _rpc = makeStellarRpc();
  return _rpc;
}

// Placeholder source account for read-only simulations (sequence is ignored —
// simulateTransaction does not consume the source's sequence number). MUST be a
// valid Ed25519 StrKey: the SDK's Account constructor validates the checksum, so
// a malformed placeholder would crash every read. This is the canonical
// all-zeros-ish well-known public key (StrKey.encodeEd25519PublicKey of a fixed
// byte pattern) — never holds funds, never signs.
const VIEW_SOURCE = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';

export interface SimulateViewArgs {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  sourceAccount?: string;
}

/**
 * Execute a view (read-only) contract call via simulateTransaction and return
 * the native-decoded return value. Raises on a simulate error — NO silent
 * fallback (AK core rule). The injected `server` makes this unit-testable
 * against a mocked rpc.Server.
 */
export async function simulateView(server: rpc.Server, a: SimulateViewArgs): Promise<unknown> {
  const source = new Account(a.sourceAccount ?? VIEW_SOURCE, '0');
  const contract = new Contract(a.contractId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(a.method, ...a.args))
    .setTimeout(30)
    .build();

  const sim = (await server.simulateTransaction(tx)) as
    | { error: string }
    | { result?: { retval: xdr.ScVal } };

  if ('error' in sim && sim.error) {
    throw new Error(`Stellar simulate ${a.method} failed: ${sim.error}`);
  }
  if (!('result' in sim) || !sim.result) {
    throw new Error(`Stellar simulate ${a.method} returned no result`);
  }
  return scValToNative(sim.result.retval);
}

// ─── ReputationRegistry reads ───────────────────────────────────────────────

const MAX_SUMMARY_CLIENTS = 5; // contract hard cap (reputation contract.rs::get_summary)

/**
 * Encode get_summary args. Rejects an empty client list locally because the
 * contract reverts when no client addresses are supplied (Sybil prevention).
 * Caps the list at the contract maximum of 5.
 */
export function buildSummaryArgs(
  agentId: number,
  clientAddresses: string[],
  tag1: string,
  tag2: string,
): xdr.ScVal[] {
  if (clientAddresses.length === 0) {
    throw new Error('get_summary requires at least one client address');
  }
  const clients = clientAddresses
    .slice(0, MAX_SUMMARY_CLIENTS)
    .map((a) => new Address(a).toScVal());
  return [
    nativeToScVal(agentId, { type: 'u32' }),
    xdr.ScVal.scvVec(clients),
    nativeToScVal(tag1, { type: 'string' }),
    nativeToScVal(tag2, { type: 'string' }),
  ];
}

/** get_summary on the Reputation Registry, scoped to specific client raters. */
export async function readStellarSummary(
  server: rpc.Server,
  agentId: number,
  clientAddresses: string[],
  tag1 = '',
  tag2 = '',
): Promise<FeedbackSummary> {
  const raw = (await simulateView(server, {
    contractId: STELLAR_REPUTATION_REGISTRY,
    method: 'get_summary',
    args: buildSummaryArgs(agentId, clientAddresses, tag1, tag2),
  })) as RawSummaryResult;
  return decodeSummary(raw);
}

// ─── IdentityRegistry reads ─────────────────────────────────────────────────

/**
 * Resolve the wallet (StrKey G...) bound to an agentId via the reserved
 * `agentWallet` binding (identity-registry::get_agent_wallet → Option<Address>).
 * Returns null when the agent has no bound wallet. AK persists agentId at claim
 * time in walletsTable.stellar_agent_id (U4) — this is the on-chain confirmation
 * of the agentId ↔ agentWallet mapping.
 */
export async function readStellarAgentWallet(
  server: rpc.Server,
  agentId: number,
): Promise<string | null> {
  const wallet = (await simulateView(server, {
    contractId: STELLAR_IDENTITY_REGISTRY,
    method: 'get_agent_wallet',
    args: [nativeToScVal(agentId, { type: 'u32' })],
  })) as string | null | undefined;
  return wallet ?? null;
}

/**
 * Total registered agents on the Identity Registry (u64). Doubles as the upper
 * bound the backfill probes against — the contract assigns sequential agentIds
 * starting at 0, so `total_agents` is one past the highest valid id.
 *
 * Verified 2026-06-11 against the live trionlabs/stellar-8004 mainnet contract.
 */
export async function getStellarTotalAgents(server: rpc.Server): Promise<number> {
  const total = (await simulateView(server, {
    contractId: STELLAR_IDENTITY_REGISTRY,
    method: 'total_agents',
    args: [],
  })) as bigint | number;
  return Number(total);
}

/**
 * Check whether an agentId is registered. Cheap pre-check before agent_uri,
 * which reverts (HostError Contract#2) on a non-existent agent.
 */
export async function stellarAgentExists(server: rpc.Server, agentId: number): Promise<boolean> {
  const exists = (await simulateView(server, {
    contractId: STELLAR_IDENTITY_REGISTRY,
    method: 'agent_exists',
    args: [nativeToScVal(agentId, { type: 'u32' })],
  })) as boolean;
  return exists === true;
}

/**
 * Resolve the owner (StrKey G...) of an agentId via `find_owner` → Option<Address>.
 * Returns null when the agentId is unregistered. Spec § (trionlabs Identity
 * Registry) treats owner ≠ agentWallet in general (setAgentWallet can rebind);
 * AK reads both and persists `owner` as the wallet row's address.
 */
export async function readStellarAgentOwner(
  server: rpc.Server,
  agentId: number,
): Promise<string | null> {
  const owner = (await simulateView(server, {
    contractId: STELLAR_IDENTITY_REGISTRY,
    method: 'find_owner',
    args: [nativeToScVal(agentId, { type: 'u32' })],
  })) as string | null | undefined;
  return owner ?? null;
}

/**
 * Fetch the agentURI string for an agentId. Throws on a non-existent agent
 * (Soroban contract revert) — callers should pre-check with `stellarAgentExists`
 * to distinguish "missing" from a real RPC failure.
 */
export async function readStellarAgentUri(
  server: rpc.Server,
  agentId: number,
): Promise<string> {
  const uri = (await simulateView(server, {
    contractId: STELLAR_IDENTITY_REGISTRY,
    method: 'agent_uri',
    args: [nativeToScVal(agentId, { type: 'u32' })],
  })) as string;
  return uri;
}

// ─── Full agent read (mirrors erc8004-celo.ts readAgent) ────────────────────

import { gunzipSync } from 'zlib';
import type { AgentRegistrationFile } from './erc8004-celo';

/** Re-export for downstream consumers — the same registration JSON spec. */
export type { AgentRegistrationFile } from './erc8004-celo';

export interface StellarAgent {
  agentId: number;
  /** find_owner result — the registrant's StrKey G... address. */
  owner: string;
  /** get_agent_wallet result — equals owner unless set_agent_wallet was used. */
  agentWallet: string;
  /** agent_uri raw return — typically `data:application/json;base64,…` or http(s). */
  agentURI: string;
  /** Parsed registration JSON (best-effort; null when unresolvable). */
  registration?: AgentRegistrationFile | null;
  /** Error message when the URI was reachable but parse/fetch failed. */
  registrationError?: string;
}

/**
 * Parse an agentURI string into the structured ERC-8004 registration JSON.
 * Supports the same URI schemes as Celo's `fetchRegistration`:
 *   - data:application/json[;enc=gzip[;level=N]];base64,XXXX
 *   - http(s):// (8s timeout)
 *
 * ipfs:// / ar:// are explicitly unsupported — fall back to attaching the
 * error string on the StellarAgent rather than throwing.
 */
async function fetchStellarRegistration(uri: string): Promise<AgentRegistrationFile | null> {
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
    throw new Error(`unsupported URI scheme: ${uri.slice(0, 32)}…`);
  }
  const res = await fetch(uri, {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'AgentKarma/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AgentRegistrationFile;
}

/**
 * Read a full Stellar agent — owner, agentWallet, agentURI, and the parsed
 * registration JSON — for one agentId. Returns null when the agentId is not
 * registered. Network errors against the off-chain registration host attach
 * to `registrationError` rather than failing the whole read (mirrors Celo).
 *
 * Used by `scripts/stellar-backfill-agents.ts` to materialize every registered
 * Stellar agent into AK's wallets table.
 */
export async function readStellarAgent(
  server: rpc.Server,
  agentId: number,
): Promise<StellarAgent | null> {
  // Pre-gate: agent_uri reverts (HostError Contract#2) on a non-existent
  // agentId — wrap the whole sequence after confirming existence so a revert
  // can be distinguished from a real RPC failure.
  const exists = await stellarAgentExists(server, agentId);
  if (!exists) return null;

  const [owner, agentWallet, agentURI] = await Promise.all([
    readStellarAgentOwner(server, agentId),
    readStellarAgentWallet(server, agentId),
    readStellarAgentUri(server, agentId),
  ]);

  // owner / agentWallet should be set for an existing agent, but the contract
  // allows agentWallet to be unset → fall back to owner per spec §3.
  if (!owner) return null;

  const agent: StellarAgent = {
    agentId,
    owner,
    agentWallet: agentWallet ?? owner,
    agentURI,
  };

  try {
    agent.registration = await fetchStellarRegistration(agentURI);
  } catch (err) {
    agent.registrationError = err instanceof Error ? err.message : String(err);
  }

  return agent;
}

// ─── Score mapping ──────────────────────────────────────────────────────────

// AK rates each agent under provider/consumer tags scoped to AK's own
// validator address (mirrors Celo's client-scoped getSummary).
export const AK_TAG2 = 'agentkarma';

export interface ComputeScoreArgs {
  agentId: number | null;
  server: rpc.Server;
  validatorAddress: string;
  /** Which karma face to read; defaults to provider. */
  tag1?: 'provider' | 'consumer';
}

/**
 * Resolve a wallet's on-chain AK attestation to a 0–100 score.
 * Returns 0 when the wallet has no registered agentId (badge-gated, no rpc
 * round-trip) or when AK has left no feedback for it.
 */
export async function computeAttestationScore(a: ComputeScoreArgs): Promise<number> {
  if (a.agentId == null) return 0;
  const summary = await readStellarSummary(
    a.server,
    a.agentId,
    [a.validatorAddress],
    a.tag1 ?? 'provider',
    AK_TAG2,
  );
  if (summary.count === 0) return 0;
  return Math.round(summary.summaryValue);
}
