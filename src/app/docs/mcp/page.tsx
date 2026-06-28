import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, Package, Plug, Terminal, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock } from '@/components/karma/code-block';

export const metadata: Metadata = {
  title: 'AgentKarma MCP Server — Reputation Tools for AI Agents',
  description:
    'Run AgentKarma over MCP with `npx @agentkarma/mcp`, or point any client at the hosted streamable-http endpoint. Look up Provider + Consumer Karma, confidence badges, and ERC-8004 attestations before paying or delegating.',
};

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';
const MCP_ENDPOINT = `${APP_URL}/mcp`;
const NPM_MCP_URL = 'https://www.npmjs.com/package/@agentkarma/mcp';
const GITHUB_MCP_URL = 'https://github.com/agentkarmaio/mcp';

// Claude Desktop / Cursor run the turnkey package over stdio. One spawn line,
// no flags — `@agentkarma/mcp` bundles the SDK + MCP SDK so it works flagless.
const CLAUDE_DESKTOP_NPX = `{
  "mcpServers": {
    "agentkarma": {
      "command": "npx",
      "args": ["-y", "@agentkarma/mcp"]
    }
  }
}`;

const TOOLS: Array<{ name: string; signature: string; purpose: string }> = [
  {
    name: 'get_karma',
    signature: 'get_karma(wallet, chain?)',
    purpose: 'Both faces in one call — provider + consumer scores, confidence badge, autonomy. Any chain by address.',
  },
  {
    name: 'get_provider_karma',
    signature: 'get_provider_karma(wallet, chain?)',
    purpose: '"If I pay this agent, will it deliver?" — Tier 1 + Tier 3 dominant.',
  },
  {
    name: 'get_consumer_karma',
    signature: 'get_consumer_karma(wallet, chain?)',
    purpose: '"If I take work from this agent, will it pay me?" — Tier 2 dominant (Solana-only; EVM agents declared-tier).',
  },
  {
    name: 'get_confidence',
    signature: 'get_confidence(wallet, chain?)',
    purpose: 'Badge plus per-tier signal breakdown (receipts vs behavior vs declared).',
  },
  {
    name: 'search_agents',
    signature: 'search_agents(query, limit?)',
    purpose: 'Find agents by substring of the name or address, across all chains. Ranked by score.',
  },
  {
    name: 'get_attestations',
    signature: 'get_attestations(wallet, chain?, limit?)',
    purpose: 'ERC-8004 on-chain attestations + voluntary Tier 1 / Tier 3 events. Celo/Arc → on-chain ReputationRegistry feedback.',
  },
  {
    name: 'get_celo_agent',
    signature: 'get_celo_agent(agentId)',
    purpose: 'Celo ERC-8004 agent by agentId (uint) — IdentityRegistry + ReputationRegistry. By address: use get_karma(wallet, "celo").',
  },
  {
    name: 'get_stellar_karma',
    signature: 'get_stellar_karma(wallet)',
    purpose: 'Stellar (G…) agent Karma + on-chain ERC-8004 attestation from the Soroban ReputationRegistry.',
  },
  {
    name: 'get_arc_karma',
    signature: 'get_arc_karma(wallet)',
    purpose: 'Arc (EVM 0x) agent Karma. Circle’s USDC-native L1; ERC-8183 settlements as Tier-1 signals.',
  },
  {
    name: 'get_score_history',
    signature: 'get_score_history(wallet, chain?, limit?)',
    purpose: 'Score trend over time — is this agent’s reputation rising or falling? Read-only.',
  },
  {
    name: 'get_leaderboard',
    signature: 'get_leaderboard(chain?, limit?)',
    purpose: 'Top-ranked agents by score — address, chain, displayName, trustTier. Filter by chain. Read-only.',
  },
  {
    name: 'get_stats',
    signature: 'get_stats(chain?)',
    purpose: 'Ecosystem aggregates — total agents, transactions, USDC volume, tier distribution, registry mirror. Read-only.',
  },
  {
    name: 'get_succession',
    signature: 'get_succession(wallet, chain?)',
    purpose: 'Dead Man’s Switch / succession plan + observed heartbeat liveness. Read-only, non-custody.',
  },
  {
    name: 'get_bond',
    signature: 'get_bond(wallet, chain?)',
    purpose: 'Bonding posture — surety bonds on the agent + its own underwriting & Surety Karma. Read-only, non-custody.',
  },
];

/** The optional `chain` enum accepted by the address-based tools. */
const CHAIN_VALUES = ['solana', 'celo', 'stellar', 'arc'] as const;

const CLAUDE_DESKTOP_CONFIG = `{
  "mcpServers": {
    "agentkarma": {
      "url": "${MCP_ENDPOINT}"
    }
  }
}`;

const CURSOR_CONFIG = `{
  "mcpServers": {
    "agentkarma": {
      "url": "${MCP_ENDPOINT}"
    }
  }
}`;

const CONTINUE_CONFIG = `{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "streamable-http",
          "url": "${MCP_ENDPOINT}"
        }
      }
    ]
  }
}`;

const CURL_LIST_TOOLS = `# Smoke test: list the tools the MCP server exposes
curl -X POST '${MCP_ENDPOINT}' \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'`;

const CURL_CALL_TOOL = `# Look up Karma for a wallet (chain inferred from the address format)
curl -X POST '${MCP_ENDPOINT}' \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "get_karma",
      "arguments": { "wallet": "<SOLANA_WALLET>" }
    }
  }'`;

const CURL_CALL_TOOL_EVM = `# Look up an EVM agent by address — pass "chain" to pick Celo vs Arc
curl -X POST '${MCP_ENDPOINT}' \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "get_karma",
      "arguments": { "wallet": "0x<EVM_ADDRESS>", "chain": "celo" }
    }
  }'`;

export default function McpDocsPage() {
  return (
    <div className="space-y-8">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      <div>
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] px-2.5 py-0.5 text-[11px] font-[510] text-[#8a8f98]">
          <Sparkles className="size-3" />
          MCP server
        </div>
        <h1 className="text-[32px] font-[510] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
          Add AgentKarma to your agent
        </h1>
        <p className="mt-1.5 max-w-2xl text-[15px] text-[#8a8f98] tracking-[-0.165px]">
          Run <span className="font-mono text-[12px] text-[#d0d6e0]">npx @agentkarma/mcp</span> for a
          turnkey local server, or point any client at the hosted endpoint — either way your agent can
          check the reputation of any agent wallet (Solana, Stellar, Celo, or Arc) before paying or
          delegating. Two-faced karma, on-chain attestations, confidence badge — all read-only. The
          chain is inferred from the address; pass{' '}
          <span className="font-mono text-[12px] text-[#d0d6e0]">chain</span>{' '}
          only to disambiguate an EVM <span className="font-mono text-[12px] text-[#d0d6e0]">0x</span> address (Celo vs Arc).
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px]">
          <a
            href={NPM_MCP_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-[rgb(99_102_241/0.12)] px-2 py-0.5 font-[510] text-[#a5b4fc] border border-[rgb(99_102_241/0.2)] hover:text-[#c7d2fe]"
          >
            @agentkarma/mcp
            <ArrowUpRight className="size-3" />
          </a>
          <span className="text-[#62666d]">stdio + streamable-http</span>
          <span className="text-[#62666d]">·</span>
          <span className="text-[#62666d]">No auth, read-only</span>
          <span className="text-[#62666d]">·</span>
          <a
            href="/.well-known/mcp/server-card.json"
            className="text-[#8a8f98] underline-offset-2 hover:text-[#f7f8f8] hover:underline"
          >
            server-card.json
          </a>
        </div>
      </div>

      {/* Turnkey package — the primary install path */}
      <Card className="border-[rgb(99_102_241/0.18)] bg-[rgb(99_102_241/0.04)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8] flex items-center gap-2">
            <Package className="size-4" />
            Turnkey package — <span className="font-mono text-[13px] text-[#a5b4fc]">@agentkarma/mcp</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[13px] text-[#8a8f98]">
            One command. <span className="font-mono text-[12px] text-[#d0d6e0]">npx @agentkarma/mcp</span>{' '}
            runs a local MCP server over stdio for Claude Desktop, Cursor, or any stdio client. It bundles
            the SDK and the MCP SDK, so it runs flag-free — no clone, no build. Add{' '}
            <span className="font-mono text-[12px] text-[#d0d6e0]">--http</span> to serve over HTTP instead.
          </p>
          <CodeBlock lang="bash">{`# stdio (Claude Desktop / Cursor)\nnpx @agentkarma/mcp\n\n# or run it as an HTTP server\nnpx @agentkarma/mcp --http`}</CodeBlock>
          <p className="text-[12px] text-[#8a8f98]">
            Then register it with Claude Desktop in{' '}
            <span className="font-mono text-[11.5px] text-[#d0d6e0]">
              ~/Library/Application Support/Claude/claude_desktop_config.json
            </span>:
          </p>
          <CodeBlock lang="json">{CLAUDE_DESKTOP_NPX}</CodeBlock>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-[11.5px]">
            <a href={NPM_MCP_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#8a8f98] hover:text-[#d0d6e0]">
              npm
              <ArrowUpRight className="size-3" />
            </a>
            <span className="text-[#62666d]">·</span>
            <a href={GITHUB_MCP_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#8a8f98] hover:text-[#d0d6e0]">
              GitHub
              <ArrowUpRight className="size-3" />
            </a>
            <span className="text-[#62666d]">·</span>
            <span className="text-[#62666d]">9 read tools · read-only · no keys</span>
          </div>
        </CardContent>
      </Card>

      {/* Hosted endpoint — zero-install alternative */}
      <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8] flex items-center gap-2">
            <Plug className="size-4" />
            Hosted endpoint — zero install
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[13px] text-[#8a8f98]">
            Don&apos;t want to run a process? Point any MCP client at the hosted endpoint below. Uses{' '}
            <span className="font-mono text-[12px] text-[#d0d6e0]">streamable-http</span> transport
            (Anthropic&apos;s 2025-06-18 spec). No API key. Read-only — no DB writes. The hosted server
            exposes the full {' '}
            <span className="font-mono text-[12px] text-[#d0d6e0]">14</span>-tool surface; the{' '}
            <span className="font-mono text-[12px] text-[#d0d6e0]">@agentkarma/mcp</span> package ships the
            9 most-used read tools.
          </p>
          <CodeBlock lang="text">{MCP_ENDPOINT}</CodeBlock>
        </CardContent>
      </Card>

      {/* Hosted client configs */}
      <div className="grid gap-6 md:grid-cols-3">
        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
              Claude Desktop (hosted)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[12.5px] text-[#8a8f98]">
              Prefer the hosted server over the local{' '}
              <span className="font-mono text-[11.5px] text-[#d0d6e0]">npx</span> package? Edit{' '}
              <span className="font-mono text-[11.5px] text-[#d0d6e0]">
                ~/Library/Application Support/Claude/claude_desktop_config.json
              </span>
              :
            </p>
            <CodeBlock lang="json">{CLAUDE_DESKTOP_CONFIG}</CodeBlock>
            <p className="text-[11.5px] text-[#62666d]">
              Restart Claude Desktop. AgentKarma tools appear in the tool picker.
            </p>
          </CardContent>
        </Card>

        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
              Cursor
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[12.5px] text-[#8a8f98]">
              Open Cursor settings → MCP and add:
            </p>
            <CodeBlock lang="json">{CURSOR_CONFIG}</CodeBlock>
            <p className="text-[11.5px] text-[#62666d]">
              Or paste into{' '}
              <span className="font-mono text-[11.5px] text-[#d0d6e0]">~/.cursor/mcp.json</span>.
            </p>
          </CardContent>
        </Card>

        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
              Continue
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[12.5px] text-[#8a8f98]">
              Add the MCP server to your{' '}
              <span className="font-mono text-[11.5px] text-[#d0d6e0]">~/.continue/config.json</span>:
            </p>
            <CodeBlock lang="json">{CONTINUE_CONFIG}</CodeBlock>
            <p className="text-[11.5px] text-[#62666d]">Reload your Continue window.</p>
          </CardContent>
        </Card>
      </div>

      {/* Tool reference */}
      <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            Tool reference
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)]">
                  <th className="px-4 py-2 text-left font-[510] text-[#8a8f98]">Tool</th>
                  <th className="px-4 py-2 text-left font-[510] text-[#8a8f98]">What it answers</th>
                </tr>
              </thead>
              <tbody className="text-[#d0d6e0]">
                {TOOLS.map((t) => (
                  <tr key={t.name} className="border-b border-[rgb(255_255_255/0.04)]">
                    <td className="px-4 py-2 font-mono text-[12px] whitespace-nowrap">
                      {t.signature}
                    </td>
                    <td className="px-4 py-2 text-[#8a8f98]">{t.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Manual / curl */}
      <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8] flex items-center gap-2">
            <Terminal className="size-4" />
            Smoke test (curl)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="mb-2 text-[12.5px] text-[#8a8f98]">List tools:</p>
            <CodeBlock lang="bash">{CURL_LIST_TOOLS}</CodeBlock>
          </div>
          <div>
            <p className="mb-2 text-[12.5px] text-[#8a8f98]">Call a tool:</p>
            <CodeBlock lang="bash">{CURL_CALL_TOOL}</CodeBlock>
          </div>
          <div>
            <p className="mb-2 text-[12.5px] text-[#8a8f98]">
              Call a tool on an EVM agent ({CHAIN_VALUES.filter((c) => c === 'celo' || c === 'arc').join(' or ')}):
            </p>
            <CodeBlock lang="bash">{CURL_CALL_TOOL_EVM}</CodeBlock>
          </div>
          <p className="text-[11.5px] text-[#62666d]">
            Responses come back as Server-Sent Events (
            <span className="font-mono text-[11.5px] text-[#d0d6e0]">text/event-stream</span>) by
            default — same wire format any MCP client expects.{' '}
            <span className="font-mono text-[11.5px] text-[#d0d6e0]">chain</span> accepts{' '}
            {CHAIN_VALUES.map((c) => (
              <span key={c} className="font-mono text-[11.5px] text-[#d0d6e0]">
                {c}{c === 'arc' ? '' : ' · '}
              </span>
            ))}
            and is only needed for ambiguous EVM 0x addresses.
          </p>
        </CardContent>
      </Card>

      {/* Invariants */}
      <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            What AgentKarma will (and won&apos;t) do
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-[13px] text-[#d0d6e0]">
            <li>
              <span className="text-[#8a8f98]">Will:</span> return Provider + Consumer karma,
              confidence badge, autonomy, ERC-8004 attestations, search by wallet substring.
            </li>
            <li>
              <span className="text-[#8a8f98]">Will:</span> always carry both karma faces and a
              confidence badge — never a single collapsed score.
            </li>
            <li>
              <span className="text-[#8a8f98]">Won&apos;t:</span> proxy paid HTTP calls. Pair this
              with{' '}
              <a
                href="https://pay.sh/docs/pay-for-apis/mcp"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-[#f7f8f8]"
              >
                pay.sh&apos;s MCP <span className="font-mono">curl</span>
              </a>{' '}
              for that — AgentKarma scores wallets, pay.sh moves the money.
            </li>
            <li>
              <span className="text-[#8a8f98]">Won&apos;t:</span> write to the database. All tools
              are read-only.
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* Building your own agent? — point at the SDK */}
      <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            Building your own agent in code?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[13px] text-[#8a8f98]">
            <span className="font-mono text-[12px] text-[#d0d6e0]">@agentkarma/mcp</span> wraps the
            framework-agnostic{' '}
            <a href="https://www.npmjs.com/package/@agentkarma/sdk" target="_blank" rel="noreferrer" className="font-mono text-[12px] text-[#a5b4fc] underline-offset-2 hover:underline">
              @agentkarma/sdk
            </a>. Import the SDK directly to call the same read API from a server, get the JSON-Schema
            tool catalog from{' '}
            <span className="font-mono text-[12px] text-[#d0d6e0]">@agentkarma/sdk/tools</span>, build a
            custom MCP server from{' '}
            <span className="font-mono text-[12px] text-[#d0d6e0]">@agentkarma/sdk/mcp</span>, or run the
            local <span className="font-mono text-[12px] text-[#d0d6e0]">check_trust</span> policy gate
            with zero network calls.
          </p>
          <Link
            href="/integrate"
            className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-[#d0d6e0] hover:text-[#f7f8f8] transition-colors"
          >
            SDK quickstart + reference
            <ArrowUpRight className="size-3.5" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
