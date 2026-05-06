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
    ];
  },
};

export default nextConfig;
