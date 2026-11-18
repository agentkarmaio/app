# Agent Bond

An agent locks USDC behind its reputation. If it misbehaves, a slasher can take part or all of the bond, citing evidence. The bond size feeds the agent's AgentKarma Provider score, with a cap.

**Testnet only.** Agent Bond is a separate product operated by AgentKarma Labs, apart from the Karma Protocol scoring layer (RFC v0.3.4-draft §12.1). It is not the third-party surety bond at `/api/v2/bond`. Contract IDs are in [DEPLOYMENTS.md](DEPLOYMENTS.md).

## How it works

| Call | Who signs | What happens |
|---|---|---|
| `deposit(agent_id, amount)` | the agent's stellar-8004 `agentWallet` (first deposit), then the bond owner | USDC moves into the contract and counts as `bonded`. The first deposit fixes the owner. |
| `request_unbond(agent_id, amount)` | owner | Moves `amount` to `unbonding` and sets `unlock_at = now + unbonding period` (7 days). A second request resets the timer. |
| `withdraw(agent_id)` | owner | After `unlock_at`, pays all of `unbonding` to the owner. |
| `slash(agent_id, amount, evidence)` | slasher | Pays `amount` to the treasury, taken from `unbonding` first, then `bonded`. Each piece of evidence can slash only once. |

Funds stay slashable while unbonding, so an agent can't escape a pending slash by leaving.

Evidence is one of:
- `Enactment(digest)`: an AgentEnact Enactment Record digest.
- `AssayVerdict(code_hash, record_digest)`: an Assay registry verdict.

Evidence is an audit pointer. The contract cannot check it, because Assay lives on NEAR and Enactment Records live off-chain. Anyone can look the pointer up from the `bond_slashed` event.

The admin handles config only (slasher, treasury, unbonding period). Every change is announced and waits `max(2 × unbonding period, 14 days)`, so an agent can exit before a new slasher takes effect. The admin cannot move funds.

## Trust assumptions (v1)

- **Slasher.** It is one operator-held testnet key (`ak-bond-slasher`), and it can slash any bond on any evidence. On mainnet the slasher must not be AgentKarma.
- **Admin.** It is the existing testnet deployer key. Through the delayed config path it can swap the slasher or treasury.
- **Registry.** The stellar-8004 registry is trusted once, at first deposit, to map `agent_id` to a wallet.

## How it affects the score

The lift is at most 10% of the gap to 100, log-scaled and capped at 10,000 USDC.
- It counts only the lowest bonded balance over the last 30 days.
- It can never push a score past 90.
- It never changes the confidence badge or the trust-tier ceiling.

A slash removes the lift and costs up to 25 points.

## Read it

```bash
curl -s https://agentkarma.io/api/v2/agent-bond/stellar-testnet/<agentId>
```

## Develop

```bash
cargo test
```

```bash
stellar contract build
```

Live end-to-end test against testnet (uses the 60-second E2E instance):

```bash
STELLAR_TESTNET_LIVE=1 bun run scripts/agent-bond-testnet-e2e.ts
```
