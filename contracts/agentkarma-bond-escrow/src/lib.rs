#![no_std]
//! AgentKarma ownerless bond-escrow contract.
//!
//! An ownerless surety-bond escrow on Soroban: underwriters stake USDC vouching
//! a young agent will deliver; the bond resolves either as a SUCCESS authorized
//! by the BENEFICIARY (who signs to release stakes back to underwriters) or as a
//! permissionless post-deadline FAILURE payout to the beneficiary. OWNERLESS —
//! no admin, no AK key, no oracle. AgentKarma only OBSERVES the public events and
//! projects them into score signals.
//!
//! NOTE on "proof": the contract cannot read past ledger state, so it does NOT
//! verify any trustless on-chain delivery proof. Success authorization rests on
//! the beneficiary's `require_auth` (incentive-compatible: they otherwise collect
//! the whole pool on failure). The submitted `DeliveryReceipt` is an audit record
//! bound to the immutable terms, not a verifiable proof.
//!
//! DEMO-ONLY this round: authored by AK as an ownerless escrow but NOT deployed.
//! See web/docs/BONDING-AND-SUCCESSION-DESIGN.md §7 (custody stance) and §3.

mod contract;
mod errors;
mod events;
mod storage;
mod types;

pub use contract::{BondEscrow, BondEscrowClient};
pub use errors::ContractError;
pub use types::{BondStatus, BondTerms, DeliveryReceipt, Stake};

#[cfg(test)]
mod test;
