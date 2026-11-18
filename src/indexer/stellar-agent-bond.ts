/**
 * Agent Bond indexer (stellar-testnet only).
 *
 * Reads `contracts/agent-bond` events from Soroban RPC with cursor pagination,
 * writes the raw log (`agent_bond_events`) and SETS current state
 * (`agent_bonds`) from each event's post-state totals, then marks the owner
 * wallets dirty so the rescore queue picks up the bond factor.
 *
 * Event shape contract (contracts/agent-bond/src/events.rs):
 *   bond events   topics [name, agent_id: u32], data = map with post-state totals
 *   config events topics [name] (ignored here; nothing scores them)
 *
 * Soroban RPC keeps about 7 days of events. The first run starts at the pinned
 * deploy ledger; a cursor older than retention is reported as a gap, never
 * silently skipped.
 */
import { scValToNative, type xdr } from '@stellar/stellar-sdk';

import type { AgentBondEventKind } from '@/db/schema';
import { STELLAR_USDC_DECIMALS } from '@/config/stellar-x402';

export const AGENT_BOND_CHAIN = 'stellar-testnet' as const;

export interface RawAgentBondEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
  inSuccessfulContractCall: boolean;
}

export type AgentBondEvidence =
  | { kind: 'enactment'; digest: string }
  | { kind: 'assay'; codeHash: string; recordDigest: string };

export interface DecodedAgentBondEvent {
  eventId: string;
  contractId: string;
  txHash: string;
  ledger: number;
  ledgerClosedAt: string;
  agentId: number;
  owner: string;
  kind: AgentBondEventKind;
  /** Human USDC, 7 dp strings (no float drift). */
  amount: string;
  bonded: string;
  unbonding: string;
  /** Present on events that carry it (deposited, slashed). */
  slashedTotal?: string;
  /** Present on unbond_requested: unix seconds. */
  unlockAt?: number;
  evidence?: AgentBondEvidence;
  evidenceId?: string;
  /** Present on slashed: the slasher that authorized it. */
  slasher?: string;
}

const TOPIC_KIND: Record<string, AgentBondEventKind> = {
  bond_deposited: 'deposited',
  bond_unbond_requested: 'unbond_requested',
  bond_withdrawn: 'withdrawn',
  bond_slashed: 'slashed',
};

const SCALE = BigInt(10 ** STELLAR_USDC_DECIMALS);

export function baseUnitsToUsdc(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const frac = (abs % SCALE).toString().padStart(STELLAR_USDC_DECIMALS, '0');
  return `${neg ? '-' : ''}${abs / SCALE}.${frac}`;
}

function hex(v: unknown, field: string): string {
  if (!(v instanceof Uint8Array) || v.length !== 32) {
    throw new Error(`agent-bond event: ${field} is not 32 bytes`);
  }
  return Buffer.from(v).toString('hex');
}

function big(v: unknown, field: string): bigint {
  if (typeof v !== 'bigint' && typeof v !== 'number') {
    throw new Error(`agent-bond event: ${field} missing`);
  }
  return BigInt(v);
}

function decodeEvidence(v: unknown): AgentBondEvidence {
  if (!Array.isArray(v)) throw new Error('agent-bond event: evidence malformed');
  if (v[0] === 'Enactment' && v.length === 2) return { kind: 'enactment', digest: hex(v[1], 'evidence.digest') };
  if (v[0] === 'AssayVerdict' && v.length === 3) {
    return { kind: 'assay', codeHash: hex(v[1], 'evidence.code_hash'), recordDigest: hex(v[2], 'evidence.record_digest') };
  }
  throw new Error(`agent-bond event: unknown evidence variant ${String(v[0])}`);
}

/**
 * Pure. Returns null for events this indexer does not consume (config events,
 * failed calls). Throws on a bond event whose shape does not match the
 * contract: that is a contract/indexer drift, and must fail loud.
 */
export function decodeAgentBondEvent(raw: RawAgentBondEvent): DecodedAgentBondEvent | null {
  if (!raw.inSuccessfulContractCall || raw.topic.length === 0) return null;
  const name = scValToNative(raw.topic[0]);
  const kind = typeof name === 'string' ? TOPIC_KIND[name] : undefined;
  if (!kind) return null;
  if (raw.topic.length !== 2) throw new Error(`agent-bond event ${name}: expected 2 topics, got ${raw.topic.length}`);

  const agentId = scValToNative(raw.topic[1]);
  if (typeof agentId !== 'number') throw new Error(`agent-bond event ${name}: agent_id is not u32`);
  const d = scValToNative(raw.value) as Record<string, unknown>;
  if (!d || typeof d !== 'object' || typeof d.owner !== 'string') {
    throw new Error(`agent-bond event ${name}: data map malformed`);
  }

  const out: DecodedAgentBondEvent = {
    eventId: raw.id,
    contractId: raw.contractId,
    txHash: raw.txHash,
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    agentId,
    owner: d.owner,
    kind,
    amount: baseUnitsToUsdc(big(d.amount, 'amount')),
    bonded: baseUnitsToUsdc(big(d.bonded, 'bonded')),
    unbonding: baseUnitsToUsdc(big(d.unbonding, 'unbonding')),
  };
  if (d.slashed_total !== undefined) out.slashedTotal = baseUnitsToUsdc(big(d.slashed_total, 'slashed_total'));
  if (kind === 'unbond_requested') out.unlockAt = Number(big(d.unlock_at, 'unlock_at'));
  if (kind === 'slashed') {
    if (typeof d.slasher !== 'string') throw new Error(`agent-bond event ${name}: slasher missing`);
    out.slasher = d.slasher;
    out.evidence = decodeEvidence(d.evidence);
    out.evidenceId = hex(d.evidence_id, 'evidence_id');
  }
  return out;
}

// ─── state projection ────────────────────────────────────────────────────────

export interface AgentBondRow {
  chain: typeof AGENT_BOND_CHAIN;
  contract_id: string;
  agent_id: number;
  owner_wallet: string;
  bonded: string;
  unbonding: string;
  unlock_at: string | null;
  slashed_total: string;
  first_deposit_at: string;
  last_ledger: number;
}

export interface AgentBondEventRow {
  chain: typeof AGENT_BOND_CHAIN;
  contract_id: string;
  event_id: string;
  tx_hash: string;
  ledger: number;
  ledger_closed_at: string;
  agent_id: number;
  owner_wallet: string;
  kind: AgentBondEventKind;
  amount: string;
  bonded: string;
  unbonding: string;
  evidence_kind: 'enactment' | 'assay' | null;
  evidence_id: string | null;
  evidence: AgentBondEvidence | null;
  slasher: string | null;
}

export function toEventRow(e: DecodedAgentBondEvent): AgentBondEventRow {
  return {
    chain: AGENT_BOND_CHAIN,
    contract_id: e.contractId,
    event_id: e.eventId,
    tx_hash: e.txHash,
    ledger: e.ledger,
    ledger_closed_at: e.ledgerClosedAt,
    agent_id: e.agentId,
    owner_wallet: e.owner,
    kind: e.kind,
    amount: e.amount,
    bonded: e.bonded,
    unbonding: e.unbonding,
    evidence_kind: e.evidence?.kind ?? null,
    evidence_id: e.evidenceId ?? null,
    evidence: e.evidence ?? null,
    slasher: e.slasher ?? null,
  };
}

type Prior = Pick<AgentBondRow, 'unlock_at' | 'slashed_total' | 'first_deposit_at'>;

/**
 * Fold ordered events into the latest state per (contract, agent). `prior`
 * supplies the fields some events do not carry (unlock_at, slashed_total,
 * first_deposit_at) from the stored row.
 */
export function projectBondState(
  events: DecodedAgentBondEvent[],
  prior: Map<string, Prior>,
): AgentBondRow[] {
  const state = new Map<string, AgentBondRow>();
  for (const e of events) {
    const key = bondKey(e.contractId, e.agentId);
    const before = state.get(key) ?? prior.get(key);
    const unlockAt =
      e.kind === 'unbond_requested' ? new Date(e.unlockAt! * 1000).toISOString()
        : Number(e.unbonding) === 0 ? null
          : before?.unlock_at ?? null;
    state.set(key, {
      chain: AGENT_BOND_CHAIN,
      contract_id: e.contractId,
      agent_id: e.agentId,
      owner_wallet: e.owner,
      bonded: e.bonded,
      unbonding: e.unbonding,
      unlock_at: unlockAt,
      slashed_total: e.slashedTotal ?? before?.slashed_total ?? '0.0000000',
      first_deposit_at: before?.first_deposit_at ?? e.ledgerClosedAt,
      last_ledger: e.ledger,
    });
  }
  return [...state.values()];
}

export function bondKey(contractId: string, agentId: number): string {
  return `${contractId}:${agentId}`;
}

// ─── run loop ────────────────────────────────────────────────────────────────

export interface AgentBondEventsPage {
  events: RawAgentBondEvent[];
  cursor: string;
  oldestLedger: number;
  latestLedger: number;
}

export interface AgentBondIndexerDeps {
  contractId: string;
  deployLedger: number;
  getEvents: (req: { startLedger: number } | { cursor: string }, limit: number) => Promise<AgentBondEventsPage>;
  getOldestLedger: () => Promise<number>;
  loadCursor: () => Promise<string | null>;
  saveCursor: (cursor: string, ledger: number) => Promise<void>;
  loadPrior: (keys: { contractId: string; agentId: number }[]) => Promise<Map<string, Prior>>;
  ensureWallets: (addresses: string[]) => Promise<void>;
  insertEvents: (rows: AgentBondEventRow[]) => Promise<number>;
  upsertBonds: (rows: AgentBondRow[]) => Promise<void>;
  markDirty: (addresses: string[]) => Promise<void>;
  /**
   * Owners with a bond event in the last ~31 days. Their counted (seasoned)
   * balance changes as days pass with no new event, so they are re-marked
   * dirty every run; otherwise the stored score would never pick up the lift.
   */
  seasoningOwners: () => Promise<string[]>;
  signal?: AbortSignal;
  pageLimit?: number;
  maxPages?: number;
}

export interface AgentBondIndexerResult {
  inserted: number;
  pages: number;
  coverage: {
    complete: boolean;
    checked: number;
    pending: number;
    unresolved: number;
    gaps: number;
    checkpoint?: string;
    head?: string;
    reason?: string;
  };
}

export async function runAgentBondIndexer(deps: AgentBondIndexerDeps): Promise<AgentBondIndexerResult> {
  const limit = deps.pageLimit ?? 200;
  const maxPages = deps.maxPages ?? 50;
  let cursor = await deps.loadCursor();
  let gaps = 0;
  if (cursor === null) {
    const oldest = await deps.getOldestLedger();
    // Events between deploy and the RPC retention floor are unrecoverable here.
    if (oldest > deps.deployLedger) gaps = 1;
  }

  let inserted = 0;
  let checked = 0;
  let pages = 0;
  let head: number | undefined;
  let lastLedger = 0;
  let complete = false;

  while (pages < maxPages) {
    deps.signal?.throwIfAborted();
    const page = await deps.getEvents(
      cursor === null ? { startLedger: Math.max(deps.deployLedger, await deps.getOldestLedger()) } : { cursor },
      limit,
    );
    pages++;
    head = page.latestLedger;
    const ours = page.events.filter((e) => e.contractId === deps.contractId);
    checked += ours.length;
    const decoded = ours
      .map(decodeAgentBondEvent)
      .filter((e): e is DecodedAgentBondEvent => e !== null)
      .sort((a, b) => a.ledger - b.ledger || a.eventId.localeCompare(b.eventId));

    if (decoded.length > 0) {
      const owners = [...new Set(decoded.map((e) => e.owner))];
      await deps.ensureWallets(owners);
      inserted += await deps.insertEvents(decoded.map(toEventRow));
      const keys = [...new Map(decoded.map((e) => [bondKey(e.contractId, e.agentId), { contractId: e.contractId, agentId: e.agentId }])).values()];
      const prior = await deps.loadPrior(keys);
      await deps.upsertBonds(projectBondState(decoded, prior));
      await deps.markDirty(owners);
      lastLedger = decoded[decoded.length - 1].ledger;
    }

    // Advance only after every write for this page succeeded.
    cursor = page.cursor;
    await deps.saveCursor(cursor, lastLedger || page.latestLedger);
    if (page.events.length < limit) {
      complete = true;
      break;
    }
  }

  const seasoning = await deps.seasoningOwners();
  if (seasoning.length > 0) await deps.markDirty(seasoning);

  return {
    inserted,
    pages,
    coverage: {
      complete: complete && gaps === 0,
      checked,
      pending: complete ? 0 : 1,
      unresolved: 0,
      gaps,
      checkpoint: cursor ?? undefined,
      head: head !== undefined ? String(head) : undefined,
      reason: gaps > 0 ? 'retention_gap' : complete ? undefined : 'budget',
    },
  };
}

// ─── production wiring ───────────────────────────────────────────────────────

/** Real RPC + DB deps for the production Agent Bond contract on testnet. */
export async function runStellarAgentBondIndexer(opts: { signal?: AbortSignal } = {}): Promise<AgentBondIndexerResult> {
  const [{ getStellarRpc }, { STELLAR_TESTNET_AGENT_BOND }, db] = await Promise.all([
    import('@/integrations/erc8004-stellar'),
    import('@/integrations/stellar-config'),
    import('@/db/client'),
  ]);
  const server = getStellarRpc('testnet');
  const { contractId, deployLedger } = STELLAR_TESTNET_AGENT_BOND;
  const cursorKey = `agent-bond:${contractId}`;

  return runAgentBondIndexer({
    contractId,
    deployLedger,
    signal: opts.signal,
    getOldestLedger: async () => (await server.getHealth()).oldestLedger,
    getEvents: async (req, limit) => {
      const filters = [{ type: 'contract' as const, contractIds: [contractId] }];
      const resp = 'cursor' in req
        ? await server.getEvents({ filters, cursor: req.cursor, limit })
        : await server.getEvents({ filters, startLedger: req.startLedger, limit });
      return {
        cursor: resp.cursor,
        oldestLedger: resp.oldestLedger,
        latestLedger: resp.latestLedger,
        events: resp.events.map((e) => ({
          id: e.id,
          ledger: e.ledger,
          ledgerClosedAt: e.ledgerClosedAt,
          contractId: e.contractId ? e.contractId.address().toString() : '',
          txHash: e.txHash,
          topic: e.topic,
          value: e.value,
          inSuccessfulContractCall: e.inSuccessfulContractCall ?? true,
        })),
      };
    },
    loadCursor: async () => (await db.getCursor(cursorKey, AGENT_BOND_CHAIN))?.last_signature ?? null,
    saveCursor: (cursor, ledger) => db.upsertCursor(cursorKey, cursor, ledger, AGENT_BOND_CHAIN),
    loadPrior: (keys) => db.getAgentBondPriors(contractId, keys.map((k) => k.agentId)),
    ensureWallets: db.makeEnsureWallets(AGENT_BOND_CHAIN),
    insertEvents: db.insertAgentBondEvents,
    upsertBonds: db.upsertAgentBonds,
    markDirty: (addresses) => db.markWalletsDirty(addresses.map((address) => ({ chain: AGENT_BOND_CHAIN, address }))),
    seasoningOwners: () => db.getAgentBondSeasoningOwners(contractId),
  });
}
