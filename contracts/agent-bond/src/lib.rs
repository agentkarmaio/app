#![no_std]
//! Agent Bond: an agent locks USDC behind its reputation. A `slasher` can slash
//! it on evidence of misconduct (AgentEnact Enactment Record digest or Assay
//! registry verdict); slashed funds go to `treasury`.
//!
//! Operated as a separate product ("Agent Bond, operated by AgentKarma Labs"),
//! testnet only. See web/docs/adr/0001-agent-bond-self-stake.md and RFC
//! v0.3.4-draft §12.1 / §16.4.

mod contract;
mod errors;
mod events;
mod storage;
mod types;

pub use contract::{AgentBond, AgentBondClient};
pub use errors::Error;
pub use types::{BondState, Config, ConfigChange, Evidence, PendingConfig};

#[cfg(test)]
mod test;
