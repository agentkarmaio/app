# AgentKarma Specimen

Reference x402-compatible micro-API on Solana mainnet, plus a cron-driven
consumer that exercises the full reputation pipeline end-to-end with real
on-chain payments.

The point: prove the system works against actual mainnet state, not synthetic
data. Tier 1 (x402 receipts) → Tier 2 (cadence + autonomy) → publish ERC-8004
attestation, all from real txs the indexer picks up like any other facilitator.

## Wallets

```
provider: BfqzVwCcNf1TcVyYaZr6zjjeZKFt57fMDMcRKGjTqQCm   (web/.keys/specimen-provider.json)
consumer: AwHpZNJA1PyWGSsqbMhFcgyJRR1bYvQTnq2DtH8ud7uZ   (web/.keys/specimen-consumer.json)
```

Both keypairs are gitignored under `web/.keys/`. Provider is also registered
as the `agentkarma-specimen` facilitator in `src/config/specimen.ts`, so the
indexer iterates it like Coinbase / pay.sh / etc.

## Funding (one-time)

Send these to the **consumer** wallet. Provider needs nothing — it just
receives.

```
~0.05 USDC   (50 calls × 0.001 USDC)
~0.01 SOL    (tx fees + ATA rent)
```

Quickest: a Phantom transfer from your hot wallet, or a Jupiter swap to USDC
followed by a transfer.

## Layout

```
specimen/
├── server.ts                 standalone Bun server (local dev)
└── scripts/
    ├── call.ts               single x402 round-trip
    └── cron.ts               long-running loop with jittered intervals

src/lib/specimen/
├── protocol.ts               headers + memo format
├── usdc.ts                   USDC SPL transfer + memo builder
├── verify.ts                 provider-side on-chain verification
├── replay.ts                 tx-signature replay guard
├── manifest.ts               agentkarma.json shape
├── payloads.ts               echo + quote bodies
└── gated-handler.ts          shared 402/200 handler

src/app/specimen/
├── page.tsx                  public landing
└── agentkarma.json/route.ts  Tier 3 declared identity manifest

src/app/api/specimen/
├── echo/route.ts             payment-gated echo
└── quote/route.ts            payment-gated quote

src/app/api/cron/
└── specimen-tick/route.ts    fires one round-trip per invocation (Servel job)
```

## Run locally

```bash
# 1. Boot the Next.js app — specimen routes ride on it
cd web
bun dev

# 2. In another shell: fire one full x402 round-trip
SPECIMEN_BASE_URL=http://localhost:3737/api/specimen bun run specimen:call

# 3. Optional: long-running cron (5 days, ~30 min cadence)
SPECIMEN_BASE_URL=http://localhost:3737/api/specimen \
  bun run specimen:cron --interval=1800 --jitter=600 --until=2026-05-11T20:00:00Z
```

The standalone Bun server (`bun run specimen:server`) is also available if you
want a separate process; it binds to `:3941` and serves the same routes at
`/echo` etc. (no `/api/specimen/` prefix).

## Run as Servel cron (production)

Once the consumer wallet is funded and the app is deployed:

```bash
# Add the consumer secret to deploy env
servel env set @agentkarma SPECIMEN_CONSUMER_PRIVATE_KEY "$(cat web/.keys/specimen-consumer.json)"

# Schedule a tick every 30 minutes through the hackathon window
servel job add specimen-tick \
  --schedule "*/30 * * * *" \
  --url https://agentkarma.io/api/cron/specimen-tick \
  --method POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  --until 2026-05-11T23:59:00Z
```

(Adjust `servel job` flags to match your actual CLI.)

## Verification checklist

After a few calls land:

1. **Indexer picks them up.** `bun run indexer:full` — should log the
   `agentkarma-specimen` facilitator with N tx.
2. **Consumer wallet enters DB.** Hit
   `/api/v2/wallet/AwHpZNJA1PyWGSsqbMhFcgyJRR1bYvQTnq2DtH8ud7uZ` — non-zero
   `tx_count` + Tier 2 metrics populated.
3. **Confidence badge.** Check the wallet page at
   `/wallet/AwHpZNJA1PyWGSsqbMhFcgyJRR1bYvQTnq2DtH8ud7uZ`. Should be 🟢
   receipt-backed once Tier 1 fires.
4. **Publish attestation.** `bun run publish 5`. Look for the consumer wallet
   in the output with a `tx:` signature. That tx is the on-chain ERC-8004
   feedback record.
5. **Verify portability.** Open the ERC-8004 attestation tx on Solscan; the
   account it touches is publicly readable by any client running the
   `8004-solana` SDK.

## Cost

Per round-trip:
- 0.001 USDC payment (paid by consumer to provider)
- ~0.000005 SOL tx fee
- ~0.002 SOL one-time ATA rent on first payment

50 calls over 5 days ≈ $0.05 USDC + $0.01 SOL ≈ **$0.10 total**.

## Things deliberately out of scope

- Subdomain routing (`specimen.agentkarma.io`). Manifest lives at
  `agentkarma.io/specimen/agentkarma.json` for the demo. Add via
  `servel domains add` after deploy if needed.
- Tier 3 auto-resolution. The manifest uses `agentkarma.v1` schema and
  declares `wallet`, but the resolver expects `.well-known/agentkarma.json`
  on the agent's own domain — wired up properly only after subdomain.
- KV-backed replay store. In-memory only; fine for single-instance + 120s
  payment window.
