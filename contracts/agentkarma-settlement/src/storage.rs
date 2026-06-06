//! Storage layout + typed accessors.
//!
//! - `AGENT_KARMA`  — persistent, keyed by `(agent_id, tag)` so Provider and
//!   Consumer karma never collapse (invariant #3). Value: `WeightedScore`.
//! - `SETTLED_IDS`  — PERSISTENT storage keyed by `settlement_id`. This is the
//!   DURABLE no-replay backstop (gate MUST #3): a consumed settlement_id is
//!   rejected for as long as the entry lives on-ledger, independent of the
//!   recency window or the (un-verifiable, validator-supplied) `ledger_seq`. The
//!   entry's TTL is bumped to `MAX_PERSISTENT_TTL` on write AND re-bumped on every
//!   `is_settled` read, so a frequently-checked id stays hot and never lapses in
//!   practice. Recency decay is a SCORING weight ONLY — it MUST NOT double as the
//!   replay guard (see the un-decay attack: re-submitting with `ledger_seq = now`
//!   would otherwise re-credit full weight).
//!
//!   Honest durability: persistent entries are NOT literally permanent. Each is
//!   bounded by the network `max_entry_ttl` (~1 year on pubnet) plus rent; an
//!   entry that is never re-bumped and runs out of TTL is archived, not deleted.
//!   The backstops beyond on-ledger TTL are (a) the read-path re-bump above for
//!   anything actively probed, (b) CAP-0053 archival restore for an evicted entry,
//!   and (c) the off-chain indexer's own dedup index (the indexer never re-submits
//!   a settlement_id it has already witnessed). Trade-off: the durable set grows
//!   with settlement volume and carries rent. That is the deliberate cost of
//!   correctness here — a weightless id is NOT a safely-droppable id, so we keep it.
//! - `VALIDATORS`   — instance Vec<Address> (AK oracle allowlist).
//! - `FACILITATORS` — instance Vec<Address> (curated facilitator/MPP set).
//! - config singletons: admin, recency window, identity-registry address.
//!
//! No `class` — free functions over `Env` (Rust idiom + AK hard rule on the TS
//! side; mirrored here for consistency).

use soroban_sdk::{contracttype, Address, BytesN, Env, Symbol, Vec};

use crate::types::{KarmaTag, WeightedScore};

/// Default recency window in ledgers (~10 days at ~1 ledger/sec → 864_000).
/// Tunable via `set_recency_window`.
pub const DEFAULT_RECENCY_WINDOW: u32 = 864_000;

/// Decay half-life in ledgers (~2.5 days → 216_000). Used by the weight engine.
pub const DECAY_HALF_LIFE: u32 = 216_000;

/// Maximum persistent-entry TTL we ever request, in ledgers.
///
/// Pinned to Stellar **pubnet**'s current persistent `max_entry_ttl` of
/// `3_110_400` ledgers (~1 year at ~5s/ledger). This is a NETWORK PARAMETER, not
/// a protocol constant — the host rejects `extend_ttl(_, extend_to)` whenever
/// `extend_to > max_entry_ttl` (it does NOT silently clamp), so requesting more
/// than the live network value escalates to a host InternalError and panics the
/// invocation. We therefore pin the documented pubnet value here and treat any
/// change to it as a review gate. (Stellar docs, state-archival: "each extension
/// can be at most `max_entry_ttl` ledgers from the current sequence_number".)
const MAX_PERSISTENT_TTL: u32 = 3_110_400;

/// Bump amount for persistent score TTL on each write (keep ~hot for a window).
const SCORE_BUMP_AMOUNT: u32 = DEFAULT_RECENCY_WINDOW;
const SCORE_BUMP_THRESHOLD: u32 = DEFAULT_RECENCY_WINDOW / 2;

/// TTL bump for the DURABLE replay set. Each consumed settlement_id is pushed to
/// `MAX_PERSISTENT_TTL` on write and re-bumped on every read (see `is_settled`),
/// so an actively-probed id never lapses. `extend_to` MUST satisfy
/// `threshold <= extend_to <= max_entry_ttl`; we bump to the pinned pubnet
/// `MAX_PERSISTENT_TTL` and use half of it as the re-bump threshold so the entry
/// is topped up well before it can decay out.
const SETTLED_BUMP_AMOUNT: u32 = MAX_PERSISTENT_TTL;
const SETTLED_BUMP_THRESHOLD: u32 = MAX_PERSISTENT_TTL / 2;

/// Instance/config storage keys.
#[contracttype]
#[derive(Clone)]
pub enum ConfigKey {
    Admin,
    RecencyWindow,
    /// Pinned stellar-8004 Identity Registry contract address. The
    /// `payee == agentWallet(agent_id)` check cross-calls this (risk #1: pin id
    /// + WASM hash off-chain; a hash change is a review gate).
    IdentityRegistry,
    Validators,
    Facilitators,
}

/// Persistent per-(agent, facet) score key.
#[contracttype]
#[derive(Clone)]
pub struct ScoreKey {
    pub agent_id: u32,
    pub tag: KarmaTag,
}

/// Durable replay-store key. Wrapping the raw hash in a struct keeps the
/// persistent keyspace from colliding with the per-`(agent, tag)` score keys.
#[contracttype]
#[derive(Clone)]
pub struct SettledKey {
    pub settlement_id: BytesN<32>,
}

// ── config singletons ──────────────────────────────────────────────────────

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&ConfigKey::Admin)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&ConfigKey::Admin, admin);
}

pub fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&ConfigKey::Admin)
}

pub fn set_identity_registry(env: &Env, registry: &Address) {
    env.storage()
        .instance()
        .set(&ConfigKey::IdentityRegistry, registry);
}

pub fn get_identity_registry(env: &Env) -> Option<Address> {
    env.storage().instance().get(&ConfigKey::IdentityRegistry)
}

pub fn set_recency_window(env: &Env, slots: u32) {
    env.storage()
        .instance()
        .set(&ConfigKey::RecencyWindow, &slots);
}

pub fn get_recency_window(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&ConfigKey::RecencyWindow)
        .unwrap_or(DEFAULT_RECENCY_WINDOW)
}

// ── validator allowlist ─────────────────────────────────────────────────────

pub fn set_validators(env: &Env, validators: &Vec<Address>) {
    env.storage()
        .instance()
        .set(&ConfigKey::Validators, validators);
}

pub fn get_validators(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&ConfigKey::Validators)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn is_validator(env: &Env, who: &Address) -> bool {
    get_validators(env).iter().any(|v| &v == who)
}

// ── facilitator allowlist ───────────────────────────────────────────────────

pub fn set_facilitators(env: &Env, facilitators: &Vec<Address>) {
    env.storage()
        .instance()
        .set(&ConfigKey::Facilitators, facilitators);
}

pub fn get_facilitators(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&ConfigKey::Facilitators)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn is_facilitator(env: &Env, who: &Address) -> bool {
    get_facilitators(env).iter().any(|f| &f == who)
}

// ── weighted score (persistent, per facet) ──────────────────────────────────

pub fn get_score(env: &Env, agent_id: u32, tag: KarmaTag) -> Option<WeightedScore> {
    env.storage()
        .persistent()
        .get(&ScoreKey { agent_id, tag })
}

pub fn set_score(env: &Env, agent_id: u32, tag: KarmaTag, score: &WeightedScore) {
    let key = ScoreKey { agent_id, tag };
    env.storage().persistent().set(&key, score);
    env.storage()
        .persistent()
        .extend_ttl(&key, SCORE_BUMP_THRESHOLD, SCORE_BUMP_AMOUNT);
}

// ── settlement replay store (PERSISTENT, durable no-replay backstop) ─────────

/// True if this settlement_id has been consumed. Durable: returns true for the
/// life of the entry (gate MUST #3, replay rejection holds regardless of age or
/// `ledger_seq`). On a hit we RE-BUMP the entry's TTL to `MAX_PERSISTENT_TTL`, so
/// any id that is actively probed (every replay attempt is a probe) keeps itself
/// hot and never lapses out from under the guard.
pub fn is_settled(env: &Env, settlement_id: &BytesN<32>) -> bool {
    let key = SettledKey {
        settlement_id: settlement_id.clone(),
    };
    let present = env.storage().persistent().has(&key);
    if present {
        // Read-path re-bump: keep frequently-checked ids alive within max TTL.
        env.storage()
            .persistent()
            .extend_ttl(&key, SETTLED_BUMP_THRESHOLD, SETTLED_BUMP_AMOUNT);
    }
    present
}

/// Mark a settlement consumed. The entry is written to PERSISTENT storage and
/// bumped to `MAX_PERSISTENT_TTL`, then re-bumped on every `is_settled` read, so a
/// consumed settlement_id stays rejected for the life of the entry (durable up to
/// `max_entry_ttl`, kept hot by the read-path re-bump). This is durable, not
/// literally permanent: an entry that runs fully out of TTL without a re-bump is
/// archived, with CAP-0053 restore and the off-chain indexer's dedup index as the
/// backstops beyond on-ledger TTL. `expires_at` is retained in the stored value
/// purely for `get_settlement_status` back-compat (the original recency-window
/// expiry hint); it is NOT the replay guard. The guard is the entry's presence in
/// durable storage.
///
/// Storage-rent trade-off (deliberate): this set grows with settlement volume and
/// carries rent. Accepted for correctness — a weightless id is not a
/// safely-droppable id (re-submitting with `ledger_seq = now` would un-decay it to
/// full weight).
pub fn mark_settled(env: &Env, settlement_id: &BytesN<32>, consumed_at: u32, expires_at: u32) {
    let key = SettledKey {
        settlement_id: settlement_id.clone(),
    };
    // Store (consumed_at, expires_at) so `get_settlement_status` can report it.
    env.storage().persistent().set(&key, &(consumed_at, expires_at));
    // Bump to the pinned pubnet max persistent TTL (valid: threshold <= extend_to
    // <= max_entry_ttl). The read-path re-bump in `is_settled` keeps it alive.
    env.storage()
        .persistent()
        .extend_ttl(&key, SETTLED_BUMP_THRESHOLD, SETTLED_BUMP_AMOUNT);
}

/// Returns `(consumed_at, expires_at)` if the settlement is on record. With the
/// durable store this is effectively "has this id ever been consumed" plus the
/// retained recency-window hint.
pub fn settlement_status(env: &Env, settlement_id: &BytesN<32>) -> Option<(u32, u32)> {
    env.storage().persistent().get(&SettledKey {
        settlement_id: settlement_id.clone(),
    })
}

/// Bump instance TTL so the contract's config/allowlists stay live across the
/// recency window. Cheap, idempotent; called on every write path.
pub fn bump_instance(env: &Env) {
    let window = get_recency_window(env);
    env.storage()
        .instance()
        .extend_ttl(DECAY_HALF_LIFE.min(window), window);
}

/// Re-export the cross-contract function name the identity registry exposes for
/// resolving an agent's payment wallet. Kept here so the contract module and
/// tests agree on one symbol.
pub fn agent_wallet_fn(env: &Env) -> Symbol {
    Symbol::new(env, "agent_wallet")
}
