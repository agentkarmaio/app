//! Agent Bond unit tests. Native, soroban-sdk `testutils`.
//!
//! Real SAC (balances actually move) + a mock stellar-8004 Identity Registry
//! exposing the same `get_agent_wallet(u32) -> Option<Address>` as testnet
//! `CDE3K4CO…` (checked with `stellar contract info interface`).

extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events as _, Ledger, LedgerInfo, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Event, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

use crate::contract::{AgentBond, AgentBondClient, MAX_UNBONDING_SECS, MIN_GOVERNANCE_DELAY_SECS, MIN_UNBONDING_SECS};
use crate::errors::Error;
use crate::events::{BondDeposited, BondSlashed, BondUnbondRequested, BondWithdrawn, ConfigProposed};
use crate::types::{ConfigChange, Evidence};

// ── mock registry ────────────────────────────────────────────────────────────

#[contract]
pub struct MockRegistry;

#[contractimpl]
impl MockRegistry {
    pub fn set_wallet(env: Env, agent_id: u32, wallet: Address) {
        let mut m: Map<u32, Address> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "w"))
            .unwrap_or_else(|| Map::new(&env));
        m.set(agent_id, wallet);
        env.storage().instance().set(&Symbol::new(&env, "w"), &m);
    }

    pub fn get_agent_wallet(env: Env, agent_id: u32) -> Option<Address> {
        let m: Map<u32, Address> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "w"))
            .unwrap_or_else(|| Map::new(&env));
        m.get(agent_id)
    }
}

// ── harness ──────────────────────────────────────────────────────────────────

const AGENT: u32 = 7;
const PERIOD: u64 = 7 * 24 * 3600;
const T0: u64 = 1_700_000_000;
const USDC: i128 = 10_000_000; // 1 USDC, 7 decimals

struct H<'a> {
    env: Env,
    bond: AgentBondClient<'a>,
    token: TokenClient<'a>,
    registry: MockRegistryClient<'a>,
    admin: Address,
    slasher: Address,
    treasury: Address,
    owner: Address,
}

fn set_time(env: &Env, timestamp: u64) {
    env.ledger().set(LedgerInfo {
        timestamp,
        protocol_version: 26,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 16,
        max_entry_ttl: 10_000_000,
    });
}

fn setup_with_period(period: u64) -> H<'static> {
    let env = Env::default();
    env.mock_all_auths();
    set_time(&env, T0);

    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token = TokenClient::new(&env, &sac.address());
    let minter = StellarAssetClient::new(&env, &sac.address());

    let registry_id = env.register(MockRegistry, ());
    let registry = MockRegistryClient::new(&env, &registry_id);

    let admin = Address::generate(&env);
    let slasher = Address::generate(&env);
    let treasury = Address::generate(&env);
    let owner = Address::generate(&env);
    registry.set_wallet(&AGENT, &owner);
    minter.mint(&owner, &(1_000 * USDC));

    let id = env.register(
        AgentBond,
        (&admin, &slasher, &treasury, &sac.address(), &registry_id, &period),
    );
    let bond = AgentBondClient::new(&env, &id);
    H { env, bond, token, registry, admin, slasher, treasury, owner }
}

fn setup() -> H<'static> {
    setup_with_period(PERIOD)
}

fn enactment(env: &Env, seed: u8) -> Evidence {
    Evidence::Enactment(BytesN::from_array(env, &[seed; 32]))
}

/// Only `who` is authorized for exactly this one call.
fn auth_only(h: &H, who: &Address, fn_name: &str, args: Vec<Val>) {
    h.env.mock_auths(&[MockAuth {
        address: who,
        invoke: &MockAuthInvoke {
            contract: &h.bond.address,
            fn_name,
            args,
            sub_invokes: &[],
        },
    }]);
}

fn bond_events(h: &H) -> std::vec::Vec<soroban_sdk::xdr::ContractEvent> {
    h.env.events().all().filter_by_contract(&h.bond.address).events().to_vec()
}

// ── constructor ──────────────────────────────────────────────────────────────

#[test]
fn constructor_rejects_period_out_of_bounds() {
    let env = Env::default();
    let a = Address::generate(&env);
    for bad in [MIN_UNBONDING_SECS - 1, MAX_UNBONDING_SECS + 1] {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            env.register(AgentBond, (&a, &a, &a, &a, &a, &bad));
        }));
        assert!(res.is_err(), "period {bad} must be rejected");
    }
}

// ── deposit ──────────────────────────────────────────────────────────────────

#[test]
fn deposit_moves_usdc_and_binds_owner() {
    let h = setup();
    h.bond.deposit(&AGENT, &(100 * USDC));

    let s = h.bond.get_bond(&AGENT).unwrap();
    assert_eq!(s.owner, h.owner);
    assert_eq!(s.bonded, 100 * USDC);
    assert_eq!(s.unbonding, 0);
    assert_eq!(s.first_deposit_at, T0);
    assert_eq!(h.token.balance(&h.bond.address), 100 * USDC);
    assert_eq!(h.token.balance(&h.owner), 900 * USDC);

    h.bond.deposit(&AGENT, &(50 * USDC));
    assert_eq!(h.bond.get_bond(&AGENT).unwrap().bonded, 150 * USDC);
}

#[test]
fn deposit_rejects_non_positive_and_unregistered() {
    let h = setup();
    assert_eq!(h.bond.try_deposit(&AGENT, &0), Err(Ok(Error::AmountNotPositive)));
    assert_eq!(h.bond.try_deposit(&999, &USDC), Err(Ok(Error::AgentNotRegistered)));
}

#[test]
fn first_deposit_requires_registry_wallet_auth() {
    let h = setup();
    let stranger = Address::generate(&h.env);
    auth_only(&h, &stranger, "deposit", (AGENT, USDC).into_val(&h.env));
    assert!(h.bond.try_deposit(&AGENT, &USDC).is_err());
    assert!(h.bond.get_bond(&AGENT).is_none());
}

#[test]
fn owner_is_frozen_after_registry_rebind() {
    let h = setup();
    h.bond.deposit(&AGENT, &(10 * USDC));
    let new_wallet = Address::generate(&h.env);
    h.registry.set_wallet(&AGENT, &new_wallet);

    // The new registry wallet cannot unbond the existing bond.
    auth_only(&h, &new_wallet, "request_unbond", (AGENT, USDC).into_val(&h.env));
    assert!(h.bond.try_request_unbond(&AGENT, &USDC).is_err());
    h.env.mock_all_auths();
    h.bond.request_unbond(&AGENT, &USDC);
    assert_eq!(h.bond.get_bond(&AGENT).unwrap().owner, h.owner);
}

// ── unbond / withdraw ────────────────────────────────────────────────────────

#[test]
fn request_unbond_moves_to_unbonding_with_unlock() {
    let h = setup();
    h.bond.deposit(&AGENT, &(100 * USDC));
    h.bond.request_unbond(&AGENT, &(40 * USDC));
    let s = h.bond.get_bond(&AGENT).unwrap();
    assert_eq!(s.bonded, 60 * USDC);
    assert_eq!(s.unbonding, 40 * USDC);
    assert_eq!(s.unlock_at, T0 + PERIOD);

    assert_eq!(
        h.bond.try_request_unbond(&AGENT, &(61 * USDC)),
        Err(Ok(Error::InsufficientBonded))
    );
    assert_eq!(h.bond.try_request_unbond(&AGENT, &0), Err(Ok(Error::AmountNotPositive)));
    assert_eq!(h.bond.try_request_unbond(&999, &USDC), Err(Ok(Error::NotFound)));
}

#[test]
fn second_unbond_request_resets_bucket_timer() {
    let h = setup();
    h.bond.deposit(&AGENT, &(100 * USDC));
    h.bond.request_unbond(&AGENT, &(10 * USDC));
    set_time(&h.env, T0 + 1000);
    h.bond.request_unbond(&AGENT, &(10 * USDC));
    let s = h.bond.get_bond(&AGENT).unwrap();
    assert_eq!(s.unbonding, 20 * USDC);
    assert_eq!(s.unlock_at, T0 + 1000 + PERIOD);
}

#[test]
fn early_withdraw_rejected_then_succeeds_at_unlock() {
    let h = setup();
    h.bond.deposit(&AGENT, &(100 * USDC));
    assert_eq!(h.bond.try_withdraw(&AGENT), Err(Ok(Error::NothingUnbonding)));

    h.bond.request_unbond(&AGENT, &(40 * USDC));
    set_time(&h.env, T0 + PERIOD - 1);
    assert_eq!(h.bond.try_withdraw(&AGENT), Err(Ok(Error::EarlyWithdraw)));

    set_time(&h.env, T0 + PERIOD);
    assert_eq!(h.bond.withdraw(&AGENT), 40 * USDC);
    let s = h.bond.get_bond(&AGENT).unwrap();
    assert_eq!((s.bonded, s.unbonding, s.unlock_at), (60 * USDC, 0, 0));
    assert_eq!(h.token.balance(&h.owner), 940 * USDC);
}

#[test]
fn only_owner_can_unbond_and_withdraw() {
    let h = setup();
    h.bond.deposit(&AGENT, &(10 * USDC));
    h.bond.request_unbond(&AGENT, &USDC);
    set_time(&h.env, T0 + PERIOD);
    let stranger = Address::generate(&h.env);
    auth_only(&h, &stranger, "withdraw", (AGENT,).into_val(&h.env));
    assert!(h.bond.try_withdraw(&AGENT).is_err());
    auth_only(&h, &stranger, "request_unbond", (AGENT, USDC).into_val(&h.env));
    assert!(h.bond.try_request_unbond(&AGENT, &USDC).is_err());
}

#[test]
fn period_change_does_not_move_existing_unlock() {
    let h = setup();
    h.bond.deposit(&AGENT, &(10 * USDC));
    h.bond.request_unbond(&AGENT, &USDC);
    h.bond.propose_config(&ConfigChange::UnbondingSecs(30 * 24 * 3600));
    set_time(&h.env, T0 + 2 * PERIOD);
    h.bond.apply_config();
    assert_eq!(h.bond.get_bond(&AGENT).unwrap().unlock_at, T0 + PERIOD);
    assert_eq!(h.bond.withdraw(&AGENT), USDC);
}

// ── slash ────────────────────────────────────────────────────────────────────

#[test]
fn slash_during_unbonding_draws_unbonding_first() {
    let h = setup();
    h.bond.deposit(&AGENT, &(100 * USDC));
    h.bond.request_unbond(&AGENT, &(30 * USDC));

    h.bond.slash(&AGENT, &(50 * USDC), &enactment(&h.env, 1));
    let s = h.bond.get_bond(&AGENT).unwrap();
    assert_eq!(s.unbonding, 0);
    assert_eq!(s.bonded, 50 * USDC);
    assert_eq!(s.slashed_total, 50 * USDC);
    assert_eq!(s.unlock_at, 0);
    assert_eq!(h.token.balance(&h.treasury), 50 * USDC);
    assert_eq!(h.token.balance(&h.bond.address), 50 * USDC);
}

#[test]
fn slash_partially_from_unbonding_keeps_unlock() {
    let h = setup();
    h.bond.deposit(&AGENT, &(100 * USDC));
    h.bond.request_unbond(&AGENT, &(30 * USDC));
    h.bond.slash(&AGENT, &(10 * USDC), &enactment(&h.env, 1));
    let s = h.bond.get_bond(&AGENT).unwrap();
    assert_eq!((s.bonded, s.unbonding, s.unlock_at), (70 * USDC, 20 * USDC, T0 + PERIOD));
}

#[test]
fn slash_above_balance_rejected() {
    let h = setup();
    h.bond.deposit(&AGENT, &(100 * USDC));
    h.bond.request_unbond(&AGENT, &(30 * USDC));
    assert_eq!(
        h.bond.try_slash(&AGENT, &(100 * USDC + 1), &enactment(&h.env, 1)),
        Err(Ok(Error::SlashExceedsBalance))
    );
    assert_eq!(h.bond.try_slash(&AGENT, &0, &enactment(&h.env, 1)), Err(Ok(Error::AmountNotPositive)));
    assert_eq!(h.bond.try_slash(&999, &USDC, &enactment(&h.env, 1)), Err(Ok(Error::NotFound)));
    // The full balance is slashable.
    h.bond.slash(&AGENT, &(100 * USDC), &enactment(&h.env, 2));
    let s = h.bond.get_bond(&AGENT).unwrap();
    assert_eq!((s.bonded, s.unbonding, s.slashed_total), (0, 0, 100 * USDC));
}

#[test]
fn only_slasher_can_slash() {
    let h = setup();
    h.bond.deposit(&AGENT, &(10 * USDC));
    for who in [h.admin.clone(), h.owner.clone(), Address::generate(&h.env)] {
        let ev = enactment(&h.env, 1);
        auth_only(&h, &who, "slash", (AGENT, USDC, ev.clone()).into_val(&h.env));
        assert!(h.bond.try_slash(&AGENT, &USDC, &ev).is_err());
    }
    let ev = enactment(&h.env, 1);
    auth_only(&h, &h.slasher, "slash", (AGENT, USDC, ev.clone()).into_val(&h.env));
    h.bond.slash(&AGENT, &USDC, &ev);
    assert_eq!(h.bond.get_bond(&AGENT).unwrap().slashed_total, USDC);
}

#[test]
fn evidence_replay_rejected_for_both_kinds() {
    let h = setup();
    h.bond.deposit(&AGENT, &(10 * USDC));
    let e = enactment(&h.env, 9);
    h.bond.slash(&AGENT, &USDC, &e);
    assert_eq!(h.bond.try_slash(&AGENT, &USDC, &e), Err(Ok(Error::EvidenceReused)));

    let a = Evidence::AssayVerdict(
        BytesN::from_array(&h.env, &[1; 32]),
        BytesN::from_array(&h.env, &[2; 32]),
    );
    h.bond.slash(&AGENT, &USDC, &a);
    assert_eq!(h.bond.try_slash(&AGENT, &USDC, &a), Err(Ok(Error::EvidenceReused)));
    assert!(h.bond.is_evidence_used(&h.bond.evidence_id(&a)));
}

#[test]
fn evidence_ids_are_domain_separated() {
    let h = setup();
    let x = BytesN::from_array(&h.env, &[5; 32]);
    let ent = h.bond.evidence_id(&Evidence::Enactment(x.clone()));
    let assay = h.bond.evidence_id(&Evidence::AssayVerdict(x.clone(), x.clone()));
    let assay_swapped = h.bond.evidence_id(&Evidence::AssayVerdict(
        x.clone(),
        BytesN::from_array(&h.env, &[6; 32]),
    ));
    assert_ne!(ent, assay);
    assert_ne!(assay, assay_swapped);
    assert_ne!(ent, x);
}

// ── admin / config ───────────────────────────────────────────────────────────

#[test]
fn only_admin_can_propose_config() {
    let h = setup();
    let change = ConfigChange::Slasher(Address::generate(&h.env));
    for who in [h.slasher.clone(), h.owner.clone()] {
        auth_only(&h, &who, "propose_config", (change.clone(),).into_val(&h.env));
        assert!(h.bond.try_propose_config(&change).is_err());
    }
}

#[test]
fn new_slasher_waits_two_periods_old_slasher_still_works() {
    let h = setup();
    h.bond.deposit(&AGENT, &(10 * USDC));
    let new_slasher = Address::generate(&h.env);
    h.bond.propose_config(&ConfigChange::Slasher(new_slasher.clone()));
    assert_eq!(h.bond.get_pending_config().unwrap().activates_at, T0 + 2 * PERIOD);

    set_time(&h.env, T0 + 2 * PERIOD - 1);
    assert_eq!(h.bond.try_apply_config(), Err(Ok(Error::ConfigNotYetActive)));

    // New slasher not yet live.
    let ev = enactment(&h.env, 1);
    auth_only(&h, &new_slasher, "slash", (AGENT, USDC, ev.clone()).into_val(&h.env));
    assert!(h.bond.try_slash(&AGENT, &USDC, &ev).is_err());
    // Old slasher still live during the window.
    auth_only(&h, &h.slasher, "slash", (AGENT, USDC, ev.clone()).into_val(&h.env));
    h.bond.slash(&AGENT, &USDC, &ev);

    h.env.mock_all_auths();
    set_time(&h.env, T0 + 2 * PERIOD);
    h.bond.apply_config();
    assert_eq!(h.bond.get_config().slasher, new_slasher);
    assert_eq!(h.bond.try_apply_config(), Err(Ok(Error::NoPendingConfig)));

    let ev2 = enactment(&h.env, 2);
    auth_only(&h, &new_slasher, "slash", (AGENT, USDC, ev2.clone()).into_val(&h.env));
    h.bond.slash(&AGENT, &USDC, &ev2);
}

#[test]
fn agent_noticing_within_one_period_can_exit_before_new_slasher() {
    let h = setup();
    h.bond.deposit(&AGENT, &(10 * USDC));
    h.bond.propose_config(&ConfigChange::Slasher(Address::generate(&h.env)));
    let activates_at = h.bond.get_pending_config().unwrap().activates_at;
    // The agent reacts at the last moment of the first period.
    set_time(&h.env, T0 + PERIOD);
    h.bond.request_unbond(&AGENT, &(10 * USDC));
    let unlock = h.bond.get_bond(&AGENT).unwrap().unlock_at;
    assert!(unlock <= activates_at);
    set_time(&h.env, unlock);
    assert_eq!(h.bond.withdraw(&AGENT), 10 * USDC);
}

#[test]
fn treasury_and_period_changes_are_delayed_and_bounded() {
    let h = setup();
    let t2 = Address::generate(&h.env);
    h.bond.propose_config(&ConfigChange::Treasury(t2.clone()));
    set_time(&h.env, T0 + 2 * PERIOD);
    h.bond.apply_config();
    assert_eq!(h.bond.get_config().treasury, t2);

    assert_eq!(
        h.bond.try_propose_config(&ConfigChange::UnbondingSecs(MIN_UNBONDING_SECS - 1)),
        Err(Ok(Error::InvalidUnbondingPeriod))
    );
    assert_eq!(
        h.bond.try_propose_config(&ConfigChange::UnbondingSecs(MAX_UNBONDING_SECS + 1)),
        Err(Ok(Error::InvalidUnbondingPeriod))
    );
    // A shorter period still waits 2x the CURRENT period.
    h.bond.propose_config(&ConfigChange::UnbondingSecs(MIN_UNBONDING_SECS));
    let now = T0 + 2 * PERIOD;
    assert_eq!(h.bond.get_pending_config().unwrap().activates_at, now + 2 * PERIOD);
}

#[test]
fn lowering_the_period_cannot_shortcut_a_slasher_swap() {
    // Attack: shrink the period first, then swap the slasher on a tiny delay.
    let h = setup();
    h.bond.propose_config(&ConfigChange::UnbondingSecs(MIN_UNBONDING_SECS));
    set_time(&h.env, T0 + 2 * PERIOD);
    h.bond.apply_config();
    assert_eq!(h.bond.get_config().unbonding_secs, MIN_UNBONDING_SECS);

    let now = T0 + 2 * PERIOD;
    h.bond.propose_config(&ConfigChange::Slasher(Address::generate(&h.env)));
    assert_eq!(
        h.bond.get_pending_config().unwrap().activates_at,
        now + MIN_GOVERNANCE_DELAY_SECS
    );
}

#[test]
fn short_period_instance_still_has_governance_floor() {
    let h = setup_with_period(MIN_UNBONDING_SECS);
    h.bond.propose_config(&ConfigChange::Treasury(Address::generate(&h.env)));
    assert_eq!(h.bond.get_pending_config().unwrap().activates_at, T0 + MIN_GOVERNANCE_DELAY_SECS);
}

#[test]
fn admin_handover_is_two_step() {
    let h = setup();
    let new_admin = Address::generate(&h.env);
    assert_eq!(h.bond.try_accept_admin(), Err(Ok(Error::NoPendingAdmin)));
    h.bond.set_admin(&new_admin);
    assert_eq!(h.bond.get_config().admin, h.admin);
    auth_only(&h, &h.admin, "accept_admin", ().into_val(&h.env));
    assert!(h.bond.try_accept_admin().is_err());
    h.env.mock_all_auths();
    h.bond.accept_admin();
    assert_eq!(h.bond.get_config().admin, new_admin);
}

#[test]
fn admin_cannot_move_funds() {
    // There is no entrypoint that pays anyone but the owner (withdraw) or the
    // treasury (slash by the slasher). Admin auth alone moves nothing.
    let h = setup();
    h.bond.deposit(&AGENT, &(10 * USDC));
    let ev = enactment(&h.env, 1);
    auth_only(&h, &h.admin, "slash", (AGENT, USDC, ev.clone()).into_val(&h.env));
    assert!(h.bond.try_slash(&AGENT, &USDC, &ev).is_err());
    assert_eq!(h.token.balance(&h.bond.address), 10 * USDC);
}

// ── arithmetic ───────────────────────────────────────────────────────────────

#[test]
fn deposit_overflow_is_an_error_not_a_panic() {
    let h = setup();
    h.bond.deposit(&AGENT, &USDC);
    // The SAC would reject the transfer anyway; the checked add must fire first.
    assert_eq!(h.bond.try_deposit(&AGENT, &i128::MAX), Err(Ok(Error::ArithmeticOverflow)));
}

// ── events ───────────────────────────────────────────────────────────────────

#[test]
fn every_bond_entrypoint_emits_two_topic_post_state_event() {
    let h = setup();
    let id = h.bond.address.clone();

    h.bond.deposit(&AGENT, &(100 * USDC));
    assert_eq!(
        bond_events(&h),
        std::vec![BondDeposited {
            agent_id: AGENT,
            owner: h.owner.clone(),
            amount: 100 * USDC,
            bonded: 100 * USDC,
            unbonding: 0,
            slashed_total: 0,
        }
        .to_xdr(&h.env, &id)]
    );

    h.bond.request_unbond(&AGENT, &(40 * USDC));
    assert_eq!(
        bond_events(&h),
        std::vec![BondUnbondRequested {
            agent_id: AGENT,
            owner: h.owner.clone(),
            amount: 40 * USDC,
            bonded: 60 * USDC,
            unbonding: 40 * USDC,
            unlock_at: T0 + PERIOD,
        }
        .to_xdr(&h.env, &id)]
    );

    let ev = enactment(&h.env, 3);
    let ev_id = h.bond.evidence_id(&ev);
    h.bond.slash(&AGENT, &(50 * USDC), &ev);
    assert_eq!(
        bond_events(&h),
        std::vec![BondSlashed {
            agent_id: AGENT,
            owner: h.owner.clone(),
            amount: 50 * USDC,
            from_unbonding: 40 * USDC,
            from_bonded: 10 * USDC,
            evidence: ev,
            evidence_id: ev_id,
            treasury: h.treasury.clone(),
            bonded: 50 * USDC,
            unbonding: 0,
            slashed_total: 50 * USDC,
        }
        .to_xdr(&h.env, &id)]
    );

    h.bond.request_unbond(&AGENT, &(5 * USDC));
    set_time(&h.env, T0 + PERIOD);
    h.bond.withdraw(&AGENT);
    assert_eq!(
        bond_events(&h),
        std::vec![BondWithdrawn {
            agent_id: AGENT,
            owner: h.owner.clone(),
            amount: 5 * USDC,
            bonded: 45 * USDC,
            unbonding: 0,
        }
        .to_xdr(&h.env, &id)]
    );

    // Topic shape the indexer relies on: exactly [name, agent_id].
    let e = &bond_events(&h)[0];
    let soroban_sdk::xdr::ContractEventBody::V0(body) = &e.body;
    assert_eq!(body.topics.len(), 2);
}

#[test]
fn config_proposal_emits_one_topic_event() {
    let h = setup();
    let change = ConfigChange::Treasury(Address::generate(&h.env));
    h.bond.propose_config(&change);
    assert_eq!(
        bond_events(&h),
        std::vec![ConfigProposed {
            admin: h.admin.clone(),
            change,
            activates_at: T0 + 2 * PERIOD,
        }
        .to_xdr(&h.env, &h.bond.address)]
    );
}

#[test]
fn short_period_deploy_for_e2e() {
    let h = setup_with_period(MIN_UNBONDING_SECS);
    h.bond.deposit(&AGENT, &USDC);
    h.bond.request_unbond(&AGENT, &USDC);
    set_time(&h.env, T0 + MIN_UNBONDING_SECS);
    assert_eq!(h.bond.withdraw(&AGENT), USDC);
}

// ── review 2026-11-18 (docs/bond/REVIEW.md) ─────────────────────────────────

/// Advance the ledger sequence (and time, 5 s per ledger) without touching anything.
fn advance_ledgers(env: &Env, ledgers: u32) {
    let li = env.ledger().get();
    env.ledger().set(LedgerInfo {
        sequence_number: li.sequence_number + ledgers,
        timestamp: li.timestamp + ledgers as u64 * 5,
        ..li
    });
}

#[test]
fn slash_then_withdraw_pays_only_the_remaining_unbonding() {
    let h = setup();
    h.bond.deposit(&AGENT, &(100 * USDC));
    h.bond.request_unbond(&AGENT, &(40 * USDC));
    h.bond.slash(&AGENT, &(15 * USDC), &enactment(&h.env, 1));
    set_time(&h.env, T0 + PERIOD);
    assert_eq!(h.bond.withdraw(&AGENT), 25 * USDC);
    let s = h.bond.get_bond(&AGENT).unwrap();
    assert_eq!((s.bonded, s.unbonding, s.slashed_total), (60 * USDC, 0, 15 * USDC));
    assert_eq!(h.token.balance(&h.owner), 925 * USDC);
    assert_eq!(h.token.balance(&h.treasury), 15 * USDC);
}

#[test]
fn slash_fully_consuming_unbonding_leaves_nothing_to_withdraw() {
    let h = setup();
    h.bond.deposit(&AGENT, &(100 * USDC));
    h.bond.request_unbond(&AGENT, &(40 * USDC));
    h.bond.slash(&AGENT, &(40 * USDC), &enactment(&h.env, 1));
    set_time(&h.env, T0 + PERIOD);
    assert_eq!(h.bond.try_withdraw(&AGENT), Err(Ok(Error::NothingUnbonding)));
}

#[test]
fn slash_above_bonded_but_within_bonded_plus_unbonding_is_allowed() {
    let h = setup();
    h.bond.deposit(&AGENT, &(100 * USDC));
    h.bond.request_unbond(&AGENT, &(40 * USDC)); // bonded 60, unbonding 40
    h.bond.slash(&AGENT, &(80 * USDC), &enactment(&h.env, 1));
    let s = h.bond.get_bond(&AGENT).unwrap();
    assert_eq!((s.bonded, s.unbonding, s.unlock_at), (20 * USDC, 0, 0));
    assert_eq!(
        h.bond.try_slash(&AGENT, &(20 * USDC + 1), &enactment(&h.env, 2)),
        Err(Ok(Error::SlashExceedsBalance))
    );
}

#[test]
fn unbond_after_partial_slash_uses_the_reduced_bonded_amount() {
    let h = setup();
    h.bond.deposit(&AGENT, &(100 * USDC));
    h.bond.slash(&AGENT, &(30 * USDC), &enactment(&h.env, 1));
    assert_eq!(h.bond.try_request_unbond(&AGENT, &(71 * USDC)), Err(Ok(Error::InsufficientBonded)));
    h.bond.request_unbond(&AGENT, &(70 * USDC));
    let s = h.bond.get_bond(&AGENT).unwrap();
    assert_eq!((s.bonded, s.unbonding), (0, 70 * USDC));
    h.bond.slash(&AGENT, &(10 * USDC), &enactment(&h.env, 2)); // still slashable
    assert_eq!(h.bond.get_bond(&AGENT).unwrap().unbonding, 60 * USDC);
}

#[test]
fn negative_amounts_rejected_everywhere() {
    let h = setup();
    h.bond.deposit(&AGENT, &USDC);
    assert_eq!(h.bond.try_deposit(&AGENT, &-1), Err(Ok(Error::AmountNotPositive)));
    assert_eq!(h.bond.try_request_unbond(&AGENT, &-1), Err(Ok(Error::AmountNotPositive)));
    assert_eq!(h.bond.try_slash(&AGENT, &-1, &enactment(&h.env, 1)), Err(Ok(Error::AmountNotPositive)));
    assert_eq!(h.bond.try_slash(&AGENT, &i128::MIN, &enactment(&h.env, 2)), Err(Ok(Error::AmountNotPositive)));
}

#[test]
fn deposit_near_i128_max_is_checked() {
    let h = setup();
    h.bond.deposit(&AGENT, &USDC);
    assert_eq!(h.bond.try_deposit(&AGENT, &(i128::MAX - USDC + 1)), Err(Ok(Error::ArithmeticOverflow)));
}

#[test]
fn every_state_change_keeps_instance_and_entries_alive() {
    use crate::storage::{DataKey, INSTANCE_BUMP, INSTANCE_THRESHOLD, PERSISTENT_THRESHOLD};
    use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
    let h = setup();
    let id = h.bond.address.clone();
    let decay = |h: &H| advance_ledgers(&h.env, INSTANCE_BUMP - INSTANCE_THRESHOLD + 1);
    let inst = |h: &H| h.env.as_contract(&id, || h.env.storage().instance().get_ttl());
    let ttl = |h: &H, k: DataKey| h.env.as_contract(&id, || h.env.storage().persistent().get_ttl(&k));

    decay(&h);
    h.bond.deposit(&AGENT, &(100 * USDC));
    assert!(inst(&h) >= INSTANCE_THRESHOLD, "deposit: instance");
    assert!(ttl(&h, DataKey::Bond(AGENT)) >= PERSISTENT_THRESHOLD, "deposit: bond");

    decay(&h);
    h.bond.request_unbond(&AGENT, &(40 * USDC));
    assert!(inst(&h) >= INSTANCE_THRESHOLD, "unbond: instance");
    assert!(ttl(&h, DataKey::Bond(AGENT)) >= PERSISTENT_THRESHOLD, "unbond: bond");

    decay(&h);
    let ev = enactment(&h.env, 1);
    let ev_id = h.bond.evidence_id(&ev);
    h.bond.slash(&AGENT, &(5 * USDC), &ev);
    assert!(inst(&h) >= INSTANCE_THRESHOLD, "slash: instance");
    assert!(ttl(&h, DataKey::Bond(AGENT)) >= PERSISTENT_THRESHOLD, "slash: bond");
    assert!(ttl(&h, DataKey::UsedEvidence(ev_id.clone())) >= PERSISTENT_THRESHOLD, "slash: evidence guard");

    decay(&h);
    h.bond.withdraw(&AGENT);
    assert!(inst(&h) >= INSTANCE_THRESHOLD, "withdraw: instance");
    assert!(ttl(&h, DataKey::Bond(AGENT)) >= PERSISTENT_THRESHOLD, "withdraw: bond");

    decay(&h);
    h.bond.propose_config(&ConfigChange::Treasury(Address::generate(&h.env)));
    assert!(inst(&h) >= INSTANCE_THRESHOLD, "propose_config");

    let s = h.bond.get_bond(&AGENT).unwrap();
    assert_eq!((s.bonded, s.unbonding, s.slashed_total), (60 * USDC, 0, 5 * USDC));
    assert_eq!(h.bond.get_config().slasher, h.slasher);
    assert!(h.bond.is_evidence_used(&ev_id));
}

#[test]
fn reads_alone_do_not_keep_the_instance_alive() {
    use soroban_sdk::testutils::storage::Instance as _;
    let h = setup();
    h.bond.deposit(&AGENT, &USDC);
    let id = h.bond.address.clone();
    let before = h.env.as_contract(&id, || h.env.storage().instance().get_ttl());
    advance_ledgers(&h.env, 10);
    let _ = h.bond.get_config();
    let after = h.env.as_contract(&id, || h.env.storage().instance().get_ttl());
    assert_eq!(after, before - 10);
}
