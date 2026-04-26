# Security Policy

AgentKarma is a reputation primitive. Its outputs feed automated decisions — facilitator gating, marketplace classification, compliance screening — and a quiet flaw can propagate across every consumer of the score. We treat security reports seriously and respond on a documented timeline.

## Scope

In scope for vulnerability disclosure:

- **Scoring integrity** — anything that lets an attacker materially raise their own karma score, lower a competitor's, or fabricate confidence-badge promotions without the underlying signals (see `docs/SIGNAL-ARCHITECTURE.md` §Threat model and anti-gaming for the published attack surface).
- **Signal-source spoofing** — forged x402 receipts, replayed feedback attestations, fabricated counterparty graphs, manifest-resolver SSRF, malicious cross-chain attestation imports.
- **Authentication and ownership** — flaws in wallet-signed claim flows, organization claim primitives, manifest ownership proofs (DNS TXT, GitHub `AGENTKARMA.md`), and any path that lets one wallet act on behalf of another.
- **API and data integrity** — injection, authentication bypass, unauthenticated access to private fields, scoring-pipeline race conditions, indexer-replay holes.
- **Infrastructure** — deployment configuration, secret exposure, dependency vulnerabilities affecting the production deployment at agentkarma.io.

Out of scope:

- Social-engineering attacks against AgentKarma operators.
- Attacks on third-party services we depend on (Helius, Supabase, Solana RPC providers) — please report those upstream. We are happy to coordinate.
- Volumetric DoS without a logical amplifier — please don't run load tests against production.
- Speculative economic-game-theory critiques without a working exploit. The threat model is published; structured proposals for improvement are welcome via GitHub issues, not via this disclosure channel.

## Reporting

Send vulnerability reports to **kerem@noras.tech**.

Include, where possible:

- A clear description of the issue and its impact.
- Reproduction steps, sample payloads, and affected URLs / endpoints / functions.
- A proof-of-concept, if available.
- Your preferred name and contact for credit (or a request to remain anonymous).

PGP encryption is optional. If you need an encryption channel, request a public key in your initial message.

## Response timeline

| Stage | Target |
|---|---|
| Acknowledgement of receipt | within 72 hours |
| Initial severity assessment + scope confirmation | within 7 days |
| Status update cadence after triage | every 14 days until resolution |
| Fix or mitigation deployed | within 90 days for critical / high severity; longer for low-severity issues, with explicit agreement |
| Public disclosure window | 90 days after initial report, or sooner by mutual agreement |

We aim to respond faster than these caps. Targets exist so reporters know what to expect, not as a stalling buffer.

## Severity guidance

We use a pragmatic severity scale, not CVSS:

- **Critical** — score-integrity flaw an attacker can exploit at scale, secret leakage, authentication bypass on signed claim flows, indexer corruption affecting all wallets.
- **High** — score manipulation requiring meaningful but feasible effort, ownership-proof bypass for a single wallet, cross-site scripting on authenticated routes.
- **Medium** — signal-source spoofing detectable by post-hoc analysis, information disclosure of non-sensitive data, cross-site scripting on unauthenticated routes.
- **Low** — best-practice gaps, missing security headers, dependency advisories without a working exploit path.

## What we do not offer (yet)

- A formal bug-bounty program with monetary rewards. AgentKarma is operated by a solo maintainer through the Colosseum Frontier hackathon; an economic bounty program is roadmap.
- Hall-of-fame or public credit list — we will credit reporters by name in resolution notes if requested, but a curated list is not maintained.
- Embargoed coordinated disclosure with multiple parties — single-party coordinated disclosure only.

## Threat model

The published threat model documents specific attacks the protocol design accounts for and the mitigations applied. Reports that demonstrate a *novel* attack vector or break a *claimed* mitigation are particularly valuable. See:

- `docs/SIGNAL-ARCHITECTURE.md` §Threat model and anti-gaming — full attack matrix with status tags.
- `docs/rfc/karma-protocol.md` §14 — normative threat model in the protocol specification.

A score-algorithm change, a new signal source, or a new ingestion path always accompanies a threat-model review. If you find a path that should have been considered and was not, that is itself a valuable report.

## Non-scope: design disagreement

We get reports that argue the protocol *should* offer features it explicitly rejects — a token, juror-bonded disputes, slash-for-stake economic security, in-protocol KYC. These are documented as out-of-scope by design (see RFC §14.4 and `docs/SIGNAL-ARCHITECTURE.md`); they are not security vulnerabilities. We're happy to discuss design tradeoffs in GitHub issues. Please don't route them through this address.

## Contact

- **Primary:** kerem@noras.tech
- **Author:** Kerem Noras
- **Project:** [agentkarma.io](https://agentkarma.io)
