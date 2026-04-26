import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/deck", destination: "/deck/index.html", permanent: false },
      { source: "/deck/", destination: "/deck/index.html", permanent: false },
    ];
  },
};

export default nextConfig;
