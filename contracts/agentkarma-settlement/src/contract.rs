//! AgentKarma settlement-gated score contract.
//!
//! Trust model: `trust-ak-oracle`. The AK indexer witnesses a completed USDC
//! SAC `transfer` on the public Stellar ledger and submits a `SettlementProof`.
//! Authenticity is established OFF-chain (anyone can re-derive `tx_hash` from the
//! ledger — the contract cannot read past events). The contract enforces the
//! four gate MUSTs over the submitted data + its own storage:
//!
//!   1. payment-proof  — every attestation references a settlement (tx_hash).
//!   2. amount-weight  — weight scales with verified USDC, recency-decayed.
//!   3. no-replay      — one settlement backs ≤ 1 attestation (settlement_id).
//!   4. no-admin-forge — admin tunes params only; cannot mint a backed score.
//!
//! Non-routing holds: the contract is a witness/gate, never custodies funds.

use soroban_sdk::{
    contract, contractimpl, xdr::ToXdr, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

use crate::errors::ContractError;
use crate::events;
use crate::storage;
use crate::types::{KarmaTag, SettlementProof, SettlementSource, WeightedScore};

/// Maximum representable score.
const SCORE_MAX: u32 = 100;

/// Per-settlement weight ceiling. A single settlement's recency-decayed weight is
/// clamped here so the weighted-mean numerator `weight * SCORE_MAX` can never
/// overflow u128 (`MAX_WEIGHT * 100 < u128::MAX`). Real USDC settlements (7
/// decimals) are ~1e7–1e12 base units — astronomically below this ceiling — so
/// clamping only ever fires on adversarial/i128::MAX inputs, which then fold in
/// gracefully instead of panicking. Accumulation across many settlements can
/// still exceed u128 and is surfaced as `ArithmeticOverflow` (never a panic).
const MAX_WEIGHT: u128 = u128::MAX / (SCORE_MAX as u128 + 1);

#[contract]
pub struct SettlementContract;

#[contractimpl]
impl SettlementContract {
    /// One-time setup. `admin` tunes operational params; `identity_registry` is
    /// the pinned stellar-8004 Identity Registry the payee-binding check
    /// cross-calls; `validators` and `facilitators` seed the allowlists.
    pub fn initialize(
        env: Env,
        admin: Address,
        identity_registry: Address,
        validators: Vec<Address>,
        facilitators: Vec<Address>,
    ) -> Result<(), ContractError> {
        if storage::is_initialized(&env) {
            return Err(ContractError::AlreadyInitialized);
        }
        storage::set_admin(&env, &admin);
        storage::set_identity_registry(&env, &identity_registry);
        storage::set_validators(&env, &validators);
        storage::set_facilitators(&env, &facilitators);
        storage::set_recency_window(&env, storage::DEFAULT_RECENCY_WINDOW);
        storage::bump_instance(&env);
        Ok(())
    }

    /// Submit an indexer-witnessed settlement proof, folding it into the agent's
    /// weighted score. The gate, in order:
    ///   - caller authed AND in VALIDATORS  → else `UnauthorizedCaller`
    ///   - `outcome ∈ [0,100]`              → else `OutcomeOutOfRange`
    ///   - source facilitator curated       → else `FacilitatorUnknown`
    ///   - `payee == agentWallet(agent_id)` → else `PayeeWalletMismatch`
    ///   - `settlement_id` unseen           → else `SettlementAlreadyConsumed`
    ///   - checked weight/decay arithmetic  → else `ArithmeticOverflow`
    pub fn submit_attestation(
        env: Env,
        caller: Address,
        agent_id: u32,
        proof: SettlementProof,
        tag: KarmaTag,
        outcome: u32,
    ) -> Result<(), ContractError> {
        // (auth) the validator must sign this invocation...
        caller.require_auth();
        // ...and be on the allowlist. Auth alone is not enough.
        if !storage::is_validator(&env, &caller) {
            return Err(ContractError::UnauthorizedCaller);
        }

        // (range) outcome is the off-chain-scored quality this settlement backs.
        if outcome > SCORE_MAX {
            return Err(ContractError::OutcomeOutOfRange);
        }

        // (facilitator) x402-direct settlements must name a curated facilitator.
        // MPP variants are peer-to-peer (no facilitator gate) but are not wired
        // for v1; reject them explicitly so an unimplemented source can't slip
        // through with zero checks.
        match &proof.source {
            SettlementSource::X402Direct(fref) => {
                if !storage::is_facilitator(&env, &fref.facilitator) {
                    return Err(ContractError::FacilitatorUnknown);
                }
            }
            SettlementSource::MppCharge | SettlementSource::MppChannelClose => {
                // Not yet a v1 source. Treated as unknown provenance.
                return Err(ContractError::FacilitatorUnknown);
            }
        }

        // (payee binding) cross-call the pinned Identity Registry: the wallet the
        // settlement PAID must be the agent's registered agentWallet. This is the
        // weakest link (trusts the registry) — id + WASM hash pinned off-chain.
        let agent_wallet = Self::resolve_agent_wallet(&env, agent_id)?;
        if agent_wallet != proof.payee {
            return Err(ContractError::PayeeWalletMismatch);
        }

        // (no-replay) one settlement backs at most one attestation — FOREVER.
        // This guard is DURABLE (persistent storage, never windowed): a consumed
        // settlement_id is rejected permanently, independent of age or the
        // validator-supplied `ledger_seq`. Recency decay below is a SCORING weight
        // only; it is NOT the replay backstop. (Were the guard windowed, an
        // attacker could re-submit a purged id with `ledger_seq = now` and re-earn
        // full un-decayed weight — the "un-decay attack".)
        let settlement_id = settlement_id(&env, &proof);
        if storage::is_settled(&env, &settlement_id) {
            return Err(ContractError::SettlementAlreadyConsumed);
        }

        // (weight) fold this settlement into the running facet score with
        // recency decay. All arithmetic is checked — overflow never panics.
        let now = env.ledger().sequence();
        let updated = fold_settlement(&env, agent_id, tag, &proof, outcome, now)?;

        // Persist the score, then record the consumed id DURABLY (no TTL window —
        // see `mark_settled`). `expires_at` is retained only as the legacy
        // recency-window hint surfaced by `get_settlement_status`; it does not
        // bound the replay guard, which is the id's mere presence in storage.
        storage::set_score(&env, agent_id, tag, &updated);
        let window = storage::get_recency_window(&env);
        let expires_at = now.saturating_add(window);
        storage::mark_settled(&env, &settlement_id, now, expires_at);
        storage::bump_instance(&env);

        events::settlement_attested(
            &env,
            agent_id,
            tag,
            &settlement_id,
            proof.amount,
            updated.score,
        );
        Ok(())
    }

    // ── auth-less reads ─────────────────────────────────────────────────────

    /// Provider-facet weighted score (the headline facet). Returns `None` if the
    /// agent has no settlement-backed provider score yet.
    pub fn get_weighted_score(env: Env, agent_id: u32) -> Option<WeightedScore> {
        storage::get_score(&env, agent_id, KarmaTag::Provider)
    }

    /// Both facets for one agent: `(provider, consumer)`.
    pub fn get_weighted_score_by_tag(
        env: Env,
        agent_id: u32,
        tag: KarmaTag,
    ) -> Option<WeightedScore> {
        storage::get_score(&env, agent_id, tag)
    }

    /// Batched provider-facet reads, index-aligned with `agent_ids`.
    pub fn get_weighted_scores(env: Env, agent_ids: Vec<u32>) -> Vec<Option<WeightedScore>> {
        let mut out: Vec<Option<WeightedScore>> = Vec::new(&env);
        for id in agent_ids.iter() {
            out.push_back(storage::get_score(&env, id, KarmaTag::Provider));
        }
        out
    }

    /// `(consumed_at, expires_at)` for a settlement_id, or `None` if it was never
    /// consumed. The record is durable, so a consumed id reports `Some(..)` for
    /// good; `expires_at` is the legacy recency-window hint, not a replay bound.
    pub fn get_settlement_status(env: Env, settlement_id: BytesN<32>) -> Option<(u32, u32)> {
        storage::settlement_status(&env, &settlement_id)
    }

    /// Recompute a settlement_id from a proof — lets any client check replay /
    /// reproduce the binding the gate uses.
    pub fn compute_settlement_id(env: Env, proof: SettlementProof) -> BytesN<32> {
        settlement_id(&env, &proof)
    }

    pub fn get_validators(env: Env) -> Vec<Address> {
        storage::get_validators(&env)
    }

    pub fn get_facilitators(env: Env) -> Vec<Address> {
        storage::get_facilitators(&env)
    }

    pub fn get_recency_window(env: Env) -> u32 {
        storage::get_recency_window(&env)
    }

    // ── admin (operational only — CANNOT forge a payment-backed score) ───────

    pub fn set_recency_window(env: Env, slots: u32) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        storage::set_recency_window(&env, slots);
        storage::bump_instance(&env);
        let admin = storage::get_admin(&env).ok_or(ContractError::NotInitialized)?;
        events::recency_window_set(&env, &admin, slots);
        Ok(())
    }

    pub fn set_validators(env: Env, validators: Vec<Address>) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        storage::set_validators(&env, &validators);
        storage::bump_instance(&env);
        let admin = storage::get_admin(&env).ok_or(ContractError::NotInitialized)?;
        events::validators_set(&env, &admin, validators.len());
        Ok(())
    }

    pub fn set_facilitators(env: Env, facilitators: Vec<Address>) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        storage::set_facilitators(&env, &facilitators);
        storage::bump_instance(&env);
        Ok(())
    }

    // ── internals ────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), ContractError> {
        let admin = storage::get_admin(env).ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    /// Cross-call the pinned Identity Registry: `agent_wallet(agent_id) ->
    /// Option<Address>`. A missing registry binding (unregistered agent) maps to
    /// `PayeeWalletMismatch` — an unregistered agent can never satisfy the gate
    /// (mirrors Celo's identity-gated policy: unregistered ⇒ no Tier-1 weight).
    fn resolve_agent_wallet(env: &Env, agent_id: u32) -> Result<Address, ContractError> {
        let registry = storage::get_identity_registry(env).ok_or(ContractError::NotInitialized)?;
        let fn_name: Symbol = storage::agent_wallet_fn(env);
        let mut args: Vec<Val> = Vec::new(env);
        args.push_back(agent_id.into_val(env));
        let wallet: Option<Address> = env.invoke_contract(&registry, &fn_name, args);
        wallet.ok_or(ContractError::PayeeWalletMismatch)
    }
}

/// `settlement_id = sha256(payer ‖ payee ‖ amount.to_be_bytes ‖ tx_hash)`.
///
/// Per the U7 task prompt: big-endian amount bytes. (The earlier design note
/// said `le_bytes`; the task prompt is authoritative — documented here so the
/// off-chain indexer hashes identically.) `Address` is serialized via its XDR
/// encoding, which is stable and collision-free across account/contract kinds.
pub fn settlement_id(env: &Env, proof: &SettlementProof) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    buf.append(&proof.payer.clone().to_xdr(env));
    buf.append(&proof.payee.clone().to_xdr(env));
    let amount_be: [u8; 16] = proof.amount.to_be_bytes();
    buf.extend_from_array(&amount_be);
    buf.append(&Bytes::from(proof.tx_hash.clone()));
    env.crypto().sha256(&buf).to_bytes()
}

/// Fold one settlement into the existing facet score with recency decay.
///
/// Model (all integer, all checked — overflow ⇒ `ArithmeticOverflow`):
///   - `decayed_weight = amount >> floor(age / half_life)` — older settlements
///     contribute geometrically less; a settlement past the recency window
///     contributes ~0 and effectively decays out.
///   - `volume_sum'` accumulates decayed weight (the prior sum is itself decayed
///     to `now` before adding, so the whole aggregate ages).
///   - `score` is the volume-weighted blend of outcomes: a $50 settlement moves
///     the score far more than a $0.001 ping (weight ∝ amount), so high-value
///     good outcomes dominate. Bounded to [0,100].
fn fold_settlement(
    env: &Env,
    agent_id: u32,
    tag: KarmaTag,
    proof: &SettlementProof,
    outcome: u32,
    now: u32,
) -> Result<WeightedScore, ContractError> {
    let half_life = storage::DECAY_HALF_LIFE.max(1);

    // New settlement's recency-decayed weight (base units → weight).
    let new_age = now.saturating_sub(proof.ledger_seq);
    let new_weight = decay_amount(proof.amount, new_age, half_life)?;

    let prior = storage::get_score(env, agent_id, tag);

    // Decay the prior aggregate forward to `now` before folding the new one in,
    // so stale volume ages out even when no fresh settlement references it.
    let (prior_volume, prior_score, prior_count) = match &prior {
        Some(p) => {
            let prior_age = now.saturating_sub(p.recency_slot);
            let decayed_vol = decay_u128(p.volume_sum, prior_age, half_life)?;
            (decayed_vol, p.score, p.count)
        }
        None => (0u128, 0u32, 0u32),
    };

    // Add the new settlement's contribution. `volume_sum` SATURATES rather than
    // reverting: a long-lived high-volume agent must stay attestable, and an
    // astronomically large (already MAX_WEIGHT-clamped) backed-USDC aggregate is a
    // display/weight figure where saturation is acceptable — a permanent
    // ArithmeticOverflow here would be a denial-of-attestation (GAP 2).
    let new_weight_u128 = new_weight as u128;
    let new_volume = prior_volume.saturating_add(new_weight_u128);
    let new_count = prior_count.checked_add(1).ok_or(ContractError::ArithmeticOverflow)?;

    // Volume-weighted mean outcome → [0,100]. Blend the prior mean (`prior_score`
    // over `prior_volume`) with the new outcome (over `new_weight`). Computed by
    // `blend_weighted_score`, which is overflow-safe for the full u128 weight range
    // (it down-scales both weights by a common shift before the *100 multiply, so a
    // WRONG score is never produced — only sub-unit rounding at extreme volume).
    // Guard div-by-zero: if total decayed volume rounds to 0 (everything aged out,
    // brand-new dust), fall back to the raw outcome so a real (if tiny) settlement
    // still registers.
    let score = if new_volume == 0 {
        outcome.min(SCORE_MAX)
    } else {
        blend_weighted_score(prior_volume, prior_score, new_weight_u128, outcome).min(SCORE_MAX)
    };

    Ok(WeightedScore {
        score,
        volume_sum: new_volume,
        count: new_count,
        recency_slot: now,
    })
}

/// `min(amount, MAX_WEIGHT) >> floor(age / half_life)`, saturating to 0 after
/// enough half-lives. Negative amounts (never a valid settlement) clamp to 0.
/// The `MAX_WEIGHT` clamp keeps the downstream weighted-mean numerator within
/// u128 even for adversarial i128::MAX amounts (no panic — DoD #3).
fn decay_amount(amount: i128, age: u32, half_life: u32) -> Result<u128, ContractError> {
    if amount <= 0 {
        return Ok(0);
    }
    let base = (amount as u128).min(MAX_WEIGHT);
    let shifts = age / half_life;
    Ok(shift_right_saturating(base, shifts))
}

fn decay_u128(value: u128, age: u32, half_life: u32) -> Result<u128, ContractError> {
    let shifts = age / half_life;
    Ok(shift_right_saturating(value, shifts))
}

/// `value >> shifts`, returning 0 once `shifts >= 128` (fully decayed). Avoids
/// the UB of an over-wide shift.
fn shift_right_saturating(value: u128, shifts: u32) -> u128 {
    if shifts >= 128 {
        0
    } else {
        value >> shifts
    }
}

/// Volume-weighted blend of two [0,100] means: returns
/// `(w_a*v_a + w_b*v_b) / (w_a + w_b)`, where `v_a`/`v_b ≤ SCORE_MAX.
///
/// Overflow-safe across the FULL u128 weight range. The naive numerator
/// `w_a*v_a + w_b*v_b` can exceed u128 when the weights approach the ceiling
/// (GAP 2: a near-max `volume_sum` would overflow the reconstruction), so we first
/// right-shift BOTH weights by a common `k` until `(w_a' + w_b')*SCORE_MAX` is
/// guaranteed to fit. Shifting both by the same amount preserves the ratio, so the
/// blended mean is exact apart from sub-unit rounding that only appears at
/// astronomical (post-clamp) volume — never a WRONG score, only a ≤1 lsb nudge.
fn blend_weighted_score(w_a: u128, v_a: u32, w_b: u128, v_b: u32) -> u32 {
    // Largest weight-sum whose ×SCORE_MAX product still fits in u128.
    let safe_ceiling = u128::MAX / (SCORE_MAX as u128);
    let mut a = w_a;
    let mut b = w_b;
    // Drop a low bit from both until the (over-approximated) sum is in range. Using
    // saturating_add only to *detect* the over-range case; the shift then shrinks
    // the true operands proportionally.
    while a.saturating_add(b) > safe_ceiling {
        a >>= 1;
        b >>= 1;
    }
    let denom = a + b;
    if denom == 0 {
        // Both weights underflowed to 0 via shifting (or were 0): no signal —
        // average the two means so neither side silently wins.
        return (v_a + v_b) / 2;
    }
    let num = a * (v_a as u128) + b * (v_b as u128);
    (num / denom) as u32
}
