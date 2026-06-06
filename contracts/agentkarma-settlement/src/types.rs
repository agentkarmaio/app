//! Contract value types — verbatim from design notes §3.
//!
//! All are `#[contracttype]` so they cross the host boundary as args / return
//! values / storage entries. No classes, no behavior here — pure data.

use soroban_sdk::{contracttype, Address, BytesN};

/// A facilitator reference inside an x402-direct settlement. `facilitator` is
/// the curated settling party; `ledger_proof_height` is the ledger at which the
/// witnessing indexer observed the transfer (timing evidence).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FacilitatorRef {
    pub facilitator: Address,
    pub ledger_proof_height: u32,
}

/// How the settlement reached the ledger. Only `X402Direct` is wired for v1;
/// the MPP variants share the same on-chain shape and slot in later (the trait
/// keeps them additive — no storage/schema change).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettlementSource {
    /// impl #1 — IMPLEMENT NOW. Single USDC SAC `transfer` via a facilitator.
    X402Direct(FacilitatorRef),
    /// impl #2 — peer-to-peer MPP charge, no facilitator. Same on-chain shape.
    MppCharge,
    /// impl #3 — cumulative MPP channel close; channel-scoped granularity.
    MppChannelClose,
}

/// The indexer-witnessed settlement proof submitted by an AK validator.
///
/// Authenticity (that tx `tx_hash` exists on the public ledger) is established
/// OFF-chain by the witness and is independently re-derivable by anyone — a
/// Soroban contract cannot read past ledger events (Stream A). The contract
/// enforces only uniqueness / payee-binding / weight / recency over this data.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementProof {
    /// SHA-256 of the signed tx XDR — immutable, ledger-derivable.
    pub tx_hash: BytesN<32>,
    /// Consumer `G...` (the payer).
    pub payer: Address,
    /// Provider `G...` — MUST equal the agent's `agentWallet`.
    pub payee: Address,
    /// USDC base units (7 decimals). Always positive for a real settlement.
    pub amount: i128,
    /// Ledger sequence the settlement landed at — proof of timing / recency.
    pub ledger_seq: u32,
    /// Settlement provenance (x402-direct now; MPP later).
    pub source: SettlementSource,
    /// AK-oracle signature now; facilitator signature if/when a verifiable
    /// signing key is published (additive upgrade to `trust-facilitator`).
    pub proof_signature: BytesN<64>,
}

/// The aggregate score returned by reads. `score` is the [0,100] volume-weighted,
/// recency-decayed headline number; `volume_sum` is the decayed backed-USDC base
/// units; `count` is the number of settlements folded in; `recency_slot` is the
/// ledger at which the aggregate was last decayed/updated.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WeightedScore {
    pub score: u32,
    pub volume_sum: u128,
    pub count: u32,
    pub recency_slot: u32,
}

/// Two-faced karma facet a submission targets. Stored alongside `agent_id` so a
/// provider score and a consumer score never collapse into one (invariant #3).
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum KarmaTag {
    Provider = 0,
    Consumer = 1,
}
