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
