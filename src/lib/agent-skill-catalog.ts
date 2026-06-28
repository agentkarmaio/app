/**
 * Single source of truth for AgentKarma's advertised agent capabilities.
 *
 * AgentKarma exposes its reputation features as 14 read-only MCP tools at
 * `/mcp`. Three artifacts describe that same surface to different consumers:
 *   - the MCP server itself (`src/app/mcp/route.ts`) — runtime tools + schemas
 *   - the MCP server card (`/.well-known/mcp/server-card.json`) — SEP-1649
 *   - the A2A agent card  (`/.well-known/agent-card.json`)      — A2A v0.3.0
 *
 * The two discovery cards derive their tool/skill lists from this catalog so a
 * new capability is declared once, not three times. The MCP route keeps its own
 * input schemas + handlers (runtime truth); names/titles here must match it.
 */

export interface AgentSkill {
  /** Stable id — identical to the MCP tool name. */
  id: string;
  /** Human title for cards. */
  title: string;
  /** What the capability does, one sentence. */
  description: string;
  /** A2A skill tags for discovery/filtering. */
  tags: string[];
  /** A2A skill usage examples (natural-language prompts). */
  examples: string[];
}

export const AGENT_SKILLS: readonly AgentSkill[] = [
  {
    id: 'get_karma',
    title: 'Get Karma (both faces)',
    description:
      'Look up the full Karma snapshot for any agent wallet (Solana, Stellar, Celo, Arc) by address — Provider + Consumer scores, confidence badge, and autonomy. Pass `chain` to disambiguate an EVM 0x address.',
    tags: ['reputation', 'karma', 'multichain', 'lookup'],
    examples: ['What is the Karma of 0x68961ac3…31b31 on Celo?'],
  },
  {
    id: 'get_provider_karma',
    title: 'Get Provider Karma',
    description: 'Provider face only — "If I pay this agent, will it deliver?". Any chain by address.',
    tags: ['reputation', 'provider', 'pre-payment'],
    examples: ['Should I trust this agent to deliver if I pay it?'],
  },
  {
    id: 'get_consumer_karma',
    title: 'Get Consumer Karma',
    description:
      'Consumer face only — "If I take work from this agent, will it pay me cleanly?". Any chain by address (EVM agents are declared-tier).',
    tags: ['reputation', 'consumer', 'counterparty'],
    examples: ['If I do work for this agent, will it settle cleanly?'],
  },
  {
    id: 'get_confidence',
    title: 'Get confidence badge',
    description:
      'Confidence badge plus per-tier signal breakdown (Tier 1 receipts vs Tier 2 behavior vs Tier 3 declared). Any chain by address.',
    tags: ['reputation', 'confidence', 'signal-tiers'],
    examples: ['Is this agent\'s score receipt-backed or just declared?'],
  },
  {
    id: 'search_agents',
    title: 'Search agents',
    description: 'Find agent wallets by substring of the name or address across all chains. Ranked by score.',
    tags: ['discovery', 'search', 'multichain'],
    examples: ['Find agents with "celina" in their name.'],
  },
  {
    id: 'get_attestations',
    title: 'Get attestations',
    description:
      'ERC-8004 on-chain attestations and voluntary Tier 1 / Tier 3 signal events for a wallet. For Celo/Arc, returns on-chain ReputationRegistry feedback.',
    tags: ['erc-8004', 'attestations', 'on-chain'],
    examples: ['Show the on-chain ERC-8004 feedback for this Celo agent.'],
  },
  {
    id: 'get_celo_agent',
    title: 'Get Celo agent (ERC-8004)',
    description:
      'Look up a Celo ERC-8004 agent by agentId (uint) — IdentityRegistry record + aggregate ReputationRegistry feedback. For lookup by address, use get_karma with chain:"celo".',
    tags: ['erc-8004', 'celo', 'identity'],
    examples: ['Get the ERC-8004 record for Celo agentId 9058.'],
  },
  {
    id: 'get_stellar_karma',
    title: 'Get Stellar agent Karma (both faces)',
    description:
      'Full Karma snapshot for a Stellar (G…) agent wallet plus the on-chain ERC-8004 attestation from the Soroban ReputationRegistry.',
    tags: ['reputation', 'stellar', 'soroban'],
    examples: ['What is the Karma of this Stellar G… agent?'],
  },
  {
    id: 'get_arc_karma',
    title: 'Get Arc agent Karma (both faces)',
    description:
      "Full Karma snapshot for an Arc (EVM 0x) agent wallet. Arc is Circle's USDC-native L1; AgentKarma indexes its ERC-8183 settlements as Tier-1 signals.",
    tags: ['reputation', 'arc', 'usdc', 'settlement'],
    examples: ['Get the Karma of this agent on Arc.'],
  },
  {
    id: 'get_score_history',
    title: 'Get score history',
    description:
      "Read-only. The agent's Karma score trend over time (score + timestamp points) so you can see whether its reputation is rising or falling. Any chain by address.",
    tags: ['reputation', 'history', 'trend'],
    examples: ['Is this agent\'s reputation rising or falling?'],
  },
  {
    id: 'get_leaderboard',
    title: 'Get leaderboard',
    description:
      'Read-only. Top-ranked agents by Karma score — address, chain, displayName, score, trustTier, confidence badge. Filter by chain or span all chains.',
    tags: ['discovery', 'leaderboard', 'ranking'],
    examples: ['Show the top 10 agents on Celo by Karma.'],
  },
  {
    id: 'get_stats',
    title: 'Get ecosystem stats',
    description:
      'Read-only. AgentKarma ecosystem aggregates — total scored agents, indexed receipt transactions, USDC volume, trust-tier distribution, and per-chain ERC-8004 registry-mirror totals.',
    tags: ['stats', 'ecosystem', 'aggregate'],
    examples: ['How many agents has AgentKarma scored across all chains?'],
  },
  {
    id: 'get_succession',
    title: "Get succession plan (Dead Man's Switch)",
    description:
      "Read-only, non-custody. The agent's declared succession plan plus AgentKarma's observed heartbeat liveness — a continuity/trust signal. Any chain by address.",
    tags: ['liveness', 'succession', 'continuity'],
    examples: ['Does this agent have a succession plan and is it still alive?'],
  },
  {
    id: 'get_bond',
    title: 'Get bonding / surety status',
    description:
      "Read-only, non-custody. The agent's bonding posture — surety bonds taken out on it plus its own underwriting activity and orthogonal Surety Karma. Any chain by address.",
    tags: ['bonding', 'surety', 'risk'],
    examples: ['Is this agent bonded? Who underwrote it?'],
  },
] as const;
