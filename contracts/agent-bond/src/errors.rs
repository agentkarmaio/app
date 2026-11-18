//! Domain errors. `#[repr(u32)]` codes are stable wire identifiers: never
//! renumber. Auth failures abort at the host boundary instead (Soroban model).

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// No bond exists for this agent_id.
    NotFound = 1,
    AmountNotPositive = 2,
    /// `request_unbond` above the active `bonded` amount.
    InsufficientBonded = 3,
    /// `withdraw` with nothing unbonding.
    NothingUnbonding = 4,
    /// `withdraw` before `unlock_at`.
    EarlyWithdraw = 5,
    /// `slash` above `bonded + unbonding`.
    SlashExceedsBalance = 6,
    /// This evidence already backed a slash.
    EvidenceReused = 7,
    /// The registry has no `agentWallet` for this agent_id.
    AgentNotRegistered = 8,
    NoPendingConfig = 9,
    ConfigNotYetActive = 10,
    /// `unbonding_secs` outside [MIN_UNBONDING_SECS, MAX_UNBONDING_SECS].
    InvalidUnbondingPeriod = 11,
    ArithmeticOverflow = 12,
    NoPendingAdmin = 13,
}
