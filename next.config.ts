import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/deck", destination: "/deck/index.html", permanent: false },
      { source: "/deck/", destination: "/deck/index.html", permanent: false },
    ];
  },
  async rewrites() {
    return [
      { source: "/_or/ingest/:path*", destination: "/api/or-ingest/:path*" },
      { source: "/_or/ingest", destination: "/api/or-ingest" },
      // SEP-1649 MCP server card discovery. Next.js App Router treats folders
      // beginning with "." as private, so the route handler lives under
      // `app/well-known/...` and we rewrite the canonical URL to it.
      { source: "/.well-known/mcp/server-card.json", destination: "/well-known/mcp/server-card.json" },
      // llmstxt.org spec — surface llms.txt + llms-full.txt at the well-known
      // location too. The canonical URL is the root one, but answer engines
      // probing /.well-known/ expect to find them there.
      { source: "/.well-known/llms.txt", destination: "/llms.txt" },
      { source: "/.well-known/llms-full.txt", destination: "/llms-full.txt" },
    ];
  },
};

export default nextConfig;
