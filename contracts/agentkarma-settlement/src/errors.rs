//! Contract error surface — verbatim from design notes §3.
//!
//! Every fallible entrypoint returns `Result<_, ContractError>`; the contract
//! NEVER panics on a domain failure (checked arithmetic maps overflow to
//! `ArithmeticOverflow`). `require_auth` failures are the one exception — they
//! abort at the host boundary by design (Soroban auth model).

use soroban_sdk::contracterror;

/// Domain errors. `#[repr(u32)]` codes are stable wire identifiers; do not
/// renumber existing variants (clients match on the integer).
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    /// `payee != stellar-8004 agentWallet(agent_id)` — the settlement paid a
    /// wallet that is not the agent's registered payment receiver.
    PayeeWalletMismatch = 1,
    /// `settlement_id` already present in `SETTLED_IDS` — replay rejected.
    SettlementAlreadyConsumed = 2,
    /// The proof's source facilitator is not in the curated `FACILITATORS` set.
    FacilitatorUnknown = 3,
    /// `outcome ∉ [0, 100]`.
    OutcomeOutOfRange = 4,
    /// A checked arithmetic op (volume sum, weight, decay) overflowed.
    /// Surfaced instead of panicking.
    ArithmeticOverflow = 5,
    /// `caller ∉ VALIDATORS` (the AK oracle allowlist).
    UnauthorizedCaller = 6,
    /// Admin op attempted before the contract was initialized.
    NotInitialized = 7,
    /// Constructor / `initialize` called twice.
    AlreadyInitialized = 8,
}
