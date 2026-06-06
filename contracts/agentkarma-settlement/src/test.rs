//! DoD invariant tests — soroban-sdk unit tests, run NATIVELY (no wasm).
//!
//! Each test spins up an `Env`, registers a MOCK stellar-8004 Identity Registry
//! (exposing `agent_wallet(agent_id) -> Option<Address>`), registers the
//! settlement contract, and drives the four Definition-of-Done invariants:
//!   1. no-replay
//!   2. payee binding
//!   3. amount-weight + recency decay (no panic on large values)
//!   4. validator allowlist (no admin path forges a payment-backed score)

extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger, LedgerInfo},
    Address, BytesN, Env, Map, Vec,
};

use crate::contract::{SettlementContract, SettlementContractClient};
use crate::errors::ContractError;
use crate::storage::{DECAY_HALF_LIFE, DEFAULT_RECENCY_WINDOW};
use crate::types::{FacilitatorRef, KarmaTag, SettlementProof, SettlementSource};

// ── mock stellar-8004 Identity Registry ─────────────────────────────────────

#[contract]
pub struct MockIdentityRegistry;

#[contractimpl]
impl MockIdentityRegistry {
    /// Seed an `agent_id -> agentWallet` binding.
    pub fn set_wallet(env: Env, agent_id: u32, wallet: Address) {
        let mut m: Map<u32, Address> = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("WALLETS"))
            .unwrap_or_else(|| Map::new(&env));
        m.set(agent_id, wallet);
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("WALLETS"), &m);
    }

    /// The exact function the settlement contract cross-calls.
    pub fn agent_wallet(env: Env, agent_id: u32) -> Option<Address> {
        let m: Map<u32, Address> = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("WALLETS"))
            .unwrap_or_else(|| Map::new(&env));
        m.get(agent_id)
    }
}

// ── harness ──────────────────────────────────────────────────────────────────

struct Harness<'a> {
    env: Env,
    client: SettlementContractClient<'a>,
    registry_id: Address,
    registry: MockIdentityRegistryClient<'a>,
    validator: Address,
    facilitator: Address,
    admin: Address,
}

/// `max_entry_ttl` for the test ledger, in ledgers. MUST be `>=` the contract's
/// pinned `MAX_PERSISTENT_TTL` (3_110_400) so the durable replay-store bump
/// (`extend_ttl(.., MAX_PERSISTENT_TTL)`) is VALID — the host rejects any
/// `extend_to > max_entry_ttl`. Set well above it (10M) so the GAP-1 durability
/// tests can advance the ledger far past DEFAULT_RECENCY_WINDOW without the
/// consumed id becoming un-extendable / lapsing out of the guard.
const TEST_MAX_ENTRY_TTL: u32 = 10_000_000;

fn set_ledger(env: &Env, sequence: u32) {
    env.ledger().set(LedgerInfo {
        timestamp: 1_700_000_000 + (sequence as u64),
        // soroban-sdk 26 host accepts exactly protocol 26 (MIN = MAX = 26).
        protocol_version: 26,
        sequence_number: sequence,
        network_id: [0; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 16,
        max_entry_ttl: TEST_MAX_ENTRY_TTL,
    });
}

fn setup<'a>() -> Harness<'a> {
    let env = Env::default();
    env.mock_all_auths();
    set_ledger(&env, 1_000_000);

    let registry_id = env.register(MockIdentityRegistry, ());
    let registry = MockIdentityRegistryClient::new(&env, &registry_id);

    let admin = Address::generate(&env);
    let validator = Address::generate(&env);
    let facilitator = Address::generate(&env);

    let contract_id = env.register(SettlementContract, ());
    let client = SettlementContractClient::new(&env, &contract_id);

    let mut validators: Vec<Address> = Vec::new(&env);
    validators.push_back(validator.clone());
    let mut facilitators: Vec<Address> = Vec::new(&env);
    facilitators.push_back(facilitator.clone());

    client.initialize(&admin, &registry_id, &validators, &facilitators);

    Harness {
        env,
        client,
        registry_id,
        registry,
        validator,
        facilitator,
        admin,
    }
}

fn tx_hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn sig(env: &Env) -> BytesN<64> {
    BytesN::from_array(env, &[7u8; 64])
}

/// Build an x402-direct proof.
fn proof(
    h: &Harness,
    payer: &Address,
    payee: &Address,
    amount: i128,
    ledger_seq: u32,
    hash_seed: u8,
) -> SettlementProof {
    SettlementProof {
        tx_hash: tx_hash(&h.env, hash_seed),
        payer: payer.clone(),
        payee: payee.clone(),
        amount,
        ledger_seq,
        source: SettlementSource::X402Direct(FacilitatorRef {
            facilitator: h.facilitator.clone(),
            ledger_proof_height: ledger_seq,
        }),
        proof_signature: sig(&h.env),
    }
}

// ── DoD #1 — no-replay ───────────────────────────────────────────────────────

#[test]
fn dod1_no_replay_same_tuple_rejected_score_unchanged() {
    let h = setup();
    let agent_id = 42u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    let p = proof(&h, &payer, &payee, 50_000_000, 1_000_000, 1);

    // First submission succeeds and moves the score.
    h.client
        .submit_attestation(&h.validator, &agent_id, &p, &KarmaTag::Provider, &90);
    let after_first = h.client.get_weighted_score(&agent_id).unwrap();
    assert_eq!(after_first.count, 1);

    // Identical (payer, payee, amount, tx_hash) → SettlementAlreadyConsumed.
    let res = h.client.try_submit_attestation(
        &h.validator,
        &agent_id,
        &p,
        &KarmaTag::Provider,
        &90,
    );
    assert_eq!(res, Err(Ok(ContractError::SettlementAlreadyConsumed)));

    // Score is unchanged after the rejected replay.
    let after_replay = h.client.get_weighted_score(&agent_id).unwrap();
    assert_eq!(after_replay, after_first);
    assert_eq!(after_replay.count, 1);

    // settlement_id is on record with a status.
    let sid = h.client.compute_settlement_id(&p);
    assert!(h.client.get_settlement_status(&sid).is_some());
}

#[test]
fn dod1_different_tx_hash_is_not_a_replay() {
    let h = setup();
    let agent_id = 7u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    let p1 = proof(&h, &payer, &payee, 10_000_000, 1_000_000, 1);
    let p2 = proof(&h, &payer, &payee, 10_000_000, 1_000_000, 2); // distinct tx_hash

    h.client
        .submit_attestation(&h.validator, &agent_id, &p1, &KarmaTag::Provider, &80);
    h.client
        .submit_attestation(&h.validator, &agent_id, &p2, &KarmaTag::Provider, &80);

    let score = h.client.get_weighted_score(&agent_id).unwrap();
    assert_eq!(score.count, 2);
}

// ── DoD #2 — payee binding ───────────────────────────────────────────────────

#[test]
fn dod2_payee_mismatch_rejected() {
    let h = setup();
    let agent_id = 11u32;
    let payer = Address::generate(&h.env);
    let real_wallet = Address::generate(&h.env);
    let wrong_wallet = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &real_wallet);

    // Settlement paid `wrong_wallet`, not the agent's registered agentWallet.
    let p = proof(&h, &payer, &wrong_wallet, 50_000_000, 1_000_000, 1);
    let res = h.client.try_submit_attestation(
        &h.validator,
        &agent_id,
        &p,
        &KarmaTag::Provider,
        &90,
    );
    assert_eq!(res, Err(Ok(ContractError::PayeeWalletMismatch)));
    assert!(h.client.get_weighted_score(&agent_id).is_none());
}

#[test]
fn dod2_unregistered_agent_rejected() {
    let h = setup();
    let agent_id = 999u32; // never bound in the registry
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);

    let p = proof(&h, &payer, &payee, 50_000_000, 1_000_000, 1);
    let res = h.client.try_submit_attestation(
        &h.validator,
        &agent_id,
        &p,
        &KarmaTag::Provider,
        &90,
    );
    // No agentWallet binding → cannot satisfy the gate → PayeeWalletMismatch.
    assert_eq!(res, Err(Ok(ContractError::PayeeWalletMismatch)));
}

// ── DoD #3 — amount-weight + recency ─────────────────────────────────────────

#[test]
fn dod3_large_amount_outweighs_dust() {
    // Two agents: big-spend-good vs dust-good with the SAME outcome. Equal
    // outcomes give equal scores (volume-weighted mean), so to show weight we
    // compare a mixed history: a big GOOD settlement dominates a dust BAD one.
    let h = setup();
    let payer = Address::generate(&h.env);

    let agent_id = 1u32;
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    // Big $50 GOOD (outcome 100) at the current ledger.
    let big = proof(&h, &payer, &payee, 50_000_000, 1_000_000, 1);
    h.client
        .submit_attestation(&h.validator, &agent_id, &big, &KarmaTag::Provider, &100);

    // Dust $0.001 BAD (outcome 0).
    let dust = proof(&h, &payer, &payee, 10_000, 1_000_000, 2);
    h.client
        .submit_attestation(&h.validator, &agent_id, &dust, &KarmaTag::Provider, &0);

    let score = h.client.get_weighted_score(&agent_id).unwrap();
    // Volume-weighted: the $50 GOOD dominates; score stays near 100, the dust
    // BAD barely dents it. A naive count-mean would give ~50.
    assert!(
        score.score >= 99,
        "expected big-good to dominate dust-bad, got {}",
        score.score
    );
    assert_eq!(score.count, 2);
    assert!(score.volume_sum > 49_000_000);
}

#[test]
fn dod3_recency_decays_old_settlements_out() {
    let h = setup();
    let agent_id = 5u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    // An OLD good settlement, witnessed long before the window.
    set_ledger(&h.env, 1_000_000);
    let old = proof(&h, &payer, &payee, 50_000_000, 1_000_000, 1);
    h.client
        .submit_attestation(&h.validator, &agent_id, &old, &KarmaTag::Provider, &100);
    let early = h.client.get_weighted_score(&agent_id).unwrap();

    // Advance the ledger ~20 half-lives (settlement well past the recency window)
    // and add a fresh BAD settlement. The aged-out good volume should have decayed
    // toward zero, so the fresh outcome dominates the headline score.
    let far_future = 1_000_000 + DECAY_HALF_LIFE * 20;
    set_ledger(&h.env, far_future);
    let fresh = proof(&h, &payer, &payee, 50_000_000, far_future, 2);
    h.client
        .submit_attestation(&h.validator, &agent_id, &fresh, &KarmaTag::Provider, &10);

    let now = h.client.get_weighted_score(&agent_id).unwrap();
    // The old 100-outcome volume decayed away; the fresh 10-outcome dominates.
    assert!(
        now.score <= 15,
        "old good should have decayed out, score={}",
        now.score
    );
    assert!(early.score >= 99);
}

#[test]
fn dod3_no_panic_on_max_values() {
    let h = setup();
    let agent_id = 3u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    // i128::MAX amount must NOT panic — it is weighted with checked arithmetic.
    let huge = proof(&h, &payer, &payee, i128::MAX, 1_000_000, 1);
    h.client
        .submit_attestation(&h.validator, &agent_id, &huge, &KarmaTag::Provider, &100);
    let score = h.client.get_weighted_score(&agent_id).unwrap();
    assert_eq!(score.score, 100);
    assert!(score.volume_sum > 0);

    // A second huge settlement keeps the running sum from overflowing into a
    // panic (it would saturate or error, never abort the host).
    let huge2 = proof(&h, &payer, &payee, i128::MAX, 1_000_000, 2);
    let res = h.client.try_submit_attestation(
        &h.validator,
        &agent_id,
        &huge2,
        &KarmaTag::Provider,
        &100,
    );
    // Either it folds in (no overflow) or returns ArithmeticOverflow — never panics.
    match res {
        Ok(Ok(())) => {
            let s = h.client.get_weighted_score(&agent_id).unwrap();
            assert_eq!(s.score, 100);
        }
        Err(Ok(ContractError::ArithmeticOverflow)) => { /* gracefully surfaced */ }
        other => panic!("unexpected result on max-value fold: {:?}", other),
    }
}

#[test]
fn dod3_negative_amount_contributes_no_weight() {
    let h = setup();
    let agent_id = 8u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    // A malformed negative amount is clamped to zero weight; falls back to the
    // raw outcome rather than panicking or going negative.
    let neg = proof(&h, &payer, &payee, -1, 1_000_000, 1);
    h.client
        .submit_attestation(&h.validator, &agent_id, &neg, &KarmaTag::Provider, &70);
    let score = h.client.get_weighted_score(&agent_id).unwrap();
    assert_eq!(score.score, 70);
    assert_eq!(score.volume_sum, 0);
}

// ── DoD #4 — validator allowlist + no admin forge ────────────────────────────

#[test]
fn dod4_non_validator_caller_rejected() {
    let h = setup();
    let agent_id = 21u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    let stranger = Address::generate(&h.env); // not in VALIDATORS
    let p = proof(&h, &payer, &payee, 50_000_000, 1_000_000, 1);

    let res = h.client.try_submit_attestation(
        &stranger,
        &agent_id,
        &p,
        &KarmaTag::Provider,
        &90,
    );
    assert_eq!(res, Err(Ok(ContractError::UnauthorizedCaller)));
    assert!(h.client.get_weighted_score(&agent_id).is_none());
}

#[test]
fn dod4_admin_cannot_forge_a_payment_backed_score() {
    // There is NO admin entrypoint that writes a WeightedScore. Admin can only
    // tune operational params (recency window, allowlists). Prove that: the admin
    // changes params, yet no score appears for an agent that received no
    // settlement; and an admin who is not a validator cannot submit.
    let h = setup();
    let agent_id = 33u32;
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    // Admin tunes params — allowed.
    h.client.set_recency_window(&500_000);
    let mut new_vals: Vec<Address> = Vec::new(&h.env);
    new_vals.push_back(Address::generate(&h.env));
    h.client.set_validators(&new_vals);
    assert_eq!(h.client.get_recency_window(), 500_000);

    // No score was forged for the agent.
    assert!(h.client.get_weighted_score(&agent_id).is_none());

    // The admin (not on the new validator list) cannot submit a backed score.
    let payer = Address::generate(&h.env);
    let p = proof(&h, &payer, &payee, 50_000_000, 1_000_000, 1);
    let res = h.client.try_submit_attestation(
        &h.admin,
        &agent_id,
        &p,
        &KarmaTag::Provider,
        &100,
    );
    assert_eq!(res, Err(Ok(ContractError::UnauthorizedCaller)));
    assert!(h.client.get_weighted_score(&agent_id).is_none());
}

// ── supporting gate checks ───────────────────────────────────────────────────

#[test]
fn outcome_out_of_range_rejected() {
    let h = setup();
    let agent_id = 50u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    let p = proof(&h, &payer, &payee, 50_000_000, 1_000_000, 1);
    let res = h.client.try_submit_attestation(
        &h.validator,
        &agent_id,
        &p,
        &KarmaTag::Provider,
        &101,
    );
    assert_eq!(res, Err(Ok(ContractError::OutcomeOutOfRange)));
}

#[test]
fn unknown_facilitator_rejected() {
    let h = setup();
    let agent_id = 51u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    let rogue = Address::generate(&h.env);
    let p = SettlementProof {
        tx_hash: tx_hash(&h.env, 1),
        payer,
        payee,
        amount: 50_000_000,
        ledger_seq: 1_000_000,
        source: SettlementSource::X402Direct(FacilitatorRef {
            facilitator: rogue, // not in FACILITATORS
            ledger_proof_height: 1_000_000,
        }),
        proof_signature: sig(&h.env),
    };
    let res = h.client.try_submit_attestation(
        &h.validator,
        &agent_id,
        &p,
        &KarmaTag::Provider,
        &90,
    );
    assert_eq!(res, Err(Ok(ContractError::FacilitatorUnknown)));
}

#[test]
fn mpp_sources_rejected_in_v1() {
    let h = setup();
    let agent_id = 52u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    let p = SettlementProof {
        tx_hash: tx_hash(&h.env, 1),
        payer,
        payee,
        amount: 50_000_000,
        ledger_seq: 1_000_000,
        source: SettlementSource::MppCharge,
        proof_signature: sig(&h.env),
    };
    let res = h.client.try_submit_attestation(
        &h.validator,
        &agent_id,
        &p,
        &KarmaTag::Provider,
        &90,
    );
    assert_eq!(res, Err(Ok(ContractError::FacilitatorUnknown)));
}

#[test]
fn two_faced_karma_provider_and_consumer_are_separate() {
    let h = setup();
    let agent_id = 60u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    let p_prov = proof(&h, &payer, &payee, 50_000_000, 1_000_000, 1);
    let p_cons = proof(&h, &payer, &payee, 50_000_000, 1_000_000, 2);

    h.client
        .submit_attestation(&h.validator, &agent_id, &p_prov, &KarmaTag::Provider, &95);
    h.client
        .submit_attestation(&h.validator, &agent_id, &p_cons, &KarmaTag::Consumer, &40);

    let prov = h
        .client
        .get_weighted_score_by_tag(&agent_id, &KarmaTag::Provider)
        .unwrap();
    let cons = h
        .client
        .get_weighted_score_by_tag(&agent_id, &KarmaTag::Consumer)
        .unwrap();
    assert_eq!(prov.score, 95);
    assert_eq!(cons.score, 40);
    // get_weighted_score defaults to the provider facet.
    assert_eq!(h.client.get_weighted_score(&agent_id).unwrap().score, 95);
}

#[test]
fn double_initialize_rejected() {
    let h = setup();
    let other = Address::generate(&h.env);
    let empty: Vec<Address> = Vec::new(&h.env);
    let res = h
        .client
        .try_initialize(&other, &h.registry_id, &empty, &empty);
    assert_eq!(res, Err(Ok(ContractError::AlreadyInitialized)));
}

#[test]
fn batched_reads_align_with_input() {
    let h = setup();
    let payer = Address::generate(&h.env);

    let a1 = 70u32;
    let w1 = Address::generate(&h.env);
    h.registry.set_wallet(&a1, &w1);
    let p1 = proof(&h, &payer, &w1, 50_000_000, 1_000_000, 1);
    h.client
        .submit_attestation(&h.validator, &a1, &p1, &KarmaTag::Provider, &88);

    let a2 = 71u32; // no attestation

    let mut ids: Vec<u32> = Vec::new(&h.env);
    ids.push_back(a1);
    ids.push_back(a2);
    let scores = h.client.get_weighted_scores(&ids);
    assert_eq!(scores.len(), 2);
    assert!(scores.get(0).unwrap().is_some());
    assert!(scores.get(1).unwrap().is_none());
}

// ── GAP 1 — replay protection is DURABLE, not window-bounded ──────────────────
//
// The replay backstop MUST be permanent: a consumed settlement_id is rejected
// FOREVER, independent of the recency window or the (validator-supplied,
// un-verifiable) `ledger_seq`. Recency decay is a SCORING weight only — never the
// replay guard. These two cases would both pass pre-fix (when the replay store
// was TEMPORARY with TTL = recency window) by re-crediting an aged-out id.

#[test]
fn gap1_replay_rejected_after_recency_window_lapses() {
    // (a) advance the ledger PAST DEFAULT_RECENCY_WINDOW, then re-submit the SAME
    // (payer, payee, amount, tx_hash). Must still be SettlementAlreadyConsumed and
    // the score must be unchanged — the id must NOT have auto-purged.
    let h = setup();
    let agent_id = 80u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    set_ledger(&h.env, 1_000_000);
    let p = proof(&h, &payer, &payee, 50_000_000, 1_000_000, 1);
    h.client
        .submit_attestation(&h.validator, &agent_id, &p, &KarmaTag::Provider, &90);
    let after_first = h.client.get_weighted_score(&agent_id).unwrap();
    assert_eq!(after_first.count, 1);

    // Jump well PAST the full recency window (a temporary-TTL id would have purged).
    let far_future = 1_000_000 + DEFAULT_RECENCY_WINDOW + DECAY_HALF_LIFE * 4;
    set_ledger(&h.env, far_future);

    // Re-submit the identical tuple. Durable no-replay → still rejected.
    let res = h.client.try_submit_attestation(
        &h.validator,
        &agent_id,
        &p,
        &KarmaTag::Provider,
        &90,
    );
    assert_eq!(res, Err(Ok(ContractError::SettlementAlreadyConsumed)));

    // No re-credit: count and score unchanged.
    let after_replay = h.client.get_weighted_score(&agent_id).unwrap();
    assert_eq!(after_replay.count, after_first.count);
    assert_eq!(after_replay.count, 1);

    // The id is still on record after the window lapsed.
    let sid = h.client.compute_settlement_id(&p);
    assert!(h.client.get_settlement_status(&sid).is_some());
}

#[test]
fn gap1_undecay_attack_rejected_with_fresh_ledger_seq() {
    // (b) the un-decay attack: re-submit an already-consumed settlement after the
    // window, but forge `proof.ledger_seq = now` so the decay math would assign it
    // FULL un-decayed weight. The DURABLE replay guard must reject BEFORE any
    // weight is computed → SettlementAlreadyConsumed, no re-credit.
    let h = setup();
    let agent_id = 81u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    set_ledger(&h.env, 1_000_000);
    let p = proof(&h, &payer, &payee, 50_000_000, 1_000_000, 1);
    h.client
        .submit_attestation(&h.validator, &agent_id, &p, &KarmaTag::Provider, &90);
    let after_first = h.client.get_weighted_score(&agent_id).unwrap();

    // Far future, past the window.
    let now = 1_000_000 + DEFAULT_RECENCY_WINDOW + DECAY_HALF_LIFE * 4;
    set_ledger(&h.env, now);

    // SAME (payer, payee, amount, tx_hash) ⇒ SAME settlement_id (ledger_seq is NOT
    // part of the id), but ledger_seq forged to `now` to dodge decay. Still rejected.
    let attack = proof(&h, &payer, &payee, 50_000_000, now, 1);
    assert_eq!(
        h.client.compute_settlement_id(&attack),
        h.client.compute_settlement_id(&p),
        "ledger_seq must not change the settlement_id"
    );
    let res = h.client.try_submit_attestation(
        &h.validator,
        &agent_id,
        &attack,
        &KarmaTag::Provider,
        &90,
    );
    assert_eq!(res, Err(Ok(ContractError::SettlementAlreadyConsumed)));

    // No re-credit despite the fresh ledger_seq.
    let after_attack = h.client.get_weighted_score(&agent_id).unwrap();
    assert_eq!(after_attack.count, after_first.count);
    assert_eq!(after_attack.count, 1);
}

// ── GAP 2 — volume_sum saturates rather than bricking attestation ─────────────
//
// A long-lived high-volume agent must STAY attestable. Pre-fix, `volume_sum` used
// checked_add and reverted with ArithmeticOverflow once near u128::MAX — a soft
// denial-of-attestation. volume_sum is a display/weight aggregate; saturating at
// astronomical USDC is acceptable and keeps the agent attestable.

#[test]
fn gap2_near_max_volume_still_attestable_saturates() {
    let h = setup();
    let agent_id = 82u32;
    let payer = Address::generate(&h.env);
    let payee = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &payee);

    // Drive volume_sum to the top of its range with a sequence of i128::MAX folds.
    // (Each fold is recency-clamped to MAX_WEIGHT, ~u128::MAX/101, so two folds
    // already sit near the ceiling.) Pre-fix the SECOND fold reverts with
    // ArithmeticOverflow on the volume_sum checked_add; post-fix it saturates and
    // the agent remains attestable.
    let p1 = proof(&h, &payer, &payee, i128::MAX, 1_000_000, 1);
    h.client
        .submit_attestation(&h.validator, &agent_id, &p1, &KarmaTag::Provider, &100);
    let p2 = proof(&h, &payer, &payee, i128::MAX, 1_000_000, 2);
    h.client
        .submit_attestation(&h.validator, &agent_id, &p2, &KarmaTag::Provider, &100);

    // A THIRD fold must NOT revert — volume_sum saturates instead of erroring.
    let p3 = proof(&h, &payer, &payee, i128::MAX, 1_000_000, 3);
    let res = h.client.try_submit_attestation(
        &h.validator,
        &agent_id,
        &p3,
        &KarmaTag::Provider,
        &100,
    );
    assert_eq!(
        res,
        Ok(Ok(())),
        "near-max volume agent must stay attestable (saturating), got {:?}",
        res
    );

    let score = h.client.get_weighted_score(&agent_id).unwrap();
    assert_eq!(score.count, 3);
    // All folds are outcome 100, so the blended score is pinned at 100 even as
    // volume saturates.
    assert_eq!(score.score, 100);
    // volume_sum saturated rather than overflowing.
    assert!(score.volume_sum > 0);

    // And a fourth, for good measure — saturation is stable, never panics/reverts.
    let p4 = proof(&h, &payer, &payee, i128::MAX, 1_000_000, 4);
    let res4 = h.client.try_submit_attestation(
        &h.validator,
        &agent_id,
        &p4,
        &KarmaTag::Provider,
        &100,
    );
    assert_eq!(res4, Ok(Ok(())));
}

// ── GAP 3 — payee binding is the real backstop, not the validator list ────────
//
// dod4_admin_cannot_forge only proves a NON-validator admin can't submit. The
// sharper attack: an admin escalates itself onto the validator list, then submits
// a fabricated proof for an arbitrary payee. The `payee == agentWallet(agent_id)`
// binding (against the pinned registry, which has no such binding) is what still
// stops it — proving the binding, not the allowlist, is the backstop.

#[test]
fn gap3_self_escalated_admin_still_blocked_by_payee_binding() {
    let h = setup();
    let agent_id = 83u32;

    // The agent IS registered, bound to its real wallet.
    let real_wallet = Address::generate(&h.env);
    h.registry.set_wallet(&agent_id, &real_wallet);

    // Admin escalates: adds ITSELF to the validator allowlist.
    let mut vals: Vec<Address> = Vec::new(&h.env);
    vals.push_back(h.admin.clone());
    h.client.set_validators(&vals);
    assert!(h.client.get_validators().iter().any(|v| v == h.admin));

    // Now a validator (the admin), the admin fabricates a proof paying an ARBITRARY
    // attacker-controlled payee that is NOT the agent's registered wallet.
    let attacker_payee = Address::generate(&h.env);
    let payer = Address::generate(&h.env);
    let forged = proof(&h, &payer, &attacker_payee, 50_000_000, 1_000_000, 9);

    let res = h.client.try_submit_attestation(
        &h.admin,
        &agent_id,
        &forged,
        &KarmaTag::Provider,
        &100,
    );
    // Validator gate now PASSES (admin escalated). The payee binding is the wall.
    assert_eq!(res, Err(Ok(ContractError::PayeeWalletMismatch)));
    assert!(h.client.get_weighted_score(&agent_id).is_none());

    // Even targeting an agent_id with NO registry binding at all → same wall.
    let unbound_agent = 8383u32;
    let forged2 = proof(&h, &payer, &attacker_payee, 50_000_000, 1_000_000, 10);
    let res2 = h.client.try_submit_attestation(
        &h.admin,
        &unbound_agent,
        &forged2,
        &KarmaTag::Provider,
        &100,
    );
    assert_eq!(res2, Err(Ok(ContractError::PayeeWalletMismatch)));
    assert!(h.client.get_weighted_score(&unbound_agent).is_none());
}
