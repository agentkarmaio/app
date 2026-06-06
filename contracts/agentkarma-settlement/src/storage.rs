//! Storage layout + typed accessors.
//!
//! - `AGENT_KARMA`  — persistent, keyed by `(agent_id, tag)` so Provider and
//!   Consumer karma never collapse (invariant #3). Value: `WeightedScore`.
//! - `SETTLED_IDS`  — TEMPORARY storage keyed by `settlement_id`; TTL bound to
//!   the recency window (CAP-0053). Beyond the window a settlement is already
//!   weightless, so auto-purge of its id is safe and replay-irrelevant.
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

/// Bump amount for persistent score TTL on each write (keep ~hot for a window).
const SCORE_BUMP_AMOUNT: u32 = DEFAULT_RECENCY_WINDOW;
const SCORE_BUMP_THRESHOLD: u32 = DEFAULT_RECENCY_WINDOW / 2;

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

/// Temporary replay-store key. Wrapping the raw hash in a struct keeps the
/// temporary keyspace from colliding with any future temporary entries.
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

// ── settlement replay store (temporary, TTL = recency window) ────────────────

/// True if this settlement_id has already been consumed within its TTL window.
pub fn is_settled(env: &Env, settlement_id: &BytesN<32>) -> bool {
    env.storage().temporary().has(&SettledKey {
        settlement_id: settlement_id.clone(),
    })
}

/// Mark a settlement consumed. TTL is bound to the recency window: once the
/// window lapses the entry auto-purges (CAP-0053), which is safe because the
/// settlement is weightless past the window anyway.
pub fn mark_settled(env: &Env, settlement_id: &BytesN<32>, consumed_at: u32, expires_at: u32) {
    let key = SettledKey {
        settlement_id: settlement_id.clone(),
    };
    // Store (consumed_at, expires_at) so `get_settlement_status` can report it.
    env.storage().temporary().set(&key, &(consumed_at, expires_at));
    let window = get_recency_window(env);
    // Extend to the full window; threshold = half-life keeps writes cheap.
    env.storage()
        .temporary()
        .extend_ttl(&key, DECAY_HALF_LIFE.min(window), window);
}

/// Returns `(consumed_at, expires_at)` if the settlement is still on record.
pub fn settlement_status(env: &Env, settlement_id: &BytesN<32>) -> Option<(u32, u32)> {
    env.storage().temporary().get(&SettledKey {
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
