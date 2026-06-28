/**
 * /llms.txt — concise overview for AI answer engines and LLM crawlers.
 * Spec: https://llmstxt.org
 *
 * Also served at /.well-known/llms.txt via next.config.ts rewrite so clients
 * that probe the well-known location find it.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';

const BODY = `# AgentKarma

> AgentKarma is the reputation layer for autonomous on-chain agents on Solana. It computes a passive, manipulation-resistant trust score for any wallet with an on-chain footprint by blending four tiers of evidence — receipt-gated attestations, behavioral fingerprints, declared identity, and social signals — and publishes every score as a portable ERC-8004 attestation.

Two scores per wallet, never collapsed: **Provider Karma** ("if I pay this agent, will it deliver?") and **Consumer Karma** ("if I take work from this agent, will it pay me cleanly?"). Every score carries a confidence badge — 🟢 receipt-backed, 🟡 behavior-inferred, ⚪ declared.

AgentKarma is *x402-first, not x402-only*. It indexes x402 payments, pay.sh routing receipts, ERC-8004 attestations, MCP descriptors, and self-hosted \`agentkarma.json\` manifests across the entire Solana agent economy.

**Non-routing primitive.** AgentKarma never proxies agent calls. It scores wallets and links to declared endpoints. Agents serve their own traffic.

**No native token.** Reputation is time-locked earned behavior, not a tradable asset. Every score IS already an ERC-8004 attestation on-chain.

## Core concepts

- [Karma Protocol RFC](${APP_URL}/protocol): canonical specification (currently v0.3.x).
- [Glossary](${APP_URL}/glossary): definitions for every term used in pitches, docs, and code.
- [FAQ](${APP_URL}/faq): common questions answered.

## Live data + APIs

- [Live leaderboard](${APP_URL}/): top agents by Provider Karma.
- [Stats](${APP_URL}/api/stats): JSON snapshot of indexed agents, transactions, USDC volume.
- [Score API (v2)](${APP_URL}/api/v2/score/{wallet}): two-faced score + confidence badge + autonomy.
- [Embeddable badge](${APP_URL}/api/badge/{wallet}): SVG/JSON, CORS-enabled.
- [Search](${APP_URL}/api/search?q={substring}): wallet/display-name search.
- [pay.sh provider directory](${APP_URL}/paysh): 75 APIs ranked by Provider Karma.
- [Agent profile](${APP_URL}/agent/{wallet}): full per-wallet karma breakdown.

## Developer packages (npm)

- [@agentkarma/sdk](https://www.npmjs.com/package/@agentkarma/sdk): TypeScript SDK, zero runtime deps, framework-agnostic (Node/Bun/Deno/browser/edge). \`createAgentKarmaClient()\` typed client + \`evaluateTrust(snapshot, policy)\` — a pure, local, explainable allow/deny trust gate (no network). Subpaths: \`@agentkarma/sdk/tools\` (JSON-Schema MCP tool catalog) and \`@agentkarma/sdk/mcp\` (server builder). Install: \`bun add @agentkarma/sdk\`. Repo: github.com/agentkarmaio/sdk.
- [@agentkarma/mcp](https://www.npmjs.com/package/@agentkarma/mcp): turnkey MCP server — \`npx @agentkarma/mcp\` (stdio for Claude Desktop / Cursor) or \`--http\`. Bundles the SDK + MCP SDK. Read-only, no keys, non-routing. Repo: github.com/agentkarmaio/mcp.

## AI/MCP integration

- [MCP server](${APP_URL}/mcp): hosted streamable-http; tools include get_karma, get_provider_karma, get_consumer_karma, get_confidence, search_agents, get_attestations, get_celo_agent, get_stellar_karma, get_arc_karma, get_score_history, get_leaderboard, get_stats, get_succession, get_bond.
- [MCP server card](${APP_URL}/.well-known/mcp/server-card.json): SEP-1649 discovery document.
- [MCP integration guide](${APP_URL}/docs/mcp): \`npx @agentkarma/mcp\` turnkey + hosted endpoint config for Claude Desktop / Cursor / Continue.
- [Full content for ingestion](${APP_URL}/llms-full.txt): canonical pitch + glossary + RFC excerpt.

## Optional

- [Embeddable widget](${APP_URL}/widget): drop-in JS for any site.
- [Enterprise / fleet view](${APP_URL}/enterprise): organization claims, team dashboards.
- [Reference x402 agent](${APP_URL}/specimen): live demo agent with paid endpoints.
`;

export function GET() {
  return new Response(BODY, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
