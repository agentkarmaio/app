//! Contract events (soroban-sdk 26 `#[contractevent]` typed events).
//!
//! These are the PUBLIC bond lifecycle the AgentKarma indexer projects into its
//! read-only `bonds` / `bond_underwriters` tables. The event shape is the
//! load-bearing contract between the on-chain escrow and the off-chain projector
//! (see web/src/indexer/bond-projection.ts): topics + fields here must stay in
//! sync with `BondLifecycleEvent` on the TS side.

use soroban_sdk::{contractevent, Address, BytesN, Env};

/// Emitted once at `initialize` — the bond opened for funding.
#[contractevent(topics = ["bond_opened"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondOpened {
    #[topic]
    pub bonded_agent: Address,
    pub beneficiary: Address,
    pub token: Address,
    pub min_delivery_amount: i128,
    pub deadline_ledger: u32,
    pub task_ref: BytesN<32>,
}

/// Emitted on each accepted `stake` — an underwriter vouched with USDC.
#[contractevent(topics = ["bond_staked"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondStaked {
    #[topic]
    pub bonded_agent: Address,
    #[topic]
    pub underwriter: Address,
    pub amount: i128,
    pub total_staked: i128,
}

/// Emitted when the bond self-resolved. `success = true` → stakes refunded;
/// `success = false` → pooled stake paid the beneficiary. `proof_tx` is the
/// objective settlement that resolved a success (zeroed on a failure resolve).
#[contractevent(topics = ["bond_resolved"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondResolved {
    #[topic]
    pub bonded_agent: Address,
    pub success: bool,
    pub total_staked: i128,
    pub proof_tx: BytesN<32>,
}

pub fn bond_opened(
    env: &Env,
    bonded_agent: &Address,
    beneficiary: &Address,
    token: &Address,
    min_delivery_amount: i128,
    deadline_ledger: u32,
    task_ref: &BytesN<32>,
) {
    BondOpened {
        bonded_agent: bonded_agent.clone(),
        beneficiary: beneficiary.clone(),
        token: token.clone(),
        min_delivery_amount,
        deadline_ledger,
        task_ref: task_ref.clone(),
    }
    .publish(env);
}

pub fn bond_staked(
    env: &Env,
    bonded_agent: &Address,
    underwriter: &Address,
    amount: i128,
    total_staked: i128,
) {
    BondStaked {
        bonded_agent: bonded_agent.clone(),
        underwriter: underwriter.clone(),
        amount,
        total_staked,
    }
    .publish(env);
}

pub fn bond_resolved(
    env: &Env,
    bonded_agent: &Address,
    success: bool,
    total_staked: i128,
    proof_tx: &BytesN<32>,
) {
    BondResolved {
        bonded_agent: bonded_agent.clone(),
        success,
        total_staked,
        proof_tx: proof_tx.clone(),
    }
    .publish(env);
}
