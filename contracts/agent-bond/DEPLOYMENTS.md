# Agent Bond — Deployments

Slashable self-stake. Operated as a separate product, "Agent Bond, operated by
AgentKarma Labs". **Testnet only.** Mainnet is blocked until the slasher is not
AgentKarma, the admin is a multisig, and the contract is externally audited.

## Testnet (`Test SDF Network ; September 2015`), deployed 2026-11-18

| Field | Production instance | E2E instance |
|---|---|---|
| Contract ID | `CDJCW763IQ2B2ZTZLMD4WNQPIXT45DVHBZBCDDXPL25VGDJF63EZOR2W` | `CCYAZCXPRXYPY4DQJHIRNEOP2EAODQSRPNOC7QSY2UNRMDPWIJSNSCO4` |
| Deploy ledger | 5801245 | 5801247 |
| `unbonding_secs` | 604800 (7 days) | 60 (live E2E only) |

Shared by both instances:

| Field | Value |
|---|---|
| WASM sha256 | `ec6f2b9a8d16bdd20dac1661ff20991cf580bf2d67bb6c5fd3632855675900f2` |
| admin | `GBTUWKBH5O7P4BHO772WF6HIYGQJBJQOGKRQMYTDP67FQKVG4IWMVUNH` (`ak-testnet-deployer`) |
| slasher | `GCPGWN3ZYWGWOVDQHGSFYWJFJB6LAK4IDTIXO33F5NXIWHC6VSIJUIPA` (`ak-bond-slasher`, operator-held, separate from admin and all attestation keys) |
| treasury | `GBP7PMBTCL7FX6HXQYHMTGFWXBEYVMBWSPGEPATIR5G7CEICEWRWWINN` (`ak-bond-treasury`, has a USDC trustline) |
| token | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (testnet USDC SAC, Circle testnet issuer) |
| identity_registry | `CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH` (stellar-8004 testnet; `get_agent_wallet`) |

Config changes wait `max(2 × unbonding_secs, 14 days)`.

Built with `stellar-cli 30.0.1`, `rustc 1.95.0`, target `wasm32v1-none`.

### Reproduce

```bash
cd contracts/agent-bond && stellar contract build
```

```bash
shasum -a 256 target/wasm32v1-none/release/agent_bond.wasm
```

### Deploy (constructor args are passed at deploy time)

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/agent_bond.wasm --source ak-testnet-deployer --network testnet -- --admin <G> --slasher <G> --treasury <G> --token <C> --identity_registry <C> --unbonding_secs 604800
```

### Operational notes

- The treasury must keep its USDC trustline. Without it, every `slash` fails.
- The keys live in the local stellar-cli keystore, never in this repo.
- The indexer starts at the deploy ledger (pinned in `src/integrations/stellar-config.ts`). Soroban RPC keeps about 7 days of events.

## Retired (never used)

`CAUIGPY4ZPYFDNRU7EEV45DZ6E7VKN32IW45XTXZCQI5MTT63UMVJHMU` and `CCWR77HVO7DQO4PYXXV7PSE7JXLDZGJYNUTSAFFWLIA56TOKJCKH5BLH` (WASM `a024c49b…`), deployed the same day. Retired before any deposit because the config delay could be shortcut by lowering the period first. Do not use them.
