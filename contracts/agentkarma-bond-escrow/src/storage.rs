//! Storage layout + typed accessors.
//!
//! - `Terms`    — instance, immutable after `initialize`. The bond's conditions.
//! - `Status`   — instance, the lifecycle state machine value.
//! - `Stakes`   — instance Vec<Stake>, the ordered underwriter ledger.
//! - `Consumed` — persistent, keyed by `settlement_tx`. Single-use guard so one
//!   settlement can resolve at most one bond (a defense-in-depth mirror of the
//!   settlement contract's no-replay store, durable for the bond's lifetime).
//!
//! No `class` — free functions over `Env` (Rust idiom + AK hard rule on the TS
//! side; mirrored here for consistency). NO admin key is ever stored.

use soroban_sdk::{contracttype, BytesN, Env, Vec};

use crate::types::{BondStatus, BondTerms, Stake};

/// Bump amount for instance TTL on each write, in ledgers (~10 days at ~1s).
const INSTANCE_BUMP_AMOUNT: u32 = 864_000;
const INSTANCE_BUMP_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT / 2;

/// TTL for the durable single-use settlement guard. Pinned to pubnet's
/// persistent `max_entry_ttl` (~1 year). `extend_to` MUST satisfy
/// `threshold <= extend_to <= max_entry_ttl`.
const CONSUMED_BUMP_AMOUNT: u32 = 3_110_400;
const CONSUMED_BUMP_THRESHOLD: u32 = CONSUMED_BUMP_AMOUNT / 2;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Terms,
    Status,
    Stakes,
    /// Durable single-use marker keyed by a settlement tx hash.
    Consumed(BytesN<32>),
}

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Terms)
}

pub fn set_terms(env: &Env, terms: &BondTerms) {
    env.storage().instance().set(&DataKey::Terms, terms);
}

pub fn get_terms(env: &Env) -> Option<BondTerms> {
    env.storage().instance().get(&DataKey::Terms)
}

pub fn set_status(env: &Env, status: BondStatus) {
    env.storage().instance().set(&DataKey::Status, &status);
}

pub fn get_status(env: &Env) -> Option<BondStatus> {
    env.storage().instance().get(&DataKey::Status)
}

pub fn get_stakes(env: &Env) -> Vec<Stake> {
    env.storage()
        .instance()
        .get(&DataKey::Stakes)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_stakes(env: &Env, stakes: &Vec<Stake>) {
    env.storage().instance().set(&DataKey::Stakes, stakes);
}

/// True if this settlement tx has already resolved a bond (single-use guard).
pub fn is_consumed(env: &Env, settlement_tx: &BytesN<32>) -> bool {
    let key = DataKey::Consumed(settlement_tx.clone());
    let present = env.storage().persistent().has(&key);
    if present {
        env.storage()
            .persistent()
            .extend_ttl(&key, CONSUMED_BUMP_THRESHOLD, CONSUMED_BUMP_AMOUNT);
    }
    present
}

/// Mark a settlement tx consumed (durable). Bumped to the pinned pubnet max TTL.
pub fn mark_consumed(env: &Env, settlement_tx: &BytesN<32>) {
    let key = DataKey::Consumed(settlement_tx.clone());
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, CONSUMED_BUMP_THRESHOLD, CONSUMED_BUMP_AMOUNT);
}

/// Bump instance TTL so the bond's terms/status/stakes stay live. Cheap,
/// idempotent; called on every write path.
pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}
