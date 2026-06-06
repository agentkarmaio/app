//! Contract events (soroban-sdk 26 `#[contractevent]` typed events). An AK
//! indexer can match on the generated topics directly.

use soroban_sdk::{contractevent, Address, BytesN, Env};

use crate::types::KarmaTag;

/// Emitted when a settlement-backed attestation is accepted and folded into the
/// agent's weighted score.
#[contractevent(topics = ["attest"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementAttested {
    #[topic]
    pub agent_id: u32,
    #[topic]
    pub tag: KarmaTag,
    pub settlement_id: BytesN<32>,
    pub amount: i128,
    pub new_score: u32,
}

/// Emitted when the validator allowlist is replaced (operational audit trail).
#[contractevent(topics = ["validators"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatorsSet {
    pub admin: Address,
    pub new_len: u32,
}

/// Emitted when the recency window is changed (operational audit trail).
#[contractevent(topics = ["recency"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecencyWindowSet {
    pub admin: Address,
    pub slots: u32,
}

pub fn settlement_attested(
    env: &Env,
    agent_id: u32,
    tag: KarmaTag,
    settlement_id: &BytesN<32>,
    amount: i128,
    new_score: u32,
) {
    SettlementAttested {
        agent_id,
        tag,
        settlement_id: settlement_id.clone(),
        amount,
        new_score,
    }
    .publish(env);
}

pub fn validators_set(env: &Env, admin: &Address, new_len: u32) {
    ValidatorsSet {
        admin: admin.clone(),
        new_len,
    }
    .publish(env);
}

pub fn recency_window_set(env: &Env, admin: &Address, slots: u32) {
    RecencyWindowSet {
        admin: admin.clone(),
        slots,
    }
    .publish(env);
}
