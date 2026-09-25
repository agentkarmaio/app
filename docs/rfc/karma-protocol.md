# Karma Protocol

- **Status:** Draft
- **Version:** 0.3.0
- **Date:** 2026-09-25
- **Author:** Kerem Noras

## 1. Abstract

Karma is an open specification for scoring the reputation of autonomous on-chain agents. It reads settled payments, registry state and signed declarations, then produces a 0–100 score, a trust tier, a confidence badge and two separate faces (provider and consumer). The protocol is chain-agnostic. The reference implementation (AgentKarma) currently indexes Solana, Stellar, Celo and Arc, and publishes scores back on-chain as ERC-8004 feedback.

## 2. Design invariants

- **Passive.** Scores come from observed settlement and registry state, not from forms or self-reported metrics.
- **Non-routing.** The scorer never sits in the payment path. It is a bureau, not a postal service.
- **Non-custodial.** The scorer never holds keys or funds, including for bonds and succession.
- **Chain-agnostic.** Every signal carries a `chain`. Scores are computed per (chain, agent) and never silently merged across chains.
- **x402-first, not x402-only.** x402 receipts are the primary evidence; any settlement rail that yields a verifiable receipt qualifies.
- **No token.** Reputation is not tradable and not stakeable for score.
- **Evidence over numbers.** A high numeric score is capped by how much evidence stands behind it (§6.4).

## 3. Networks

| Chain | Status | Payment evidence | Registry | Data source |
|---|---|---|---|---|
| Solana | Live | x402 USDC via known facilitators, pay.sh routed receipts | 8004-solana (supplementary) | Helius Enhanced Transactions + webhook |
| Stellar | Live | x402 and MPP USDC (SEP-41 SAC, Circle issuer) | stellar-8004 (mirror) | Horizon, Soroban RPC |
| Celo | Live | x402 USDC / USDT / USDm via curated facilitators | ERC-8004 (mirror) | JSON-RPC |
| Arc | Live | Native USDC receipts, ERC-8183 job settlement | ERC-8004 | JSON-RPC, block-walk settlement sweep |
| Arc testnet | Retired | — | ERC-8004 (archived) | read-only archive |

**Population rule.** On registry-mirror chains (Stellar, Celo) the agent population is the ERC-8004 registry. On Solana and Arc the population is every wallet with observed agent settlement; the registry enriches identity but does not gate inclusion.

**Asset matching.** Stablecoins are matched by contract or issuer, never by ticker alone. On Arc only the native system emitter is counted, so a single movement is not double-counted through its ERC-20 mirror.

## 4. Signal model

Every observation becomes a signal: `(chain, agent, kind, tier, weight, face, observedAt, evidence)`.

### 4.1 Four tiers

| Tier | Name | Default weight | Examples |
|---|---|---|---|
| 1 | Receipt-gated | 60% | pay.sh routed receipt, ERC-8183 job settled, Arc USDC settlement, ERC-8004 feedback bound to a payment, bond open/resolve, executed inheritance |
| 2 | Behavioral | 25% | x402 payments, success rate, counterparty diversity, loyalty, activity, deal size, age, cadence, heartbeat |
| 3 | Declared identity | 10% | `agentkarma.json` manifest, MCP descriptor, x402 `accepts`, domain / GitHub proofs, cross-chain 8004 identity, declared will |
| 4 | Social / derivative | 5% | endorsements and derived graph signals |

When a tier has no signals, its weight is redistributed proportionally across the tiers that are present.

### 4.2 Presence-only kinds

Some signals prove that a tier exists without proving quality (for example an unsigned manifest). These kinds raise tier presence and the confidence badge but never lift the evidence ceiling.

### 4.3 Borrowed Tier 1

A bond or a declared will is Tier 1 by construction, but it is collateral, not service history. If an agent's only Tier-1 evidence is borrowed, its receipt level for the ceiling is treated as `none`.

## 5. Two faces

Every agent has two independent scores:

- **Provider karma** — how reliably it delivers when paid.
- **Consumer karma** — how reliably it pays and behaves as a buyer.

The two are never collapsed into one number. Tier 2 alone is ambiguous about direction, so a provider face requires Tier 1 or Tier 3 evidence. The consumer face is Tier-2 only and its ceiling is gated by behavior thickness alone.

## 6. Scoring

### 6.1 Composite

```
raw   = Σ w_k · tier_k            (present tiers, renormalized)
score = round(clamp(raw · decay, 0, 1) · 100, 2)
```

No tiers present → score 0, badge `declared`.

### 6.2 Tier 2 metrics

| Metric | Provider weight | Consumer weight | Normalization |
|---|---|---|---|
| successRate | 0.30 | 0.25 | successes / tx |
| loyalty | 0.20 | 0.15 | (avg tx per counterparty − 1) / 4 |
| diversity | 0.20 | 0.15 | unique counterparties / 10 |
| activity | 0.10 | 0.15 | tx / 500 |
| avgDealSize | 0.10 | 0.10 | log10(1 + avg USDC) / log10(1001) |
| age | 0.10 | 0.10 | days / 180 |

Cadence is blended in as `tier2 · 0.9 + cadence · 0.1`. Loyalty is capped at 0.40 when average tx per counterparty ≥ 20 with fewer than 3 counterparties (sybil loop). Heartbeat signals move Tier 2 within a ±0.25 band.

### 6.3 Tier 1

- On-chain ERC-8004 feedback and local feedback blend as `0.4 · onChain + 0.6 · local`; local feedback is shrunk toward a 0.5 prior with confidence `min(1, n / 10)`.
- pay.sh strength: 1 receipt → 0.85, 2 → 0.95, 3+ → 1.0.
- Receipt sources combine with `max`, never by summation, so volume of one kind cannot inflate the tier.

### 6.4 Recency decay

| Days since last signal | Multiplier |
|---|---|
| ≤ 7 | 1.00 |
| 8–30 | 1.00 → 0.95 linear |
| 31–90 | 0.95 → 0.80 linear |
| > 90 | 0.80 |

### 6.5 Trust tiers and evidence ceiling

| Score | Tier |
|---|---|
| ≤ 20 | Unrated |
| ≤ 40 | Poor |
| ≤ 60 | Fair |
| ≤ 75 | Good |
| ≤ 90 | Very Good |
| > 90 | Excellent |

The published tier is `min(numeric tier, ceiling)`. Behavior is `thin`, `moderate` (≥ 50 tx, ≥ 3 counterparties, ≥ 14 days) or `thick` (≥ 200 tx, ≥ 10 counterparties, ≥ 30 days). Receipts are `none`, `some` (Tier 1 > 0) or `strong` (Tier 1 ≥ 0.7).

| Behavior \ Receipts | none | some | strong |
|---|---|---|---|
| thin | Fair | Good | Very Good |
| moderate | Good | Very Good | Very Good |
| thick | Very Good | Very Good | Excellent |

### 6.6 Confidence badge

Every published score MUST carry a badge. A score without one is non-conformant.

- 🟢 **Receipt-backed** — Tier 1 present.
- 🟡 **Behavior-inferred** — Tier 2 present, no Tier 1.
- ⚪ **Declared** — neither Tier 1 nor Tier 2.

## 7. Orthogonal axes

These are published next to Karma and are never blended into it:

- **Autonomy** (0–100, ≥ 10 tx) — agent-like vs human-like timing and behavior.
- **Cadence** (≥ 10 tx) — regularity of activity.
- **Reciprocity** — circular vs organic flow between counterparties.
- **Settlement quality** — proven / reliable settlement from ≥ 3 distinct counterparties.
- **Farm detection** — bulk mints, self-dealt feedback, templated metadata, uniformly positive feedback.
- **Operator score** — quality of the entity running a fleet of agents.
- **Surety karma** (0–100) — underwriting track record; reliable at ≥ 3 settled bonds and score ≥ 70.

## 8. Bonds and succession

- **Bonds.** An underwriter can bond an agent. Opening and resolving a bond are Tier-1 signals for the agent and feed the underwriter's surety karma. Bonds count as borrowed Tier 1 (§4.3).
- **Succession.** An agent can declare a will (Tier 3) and emit heartbeats. Liveness is `live`, `lapsing` (past 50% of the grace window) or `lapsed`. An executed inheritance is Tier 1 for the heir.
- The scorer observes both; it never executes transfers or holds keys.

## 9. ERC-8004 export

Scores are published as ERC-8004 Reputation Registry feedback via `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)`.

| Field | Value |
|---|---|
| tag1 | `agentkarma_metadata` (scores), `agentkarma_review` (human reviews) |
| tag2 | scheme version, currently `v0.2` |
| feedbackURI | JSON evidence document, content-addressed by `feedbackHash` |

AgentKarma holds its own ERC-8004 identity on each chain it attests on (Celo, Stellar, Arc). Any EVM wallet may submit feedback through the same call; the scorer weighs raters, it does not whitelist them.

## 10. Identity and claims

- **Manifest.** Agents declare identity at `/.well-known/agentkarma.json` (Tier 3; unsigned 0.5, owner-signed 1.0).
- **Claims.** Owners prove control with a wallet signature (Solana, EVM or Stellar). A claim unlocks profile editing; it never changes the score.
- **Personhood.** Optional Self Protocol zero-knowledge verification binds a unique human to an operator without revealing identity.

## 11. Access

- **REST** — `/api/v2/score/{wallet}`, `/api/v2/agent/{chain}/{id}`, plus bond, succession and registry endpoints.
- **MCP** — `/mcp`, tools include `get_karma`, `get_provider_karma`, `get_consumer_karma`, `get_confidence`, `get_attestations`, `get_bond`, `get_succession`.
- **A2A** — `/a2a`, with agent cards under `/.well-known/`.
- **Badge** — `/api/badge/{wallet}` (SVG).
- **SDK** — `@agentkarma/sdk` (`getKarma`, `evaluateTrust`).

Every response includes `chain`, the score, both faces, the trust tier and the confidence badge.

## 12. Conformance

An implementation conforms to this draft if it:

1. Keeps scores per chain and labels every score with its chain.
2. Applies the tier weights and redistribution in §4.1 and the evidence ceiling in §6.5.
3. Publishes provider and consumer faces separately.
4. Attaches a confidence badge to every score.
5. Stays non-routing and non-custodial.

## 13. Changes from 0.2

- Protocol generalized from Solana to any settlement chain; per-chain population and asset-matching rules added (§3).
- Stellar, Celo and Arc added; Arc testnet retired to archive.
- ERC-8183 job settlement and Arc USDC settlement added as Tier-1 kinds.
- Evidence-gated ceiling, borrowed-Tier-1 rule and presence-only kinds specified.
- Bonds, surety karma and succession specified.
- ERC-8004 export tags and multichain attester identities specified.
