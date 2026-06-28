import type { Metadata, Viewport } from "next";
import "./globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import { Inter, JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import { OpenReplay } from "@/components/layout/openreplay";
import { SolanaWalletProvider } from "@/components/wallet/wallet-provider";
import { EvmWalletProvider } from "@/components/wallet/evm-wallet-provider";

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

const siteUrl = "https://agentkarma.io";
const siteTitle = "AgentKarma — Reputation Layer for Autonomous On-Chain Agents";
const siteDescription = "Passive, manipulation-resistant trust scores for any autonomous agent with a Solana footprint. Four-tier signal spectrum, two-faced karma, ERC-8004 attestations. x402-first, not x402-only.";
const ogImage = "/brand/agentkarma-dark-X.png";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: "%s — AgentKarma",
  },
  description: siteDescription,
  applicationName: "AgentKarma",
  manifest: "/site.webmanifest",
  alternates: {
    canonical: "/",
    types: {
      "text/plain": [
        { url: "/llms.txt", title: "llms.txt — overview for AI crawlers" },
        { url: "/llms-full.txt", title: "llms-full.txt — full content for AI ingestion" },
      ],
    },
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
  },
  authors: [{ name: "Kerem Noras", url: "https://x.com/agentkarmaio" }],
  creator: "Kerem Noras",
  publisher: "AgentKarma",
  category: "technology",
  keywords: [
    "AgentKarma",
    "Solana agent reputation",
    "autonomous agent reputation",
    "x402 reputation",
    "pay.sh reputation",
    "ERC-8004 attestation",
    "agent trust score",
    "MCP reputation",
    "agent identity",
    "on-chain reputation",
    "Provider Karma",
    "Consumer Karma",
    "Autonomy Confidence",
  ],
  openGraph: {
    type: "website",
    url: siteUrl,
    title: siteTitle,
    description: siteDescription,
    siteName: "AgentKarma",
    locale: "en_US",
    images: [{ url: ogImage, width: 2048, height: 2048, alt: "AgentKarma" }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@agentkarmaio",
    creator: "@agentkarmaio",
    title: siteTitle,
    description: siteDescription,
    images: [ogImage],
  },
};

export const viewport: Viewport = {
  themeColor: "#08090a",
};

const ORGANIZATION_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "AgentKarma",
  alternateName: "Karma",
  url: siteUrl,
  logo: `${siteUrl}/brand/agentkarma-dark-X.png`,
  description: siteDescription,
  sameAs: [
    "https://x.com/agentkarmaio",
    "https://github.com/agentkarma",
  ],
  founder: {
    "@type": "Person",
    name: "Kerem Noras",
    url: "https://x.com/agentkarmaio",
  },
} as const;

const WEBSITE_LD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "AgentKarma",
  url: siteUrl,
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: `${siteUrl}/explore?q={search_term_string}`,
    },
    "query-input": "required name=search_term_string",
  },
} as const;

const SOFTWARE_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "AgentKarma",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  url: siteUrl,
  description: siteDescription,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  featureList: [
    "Provider Karma + Consumer Karma scoring",
    "Confidence badge (receipt-backed / behavior-inferred / declared)",
    "Autonomy Confidence",
    "ERC-8004 attestation export",
    "Embeddable badge widget",
    "MCP server (streamable-http)",
    "Public REST API",
  ],
  audience: {
    "@type": "Audience",
    audienceType: "Developers, agent operators, x402 facilitators, marketplaces",
  },
} as const;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("dark font-sans", inter.variable, mono.variable)}>
      <body className="min-h-screen overflow-x-hidden bg-background antialiased">
        <SolanaWalletProvider>
          <EvmWalletProvider>
            <OpenReplay />
            <Navbar />
            <main className="mx-auto max-w-5xl px-4 py-8">
              {children}
            </main>
            <Footer />
          </EvmWalletProvider>
        </SolanaWalletProvider>
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION_LD) }}
        />
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
          dangerouslySetInnerHTML={{ __html: JSON.stringify(WEBSITE_LD) }}
        />
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
          dangerouslySetInnerHTML={{ __html: JSON.stringify(SOFTWARE_LD) }}
        />
      </body>
    </html>
  );
}
