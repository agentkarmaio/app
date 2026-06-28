/**
 * AgentKarma MCP Server — streamable-http transport.
 *
 * Exposes the read-only Karma surface as an MCP server at `/mcp`. Designed to
 * sit alongside pay.sh's MCP server: pay.sh's `curl` tool MAKES paid calls,
 * AgentKarma's tools answer the prior question — "should I trust this agent
 * before paying?".
 *
 * Non-routing invariant (RFC §12): we score, never proxy. None of these tools
 * make outbound API calls on behalf of the caller.
 *
 * Two-faced invariant: every wallet response carries Provider Karma AND
 * Consumer Karma — never a single collapsed score.
 *
 * Transport: WebStandardStreamableHTTPServerTransport in stateless mode. Each
 * request gets a fresh transport, McpServer is reused via a module-level
 * singleton. This works on any runtime that supports Web Standards (Next.js
 * App Router included).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  resolveKarma,
  resolveAttestations,
  resolveEvmKarma,
  searchAgents,
  type KarmaSnapshot,
  type EvmKarmaSnapshot,
} from '@/lib/karma-resolver';
import { readAgent, aggregateFeedback } from '@/integrations/erc8004-celo';
import { getAdapter } from '@/chain-adapters/registry';
import { resolveAgentChain } from '@/app/agent/[wallet]/resolve-chain';
import {
  getScoreHistory,
  getLeaderboard,
  getFeedbackSummariesForWallets,
  getStats,
  getSuccession,
  getRecentTransactionsForWallet,
  getBondsForAgent,
  getUnderwriterPositions,
} from '@/db/client';
import { deriveSuccessionLiveness } from '@/scoring/succession';
import { computeSurety } from '@/scoring/surety';
import {
  buildSuccessionView,
  buildBondView,
  buildSuretyView,
  isBondSettled,
  toSuretyPosition,
} from '@/lib/succession-view';
import type { Chain } from '@/db/schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// --- MCP server (singleton) -----------------------------------------------

const SERVER_INFO = {
  name: 'agentkarma',
  title: 'AgentKarma MCP server',
  version: '0.1.0',
} as const;

const SERVER_INSTRUCTIONS = [
  'AgentKarma is the reputation layer for autonomous on-chain agents on Solana.',
  'Use these tools to look up trust signals BEFORE paying or delegating to a',
  'wallet — every response carries two-faced karma (provider + consumer) and a',
  'confidence badge (receipt-backed / behavior-inferred / declared).',
  'AgentKarma does not proxy paid calls. For payment, use pay.sh.',
].join(' ');

export const walletSchema = z
  .string()
  .min(32)
  .max(56)
  .describe('On-chain agent wallet address: Solana base58 (32–44 chars), Stellar StrKey G-address (56 chars), or EVM 0x-address (42 chars, Celo or Arc).');

/**
 * Optional chain declaration. Solana (base58) and Stellar (G…) addresses are
 * format-unique, so this is only needed to disambiguate an EVM `0x…` address,
 * which is valid on BOTH Celo and Arc. When omitted, the chain is inferred from
 * the address format and (for EVM) the DB rows; ambiguous EVM addresses default
 * to Celo. Mirrors the web's `?chain=` query param on `/agent/[wallet]`.
 */
export const chainSchema = z
  .enum(['solana', 'celo', 'stellar', 'arc'])
  .optional()
  .describe('Declare the chain for EVM-ambiguous 0x addresses (Celo vs Arc); inferred from address format otherwise.');

const walletShape: { wallet: typeof walletSchema; chain: typeof chainSchema } = {
  wallet: walletSchema,
  chain: chainSchema,
};

/**
 * Optional chain FILTER for the non-address tools (`get_leaderboard`,
 * `get_stats`). Same enum as `chainSchema`, but a different role: here it scopes
 * an aggregate to one chain rather than disambiguating an EVM 0x address. Omit
 * to span every chain.
 */
export const chainFilterSchema = z
  .enum(['solana', 'celo', 'stellar', 'arc'])
  .optional()
  .describe('Restrict results to a single chain (solana / celo / stellar / arc). Omit to span all chains.');

/**
 * Coercing integer param. LLM clients and test playgrounds routinely pass
 * numbers as JSON strings (e.g. `{"agentId": "9263"}`). `z.coerce.number()`
 * turns "9263"→9263 at parse-time while still rejecting genuine garbage
 * ("abc"→NaN), non-integers ("9263.5") and empties (""→0 fails .int()/range).
 * The advertised JSON Schema stays type "number" — honest but forgiving.
 */
export const intParam = () => z.coerce.number().int();

/**
 * Build a fresh `McpServer` per request. The SDK's high-level server wraps a
 * single underlying `Protocol` and refuses to re-connect once a transport is
 * attached, so we cannot share one instance across stateless requests. The
 * cost is just allocating + registering the tools — microseconds.
 */
function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);
  return server;
}

/** Tool names registered on a fresh server — used by tests and discovery. */
export function listRegisteredToolNames(): string[] {
  const server = buildServer();
  // McpServer keeps registered tools in `_registeredTools` (keyed by name).
  const reg = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  return reg ? Object.keys(reg) : [];
}

function readOnly() {
  return { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
}

/**
 * Chain-aware resolution for the address-based tools. Resolves the address to
 * its chain (reusing the web's `resolveAgentChain`, honoring an optional `chain`
 * hint for EVM-ambiguous 0x addresses), then dispatches:
 *
 *   - solana  → the receipt-based Solana karma path (`resolveKarma`, unchanged).
 *   - stellar → `resolveKarma` + on-chain ERC-8004 attestation via the adapter.
 *   - celo/arc → declared `wallets` row + on-chain ERC-8004 identity/feedback
 *               read keyed by the agentId on the row (`resolveEvmKarma`).
 *
 * Returns a discriminated union the tool handlers project into their JSON
 * shape, or `null` when nothing was found (→ the existing notFound() error).
 */
// Exported so the A2A agent endpoint (src/app/a2a/route.ts) resolves + projects
// karma through the EXACT same path as get_karma — byte-identical answers, one
// source of truth. These are inert exports (no behavior change to /mcp).
export type ResolvedKarma =
  | { kind: 'solana'; snap: KarmaSnapshot }
  | { kind: 'stellar'; snap: KarmaSnapshot; onChainAttestation: number }
  | { kind: 'evm'; snap: EvmKarmaSnapshot };

export async function resolveForChain(
  addr: string,
  chainHint: Chain | undefined,
): Promise<ResolvedKarma | null> {
  const resolved = await resolveAgentChain(addr, chainHint);

  // An EVM address (0x…) with an explicit Celo/Arc hint that matched NO DB row
  // resolves to chain=null. Honor the declared chain anyway: route to the EVM
  // path (→ clean not-found) rather than falling through to the Solana lookup,
  // which would be a wrong-chain attempt against an address that can't be Solana.
  const evmChain: 'celo' | 'arc' | null =
    resolved.chain === 'celo' || resolved.chain === 'arc'
      ? resolved.chain
      : resolved.addressClass === 'evm' && (chainHint === 'celo' || chainHint === 'arc')
        ? chainHint
        : null;

  // Celo / Arc — declared row + on-chain ERC-8004 read keyed by agentId.
  if (evmChain) {
    const snap = await resolveEvmKarma(addr, evmChain, resolved.wallet);
    if (!snap) return null;
    return { kind: 'evm', snap };
  }

  // Stellar — Solana-style snapshot + on-chain attestation via the adapter.
  if (resolved.chain === 'stellar') {
    const stellar = getAdapter('stellar');
    const [onChainAttestation, snap] = await Promise.all([
      stellar.readAttestation(addr).catch(() => 0),
      resolveKarma(addr),
    ]);
    if (!snap) return null;
    return { kind: 'stellar', snap, onChainAttestation };
  }

  // Solana (or an unmatched EVM/unknown address that still has Solana tx/rows).
  // resolveKarma defaults to the Solana composite-PK row, the original behavior.
  const snap = await resolveKarma(addr);
  if (!snap) return null;
  return { kind: 'solana', snap };
}

/** Project a resolved karma into the full two-faced JSON `get_karma` returns. */
export function fullKarmaJson(r: ResolvedKarma, addr: string) {
  if (r.kind === 'evm') return evmKarmaJson(r.snap);
  const { snap } = r;
  const base = {
    chain: r.kind === 'stellar' ? ('stellar' as const) : ('solana' as const),
    address: snap.address,
    provider: faceJson(snap.provider),
    consumer: faceJson(snap.consumer),
    confidenceBadge: snap.confidenceBadge,
    autonomy: snap.autonomy,
    identity: snap.identity,
    txCount: snap.txCount,
    lastActive: snap.lastActive,
    profileUrl: profileUrl(addr),
  };
  if (r.kind === 'stellar') {
    const stellar = getAdapter('stellar');
    return {
      ...base,
      onChainAttestation: r.onChainAttestation,
      explorerUrls: {
        stellarExpert: stellar.explorerAddressUrl(addr),
        agentkarma: profileUrl(addr),
      },
    };
  }
  return base;
}

/** Project an EVM (Celo/Arc) snapshot into the two-faced-shaped JSON. */
function evmKarmaJson(snap: EvmKarmaSnapshot) {
  return {
    chain: snap.chain,
    address: snap.address,
    agentId: snap.agentId,
    owner: snap.owner,
    agentWallet: snap.agentWallet,
    agentURI: snap.agentURI,
    registrationError: snap.registrationError,
    identity: snap.identity,
    services: snap.services,
    // Two-faced invariant: EVM agents are declared-tier today (no tx history),
    // so the consumer face has no behavioral signal — surfaced explicitly so
    // the response still carries BOTH faces, never a single collapsed score.
    provider: {
      score: snap.provider.score,
      trustTier: snap.provider.trustTier,
      confidenceBadge: snap.provider.confidenceBadge,
      hasSignal: snap.onChainFeedback != null && snap.onChainFeedback.count > 0,
    },
    consumer: {
      score: null,
      trustTier: 'Unrated',
      confidenceBadge: snap.provider.confidenceBadge,
      hasSignal: false,
      note: 'Consumer (payment-behavior) signal is Solana-only today; EVM agents are declared-tier.',
    },
    confidenceBadge: snap.provider.confidenceBadge,
    onChainFeedback: snap.onChainFeedback,
    claimed: snap.claimed,
    explorerUrls: snap.explorerUrls,
    profileUrl: snap.explorerUrls.agentkarma,
  };
}

function registerTools(server: McpServer): void {
  // --- get_karma --------------------------------------------------------
  server.registerTool(
    'get_karma',
    {
      title: 'Get Karma (both faces)',
      description:
        'Look up the full Karma snapshot for ANY agent wallet — Solana, Stellar, Celo, or Arc — by address: provider score, consumer score, confidence badge, and autonomy. The chain is inferred from the address format; pass `chain` only to disambiguate an EVM 0x address (Celo vs Arc). Use this BEFORE paying an agent or accepting a request from one.',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr, chain }) => runTool('get_karma', async () => {
      const resolved = await resolveForChain(addr, chain);
      if (!resolved) return notFound(addr);
      return jsonResult(fullKarmaJson(resolved, addr));
    }),
  );

  // --- get_provider_karma ----------------------------------------------
  server.registerTool(
    'get_provider_karma',
    {
      title: 'Get Provider Karma',
      description:
        'Provider face only — "If I pay this agent, will it deliver?". Driven primarily by Tier 1 receipt-gated attestations and Tier 3 declared identity. Works for any chain by address; pass `chain` to disambiguate an EVM 0x address.',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr, chain }) => runTool('get_provider_karma', async () => {
      const resolved = await resolveForChain(addr, chain);
      if (!resolved) return notFound(addr);
      if (resolved.kind === 'evm') {
        const { snap } = resolved;
        return jsonResult({
          chain: snap.chain,
          address: snap.address,
          agentId: snap.agentId,
          provider: {
            score: snap.provider.score,
            trustTier: snap.provider.trustTier,
            confidenceBadge: snap.provider.confidenceBadge,
            hasSignal: snap.onChainFeedback != null && snap.onChainFeedback.count > 0,
          },
          confidenceBadge: snap.provider.confidenceBadge,
          onChainFeedback: snap.onChainFeedback,
          profileUrl: snap.explorerUrls.agentkarma,
        });
      }
      const { snap } = resolved;
      return jsonResult({
        chain: resolved.kind,
        address: snap.address,
        provider: faceJson(snap.provider),
        confidenceBadge: snap.provider.confidenceBadge,
        autonomy: snap.autonomy,
        txCount: snap.txCount,
        lastActive: snap.lastActive,
        profileUrl: profileUrl(addr),
      });
    }),
  );

  // --- get_consumer_karma ----------------------------------------------
  server.registerTool(
    'get_consumer_karma',
    {
      title: 'Get Consumer Karma',
      description:
        'Consumer face only — "If I take work from this agent, will it pay me cleanly?". Driven primarily by Tier 2 payment behavior (success rate, volume, cadence). Works for any chain by address; pass `chain` to disambiguate an EVM 0x address. NOTE: consumer (payment-behavior) signal is Solana-only today — EVM agents are declared-tier and return a null consumer score.',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr, chain }) => runTool('get_consumer_karma', async () => {
      const resolved = await resolveForChain(addr, chain);
      if (!resolved) return notFound(addr);
      if (resolved.kind === 'evm') {
        const { snap } = resolved;
        return jsonResult({
          chain: snap.chain,
          address: snap.address,
          agentId: snap.agentId,
          consumer: {
            score: null,
            trustTier: 'Unrated',
            confidenceBadge: snap.provider.confidenceBadge,
            hasSignal: false,
            note: 'Consumer (payment-behavior) signal is Solana-only today; EVM agents are declared-tier.',
          },
          confidenceBadge: snap.provider.confidenceBadge,
          profileUrl: snap.explorerUrls.agentkarma,
        });
      }
      const { snap } = resolved;
      return jsonResult({
        chain: resolved.kind,
        address: snap.address,
        consumer: faceJson(snap.consumer),
        confidenceBadge: snap.consumer.confidenceBadge,
        autonomy: snap.autonomy,
        txCount: snap.txCount,
        lastActive: snap.lastActive,
        profileUrl: profileUrl(addr),
      });
    }),
  );

  // --- get_confidence ---------------------------------------------------
  server.registerTool(
    'get_confidence',
    {
      title: 'Get confidence badge',
      description:
        'Return the confidence badge plus the per-tier signal breakdown that produced it. Badges: "receipt-backed" (Tier 1 dominant), "behavior-inferred" (Tier 2 dominant), "declared" (Tier 3 only). Works for any chain by address; pass `chain` to disambiguate an EVM 0x address.',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr, chain }) => runTool('get_confidence', async () => {
      const resolved = await resolveForChain(addr, chain);
      if (!resolved) return notFound(addr);
      if (resolved.kind === 'evm') {
        const { snap } = resolved;
        return jsonResult({
          chain: snap.chain,
          address: snap.address,
          badge: snap.provider.confidenceBadge,
          provider: {
            badge: snap.provider.confidenceBadge,
            // EVM agents are declared-tier (no per-tier receipt/behavior
            // aggregates); on-chain ERC-8004 feedback is the available evidence.
            tierAggregates: null,
            onChainFeedback: snap.onChainFeedback,
          },
        });
      }
      const { snap } = resolved;
      return jsonResult({
        chain: resolved.kind,
        address: snap.address,
        badge: snap.confidenceBadge,
        provider: {
          badge: snap.provider.confidenceBadge,
          tierAggregates: snap.provider.tierAggregates,
        },
        consumer: {
          badge: snap.consumer.confidenceBadge,
          tierAggregates: snap.consumer.tierAggregates,
        },
      });
    }),
  );

  // --- search_agents ----------------------------------------------------
  server.registerTool(
    'search_agents',
    {
      title: 'Search agents by name or wallet',
      description:
        'Find agents by a substring of their display name OR wallet address (case-insensitive), across all chains. Returns up to `limit` results ranked by score, each with its chain.',
      inputSchema: {
        query: z.string().min(3).describe('Agent name or wallet-address substring (≥3 chars).'),
        limit: intParam().min(1).max(50).optional()
          .describe('Max results (1–50, default 8).'),
      },
      annotations: readOnly(),
    },
    async ({ query, limit }) => runTool('search_agents', async () => {
      const results = await searchAgents(query, limit ?? 8);
      return jsonResult({
        query,
        count: results.length,
        results: results.map((r) => ({
          address: r.address,
          chain: r.chain,
          displayName: r.displayName,
          score: r.score,
          trustTier: r.trustTier,
          txCount: r.txCount,
          profileUrl: profileUrl(r.address),
        })),
      });
    }),
  );

  // --- get_celo_agent ---------------------------------------------------
  server.registerTool(
    'get_celo_agent',
    {
      title: 'Get Celo agent (ERC-8004)',
      description:
        'Look up a Celo ERC-8004 agent by its agentId (uint256 NFT tokenId). Returns the IdentityRegistry record (owner, agentURI, declared services from the agent registration JSON) plus aggregate ReputationRegistry feedback (count, average score, recent records). Use this to preflight any agent operating on Celo — same primitive as the Solana karma tools, just on EVM rails.',
      inputSchema: {
        agentId: intParam()
          .positive()
          .describe('ERC-8004 agentId on Celo mainnet (positive integer).'),
      },
      annotations: readOnly(),
    },
    async ({ agentId }) => runTool('get_celo_agent', async () => {
      const id = BigInt(agentId);
      // readAgent THROWS (ownerOf/tokenURI revert) for a nonexistent tokenId —
      // catch it so a bad/huge agentId returns the clean celo_agent_not_found
      // below instead of leaking the raw viem contract-revert dump.
      const [agent, agg] = await Promise.all([
        readAgent(id).catch(() => null),
        aggregateFeedback(id).catch(() => null),
      ]);
      if (!agent) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'celo_agent_not_found',
              agentId,
              message: `No agent registered with id ${agentId} in Celo IdentityRegistry.`,
            }),
          }],
        };
      }
      return jsonResult({
        chain: 'celo',
        agentId,
        owner: agent.owner,
        agentWallet: agent.agentWallet,
        tokenURI: agent.tokenURI,
        registration: agent.registration ?? null,
        registrationError: agent.registrationError,
        reputation: agg
          ? {
              count: agg.count,
              average: agg.average,
              records: agg.records.map((r) => ({
                client: r.client,
                value: r.value,
                tag1: r.tag1,
                tag2: r.tag2,
                revoked: r.revoked,
              })),
            }
          : null,
        explorerUrls: {
          celoscan: `https://celoscan.io/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=${agentId}`,
          eightthousandfourscan: `https://8004scan.io/agent/${agentId}`,
          agentkarma: `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io'}/api/v2/celo/${agentId}`,
        },
      });
    }),
  );

  // --- get_stellar_karma -----------------------------------------------
  server.registerTool(
    'get_stellar_karma',
    {
      title: 'Get Stellar agent Karma (both faces)',
      description:
        'Look up the full Karma snapshot for a Stellar agent wallet (G… StrKey address): provider score, consumer score, confidence badge, autonomy, plus the on-chain ERC-8004 attestation value read from the Soroban ReputationRegistry. Same primitive as get_karma (Solana) — Stellar rails. Use BEFORE paying a Stellar agent.',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr }) => runTool('get_stellar_karma', async () => {
      const stellar = getAdapter('stellar');
      if (!stellar.validateAddress(addr)) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'invalid_stellar_address',
              wallet: addr,
              message: 'Expected a Stellar StrKey G… Ed25519 address (56 chars).',
            }),
          }],
        };
      }
      const onChainAttestation = await stellar.readAttestation(addr).catch(() => 0);
      const snap = await resolveKarma(addr);
      if (!snap) return notFound(addr);
      return jsonResult({
        chain: 'stellar',
        address: snap.address,
        provider: faceJson(snap.provider),
        consumer: faceJson(snap.consumer),
        confidenceBadge: snap.confidenceBadge,
        autonomy: snap.autonomy,
        identity: snap.identity,
        txCount: snap.txCount,
        lastActive: snap.lastActive,
        onChainAttestation,
        explorerUrls: {
          stellarExpert: stellar.explorerAddressUrl(addr),
          agentkarma: profileUrl(addr),
        },
        profileUrl: profileUrl(addr),
      });
    }),
  );

  // --- get_arc_karma ----------------------------------------------------
  server.registerTool(
    'get_arc_karma',
    {
      title: 'Get Arc agent Karma (both faces)',
      description:
        'Look up the full Karma snapshot for an Arc agent wallet (EVM 0x… address): provider score, consumer score, confidence badge, and autonomy. Arc is Circle\'s USDC-native L1; AgentKarma indexes its ERC-8183 agentic-commerce job settlements as Tier-1 receipt-grade signals. Same primitive as get_karma (Solana) / get_stellar_karma — Arc rails. Use BEFORE paying an Arc agent.',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr }) => runTool('get_arc_karma', async () => {
      const arc = getAdapter('arc');
      if (!arc.validateAddress(addr)) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'invalid_arc_address',
              wallet: addr,
              message: 'Expected an EVM 0x… address (42 chars) on Arc.',
            }),
          }],
        };
      }
      const onChainAttestation = await arc.readAttestation(addr).catch(() => 0);
      const snap = await resolveKarma(addr);
      if (!snap) return notFound(addr);
      return jsonResult({
        chain: 'arc',
        address: snap.address,
        provider: faceJson(snap.provider),
        consumer: faceJson(snap.consumer),
        confidenceBadge: snap.confidenceBadge,
        autonomy: snap.autonomy,
        identity: snap.identity,
        txCount: snap.txCount,
        lastActive: snap.lastActive,
        onChainAttestation,
        explorerUrls: {
          arcscan: arc.explorerAddressUrl(addr),
          agentkarma: profileUrl(addr),
        },
        profileUrl: profileUrl(addr),
      });
    }),
  );

  // --- get_attestations -------------------------------------------------
  server.registerTool(
    'get_attestations',
    {
      title: 'Get attestations',
      description:
        'Return ERC-8004 on-chain attestations and voluntary Tier 1 / Tier 3 signal events for a wallet. Tier 1 = receipt-gated (e.g. x402 / pay.sh-routed). Tier 3 = declared identity (manifests, claims). For Celo/Arc agents this returns the on-chain ERC-8004 ReputationRegistry feedback. Pass `chain` to disambiguate an EVM 0x address.',
      inputSchema: {
        wallet: walletSchema,
        chain: chainSchema,
        limit: intParam().min(1).max(200).optional()
          .describe('Max signal events returned (1–200, default 50).'),
      },
      annotations: readOnly(),
    },
    async ({ wallet: addr, chain, limit }) => runTool('get_attestations', async () => {
      // EVM (Celo/Arc): the attestation surface IS the on-chain ERC-8004
      // ReputationRegistry feedback — the Solana signal_events table is empty
      // for these. Read it directly rather than via resolveAttestations. Honor
      // an explicit EVM chain hint even when no DB row matched (chain=null).
      const resolved = await resolveAgentChain(addr, chain);
      const evmChain: 'celo' | 'arc' | null =
        resolved.chain === 'celo' || resolved.chain === 'arc'
          ? resolved.chain
          : resolved.addressClass === 'evm' && (chain === 'celo' || chain === 'arc')
            ? chain
            : null;
      if (evmChain) {
        const snap = await resolveEvmKarma(addr, evmChain, resolved.wallet);
        if (!snap) return notFound(addr);
        const fb = snap.onChainFeedback;
        return jsonResult({
          wallet: addr,
          chain: evmChain,
          agentId: snap.agentId,
          erc8004: {
            count: fb?.count ?? 0,
            averageScore: fb?.average ?? null,
            records: (fb?.records ?? []).slice(0, limit ?? 50),
          },
          voluntary: [],
          explorerUrls: snap.explorerUrls,
        });
      }
      const bundle = await resolveAttestations(addr, limit ?? 50);
      return jsonResult(bundle);
    }),
  );

  // --- get_score_history ------------------------------------------------
  server.registerTool(
    'get_score_history',
    {
      title: 'Get score history',
      description:
        'READ-ONLY. Return the agent\'s Karma score trend — the chronological score snapshots AgentKarma has recorded — so you can see whether its reputation is RISING or FALLING before paying. Each point is { score, calculatedAt }. Works for any chain by address; pass `chain` to disambiguate an EVM 0x address.',
      inputSchema: {
        wallet: walletSchema,
        chain: chainSchema,
        limit: intParam().min(1).max(200).optional()
          .describe('Max trend points returned, oldest→newest (1–200, default 30).'),
      },
      annotations: readOnly(),
    },
    async ({ wallet: addr, chain, limit }) => runTool('get_score_history', async () => {
      // Validate/resolve the chain (also rejects junk addresses cleanly). The
      // scores table is keyed by wallet_address only (chain-agnostic), so the
      // resolved chain is surfaced for context but not used to scope the read.
      const resolved = await resolveAgentChain(addr, chain);
      const history = await getScoreHistory(addr, limit ?? 30);
      if (history.length === 0) return notFound(addr);
      return jsonResult({
        chain: resolved.chain,
        address: addr,
        count: history.length,
        points: history.map((p) => ({ score: p.score, calculatedAt: p.calculated_at })),
        profileUrl: profileUrl(addr),
      });
    }),
  );

  // --- get_leaderboard --------------------------------------------------
  server.registerTool(
    'get_leaderboard',
    {
      title: 'Get leaderboard',
      description:
        'READ-ONLY. Return the top-ranked agents by Karma score (highest first), each with address, chain, displayName, score, trustTier, confidence badge and tx count. Use to discover the most-trusted agents in the ecosystem. Pass `chain` to scope to one chain; omit to span all.',
      inputSchema: {
        chain: chainFilterSchema,
        limit: intParam().min(1).max(50).optional()
          .describe('Number of top agents returned (1–50, default 10).'),
      },
      annotations: readOnly(),
    },
    async ({ chain, limit }) => runTool('get_leaderboard', async () => {
      const take = limit ?? 10;
      const { wallets, total } = await getLeaderboard(take, 0, { chain });
      const deliveryMap = await getFeedbackSummariesForWallets(wallets.map((w) => w.address));
      return jsonResult({
        chain: chain ?? null,
        total,
        count: wallets.length,
        agents: wallets.map((w, i) => {
          const delivery = deliveryMap.get(w.address) ?? null;
          return {
            rank: i + 1,
            address: w.address,
            chain: w.chain,
            displayName: w.display_name ?? null,
            score: Number(w.score),
            providerScore: w.provider_score != null ? Number(w.provider_score) : Number(w.score),
            consumerScore: w.consumer_score != null ? Number(w.consumer_score) : null,
            confidenceBadge: w.confidence_badge ?? 'declared',
            trustTier: w.trust_tier,
            txCount: w.tx_count,
            lastSeen: w.last_seen,
            delivery: delivery
              ? { total: delivery.total, deliveryRate: delivery.deliveryRate }
              : null,
            profileUrl: profileUrl(w.address),
          };
        }),
      });
    }),
  );

  // --- get_stats --------------------------------------------------------
  server.registerTool(
    'get_stats',
    {
      title: 'Get ecosystem stats',
      description:
        'READ-ONLY. Return AgentKarma\'s ecosystem aggregates — total scored agents, total indexed receipt transactions, total USDC volume, the trust-tier distribution, and the per-chain ERC-8004 registry-mirror totals. No params required. Use for a one-shot overview of how much agent activity AgentKarma has indexed.',
      inputSchema: {
        chain: chainFilterSchema,
      },
      annotations: readOnly(),
    },
    async ({ chain }) => runTool('get_stats', async () => {
      // getStats is the hardened, best-effort aggregate helper (SQL RPCs, never a
      // full-table scan — see the 2026-06-18 schema-cache/timeout incident). It
      // is ecosystem-wide; the optional `chain` lets a caller narrow the
      // per-chain registry block while the global figures stay whole.
      const stats = await getStats();
      const registries = chain
        ? stats.registries.filter((r) => r.chain === chain)
        : stats.registries;
      return jsonResult({
        chainFilter: chain ?? null,
        totalAgents: stats.totalAgents,
        totalTransactions: stats.totalTransactions,
        totalVolumeUsdc: stats.totalVolumeUsdc,
        tierDistribution: stats.tierDistribution,
        registries,
      });
    }),
  );

  // --- get_succession ---------------------------------------------------
  server.registerTool(
    'get_succession',
    {
      title: 'Get succession plan (Dead Man\'s Switch)',
      description:
        'READ-ONLY. Return the agent\'s declared succession plan (Dead Man\'s Switch) plus AgentKarma\'s OBSERVED heartbeat liveness — derived status, heir count, deadline, seconds since last heartbeat. A real continuity/trust signal: an agent with a live, well-formed will is safer to depend on. AgentKarma never holds a key, funds, or executes the will (non-custody). Works for any chain by address; pass `chain` to disambiguate an EVM 0x address. Returns not-found when no plan is declared.',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr, chain }) => runTool('get_succession', async () => {
      const resolved = await resolveAgentChain(addr, chain);
      const resolvedChain: Chain = resolved.chain ?? (chain as Chain | undefined) ?? 'solana';

      const succession = await getSuccession(addr, resolvedChain);
      if (!succession) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'no_succession_plan',
              wallet: addr,
              chain: resolvedChain,
              message: 'This agent has declared no succession plan (Dead Man\'s Switch).',
            }),
          }],
        };
      }

      // Heartbeat = the agent's last meaningful tx. Bounded fetch; only the most
      // recent matters. Empty for chains/agents without indexed txs.
      let lastTxAt: string | null = null;
      try {
        const recent = await getRecentTransactionsForWallet(addr, 1);
        lastTxAt = recent[0]?.timestamp ?? null;
      } catch {
        lastTxAt = null;
      }

      const liveness = deriveSuccessionLiveness({
        succession: { status: succession.status, interval_seconds: succession.interval_seconds },
        lastMeaningfulTxAt: lastTxAt ?? succession.last_heartbeat_at,
      });

      return jsonResult({
        chain: resolvedChain,
        address: addr,
        succession: buildSuccessionView(succession, liveness),
        profileUrl: profileUrl(addr),
      });
    }),
  );

  // --- get_bond ---------------------------------------------------------
  server.registerTool(
    'get_bond',
    {
      title: 'Get bonding / surety status',
      description:
        'READ-ONLY. Return the agent\'s bonding posture two ways: (1) surety bonds taken out ON this agent (third parties staked that it will deliver) split into open vs resolved, and (2) this wallet\'s own underwriting activity plus its orthogonal Surety Karma. A bond lifts the bonded agent\'s confidence/Tier-1 presence only — never its trust ceiling; Surety Karma is never folded into Provider/Consumer karma. Demo/seeded bonds are flagged isDemo. AgentKarma never holds the bond nor resolves it (non-custody). Works for any chain by address; pass `chain` to disambiguate an EVM 0x address.',
      inputSchema: walletShape,
      annotations: readOnly(),
    },
    async ({ wallet: addr, chain }) => runTool('get_bond', async () => {
      const resolved = await resolveAgentChain(addr, chain);
      const resolvedChain: Chain = resolved.chain ?? (chain as Chain | undefined) ?? 'solana';

      const [bonds, positions] = await Promise.all([
        getBondsForAgent(addr, resolvedChain),
        getUnderwriterPositions(addr, resolvedChain),
      ]);

      const views = bonds.map(buildBondView);
      const open = views.filter((b) => !isBondSettled(b.status) && b.status !== 'expired');
      const resolvedBonds = views.filter((b) => isBondSettled(b.status) || b.status === 'expired');
      const totalBondedUsdc = views.reduce(
        (sum, b) => sum + (b.currency === 'USDC' ? b.amount : 0),
        0,
      );
      const hasDemo = views.some((b) => b.isDemo);

      const suretyResult = computeSurety(positions.map(toSuretyPosition));
      const surety = suretyResult ? buildSuretyView(suretyResult) : null;

      if (views.length === 0 && surety == null) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'no_bond_activity',
              wallet: addr,
              chain: resolvedChain,
              message: 'No bonds taken on this agent and no underwriting activity by it.',
            }),
          }],
        };
      }

      return jsonResult({
        chain: resolvedChain,
        address: addr,
        bonds: {
          open,
          resolved: resolvedBonds,
          totalBondedUsdc: Math.round(totalBondedUsdc * 1e6) / 1e6,
          hasDemo,
        },
        surety,
        profileUrl: profileUrl(addr),
      });
    }),
  );
}

function faceJson(b: { score: number; trustTier: string; confidenceBadge: string; hasSignal: boolean; metrics: Record<string, number> | null; tierAggregates: Record<string, number | null> | null }) {
  return {
    score: b.score,
    trustTier: b.trustTier,
    confidenceBadge: b.confidenceBadge,
    hasSignal: b.hasSignal,
    metrics: b.metrics,
    tierAggregates: b.tierAggregates,
  };
}

function profileUrl(addr: string): string {
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';
  return `${origin}/agent/${addr}`;
}

function jsonResult(payload: unknown) {
  const text = JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

function notFound(addr: string) {
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'wallet_not_found',
        wallet: addr,
        message: 'No indexed transactions or wallet record found. AgentKarma indexes pay.sh / x402 / MPP-on-Solana receipts; wallets without on-chain agent activity won\'t appear.',
      }),
    }],
  };
}

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * Universal tool backstop: run a tool body and convert ANY thrown error into a
 * clean, generic MCP result instead of leaking a raw viem contract-revert or
 * Postgres stack to the caller (the get_celo_agent tokenURI-revert dump being
 * the canonical case). Returned (not thrown) error results pass through
 * untouched.
 *
 * SECURITY: the raw error string is NEVER echoed to the caller — this endpoint
 * is public and unauthenticated, and a DB/RPC error can carry connection
 * strings, internal hostnames, or file paths. On-chain reverts mean the
 * id/address simply doesn't exist (a benign not-found); anything else is logged
 * server-side only and surfaced as a generic message.
 */
export async function runTool(tool: string, fn: () => Promise<ToolText>): Promise<ToolText> {
  try {
    return await fn();
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const missing = /revert|nonexistent|does not exist|not found|invalid token|out of bounds|ERC721|owner query/i.test(raw);
    if (!missing) console.error(`[runTool:${tool}]`, err); // full detail, server-side only
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: missing ? 'not_found' : 'tool_error',
            tool,
            message: missing
              ? `No on-chain record matched this ${tool} lookup — check the id / address and chain.`
              : `${tool} encountered an unexpected error. Try again, or verify the id / address and chain.`,
          },
          null,
          2,
        ),
      }],
    };
  }
}

// --- HTTP route handlers --------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
} as const;

async function handle(request: Request): Promise<Response> {
  // Stateless: each request gets a fresh transport. No session ID is required
  // by callers — fine for Claude Desktop / Cursor / Continue and for Cloudflare-
  // style edge runtimes if we ever switch.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await buildServer().connect(transport);
  const response = await transport.handleRequest(request);

  // Layer CORS onto the SDK response (it doesn't add them by default).
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) merged.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  // Real MCP clients open a GET SSE stream and carry one of: Accept:
  // text/event-stream, an Mcp-Session-Id, or an Mcp-Protocol-Version header.
  // Vanilla liveness probes (8004scan, uptime checkers, browsers) carry none
  // of these — return a friendly 200 discovery pointer instead of letting the
  // SDK 4xx the probe and flag the endpoint Unhealthy.
  const accept = request.headers.get('accept') ?? '';
  const isMcpClient =
    accept.includes('text/event-stream') ||
    request.headers.get('mcp-session-id') !== null ||
    request.headers.get('mcp-protocol-version') !== null;

  if (!isMcpClient) {
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';
    return Response.json(
      {
        server: SERVER_INFO.name,
        title: SERVER_INFO.title,
        version: SERVER_INFO.version,
        transport: 'streamable-http',
        protocolVersion: '2025-06-18',
        hint: 'POST JSON-RPC messages to this endpoint to interact with the MCP server.',
        serverCard: `${origin}/.well-known/mcp/server-card.json`,
        docs: `${origin}/docs/mcp`,
      },
      {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
        },
      },
    );
  }
  return handle(request);
}

export async function DELETE(request: Request) {
  return handle(request);
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
