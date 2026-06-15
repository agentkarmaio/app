//! Contract error surface.
//!
//! Every fallible entrypoint returns `Result<_, ContractError>`; the contract
//! NEVER panics on a domain failure. `require_auth` failures are the one
//! exception — they abort at the host boundary by design (Soroban auth model).
//!
//! NOTE the ABSENCE of any `UnauthorizedAdmin` / `NotAdmin` variant: this
//! contract is ownerless, so there is no admin failure mode to encode.

use soroban_sdk::contracterror;

/// Domain errors. `#[repr(u32)]` codes are stable wire identifiers; do not
/// renumber existing variants (clients/indexers match on the integer).
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    /// `initialize` called on an already-initialized bond.
    AlreadyInitialized = 1,
    /// Any entrypoint called before `initialize`.
    NotInitialized = 2,
    /// A stake/resolve was attempted on a bond not in the required state.
    InvalidState = 3,
    /// `stake` after the funding window closed (deadline passed) or after the
    /// bond already left `Open`.
    FundingClosed = 4,
    /// `claim_success` submitted after the delivery deadline elapsed.
    DeadlinePassed = 5,
    /// `claim_failure` triggered before the delivery deadline elapsed.
    DeadlineNotReached = 6,
    /// The submitted delivery receipt does not match the bond's immutable terms
    /// (wrong payer/payee, under-amount, or replayed settlement id). Note this is
    /// a binding check on the recorded fields, NOT an authenticity proof — the
    /// success authorization is the beneficiary's `require_auth`.
    ReceiptMismatch = 7,
    /// A non-positive amount was supplied where a positive USDC value is needed.
    AmountNotPositive = 8,
    /// A checked arithmetic op (stake sum, payout split) overflowed. Surfaced
    /// instead of panicking.
    ArithmeticOverflow = 9,
    /// No underwriters staked — nothing to resolve / refund.
    NoUnderwriters = 10,
}
