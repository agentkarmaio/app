#![no_std]
//! AgentKarma settlement-gated score contract (U7).
//!
//! A Soroban witness/gate that makes AK's settlement-gate publicly auditable
//! on-chain: it records settlement-backed, no-replay, amount-weighted,
//! recency-decayed reputation, published over the stellar-8004 identity layer.
//! `trust-ak-oracle`, non-routing — never custodies funds.
//!
//! See the design notes §3.

mod contract;
mod errors;
mod events;
mod storage;
mod types;

pub use contract::{SettlementContract, SettlementContractClient};
pub use errors::ContractError;
pub use types::{
    FacilitatorRef, KarmaTag, SettlementProof, SettlementSource, WeightedScore,
};

#[cfg(test)]
mod test;
