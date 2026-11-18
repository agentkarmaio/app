//! Agent Bond contract.
//!
//! Roles and trust (see ADR 0001, PLAN.md §3):
//! - owner: the agent's registry wallet, frozen at first deposit. Deposits,
//!   requests unbond, receives withdrawals. Nobody else can move a bond except
//!   the slasher, and only to the treasury.
//! - slasher: slashes on evidence. Evidence is an audit pointer, NOT verified
//!   on-chain (Soroban cannot read NEAR or off-chain records).
//! - admin: config only. Every change waits max(2x the current unbonding
//!   period, 14 days), so an agent that notices within one period can still
//!   exit, and lowering the period first cannot shortcut a slasher swap.
//!
//! All USDC movement goes through `pull` / `push`: the seam a future
//! `YieldAdapter` would replace (PLAN.md §4). No yield logic in v1.

use soroban_sdk::{contract, contractimpl, token, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec};

use crate::errors::Error;
use crate::events::{
    AdminChanged, AdminProposed, BondDeposited, BondSlashed, BondUnbondRequested, BondWithdrawn,
    ConfigApplied, ConfigProposed,
};
use crate::storage;
use crate::types::{BondState, Config, ConfigChange, Evidence, PendingConfig};

pub const MIN_UNBONDING_SECS: u64 = 60;
pub const MAX_UNBONDING_SECS: u64 = 90 * 24 * 3600;
/// Absolute floor on every config delay, so lowering the period first cannot
/// shortcut a later slasher or treasury swap.
pub const MIN_GOVERNANCE_DELAY_SECS: u64 = 14 * 24 * 3600;

const TAG_ENACTMENT: &[u8] = b"agentkarma.bond.evidence.enactment/1";
const TAG_ASSAY: &[u8] = b"agentkarma.bond.evidence.assay/1";

#[contract]
pub struct AgentBond;

#[contractimpl]
impl AgentBond {
    /// Atomic with deploy: no front-runnable `initialize` window.
    pub fn __constructor(
        env: Env,
        admin: Address,
        slasher: Address,
        treasury: Address,
        token: Address,
        identity_registry: Address,
        unbonding_secs: u64,
    ) -> Result<(), Error> {
        check_period(unbonding_secs)?;
        storage::set_config(
            &env,
            &Config { admin, slasher, treasury, token, identity_registry, unbonding_secs },
        );
        storage::bump_instance(&env);
        Ok(())
    }

    /// Lock `amount` USDC for `agent_id`. The first deposit binds the owner to
    /// the registry's `agentWallet`; later deposits need the owner's auth.
    pub fn deposit(env: Env, agent_id: u32, amount: i128) -> Result<(), Error> {
        positive(amount)?;
        let cfg = storage::get_config(&env);
        let mut bond = match storage::get_bond(&env, agent_id) {
            Some(b) => b,
            None => BondState {
                owner: registry_wallet(&env, &cfg, agent_id)?,
                bonded: 0,
                unbonding: 0,
                unlock_at: 0,
                slashed_total: 0,
                first_deposit_at: env.ledger().timestamp(),
            },
        };
        bond.owner.require_auth();
        bond.bonded = bond.bonded.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;

        pull(&env, &cfg, &bond.owner, amount);
        storage::set_bond(&env, agent_id, &bond);
        storage::bump_instance(&env);
        BondDeposited {
            agent_id,
            owner: bond.owner.clone(),
            amount,
            bonded: bond.bonded,
            unbonding: bond.unbonding,
            slashed_total: bond.slashed_total,
        }
        .publish(&env);
        Ok(())
    }

    /// Move `amount` from bonded to unbonding. Resets the whole bucket's unlock
    /// to `now + unbonding_secs` (can only delay exit, never shorten it).
    pub fn request_unbond(env: Env, agent_id: u32, amount: i128) -> Result<(), Error> {
        positive(amount)?;
        let cfg = storage::get_config(&env);
        let mut bond = storage::get_bond(&env, agent_id).ok_or(Error::NotFound)?;
        bond.owner.require_auth();
        if amount > bond.bonded {
            return Err(Error::InsufficientBonded);
        }
        bond.bonded -= amount;
        bond.unbonding = bond.unbonding.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;
        bond.unlock_at = env
            .ledger()
            .timestamp()
            .checked_add(cfg.unbonding_secs)
            .ok_or(Error::ArithmeticOverflow)?;

        storage::set_bond(&env, agent_id, &bond);
        storage::bump_instance(&env);
        BondUnbondRequested {
            agent_id,
            owner: bond.owner.clone(),
            amount,
            bonded: bond.bonded,
            unbonding: bond.unbonding,
            unlock_at: bond.unlock_at,
        }
        .publish(&env);
        Ok(())
    }

    /// Pay all matured unbonding to the owner. Returns the amount paid.
    pub fn withdraw(env: Env, agent_id: u32) -> Result<i128, Error> {
        let cfg = storage::get_config(&env);
        let mut bond = storage::get_bond(&env, agent_id).ok_or(Error::NotFound)?;
        bond.owner.require_auth();
        if bond.unbonding == 0 {
            return Err(Error::NothingUnbonding);
        }
        if env.ledger().timestamp() < bond.unlock_at {
            return Err(Error::EarlyWithdraw);
        }
        let amount = bond.unbonding;
        bond.unbonding = 0;
        bond.unlock_at = 0;

        // State first, then the transfer (no reentry path, but keep the order).
        storage::set_bond(&env, agent_id, &bond);
        push(&env, &cfg, &bond.owner, amount);
        storage::bump_instance(&env);
        BondWithdrawn {
            agent_id,
            owner: bond.owner.clone(),
            amount,
            bonded: bond.bonded,
            unbonding: bond.unbonding,
        }
        .publish(&env);
        Ok(amount)
    }

    /// Slash `amount` to the treasury. Draws from unbonding first (an exiting
    /// agent pays first), then bonded. One piece of evidence slashes once.
    pub fn slash(env: Env, agent_id: u32, amount: i128, evidence: Evidence) -> Result<(), Error> {
        let cfg = storage::get_config(&env);
        cfg.slasher.require_auth();
        positive(amount)?;
        let mut bond = storage::get_bond(&env, agent_id).ok_or(Error::NotFound)?;
        let available = bond.bonded.checked_add(bond.unbonding).ok_or(Error::ArithmeticOverflow)?;
        if amount > available {
            return Err(Error::SlashExceedsBalance);
        }
        let ev_id = evidence_hash(&env, &evidence);
        if storage::is_evidence_used(&env, &ev_id) {
            return Err(Error::EvidenceReused);
        }

        let from_unbonding = amount.min(bond.unbonding);
        let from_bonded = amount - from_unbonding;
        bond.unbonding -= from_unbonding;
        bond.bonded -= from_bonded;
        if bond.unbonding == 0 {
            bond.unlock_at = 0;
        }
        bond.slashed_total = bond.slashed_total.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;

        storage::mark_evidence_used(&env, &ev_id);
        storage::set_bond(&env, agent_id, &bond);
        push(&env, &cfg, &cfg.treasury, amount);
        storage::bump_instance(&env);
        BondSlashed {
            agent_id,
            slasher: cfg.slasher.clone(),
            owner: bond.owner.clone(),
            amount,
            from_unbonding,
            from_bonded,
            evidence,
            evidence_id: ev_id,
            treasury: cfg.treasury.clone(),
            bonded: bond.bonded,
            unbonding: bond.unbonding,
            slashed_total: bond.slashed_total,
        }
        .publish(&env);
        Ok(())
    }

    // ── admin: config only, delayed ─────────────────────────────────────────

    /// Propose a config change. Replaces any pending one (which restarts the
    /// delay). Activates at `now + max(2 * current unbonding_secs, 14 days)`.
    pub fn propose_config(env: Env, change: ConfigChange) -> Result<(), Error> {
        let cfg = storage::get_config(&env);
        cfg.admin.require_auth();
        if let ConfigChange::UnbondingSecs(secs) = change {
            check_period(secs)?;
        }
        let delay = cfg
            .unbonding_secs
            .checked_mul(2)
            .ok_or(Error::ArithmeticOverflow)?
            .max(MIN_GOVERNANCE_DELAY_SECS);
        let activates_at = env.ledger().timestamp().checked_add(delay).ok_or(Error::ArithmeticOverflow)?;
        storage::set_pending_config(&env, &PendingConfig { change: change.clone(), activates_at });
        storage::bump_instance(&env);
        ConfigProposed { admin: cfg.admin.clone(), change, activates_at }.publish(&env);
        Ok(())
    }

    /// Apply the pending change once its delay has passed. Permissionless: the
    /// change was already authorized and announced.
    pub fn apply_config(env: Env) -> Result<(), Error> {
        let pending = storage::get_pending_config(&env).ok_or(Error::NoPendingConfig)?;
        if env.ledger().timestamp() < pending.activates_at {
            return Err(Error::ConfigNotYetActive);
        }
        let mut cfg = storage::get_config(&env);
        match pending.change.clone() {
            ConfigChange::Slasher(a) => cfg.slasher = a,
            ConfigChange::Treasury(a) => cfg.treasury = a,
            ConfigChange::UnbondingSecs(s) => cfg.unbonding_secs = s,
        }
        storage::set_config(&env, &cfg);
        storage::clear_pending_config(&env);
        storage::bump_instance(&env);
        ConfigApplied { change: pending.change }.publish(&env);
        Ok(())
    }

    /// Step 1 of the admin handover.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let cfg = storage::get_config(&env);
        cfg.admin.require_auth();
        storage::set_pending_admin(&env, &new_admin);
        storage::bump_instance(&env);
        AdminProposed { admin: cfg.admin, pending: new_admin }.publish(&env);
        Ok(())
    }

    /// Step 2: the proposed admin accepts.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending = storage::get_pending_admin(&env).ok_or(Error::NoPendingAdmin)?;
        pending.require_auth();
        let mut cfg = storage::get_config(&env);
        let old = cfg.admin.clone();
        cfg.admin = pending.clone();
        storage::set_config(&env, &cfg);
        storage::clear_pending_admin(&env);
        storage::bump_instance(&env);
        AdminChanged { old, new: pending }.publish(&env);
        Ok(())
    }

    // ── reads ───────────────────────────────────────────────────────────────

    pub fn get_bond(env: Env, agent_id: u32) -> Option<BondState> {
        storage::get_bond(&env, agent_id)
    }

    pub fn get_config(env: Env) -> Config {
        storage::get_config(&env)
    }

    pub fn get_pending_config(env: Env) -> Option<PendingConfig> {
        storage::get_pending_config(&env)
    }

    pub fn is_evidence_used(env: Env, evidence_id: BytesN<32>) -> bool {
        storage::is_evidence_used(&env, &evidence_id)
    }

    /// The replay key for a piece of evidence (domain-separated SHA-256).
    pub fn evidence_id(env: Env, evidence: Evidence) -> BytesN<32> {
        evidence_hash(&env, &evidence)
    }
}

// ── internals ────────────────────────────────────────────────────────────────

fn positive(amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::AmountNotPositive);
    }
    Ok(())
}

fn check_period(secs: u64) -> Result<(), Error> {
    if !(MIN_UNBONDING_SECS..=MAX_UNBONDING_SECS).contains(&secs) {
        return Err(Error::InvalidUnbondingPeriod);
    }
    Ok(())
}

/// stellar-8004 `get_agent_wallet(u32) -> Option<Address>`.
fn registry_wallet(env: &Env, cfg: &Config, agent_id: u32) -> Result<Address, Error> {
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(agent_id.into_val(env));
    let wallet: Option<Address> =
        env.invoke_contract(&cfg.identity_registry, &Symbol::new(env, "get_agent_wallet"), args);
    wallet.ok_or(Error::AgentNotRegistered)
}

fn evidence_hash(env: &Env, evidence: &Evidence) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    match evidence {
        Evidence::Enactment(digest) => {
            buf.extend_from_slice(TAG_ENACTMENT);
            buf.append(&Bytes::from(digest.clone()));
        }
        Evidence::AssayVerdict(code_hash, record_digest) => {
            buf.extend_from_slice(TAG_ASSAY);
            buf.append(&Bytes::from(code_hash.clone()));
            buf.append(&Bytes::from(record_digest.clone()));
        }
    }
    env.crypto().sha256(&buf).to_bytes()
}

/// Yield seam: USDC in. A future adapter replaces this body.
fn pull(env: &Env, cfg: &Config, from: &Address, amount: i128) {
    token::Client::new(env, &cfg.token).transfer(from, env.current_contract_address(), &amount);
}

/// Yield seam: USDC out. A future adapter must keep an idle buffer so this can
/// never fail on venue liquidity (PLAN.md §4.1).
fn push(env: &Env, cfg: &Config, to: &Address, amount: i128) {
    token::Client::new(env, &cfg.token).transfer(&env.current_contract_address(), to, &amount);
}
