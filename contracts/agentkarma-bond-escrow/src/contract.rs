//! AgentKarma ownerless bond-escrow contract.
//!
//! A surety bond: third-party underwriters stake USDC vouching that a young
//! `bonded_agent` will deliver a task to a `beneficiary` by `deadline_ledger`.
//!
//! NON-CUSTODY / OWNERLESS, BY CONSTRUCTION (RFC §12 Non-Routing AND
//! Non-Custody):
//!   - There is NO admin entrypoint, NO stored admin, NO upgrade path. AgentKarma
//!     holds no key here. AK can neither resolve nor sweep a bond.
//!   - The escrow custodies the staked USDC in its OWN address. It resolves a
//!     SUCCESS only when the `beneficiary` authorizes it — the beneficiary is the
//!     relying party who would otherwise collect the whole pool on failure, so
//!     their signature is the genuinely-authorized acknowledgement that the agent
//!     delivered. There is no AK oracle, no admin, and no subjective arbiter.
//!   - AgentKarma only OBSERVES the public events (`BondOpened` / `BondStaked` /
//!     `BondResolved`) and projects them into its read-only score signals.
//!
//! Resolution is authorized at the EDGE (no AK in the loop):
//!   - `claim_success` — the `beneficiary` (and only the beneficiary) signs to
//!     release the stakes back to underwriters, acknowledging delivery. The
//!     submitted `DeliveryReceipt` is a permanent on-chain RECORD of what was
//!     delivered (settlement tx hash, payer/payee/amount) — it is NOT a trusted
//!     authenticity proof (a Soroban contract cannot read past ledger state, so
//!     these fields are not independently verifiable on-chain; the beneficiary's
//!     `require_auth` is what authorizes the release). The contract still binds
//!     the recorded payer/payee to its immutable terms and enforces single-use
//!     per settlement tx.
//!   - `claim_failure` — after the deadline, anyone triggers payout of the pooled
//!     stake to the `beneficiary`, terminating `ResolvedFailure`. (Permissionless
//!     because the only possible outcome — paying the beneficiary — is fixed by
//!     the terms, so no authorization is needed.)
//!
//! Both resolutions are TERMINAL and single-shot (no double-payout). A
//! `settlement_tx` record resolves at most one bond (durable consumed-guard).

#![allow(clippy::needless_pass_by_value)]

use soroban_sdk::{contract, contractimpl, token, Address, Env, Vec};

use crate::errors::ContractError;
use crate::events;
use crate::storage;
use crate::types::{BondStatus, BondTerms, DeliveryReceipt, Stake};

#[contract]
pub struct BondEscrow;

#[contractimpl]
impl BondEscrow {
    /// One-time setup. Fixes the IMMUTABLE bond terms and opens funding. There is
    /// deliberately no `admin` parameter — once initialized, the terms can never
    /// be changed and no privileged party exists.
    ///
    /// `min_delivery_amount` must be positive (a bond with a zero delivery bar is
    /// meaningless). `deadline_ledger` is the objective clock; the caller chooses
    /// it relative to the current ledger off-chain.
    pub fn initialize(env: Env, terms: BondTerms) -> Result<(), ContractError> {
        if storage::is_initialized(&env) {
            return Err(ContractError::AlreadyInitialized);
        }
        if terms.min_delivery_amount <= 0 {
            return Err(ContractError::AmountNotPositive);
        }
        let opened = events_terms(&terms);
        storage::set_terms(&env, &terms);
        storage::set_status(&env, BondStatus::Open);
        storage::set_stakes(&env, &Vec::new(&env));
        storage::bump_instance(&env);
        events::bond_opened(
            &env,
            &opened.0,
            &opened.1,
            &opened.2,
            opened.3,
            opened.4,
            &opened.5,
        );
        Ok(())
    }

    /// An underwriter stakes `amount` USDC, vouching the agent will deliver. The
    /// underwriter signs (auth) and the staked USDC is pulled into the escrow's
    /// own balance via the token SAC `transfer`. Allowed only while `Open` and
    /// before the deadline (no funding a bond whose outcome is already decidable).
    ///
    /// Re-staking by the same underwriter appends another `Stake` row; the
    /// projector aggregates per-underwriter off-chain (mirrors how the indexer
    /// upserts `bond_underwriters`).
    pub fn stake(
        env: Env,
        underwriter: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        underwriter.require_auth();

        let terms = storage::get_terms(&env).ok_or(ContractError::NotInitialized)?;
        let status = storage::get_status(&env).ok_or(ContractError::NotInitialized)?;
        if status != BondStatus::Open {
            return Err(ContractError::FundingClosed);
        }
        if amount <= 0 {
            return Err(ContractError::AmountNotPositive);
        }
        // Funding closes at the deadline — past it the bond is resolvable as a
        // failure and must not accept fresh stake.
        if env.ledger().sequence() > terms.deadline_ledger {
            return Err(ContractError::FundingClosed);
        }

        // Pull the stake into the escrow's own balance. The underwriter authed
        // above; the SAC enforces the underwriter actually holds the funds.
        let escrow = env.current_contract_address();
        let client = token::Client::new(&env, &terms.token);
        client.transfer(&underwriter, &escrow, &amount);

        let mut stakes = storage::get_stakes(&env);
        stakes.push_back(Stake { underwriter: underwriter.clone(), amount });
        storage::set_stakes(&env, &stakes);
        storage::bump_instance(&env);

        let total = total_staked(&stakes)?;
        events::bond_staked(&env, &terms.bonded_agent, &underwriter, amount, total);
        Ok(())
    }

    /// Resolve the bond as a SUCCESS. AUTHORIZED BY THE BENEFICIARY — the relying
    /// party signs to acknowledge the agent delivered and release the staked USDC
    /// back to the underwriters. The beneficiary is the party who would otherwise
    /// collect the entire pool on failure, so their signature is the genuine,
    /// incentive-compatible authorization (they have nothing to gain by signing a
    /// false success). No AK key, no admin, no oracle is involved.
    ///
    /// The submitted `DeliveryReceipt` is recorded for the indexer / audit trail
    /// (settlement tx hash, payer/payee/amount) and is bound to the immutable
    /// terms, but it is NOT an authenticity proof: a Soroban contract cannot read
    /// past ledger state, so the on-chain `require_auth` — not the receipt — is
    /// what authorizes the release.
    ///
    /// Gate, in order:
    ///   - `beneficiary.require_auth()`         → else host-level auth abort
    ///   - bond is `Open`                       → else `InvalidState`
    ///   - `settled_ledger <= deadline_ledger`  → else `DeadlinePassed`
    ///   - `payer == terms.bonded_agent`        → else `ReceiptMismatch`
    ///   - `payee == terms.beneficiary`         → else `ReceiptMismatch`
    ///   - `amount >= terms.min_delivery_amount`→ else `ReceiptMismatch`
    ///   - `settlement_tx` unconsumed           → else `ReceiptMismatch`
    pub fn claim_success(env: Env, receipt: DeliveryReceipt) -> Result<(), ContractError> {
        let terms = storage::get_terms(&env).ok_or(ContractError::NotInitialized)?;
        // Only the beneficiary can release the stakes back to underwriters. This
        // is the authorization that makes a success resolution genuine — without
        // it, anyone could forge the receipt fields and unwind the bond.
        terms.beneficiary.require_auth();

        let status = storage::get_status(&env).ok_or(ContractError::NotInitialized)?;
        if status != BondStatus::Open {
            return Err(ContractError::InvalidState);
        }
        // A delivery must have settled on/before the deadline to count.
        if receipt.settled_ledger > terms.deadline_ledger {
            return Err(ContractError::DeadlinePassed);
        }
        // Bind the recorded receipt to the bond's immutable terms — keeps the
        // audit record honest even though authorization rests on require_auth.
        if receipt.payer != terms.bonded_agent {
            return Err(ContractError::ReceiptMismatch);
        }
        if receipt.payee != terms.beneficiary {
            return Err(ContractError::ReceiptMismatch);
        }
        if receipt.amount < terms.min_delivery_amount {
            return Err(ContractError::ReceiptMismatch);
        }
        // Single-use: one settlement record resolves at most one bond.
        if storage::is_consumed(&env, &receipt.settlement_tx) {
            return Err(ContractError::ReceiptMismatch);
        }

        let stakes = storage::get_stakes(&env);
        if stakes.is_empty() {
            return Err(ContractError::NoUnderwriters);
        }
        let total = total_staked(&stakes)?;

        // Refund each underwriter their exact stake from the escrow balance.
        let escrow = env.current_contract_address();
        let client = token::Client::new(&env, &terms.token);
        for s in stakes.iter() {
            client.transfer(&escrow, &s.underwriter, &s.amount);
        }

        storage::mark_consumed(&env, &receipt.settlement_tx);
        storage::set_status(&env, BondStatus::ResolvedSuccess);
        storage::bump_instance(&env);
        events::bond_resolved(&env, &terms.bonded_agent, true, total, &receipt.settlement_tx);
        Ok(())
    }

    /// Resolve the bond as a FAILURE after the deadline elapses with no delivery
    /// proof. Anyone may call (permissionless). The pooled stake is transferred
    /// to the beneficiary — the relying party is made whole.
    ///
    /// Gate:
    ///   - bond is `Open`                        → else `InvalidState`
    ///   - `now > deadline_ledger`               → else `DeadlineNotReached`
    ///   - at least one underwriter staked        → else `NoUnderwriters`
    pub fn claim_failure(env: Env) -> Result<(), ContractError> {
        let terms = storage::get_terms(&env).ok_or(ContractError::NotInitialized)?;
        let status = storage::get_status(&env).ok_or(ContractError::NotInitialized)?;
        if status != BondStatus::Open {
            return Err(ContractError::InvalidState);
        }
        if env.ledger().sequence() <= terms.deadline_ledger {
            return Err(ContractError::DeadlineNotReached);
        }

        let stakes = storage::get_stakes(&env);
        if stakes.is_empty() {
            return Err(ContractError::NoUnderwriters);
        }
        let total = total_staked(&stakes)?;

        // Pay the entire pooled stake to the beneficiary.
        let escrow = env.current_contract_address();
        let client = token::Client::new(&env, &terms.token);
        client.transfer(&escrow, &terms.beneficiary, &total);

        storage::set_status(&env, BondStatus::ResolvedFailure);
        storage::bump_instance(&env);
        events::bond_resolved(
            &env,
            &terms.bonded_agent,
            false,
            total,
            &zero_hash(&env),
        );
        Ok(())
    }

    // ── auth-less reads ──────────────────────────────────────────────────────

    pub fn get_status(env: Env) -> Option<BondStatus> {
        storage::get_status(&env)
    }

    pub fn get_terms(env: Env) -> Option<BondTerms> {
        storage::get_terms(&env)
    }

    pub fn get_stakes(env: Env) -> Vec<Stake> {
        storage::get_stakes(&env)
    }

    /// Total USDC currently pooled across all stakes (saturating-free; checked).
    pub fn get_total_staked(env: Env) -> Result<i128, ContractError> {
        total_staked(&storage::get_stakes(&env))
    }
}

// ── internals ────────────────────────────────────────────────────────────────

/// Sum all stake amounts with checked arithmetic — overflow surfaces as an error
/// rather than panicking.
fn total_staked(stakes: &Vec<Stake>) -> Result<i128, ContractError> {
    let mut total: i128 = 0;
    for s in stakes.iter() {
        total = total
            .checked_add(s.amount)
            .ok_or(ContractError::ArithmeticOverflow)?;
    }
    Ok(total)
}

/// Destructure terms into the positional tuple `bond_opened` expects (kept tiny
/// so the entrypoint stays readable).
type OpenedTuple = (
    Address,
    Address,
    Address,
    i128,
    u32,
    soroban_sdk::BytesN<32>,
);
fn events_terms(terms: &BondTerms) -> OpenedTuple {
    (
        terms.bonded_agent.clone(),
        terms.beneficiary.clone(),
        terms.token.clone(),
        terms.min_delivery_amount,
        terms.deadline_ledger,
        terms.task_ref.clone(),
    )
}

/// All-zero 32-byte hash — the `proof_tx` placeholder on a failure resolve
/// (which has no settlement proof).
fn zero_hash(env: &Env) -> soroban_sdk::BytesN<32> {
    soroban_sdk::BytesN::from_array(env, &[0u8; 32])
}
