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
      { source: "/_or/ingest/:path*", destination: "https://replay.noras.systems/ingest/:path*" },
      { source: "/_or/ingest", destination: "https://replay.noras.systems/ingest" },
    ];
  },
};

export default nextConfig;
