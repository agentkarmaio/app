import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // The actual PDF lives at /files/deck.pdf so iframe/PDF.js can fetch it;
      // /deck.pdf 302s to the gated, OpenReplay-recorded viewer page.
      { source: "/deck.pdf", destination: "/deck", permanent: false },
    ];
  },
  async rewrites() {
    return [
      // SEP-1649 MCP server card discovery. Next.js App Router treats folders
      // beginning with "." as private, so the route handler lives under
      // `app/well-known/...` and we rewrite the canonical URL to it.
      { source: "/.well-known/mcp/server-card.json", destination: "/well-known/mcp/server-card.json" },
      // ERC-8004 agent registration file. AK's Celo IdentityRegistry record
      // (tokenId minted from 0xCfc0…5b96) references this URI as its agentURI.
      { source: "/.well-known/agent.json", destination: "/well-known/agent.json" },
      // A2A AgentCard (protocolVersion 0.3.0) — AgentKarma's own agent surface;
      // its skills are the reputation tools, served over MCP.
      { source: "/.well-known/agent-card.json", destination: "/well-known/agent-card.json" },
      // llmstxt.org spec — surface llms.txt + llms-full.txt at the well-known
      // location too. The canonical URL is the root one, but answer engines
      // probing /.well-known/ expect to find them there.
      { source: "/.well-known/llms.txt", destination: "/llms.txt" },
      { source: "/.well-known/llms-full.txt", destination: "/llms-full.txt" },
    ];
  },
};

export default nextConfig;
