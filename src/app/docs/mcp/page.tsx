import Link from 'next/link';
import { ArrowLeft, Plug, Terminal, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock } from '@/components/karma/code-block';

export const metadata = {
  title: 'AgentKarma MCP Server — Reputation Tools for AI Agents',
  description:
    'Add AgentKarma to Claude Desktop, Cursor, Continue, or any MCP-compatible client. Look up Provider + Consumer Karma, confidence badges, and ERC-8004 attestations before paying or delegating.',
};

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';
const MCP_ENDPOINT = `${APP_URL}/mcp`;

const TOOLS: Array<{ name: string; signature: string; purpose: string }> = [
  {
    name: 'get_karma',
    signature: 'get_karma(wallet)',
    purpose: 'Both faces in one call — provider + consumer scores, confidence badge, autonomy.',
  },
  {
    name: 'get_provider_karma',
    signature: 'get_provider_karma(wallet)',
    purpose: '"If I pay this agent, will it deliver?" — Tier 1 + Tier 3 dominant.',
  },
  {
    name: 'get_consumer_karma',
    signature: 'get_consumer_karma(wallet)',
    purpose: '"If I take work from this agent, will it pay me?" — Tier 2 dominant.',
  },
  {
    name: 'get_confidence',
    signature: 'get_confidence(wallet)',
    purpose: 'Badge plus per-tier signal breakdown (receipts vs behavior vs declared).',
  },
  {
    name: 'search_agents',
    signature: 'search_agents(query, limit?)',
    purpose: 'Find agent wallets by substring of the address. Ranked by score.',
  },
  {
    name: 'get_attestations',
    signature: 'get_attestations(wallet, limit?)',
    purpose: 'ERC-8004 on-chain attestations + voluntary Tier 1 / Tier 3 events.',
  },
];

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

const CURL_CALL_TOOL = `# Look up Karma for a wallet
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
          Drop AgentKarma into any MCP-compatible client and your agent can check the reputation of any
          Solana wallet before paying or delegating. Two-faced karma, on-chain attestations, confidence
          badge — all read-only, all in 30 seconds.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px]">
          <span className="inline-flex items-center rounded-md bg-[rgb(99_102_241/0.12)] px-2 py-0.5 font-[510] text-[#a5b4fc] border border-[rgb(99_102_241/0.2)]">
            streamable-http
          </span>
          <span className="text-[#62666d]">SEP-1649 server card</span>
          <span className="text-[#62666d]">·</span>
          <span className="text-[#62666d]">No auth required</span>
          <span className="text-[#62666d]">·</span>
          <a
            href="/.well-known/mcp/server-card.json"
            className="text-[#8a8f98] underline-offset-2 hover:text-[#f7f8f8] hover:underline"
          >
            server-card.json
          </a>
        </div>
      </div>

      {/* Endpoint card */}
      <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8] flex items-center gap-2">
            <Plug className="size-4" />
            Endpoint
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[13px] text-[#8a8f98]">
            Point any MCP client at the endpoint below. Uses{' '}
            <span className="font-mono text-[12px] text-[#d0d6e0]">streamable-http</span> transport
            (Anthropic&apos;s 2025-06-18 spec). No API key. Read-only — no DB writes.
          </p>
          <CodeBlock lang="text">{MCP_ENDPOINT}</CodeBlock>
        </CardContent>
      </Card>

      {/* Quick install */}
      <div className="grid gap-6 md:grid-cols-3">
        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
              Claude Desktop
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[12.5px] text-[#8a8f98]">
              Edit{' '}
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
          <p className="text-[11.5px] text-[#62666d]">
            Responses come back as Server-Sent Events (
            <span className="font-mono text-[11.5px] text-[#d0d6e0]">text/event-stream</span>) by
            default — same wire format any MCP client expects.
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
    </div>
  );
}
