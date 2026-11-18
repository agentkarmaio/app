//! Typed events. Shape contract with the indexer
//! (`web/src/indexer/stellar-agent-bond.ts`):
//!
//! - Bond events have EXACTLY two topics: `[name, agent_id: u32]`.
//! - Config events have exactly one topic: `[name]`.
//! - Every bond event carries the POST-STATE totals, so the indexer sets state
//!   instead of adding deltas (idempotent, replay-safe, order-tolerant).

use soroban_sdk::{contractevent, Address, BytesN};

use crate::types::{ConfigChange, Evidence};

#[contractevent(topics = ["bond_deposited"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondDeposited {
    #[topic]
    pub agent_id: u32,
    pub owner: Address,
    pub amount: i128,
    pub bonded: i128,
    pub unbonding: i128,
    pub slashed_total: i128,
}

#[contractevent(topics = ["bond_unbond_requested"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondUnbondRequested {
    #[topic]
    pub agent_id: u32,
    pub owner: Address,
    pub amount: i128,
    pub bonded: i128,
    pub unbonding: i128,
    pub unlock_at: u64,
}

#[contractevent(topics = ["bond_withdrawn"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondWithdrawn {
    #[topic]
    pub agent_id: u32,
    pub owner: Address,
    pub amount: i128,
    pub bonded: i128,
    pub unbonding: i128,
}

#[contractevent(topics = ["bond_slashed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondSlashed {
    #[topic]
    pub agent_id: u32,
    /// The slasher that authorized this slash (config at the time), so every
    /// slash is auditable from its own event.
    pub slasher: Address,
    pub owner: Address,
    pub amount: i128,
    pub from_unbonding: i128,
    pub from_bonded: i128,
    pub evidence: Evidence,
    pub evidence_id: BytesN<32>,
    pub treasury: Address,
    pub bonded: i128,
    pub unbonding: i128,
    pub slashed_total: i128,
}

#[contractevent(topics = ["cfg_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigProposed {
    pub admin: Address,
    pub change: ConfigChange,
    pub activates_at: u64,
}

#[contractevent(topics = ["cfg_applied"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigApplied {
    pub change: ConfigChange,
}

#[contractevent(topics = ["admin_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposed {
    pub admin: Address,
    pub pending: Address,
}

#[contractevent(topics = ["admin_changed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    pub old: Address,
    pub new: Address,
}
