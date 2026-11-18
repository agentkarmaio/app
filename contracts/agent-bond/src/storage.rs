//! Storage layout + typed accessors (free functions over `Env`).
//!
//! - instance   `Config`, `PendingConfig`, `PendingAdmin`
//! - persistent `Bond(agent_id)`, `UsedEvidence(evidence_id)` (replay guard)

use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::types::{BondState, Config, PendingConfig};

const INSTANCE_BUMP: u32 = 864_000;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP / 2;
/// Pinned to pubnet persistent `max_entry_ttl` (about 1 year).
const PERSISTENT_BUMP: u32 = 3_110_400;
const PERSISTENT_THRESHOLD: u32 = PERSISTENT_BUMP / 2;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    PendingConfig,
    PendingAdmin,
    Bond(u32),
    UsedEvidence(BytesN<32>),
}

pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

pub fn get_config(env: &Env) -> Config {
    // Set atomically in the constructor; absence is impossible after deploy.
    env.storage().instance().get(&DataKey::Config).unwrap()
}

pub fn set_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn get_pending_config(env: &Env) -> Option<PendingConfig> {
    env.storage().instance().get(&DataKey::PendingConfig)
}

pub fn set_pending_config(env: &Env, pending: &PendingConfig) {
    env.storage().instance().set(&DataKey::PendingConfig, pending);
}

pub fn clear_pending_config(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingConfig);
}

pub fn get_pending_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PendingAdmin)
}

pub fn set_pending_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::PendingAdmin, admin);
}

pub fn clear_pending_admin(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingAdmin);
}

pub fn get_bond(env: &Env, agent_id: u32) -> Option<BondState> {
    let key = DataKey::Bond(agent_id);
    let bond: Option<BondState> = env.storage().persistent().get(&key);
    if bond.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
    }
    bond
}

pub fn set_bond(env: &Env, agent_id: u32, bond: &BondState) {
    let key = DataKey::Bond(agent_id);
    env.storage().persistent().set(&key, bond);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
}

pub fn is_evidence_used(env: &Env, evidence_id: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::UsedEvidence(evidence_id.clone()))
}

pub fn mark_evidence_used(env: &Env, evidence_id: &BytesN<32>) {
    let key = DataKey::UsedEvidence(evidence_id.clone());
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
}
