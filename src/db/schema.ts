/**
 * Karma DB Schema
 *
 * Drizzle table definitions -> used by drizzle-kit for schema push/migrations
 * TypeScript types -> used at runtime by Supabase client queries
 */

import {
  pgTable, text, timestamp, integer, numeric, boolean, uuid, index, uniqueIndex, jsonb,
  primaryKey, foreignKey, bigint,
} from 'drizzle-orm/pg-core';

// ─── Chain dimension ─────────────────────────────────────────────────────────
//
// Every agent identity is keyed by (chain, address). Adding a chain extends
// this union and feeds the composite primary key on `wallets` plus every
// foreign key that references it. NEVER reuse a value across chains — Solana/
// Stellar are format-disjoint, but Celo and Arc are BOTH EVM (0x40hex) and
// indistinguishable by address alone, so the composite (chain, address) PK is
// the durable correctness guarantee — never auto-detect an EVM chain from the
// address (see lib/chain-detect.ts).

export const CHAINS = ['solana', 'celo', 'stellar', 'arc'] as const;
export type Chain = (typeof CHAINS)[number];
export const DEFAULT_CHAIN: Chain = 'solana';

export function isChain(value: unknown): value is Chain {
  return typeof value === 'string' && (CHAINS as readonly string[]).includes(value);
}

// --- Drizzle Table Definitions (for drizzle-kit push) -------------------------

export const walletsTable = pgTable('wallets', {
  chain:           text('chain').notNull().default('solana').$type<Chain>(),
  address:         text('address').notNull(),
  first_seen:      timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
  last_seen:       timestamp('last_seen',  { withTimezone: true }).notNull().defaultNow(),
  tx_count:        integer('tx_count').notNull().default(0),
  score:           numeric('score', { precision: 6, scale: 2 }).notNull().default('0'),
  trust_tier:      text('trust_tier').notNull().default('Unrated'),
  updated_at:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  entity_name:     text('entity_name'),
  entity_category: text('entity_category'),
  funded_by:       text('funded_by'),
  funded_by_name:  text('funded_by_name'),
  sybil_risk:      boolean('sybil_risk').default(false),
  enriched_at:     timestamp('enriched_at', { withTimezone: true }),
  // Agent claiming (optional identity enrichment)
  claimed:         boolean('claimed').default(false),
  display_name:    text('display_name'),
  // Agent logo, denormalized from registration JSON (registry mirror writes it,
  // like display_name) so list queries reading `wallets` can render it without a
  // per-row registration fetch. http(s) URL; rendered via the SSRF image proxy.
  image_url:       text('image_url'),
  description:     text('description'),
  website:         text('website'),
  category:        text('category'),
  claimed_at:      timestamp('claimed_at', { withTimezone: true }),
  // Tier 3 declared identity: parallel agent-payment rail addresses. MPP runs
  // on Tempo (EVM-style 0x… 42-char). Declared-only — no on-chain verification
  // until cross-chain wallet linkage lands. NEVER blended into Karma.
  tempo_address:   text('tempo_address'),
  // Proof of ownership for the claim (Tier 3 declared). The off-chain signature
  // + signed challenge the keyholder produced at claim time, persisted so the
  // agent page can display a re-verifiable receipt. NOT an on-chain attestation;
  // it proves key control over the claimed address, nothing more. NULL for rows
  // claimed before this column existed (we can't fabricate a signature we never
  // captured). claim_message embeds the address + timestamp, so it self-describes.
  claim_signature: text('claim_signature'),
  claim_message:   text('claim_message'),
  // Two-faced karma (Phase F — signal spectrum)
  provider_score:  numeric('provider_score', { precision: 6, scale: 2 }).notNull().default('0'),
  consumer_score:  numeric('consumer_score', { precision: 6, scale: 2 }),
  confidence_badge: text('confidence_badge').notNull().default('declared'),
  // Autonomy Confidence (RFC v0.3 §5.5) — orthogonal to karma
  autonomy_score:  numeric('autonomy_score', { precision: 6, scale: 2 }),
  autonomy_label:  text('autonomy_label'),
  // Denormalized Tier-2 metric values (0–1) so the Explore table can filter
  // + sort on them without joining scores/signal_events for every query.
  metric_success_rate: numeric('metric_success_rate', { precision: 5, scale: 4 }),
  metric_diversity:    numeric('metric_diversity',    { precision: 5, scale: 4 }),
  metric_volume:       numeric('metric_volume',       { precision: 5, scale: 4 }),
  metric_age:          numeric('metric_age',          { precision: 5, scale: 4 }),
  metric_cadence:      numeric('metric_cadence',      { precision: 5, scale: 4 }),
  // Deferred-scoring queue: set by the webhook/indexer when new txs land,
  // cleared by the rescore worker after scores are recomputed. Keeps the
  // webhook hot path O(batch-size) instead of O(wallet-history).
  scoring_dirty_at:    timestamp('scoring_dirty_at', { withTimezone: true }),
  // Wallet-side regressive scan queue. NULL = never scanned. State machine:
  // pending → scanning → done | failed. Drives the worker drain in
  // instrumentation.ts (mirrors scoring_dirty_at pattern).
  scan_state:          text('scan_state'),
  scan_requested_at:   timestamp('scan_requested_at',   { withTimezone: true }),
  scan_completed_at:   timestamp('scan_completed_at',   { withTimezone: true }),
  scan_attempts:       integer('scan_attempts').notNull().default(0),
  scan_hit_count:      integer('scan_hit_count').notNull().default(0),
  scan_partial:        boolean('scan_partial').notNull().default(false),
  scan_last_error:     text('scan_last_error'),
  // Self Protocol attestation (Tier 3 declared — see RFC §5.5). Filled by the
  // /api/v2/self/verify endpoint when a wallet's controlling human completes
  // a passport scan via the Self mobile app. self_nullifier is the unique
  // per-(user, scope) marker from the ZK proof — proof-of-presence, not the
  // passport data itself.
  // UNIQUE on (self_nullifier) — one passport (per scope) anchors one wallet.
  // Doubles as the replay guard since the SDK is stateless.
  self_nullifier:      text('self_nullifier').unique(),
  self_verified_at:    timestamp('self_verified_at', { withTimezone: true }),
  self_scope:          text('self_scope'),
  // ERC-8004 Soroban agentId (u32) bound to this wallet on Stellar's
  // IdentityRegistry. NULL until the agent claims/registers (U4). U3's publish
  // path skips on-chain feedback when this is NULL (identity-gated, mirrors Celo).
  stellar_agent_id:    integer('stellar_agent_id'),
  // ERC-8004 EVM agentId (uint256, but always small enough for int32 in
  // practice — current Celo tip <10k) bound to this wallet on Celo's
  // IdentityRegistry. NULL until the agent is materialized via the celo
  // backfill (see scripts/celo-backfill-agents.ts) or claim. One owner can
  // technically own multiple agentIds; we store the most-recent observed.
  celo_agent_id:       integer('celo_agent_id'),
  // ERC-8004 Arc Testnet agentId (uint256, fits int32 — AK itself is 72077).
  // Bound to this wallet on Arc's IdentityRegistry. NULL until the agent is
  // materialized via the arc backfill (see scripts/arc-backfill-agents.ts).
  // Arc has no mainnet today (launches summer 2026); presence of this column
  // value is the durable testnet marker — chain='arc' + arc_agent_id != NULL
  // is always testnet. When Arc mainnet ships, a distinct chain value will
  // fork and these rows stay visibly testnet.
  arc_agent_id:        integer('arc_agent_id'),
  // --- Succession / Dead Man's Switch (denormalized for Agent Estates) -------
  // Declared agent-succession state. The full will (heirs, hash) lives in
  // `successions`; these denormalized columns drive the public Agent Estates
  // dashboard filter/sort without a join (mirrors metric_*/autonomy_*).
  // status: NULL=none | 'declared' | 'live' | 'lapsing' | 'lapsed' | 'executed' | 'revoked'
  succession_status:           text('succession_status').$type<SuccessionStatus>(),
  // Last heartbeat AK observed (derived from last meaningful tx / liveness).
  heartbeat_last_at:           timestamp('heartbeat_last_at', { withTimezone: true }),
  // Declared cadence: a gap beyond this marks the agent lapsing/lapsed.
  heartbeat_interval_seconds:  integer('heartbeat_interval_seconds'),
  // --- Surety Karma (orthogonal axis — underwriter quality) ------------------
  // How good is this wallet at judging which agents deliver? Derived from
  // bond_underwriters outcomes. ORTHOGONAL — never blended into Provider/
  // Consumer Karma (mirrors autonomy_score/autonomy_label, RFC §5.5).
  surety_score:                numeric('surety_score', { precision: 6, scale: 2 }),
  surety_label:                text('surety_label').$type<SuretyLabel>(),
}, (table) => [
  primaryKey({ columns: [table.chain, table.address], name: 'wallets_pkey' }),
  index('idx_wallets_chain').on(table.chain),
  index('idx_wallets_address').on(table.address),
  index('idx_wallets_score').on(table.score),
  index('idx_wallets_provider_score').on(table.provider_score),
  index('idx_wallets_confidence_badge').on(table.confidence_badge),
  index('idx_wallets_autonomy_score').on(table.autonomy_score),
  index('idx_wallets_metric_cadence').on(table.metric_cadence),
  index('idx_wallets_metric_success_rate').on(table.metric_success_rate),
  index('idx_wallets_metric_diversity').on(table.metric_diversity),
  index('idx_wallets_scoring_dirty_at').on(table.scoring_dirty_at),
  index('idx_wallets_scan_state').on(table.scan_state),
  index('idx_wallets_celo_agent_id').on(table.celo_agent_id),
  index('idx_wallets_arc_agent_id').on(table.arc_agent_id),
  index('idx_wallets_succession_status').on(table.succession_status),
  index('idx_wallets_surety_score').on(table.surety_score),
]);

export const transactionsTable = pgTable('transactions', {
  id:             uuid('id').primaryKey().defaultRandom(),
  chain:          text('chain').notNull().default('solana').$type<Chain>(),
  wallet_address: text('wallet_address').notNull(),
  facilitator:    text('facilitator').notNull(),
  amount:         numeric('amount', { precision: 20, scale: 6 }).notNull().default('0'),
  timestamp:      timestamp('timestamp', { withTimezone: true }).notNull(),
  success:        boolean('success').notNull().default(true),
  tx_signature:   text('tx_signature').unique().notNull(),
  // Payee / resource-server address (the actual counterparty), distinct from the
  // facilitator that routed the payment. Nullable: legacy rows + chains where the
  // payee is not yet extracted fall back to `facilitator` in scoring. Populated
  // per-chain by the indexer (see docs/counterparty-signal-followup.md).
  counterparty:   text('counterparty'),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.wallet_address],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'transactions_chain_wallet_address_fkey',
  }).onDelete('cascade'),
  index('idx_transactions_chain_wallet_address').on(table.chain, table.wallet_address),
  index('idx_transactions_facilitator').on(table.facilitator),
  index('idx_transactions_counterparty').on(table.counterparty),
  index('idx_transactions_timestamp').on(table.timestamp),
]);

export const scoresTable = pgTable('scores', {
  id:             uuid('id').primaryKey().defaultRandom(),
  chain:          text('chain').notNull().default('solana').$type<Chain>(),
  wallet_address: text('wallet_address').notNull(),
  score:          numeric('score', { precision: 6, scale: 2 }).notNull(),
  success_rate:   numeric('success_rate', { precision: 5, scale: 4 }).notNull().default('0'),
  diversity:      numeric('diversity', { precision: 5, scale: 4 }).notNull().default('0'),
  volume:         numeric('volume', { precision: 20, scale: 6 }).notNull().default('0'),
  age:            integer('age').notNull().default(0),
  calculated_at:  timestamp('calculated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.wallet_address],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'scores_chain_wallet_address_fkey',
  }).onDelete('cascade'),
  index('idx_scores_chain_wallet_address').on(table.chain, table.wallet_address),
  index('idx_scores_calculated_at').on(table.calculated_at),
]);

// --- Consumer Feedback -------------------------------------------------------

export const feedbackTable = pgTable('feedback', {
  id:              uuid('id').primaryKey().defaultRandom(),
  chain:           text('chain').notNull().default('solana').$type<Chain>(),
  agent_wallet:    text('agent_wallet').notNull(),
  consumer_wallet: text('consumer_wallet').notNull(),
  rating:          text('rating').notNull(),  // 'delivered' | 'failed'
  tx_signature:    text('tx_signature').notNull().unique(), // one feedback per tx
  created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.agent_wallet],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'feedback_chain_agent_wallet_fkey',
  }).onDelete('cascade'),
  index('idx_feedback_chain_agent_wallet').on(table.chain, table.agent_wallet),
  index('idx_feedback_tx_signature').on(table.tx_signature),
]);

// --- Signal Events (Phase F — signal spectrum) -------------------------------

export const signalEventsTable = pgTable('signal_events', {
  id:           uuid('id').primaryKey().defaultRandom(),
  chain:        text('chain').notNull().default('solana').$type<Chain>(),
  agent_wallet: text('agent_wallet').notNull(),
  tier:         integer('tier').notNull(),
  kind:         text('kind').notNull(),
  face:         text('face').notNull().default('provider'),
  weight:       numeric('weight', { precision: 5, scale: 4 }).notNull().default('1.0'),
  value:        numeric('value', { precision: 5, scale: 4 }),
  payload:      jsonb('payload'),
  signed_by:    text('signed_by'),
  tx_ref:       text('tx_ref'),
  observed_at:  timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.agent_wallet],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'signal_events_chain_agent_wallet_fkey',
  }).onDelete('cascade'),
  index('idx_signal_events_chain_agent_wallet').on(table.chain, table.agent_wallet),
  index('idx_signal_events_tier').on(table.tier),
  index('idx_signal_events_face').on(table.face),
  index('idx_signal_events_observed_at').on(table.observed_at),
  index('idx_signal_events_kind').on(table.kind),
  // Dedup same external event across retries. Rows with NULL tx_ref (synthetic
  // signals) don't collide because Postgres treats NULLs as distinct in unique
  // indexes — same effect as a partial index but Supabase-js `.upsert()` needs
  // a non-partial target to match ON CONFLICT. Now chain-scoped.
  uniqueIndex('uniq_signal_events_dedup')
    .on(table.chain, table.agent_wallet, table.kind, table.tx_ref),
]);

// --- Organizations (Enterprise fleet view) ----------------------------------

export const organizationsTable = pgTable('organizations', {
  slug:        text('slug').primaryKey(),
  name:        text('name').notNull(),
  description: text('description'),
  website:     text('website'),
  logo_url:    text('logo_url'),
  verified:    boolean('verified').notNull().default(false),
  created_at:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembersTable = pgTable('organization_members', {
  id:               uuid('id').primaryKey().defaultRandom(),
  organization_slug: text('organization_slug').notNull().references(() => organizationsTable.slug, { onDelete: 'cascade' }),
  chain:            text('chain').notNull().default('solana').$type<Chain>(),
  agent_wallet:     text('agent_wallet').notNull(),
  role:             text('role'),
  added_at:         timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.agent_wallet],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'organization_members_chain_agent_wallet_fkey',
  }).onDelete('cascade'),
  index('idx_org_members_slug').on(table.organization_slug),
  index('idx_org_members_chain_wallet').on(table.chain, table.agent_wallet),
  uniqueIndex('uniq_org_members').on(table.organization_slug, table.chain, table.agent_wallet),
]);

// --- Agent Manifests (Phase H1 — Tier 3 declared identity) ------------------

export const agentManifestsTable = pgTable('agent_manifests', {
  id:           uuid('id').primaryKey().defaultRandom(),
  chain:        text('chain').notNull().default('solana').$type<Chain>(),
  agent_wallet: text('agent_wallet').notNull(),
  source_type:  text('source_type').notNull(), // 'x402_accepts' | 'mcp_descriptor' | 'self_hosted' | 'claim_form'
  url:          text('url'),
  fetched_at:   timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  raw:          jsonb('raw'),
  parsed:       jsonb('parsed'),
  verified:     boolean('verified').notNull().default(false),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.agent_wallet],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'agent_manifests_chain_agent_wallet_fkey',
  }).onDelete('cascade'),
  index('idx_agent_manifests_chain_agent_wallet').on(table.chain, table.agent_wallet),
  index('idx_agent_manifests_source_type').on(table.source_type),
  // One manifest row per (chain, wallet, source_type) — resolver overwrites on refresh.
  uniqueIndex('uniq_agent_manifests_source').on(table.chain, table.agent_wallet, table.source_type),
]);

// --- Successions / Dead Man's Switch (Agent Wills) --------------------------
//
// An agent declares a succession plan (heartbeat interval + heirs). AK OBSERVES
// the public lifecycle and scores it — AK never holds a key, never holds funds,
// never executes a will (RFC §12 Non-Routing AND Non-Custody Mandate). One will
// per (chain, agent_wallet); the resolver overwrites on re-declaration.
// will_hash + on-chain witness fields stay NULL in the no-contract MVP.

export const successionsTable = pgTable('successions', {
  chain:                text('chain').notNull().default('solana').$type<Chain>(),
  agent_wallet:         text('agent_wallet').notNull(),
  source_type:          text('source_type').notNull(), // 'claim_form' | 'self_hosted'
  // Declared cadence; a gap beyond this flips status to lapsing → lapsed.
  interval_seconds:     integer('interval_seconds').notNull(),
  // Ordered heirs with optional split weights: [{ address, chain, share, label }].
  heirs:                jsonb('heirs').notNull(),
  status:               text('status').notNull().default('declared').$type<SuccessionStatus>(),
  // Witness anchor for a future on-chain will (NULL in no-contract MVP).
  will_hash:            text('will_hash'),
  declared_at:          timestamp('declared_at', { withTimezone: true }).notNull().defaultNow(),
  last_heartbeat_at:    timestamp('last_heartbeat_at', { withTimezone: true }),
  lapsed_at:            timestamp('lapsed_at', { withTimezone: true }),
  executed_at:          timestamp('executed_at', { withTimezone: true }),
  revoked_at:           timestamp('revoked_at', { withTimezone: true }),
  updated_at:           timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.chain, table.agent_wallet], name: 'successions_pkey' }),
  foreignKey({
    columns: [table.chain, table.agent_wallet],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'successions_chain_agent_wallet_fkey',
  }).onDelete('cascade'),
  index('idx_successions_status').on(table.status),
  index('idx_successions_last_heartbeat_at').on(table.last_heartbeat_at),
]);

// --- Bonds / Agent Bonding (surety-bond-as-signal) -------------------------
//
// Third parties stake USDC in an EDGE escrow that a young agent will deliver a
// task. AK never holds the bond and is NEVER the resolution oracle — the escrow
// resolves at the edge (success authorized by the beneficiary; failure
// permissionless after the deadline). `bonds` is AK's read-only projection of
// that escrow's public lifecycle. Bonds are DEMO-fed this round (is_demo rows,
// excluded from real scores); real-escrow ingestion is phase 2.
// CARDINAL RULE (enforced in scoring): a bond lifts the bonded agent's
// confidence badge + Tier-1 presence ONLY, never the evidence-gated trust
// ceiling — no buying your way to "Excellent" on borrowed capital.

export const bondsTable = pgTable('bonds', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  chain:               text('chain').notNull().default('solana').$type<Chain>(),
  bonded_agent_wallet: text('bonded_agent_wallet').notNull(),
  beneficiary:         text('beneficiary').notNull(),
  task_ref:            text('task_ref'),
  amount:              numeric('amount', { precision: 20, scale: 6 }).notNull().default('0'),
  currency:            text('currency').notNull().default('USDC'),
  status:              text('status').notNull().default('open').$type<BondStatus>(),
  escrow_ref:          text('escrow_ref').notNull(), // edge-escrow contract / account id
  // Objective settlement proof AK re-derived to resolve (x402 receipt / ERC-8183).
  resolution_proof_tx: text('resolution_proof_tx'),
  // Demo/seeded rows are clearly flagged so the UI never implies real on-chain
  // bonds before an escrow is deployed.
  is_demo:             boolean('is_demo').notNull().default(false),
  opened_at:           timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  resolved_at:         timestamp('resolved_at', { withTimezone: true }),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.bonded_agent_wallet],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'bonds_chain_bonded_agent_wallet_fkey',
  }).onDelete('cascade'),
  index('idx_bonds_chain_bonded_agent_wallet').on(table.chain, table.bonded_agent_wallet),
  index('idx_bonds_status').on(table.status),
  index('idx_bonds_escrow_ref').on(table.escrow_ref),
  // One projected row per (chain, escrow_ref) — dedup escrow events on re-index.
  uniqueIndex('uniq_bonds_escrow_ref').on(table.chain, table.escrow_ref),
]);

export const bondUnderwritersTable = pgTable('bond_underwriters', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  bond_id:             uuid('bond_id').notNull().references(() => bondsTable.id, { onDelete: 'cascade' }),
  chain:               text('chain').notNull().default('solana').$type<Chain>(),
  underwriter_wallet:  text('underwriter_wallet').notNull(),
  stake_amount:        numeric('stake_amount', { precision: 20, scale: 6 }).notNull().default('0'),
  premium_earned:      numeric('premium_earned', { precision: 20, scale: 6 }),
  settled:             boolean('settled').notNull().default(false),
  created_at:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.chain, table.underwriter_wallet],
    foreignColumns: [walletsTable.chain, walletsTable.address],
    name: 'bond_underwriters_chain_underwriter_wallet_fkey',
  }).onDelete('cascade'),
  index('idx_bond_underwriters_bond_id').on(table.bond_id),
  index('idx_bond_underwriters_chain_underwriter_wallet').on(table.chain, table.underwriter_wallet),
  uniqueIndex('uniq_bond_underwriters').on(table.bond_id, table.chain, table.underwriter_wallet),
]);

// --- Deck Views (pitch-deck visitor identification) -------------------------
//
// Captured when a visitor submits the email gate at /deck (and on every
// returning-visitor load). Used both for OpenReplay correlation and lead
// follow-up. Not joined to wallets — these are humans, not agents.

export const deckViewsTable = pgTable('deck_views', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        text('email').notNull(),
  is_returning: boolean('is_returning').notNull().default(false),
  ip:           text('ip'),
  user_agent:   text('user_agent'),
  referrer:     text('referrer'),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_deck_views_email').on(table.email),
  index('idx_deck_views_created_at').on(table.created_at),
]);

// --- Indexer Cursor State ----------------------------------------------------

export const indexerCursorsTable = pgTable('indexer_cursors', {
  chain:          text('chain').notNull().default('solana').$type<Chain>(),
  facilitator:    text('facilitator').notNull(),
  last_signature: text('last_signature').notNull(),
  last_slot:      integer('last_slot'),
  updated_at:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.chain, table.facilitator], name: 'indexer_cursors_pkey' }),
  index('idx_indexer_cursors_chain').on(table.chain),
]);

// --- ERC-8004 Registry Mirror (per-agent, keyed by agent_id not address) -----
//
// Registry-faithful mirror of every ERC-8004 IdentityRegistry NFT and
// ReputationRegistry feedback record. Keyed by (chain, agent_id) because a
// single owner address routinely controls hundreds of agents — the
// address-keyed `wallets` table structurally cannot count agents 1:1 (Celo ids
// 1..1000 → 41 owners). This table lets AK match 8004scan's per-network agent +
// feedback totals and scan every agent. Generic across EVM 8004 chains (Celo +
// Arc); Stellar/Soroban can populate it via its own scanner. NO FK to wallets.
// Populated by src/indexer/erc8004-registry.ts.

export const erc8004AgentsTable = pgTable('erc8004_agents', {
  chain:               text('chain').notNull().$type<Chain>(),
  // ERC-8004 declares uint256/uint64; ids are tiny today but BIGINT removes the
  // overflow foot-gun that wallets.celo_agent_id INTEGER carries.
  agent_id:            bigint('agent_id', { mode: 'number' }).notNull(),
  owner:               text('owner').notNull(),
  agent_wallet:        text('agent_wallet'),
  token_uri:           text('token_uri'),
  registration:        jsonb('registration'),
  // inline | fetched | empty | unreachable | invalid | pending
  registration_status: text('registration_status').notNull().default('pending'),
  metadata_score:      integer('metadata_score').notNull().default(0),
  feedback_count:      integer('feedback_count').notNull().default(0),
  // Unbounded NUMERIC: ERC-8004 feedback values are arbitrary int128 (see
  // 0011_erc8004_value_widen.sql) — a bounded numeric overflows on outlier
  // registry records. raw_value (TEXT) on erc8004_feedback is the exact source.
  feedback_sum:        numeric('feedback_sum'),
  feedback_avg:        numeric('feedback_avg'),
  first_indexed_at:    timestamp('first_indexed_at', { withTimezone: true }).notNull().defaultNow(),
  last_indexed_at:     timestamp('last_indexed_at',  { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.chain, table.agent_id], name: 'erc8004_agents_pkey' }),
  index('idx_erc8004_agents_chain').on(table.chain),
  index('idx_erc8004_agents_owner').on(table.owner),
  index('idx_erc8004_agents_agent_wallet').on(table.agent_wallet),
  index('idx_erc8004_agents_metadata').on(table.metadata_score),
]);

export const erc8004FeedbackTable = pgTable('erc8004_feedback', {
  chain:          text('chain').notNull().$type<Chain>(),
  agent_id:       bigint('agent_id', { mode: 'number' }).notNull(),
  client:         text('client').notNull(),
  // feedbackIndex is a per-(agent, client) sequential counter, so the unique
  // record key is (chain, agent_id, client, feedback_index).
  feedback_index: bigint('feedback_index', { mode: 'number' }).notNull(),
  raw_value:      text('raw_value'),
  // Unbounded NUMERIC — see 0011_erc8004_value_widen.sql. raw_value is exact.
  value:          numeric('value'),
  value_decimals: integer('value_decimals').notNull().default(0),
  tag1:           text('tag1').notNull().default(''),
  tag2:           text('tag2').notNull().default(''),
  revoked:        boolean('revoked').notNull().default(false),
  indexed_at:     timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({
    columns: [table.chain, table.agent_id, table.client, table.feedback_index],
    name: 'erc8004_feedback_pkey',
  }),
  foreignKey({
    columns: [table.chain, table.agent_id],
    foreignColumns: [erc8004AgentsTable.chain, erc8004AgentsTable.agent_id],
    name: 'erc8004_feedback_agent_fkey',
  }).onDelete('cascade'),
  index('idx_erc8004_feedback_chain_agent').on(table.chain, table.agent_id),
  index('idx_erc8004_feedback_client').on(table.client),
  index('idx_erc8004_feedback_revoked').on(table.revoked),
]);

// --- x402 Payee Discovery (endpoint-driven self-seeder) ----------------------
//
// Populated by scripts/celo-x402-discover-payees.ts: walks indexed Celo agents,
// probes each declared service endpoint over HTTP (SSRF-guarded), and when an
// endpoint answers HTTP 402 with an x402 `accepts` body, persists the declared
// `payTo` for a known Celo stablecoin here. The Celo x402 settlement indexer
// (src/indexer/celo-x402.ts) unions VERIFIED rows from this table into its
// facilitator/payee match set — so the indexer self-populates instead of
// requiring a hand-curated config entry.
//
// Keyed (chain, address) per the multi-chain convention. `chain` is always
// 'celo' today but the column generalizes to any EVM x402 chain.
//
// Attribution-poisoning guard: a malicious agent could declare a victim's
// address as `payTo`, causing AK to attribute the victim's stablecoin transfers
// as the agent's x402 provider signal. `verified` is TRUE only when the
// declared `payTo` is self-controlled by the source agent (== its owner /
// agentWallet on the IdentityRegistry); cross-address declarations are stored
// with `verified=false` and are NOT fed to the indexer. `source_agent_id` tags
// provenance so a poisoned entry is always traceable.
export const celoX402PayeesTable = pgTable('celo_x402_payees', {
  chain:           text('chain').notNull().default('celo').$type<Chain>(),
  /** Lowercased EVM payee address (the x402 `payTo`). */
  address:         text('address').notNull(),
  /** ERC-8004 agentId whose endpoint declared this payee (provenance). */
  source_agent_id: bigint('source_agent_id', { mode: 'number' }),
  /** The probed service endpoint that returned the 402. */
  endpoint:        text('endpoint'),
  /** Resolved Celo stablecoin contract address the price is denominated in. */
  asset:           text('asset'),
  /** Raw x402 `network` value (e.g. eip155:42220). */
  network:         text('network'),
  /** TRUE = self-payee (payTo controlled by the source agent) → indexer-eligible.
   *  FALSE = cross-address declaration → stored for audit, NOT indexed. */
  verified:        boolean('verified').notNull().default(false),
  discovered_at:   timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  last_seen_at:    timestamp('last_seen_at',  { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.chain, table.address], name: 'celo_x402_payees_pkey' }),
  index('idx_celo_x402_payees_verified').on(table.verified),
  index('idx_celo_x402_payees_source_agent').on(table.source_agent_id),
]);

// --- TypeScript Types (for runtime Supabase queries) -------------------------

export type TrustTier = 'Unrated' | 'Poor' | 'Fair' | 'Good' | 'Very Good' | 'Excellent';

export type Erc8004RegistrationStatus =
  | 'inline' | 'fetched' | 'empty' | 'unreachable' | 'invalid' | 'pending';

export interface Erc8004Agent {
  chain: Chain;
  agent_id: number;
  owner: string;
  agent_wallet: string | null;
  token_uri: string | null;
  registration: unknown | null;
  registration_status: Erc8004RegistrationStatus;
  metadata_score: number;
  feedback_count: number;
  feedback_sum: string | null;
  feedback_avg: string | null;
  first_indexed_at: string;
  last_indexed_at: string;
}

export interface Erc8004Feedback {
  chain: Chain;
  agent_id: number;
  client: string;
  feedback_index: number;
  raw_value: string | null;
  value: string | null;
  value_decimals: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
  indexed_at: string;
}

export interface CeloX402Payee {
  chain: Chain;
  address: string;
  source_agent_id: number | null;
  endpoint: string | null;
  asset: string | null;
  network: string | null;
  verified: boolean;
  discovered_at: string;
  last_seen_at: string;
}

export type LivenessStatus = 'Active' | 'Recent' | 'Dormant' | 'Inactive';

export type AgentCategory = 'ai' | 'data' | 'defi' | 'infra' | 'social' | 'utility' | 'other';

export type ConfidenceBadge = 'receipt-backed' | 'behavior-inferred' | 'declared';
export type SignalTier = 1 | 2 | 3 | 4;
export type KarmaFace = 'provider' | 'consumer';

export interface Wallet {
  chain: Chain;
  address: string;
  first_seen: string;
  last_seen: string;
  tx_count: number;
  score: number;
  trust_tier: TrustTier;
  updated_at: string;
  entity_name?: string | null;
  entity_category?: string | null;
  funded_by?: string | null;
  funded_by_name?: string | null;
  sybil_risk?: boolean;
  enriched_at?: string | null;
  // Agent claiming
  claimed?: boolean;
  display_name?: string | null;
  image_url?: string | null;
  description?: string | null;
  website?: string | null;
  category?: string | null;
  claimed_at?: string | null;
  // Tier 3 declared identity (parallel agent-payment rails). Tempo / MPP.
  tempo_address?: string | null;
  // Off-chain proof of ownership captured at claim time (re-verifiable receipt).
  // NULL for pre-feature claims. See schema column comment.
  claim_signature?: string | null;
  claim_message?: string | null;
  // Two-faced karma (Phase F)
  provider_score: number;
  consumer_score: number | null;
  confidence_badge: ConfidenceBadge;
  autonomy_score?: number | null;
  autonomy_label?: AutonomyLabel | null;
  // Denormalized Tier-2 metrics (0–1, nullable until first score recompute)
  metric_success_rate?: number | null;
  metric_diversity?: number | null;
  metric_volume?: number | null;
  metric_age?: number | null;
  metric_cadence?: number | null;
  // Deferred-scoring queue sentinel. Non-null = awaiting recompute.
  scoring_dirty_at?: string | null;
  // Wallet-side regressive scan queue (Phase H+ — backfill on lookup).
  scan_state?: WalletScanState | null;
  scan_requested_at?: string | null;
  scan_completed_at?: string | null;
  scan_attempts?: number;
  scan_hit_count?: number;
  scan_partial?: boolean;
  scan_last_error?: string | null;
  // Self Protocol attestation
  self_nullifier?: string | null;
  self_verified_at?: string | null;
  self_scope?: string | null;
  // ERC-8004 Soroban agentId (u32) — null until registered/claimed on Stellar.
  stellar_agent_id?: number | null;
  // ERC-8004 Celo agentId (uint256, stored as int32) — null until materialized.
  celo_agent_id?: number | null;
  // ERC-8004 Arc Testnet agentId (uint256, stored as int32) — null until materialized.
  arc_agent_id?: number | null;
  // Succession / Dead Man's Switch (denormalized from `successions`).
  succession_status?: SuccessionStatus | null;
  heartbeat_last_at?: string | null;
  heartbeat_interval_seconds?: number | null;
  // Surety Karma — orthogonal underwriter-quality axis (never blended).
  surety_score?: number | null;
  surety_label?: SuretyLabel | null;
}

export type WalletScanState = 'pending' | 'scanning' | 'done' | 'failed';

export type AutonomyLabel = 'agent-like' | 'mixed' | 'human-like';

export interface Organization {
  slug: string;
  name: string;
  description: string | null;
  website: string | null;
  logo_url: string | null;
  verified: boolean;
  created_at: string;
}

export interface OrganizationMember {
  id: string;
  organization_slug: string;
  chain: Chain;
  agent_wallet: string;
  role: string | null;
  added_at: string;
}

export type ManifestSourceType = 'x402_accepts' | 'mcp_descriptor' | 'self_hosted' | 'claim_form';

export interface AgentManifest {
  id: string;
  chain: Chain;
  agent_wallet: string;
  source_type: ManifestSourceType;
  url: string | null;
  fetched_at: string;
  raw: Record<string, unknown> | null;
  parsed: ParsedManifest | null;
  verified: boolean;
  created_at: string;
}

/** Normalized view of what a manifest declares, regardless of source format. */
export interface ParsedManifest {
  name?: string | null;
  description?: string | null;
  website?: string | null;
  github?: string | null;
  category?: string | null;
  capabilities?: string[];
  endpoints?: Array<{ kind: string; url: string; description?: string }>;
  /** Optional Tempo (EVM 0x…) address — declares MPP rail participation. */
  tempoAddress?: string | null;
  /**
   * Optional Dead Man's Switch plan declared in a self-hosted agentkarma.json.
   * Carried through as a raw blob; the manifest refresh path validates it via
   * the succession write-path (interval bounds, heir address/chain validity,
   * self-as-sole-heir rejection) before persisting. Declared intent only — a
   * declared will NEVER lifts the confidence badge off ⚪ on its own.
   */
  succession?: ManifestSuccessionPlan | null;
  [key: string]: unknown;
}

/** Raw succession plan shape as declared in an agentkarma.json manifest. */
export interface ManifestSuccessionPlan {
  intervalSeconds: number;
  heirs: SuccessionHeir[];
}

/**
 * EVM-style address (Tempo, used by MPP). Matched case-insensitively; we store
 * whatever the user typed (no normalization) so checksummed addresses survive.
 */
export const TEMPO_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
export function isTempoAddress(value: unknown): value is string {
  return typeof value === 'string' && TEMPO_ADDRESS_REGEX.test(value);
}

export interface SignalEvent {
  id: string;
  chain: Chain;
  agent_wallet: string;
  tier: SignalTier;
  kind: string;
  face: KarmaFace;
  weight: number;
  value: number | null;
  payload: Record<string, unknown> | null;
  signed_by: string | null;
  tx_ref: string | null;
  observed_at: string;
  created_at: string;
}

// --- Succession / Dead Man's Switch types -----------------------------------

export type SuccessionStatus =
  | 'declared'  // will registered, heartbeat not yet evaluated
  | 'live'      // heartbeat within interval — agent healthy
  | 'lapsing'   // approaching the interval deadline (warning band)
  | 'lapsed'    // interval exceeded — succession conditions met
  | 'executed'  // inheritance transfer observed on-chain
  | 'revoked';  // owner cancelled the will

export type SuretyLabel = 'reliable' | 'mixed' | 'unproven';

/** A single heir in a declared will. `share` is an optional split weight. */
export interface SuccessionHeir {
  address: string;
  chain: Chain;
  share?: number | null;
  label?: string | null;
}

export type SuccessionSourceType = 'claim_form' | 'self_hosted';

export interface Succession {
  chain: Chain;
  agent_wallet: string;
  source_type: SuccessionSourceType;
  interval_seconds: number;
  heirs: SuccessionHeir[];
  status: SuccessionStatus;
  will_hash: string | null;
  declared_at: string;
  last_heartbeat_at: string | null;
  lapsed_at: string | null;
  executed_at: string | null;
  revoked_at: string | null;
  updated_at: string;
}

// --- Agent Bonding types ----------------------------------------------------

export type BondStatus =
  | 'open'              // escrow funded, task in flight
  | 'resolved_success' // agent delivered — underwriters earn premium
  | 'resolved_failure' // agent failed — stake pays the beneficiary
  | 'expired';         // task window elapsed without resolution

export interface Bond {
  id: string;
  chain: Chain;
  bonded_agent_wallet: string;
  beneficiary: string;
  task_ref: string | null;
  amount: number;
  currency: string;
  status: BondStatus;
  escrow_ref: string;
  resolution_proof_tx: string | null;
  is_demo: boolean;
  opened_at: string;
  resolved_at: string | null;
}

export interface BondUnderwriter {
  id: string;
  bond_id: string;
  chain: Chain;
  underwriter_wallet: string;
  stake_amount: number;
  premium_earned: number | null;
  settled: boolean;
  created_at: string;
}

/** Derive liveness status from last_seen timestamp */
export function getLivenessStatus(lastSeen: string | Date): LivenessStatus {
  const ms = Date.now() - new Date(lastSeen).getTime();
  const hours = ms / (1000 * 60 * 60);
  if (hours <= 24) return 'Active';
  if (hours <= 7 * 24) return 'Recent';
  if (hours <= 90 * 24) return 'Dormant';
  return 'Inactive';
}

export interface Transaction {
  id: string;
  chain: Chain;
  wallet_address: string;
  facilitator: string;
  amount: number;
  timestamp: string;
  success: boolean;
  tx_signature: string;
  counterparty?: string | null;
}

export interface Score {
  id: string;
  chain: Chain;
  wallet_address: string;
  score: number;
  success_rate: number;
  diversity: number;
  volume: number;
  age: number;
  calculated_at: string;
}

export type FeedbackRating = 'delivered' | 'failed';

export interface Feedback {
  id: string;
  chain: Chain;
  agent_wallet: string;
  consumer_wallet: string;
  rating: FeedbackRating;
  tx_signature: string;
  created_at: string;
}

export interface IndexerCursor {
  chain: Chain;
  facilitator: string;
  last_signature: string;
  last_slot: number | null;
  updated_at: string;
}
