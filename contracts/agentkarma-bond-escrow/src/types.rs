//! Contract value types.
//!
//! All are `#[contracttype]` so they cross the host boundary as args / return
//! values / storage entries. No classes, no behavior here — pure data.

use soroban_sdk::{contracttype, Address, BytesN};

/// Lifecycle of a bond. The contract is a strict state machine:
///
/// ```text
///   Open ──(claim_success: beneficiary acknowledges delivery)─▶ ResolvedSuccess
///   Open ──(claim_failure: deadline elapsed, no delivery)─────▶ ResolvedFailure
/// ```
///
/// `ResolvedSuccess` / `ResolvedFailure` are TERMINAL — once set, every state
/// transition is rejected with `InvalidState`, so a bond can be resolved at most
/// once (no double-payout). There is no path BACK to `Open`.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BondStatus {
    /// Funding + in-flight: underwriters may stake; either resolution is open
    /// (success before deadline, failure after).
    Open = 0,
    /// Agent delivered: the beneficiary authorized release before the deadline.
    /// Stakes were returned to underwriters.
    ResolvedSuccess = 1,
    /// Deadline elapsed with no delivery proof. Staked bond paid the beneficiary.
    ResolvedFailure = 2,
}

/// Immutable bond terms, fixed at `initialize` and never mutated. The
/// resolution logic binds every submitted receipt to THESE and requires the
/// beneficiary's authorization to release on success — no admin and no off-chain
/// oracle is in the loop.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondTerms {
    /// The agent being vouched for. A `claim_success` receipt MUST record this
    /// agent as the payer that settled to the beneficiary.
    pub bonded_agent: Address,
    /// Who is made whole on failure (the relying party). On `claim_failure` the
    /// pooled stake is transferred here.
    pub beneficiary: Address,
    /// USDC SAC token the stakes are denominated + custodied in.
    pub token: Address,
    /// Minimum USDC the delivery settlement must move from `bonded_agent` to
    /// `beneficiary` to count as delivery. 7-dec base units.
    pub min_delivery_amount: i128,
    /// Ledger sequence after which `claim_success` is rejected and
    /// `claim_failure` becomes available. The objective, AK-independent clock.
    pub deadline_ledger: u32,
    /// Opaque off-chain task reference (hash of the task spec). Recorded for the
    /// indexer / UI; never interpreted on-chain.
    pub task_ref: BytesN<32>,
}

/// A delivery RECORD attached to a beneficiary-authorized `claim_success`. It is
/// NOT a trustless authenticity proof: a Soroban contract cannot read past ledger
/// state, so the contract cannot verify that `settlement_tx` actually exists or
/// moved these funds. Authorization to release rests entirely on the
/// beneficiary's `require_auth()` in `claim_success`; this struct exists to
/// (a) leave a permanent on-chain audit record of what was delivered, and
/// (b) bind payer/payee/amount to the immutable terms and enforce single-use via
/// `settlement_tx`. The off-chain indexer can independently re-derive the
/// recorded settlement from the public ledger for display.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveryReceipt {
    /// SHA-256 of the signed settlement tx XDR — the single-use key (one
    /// settlement record resolves at most one bond) and the audit anchor.
    pub settlement_tx: BytesN<32>,
    /// The recorded payer — MUST equal `terms.bonded_agent`.
    pub payer: Address,
    /// The recorded payee — MUST equal `terms.beneficiary`.
    pub payee: Address,
    /// USDC recorded as moved — MUST be `>= terms.min_delivery_amount`.
    pub amount: i128,
    /// Ledger the settlement landed at — MUST be `<= terms.deadline_ledger`.
    pub settled_ledger: u32,
}

/// A single underwriter's recorded stake. The escrow custodies the summed
/// stakes; on success each underwriter is refunded their `amount`, on failure
/// the pool pays the beneficiary.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stake {
    pub underwriter: Address,
    pub amount: i128,
}
