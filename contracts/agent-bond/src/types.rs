//! Contract value types. Pure data, no behavior.

use soroban_sdk::{contracttype, Address, BytesN};

/// Immutable-by-default configuration. `slasher`, `treasury` and
/// `unbonding_secs` change only through the delayed `propose_config` /
/// `apply_config` path; `admin` changes through the two-step handover.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub slasher: Address,
    pub treasury: Address,
    /// USDC Stellar Asset Contract. The only asset in v1.
    pub token: Address,
    /// stellar-8004 Identity Registry, read once per bond at first deposit.
    pub identity_registry: Address,
    pub unbonding_secs: u64,
}

/// One config change, applied only after its delay.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigChange {
    Slasher(Address),
    Treasury(Address),
    UnbondingSecs(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingConfig {
    pub change: ConfigChange,
    /// Ledger timestamp (seconds) at or after which `apply_config` succeeds.
    pub activates_at: u64,
}

/// Per-agent bond. Amounts are USDC base units (7 decimals).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondState {
    /// Fixed at first deposit from the registry's `agentWallet`. Only the owner
    /// deposits, unbonds and receives withdrawals; later registry changes do not
    /// move it.
    pub owner: Address,
    /// Active stake. Counts toward the score.
    pub bonded: i128,
    /// Exiting stake. Still slashable, does not count toward the score.
    pub unbonding: i128,
    /// Timestamp when `unbonding` becomes withdrawable. 0 when nothing unbonds.
    pub unlock_at: u64,
    pub slashed_total: i128,
    pub first_deposit_at: u64,
}

/// What a slash points at. Not verified on-chain: Soroban cannot read the NEAR
/// Assay registry or an off-chain Enactment Record. The slasher is trusted to
/// slash only on real evidence; the event makes every pointer auditable.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Evidence {
    /// AgentEnact Enactment Record digest (SHA-256 of the unsigned record).
    Enactment(BytesN<32>),
    /// Assay registry verdict: (code_hash, record_digest).
    AssayVerdict(BytesN<32>, BytesN<32>),
}
