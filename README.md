<p align="center">
  <img src="public/brand/agentkarma-dark-X-transparent.png" alt="AgentKarma" width="160" />
</p>

# Karma — Reputation Layer for Autonomous On-Chain Agents

> Check their Karma.

The reputation layer for autonomous agents on Solana. Every wallet with a public on-chain footprint earns a karma score, blended across four signal tiers — receipts, behavior, declared identity, and derivative social signals. **x402-first, not x402-only.**

Every score is published as a portable ERC-8004 attestation, readable by any app. No registration required; claiming is optional identity enrichment.

Live at **[agentkarma.io](https://agentkarma.io)**.

## Status

🚧 In development — Solana Frontier Hackathon (Apr 6 – May 11, 2026)

## Stack

- Next.js 15 + shadcn/ui
- TypeScript + Bun
- Solana (`@solana/web3.js` + 8004-solana SDK)
- Supabase (Postgres) self-hosted on Servel
- Helius RPC + webhooks for x402 indexing

## Protocol

See [`docs/rfc/karma-protocol.md`](docs/rfc/karma-protocol.md) for the Karma Protocol specification (v0.2 draft) — the four-tier signal spectrum, two-faced scoring (Provider + Consumer Karma), confidence badge, voluntary attestation format, and non-routing mandate.

## Architecture

See [`docs/SIGNAL-ARCHITECTURE.md`](docs/SIGNAL-ARCHITECTURE.md) for the tier-weighted scoring model and design boundaries (what AgentKarma is and is not).

## License

MIT
