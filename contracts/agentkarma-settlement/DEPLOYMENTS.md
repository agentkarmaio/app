# AgentKarma Settlement Contract — Deployments

The settlement-gated, payment-weighted score contract (U7). Trust model: `trust-ak-oracle`
(see `../../docs/superpowers/specs/2026-06-06-stellar-integration-decision.md`). Non-routing:
the contract is a witness, it never receives/holds/relays funds.

## Testnet (Stellar `Test SDF Network ; September 2015`)

| Field | Value |
|---|---|
| **Contract ID** | `CAAUXR7ITKSAZOMWRYOJ6GBVL53TYVO4YXBXTAAUMHTMDPKFLNDMJPN6` |
| **Explorer** | https://stellar.expert/explorer/testnet/contract/CAAUXR7ITKSAZOMWRYOJ6GBVL53TYVO4YXBXTAAUMHTMDPKFLNDMJPN6 |
| **WASM sha256** | `defd724b2130db1253077d40c734682ae746ced299dc1ca86ef2696d8373ab01` |
| **Deployed** | 2026-06-06 |
| **Deployer / admin** | `GBTUWKBH5O7P4BHO772WF6HIYGQJBJQOGKRQMYTDP67FQKVG4IWMVUNH` (testnet, friendbot-funded; alias `ak-testnet-deployer`) |
| **`initialize` args** | admin = deployer · identity_registry = `CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH` (stellar-8004 testnet Identity Registry) · validators = `[deployer]` · facilitators = `[]` |
| **Liveness** | `get_weighted_score(1)` → `null` (clean empty read) ✅ |

Built with `stellar-cli 26.1.0`, `rustc 1.95.0`, target `wasm32v1-none`. Reproducible: pin the
toolchain (`rust-toolchain.toml`) + the release profile in `Cargo.toml`; rebuild and compare the
WASM sha256 above.

### Reproduce
```bash
rustup target add wasm32v1-none
cd contracts/agentkarma-settlement && stellar contract build
shasum -a 256 target/wasm32v1-none/release/agentkarma_settlement.wasm   # == defd724b…3ab01
```

### Wiring (deferred — on-chain-write milestone)
Point the TS publish path at this contract via `STELLAR_SETTLEMENT_CONTRACT` once the indexer
builds `SettlementProof`s (needs the OZ Channels pubnet facilitator address + `STELLAR_RPC_URL`).
Validators is `[deployer]` for now; replace with AK's production validator key before any real use.

## Mainnet (pubnet)

Not deployed. Before mainnet: external audit (Soroban Audit Bank), real validator key, and the
`facilitators` set seeded from the discovered OZ Channels pubnet facilitator.
