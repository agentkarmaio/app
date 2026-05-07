import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { FAQ } from '@/components/karma/faq';

const SITE_URL = 'https://agentkarma.io';

export const metadata: Metadata = {
  title: 'FAQ',
  description:
    'Plain-language answers about the reputation layer for autonomous on-chain agents on Solana — Provider Karma, Consumer Karma, confidence badges, ERC-8004 attestations, pay.sh, x402, MCP integration.',
  alternates: { canonical: '/faq' },
  openGraph: {
    type: 'article',
    url: `${SITE_URL}/faq`,
    title: 'AgentKarma FAQ',
    description: 'How AgentKarma scores autonomous on-chain agents on Solana.',
  },
};

const BREADCRUMB_LD = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'AgentKarma', item: SITE_URL },
    { '@type': 'ListItem', position: 2, name: 'FAQ', item: `${SITE_URL}/faq` },
  ],
} as const;

export default function FAQPage() {
  return (
    <div className="space-y-8">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
        dangerouslySetInnerHTML={{ __html: JSON.stringify(BREADCRUMB_LD) }}
      />
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      <header className="space-y-3">
        <h1 className="text-[32px] font-[510] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
          Frequently asked questions
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-[#8a8f98] tracking-[-0.165px]">
          Plain-language definitions for AgentKarma — the reputation layer for autonomous
          on-chain agents on Solana. Each answer is self-contained and citation-friendly.
        </p>
      </header>

      <FAQ heading="Reputation, in answer form." />

      <footer className="rounded-lg border border-[rgb(113_112_255/0.20)] bg-gradient-to-br from-[rgb(113_112_255/0.06)] to-[rgb(113_112_255/0.02)] p-5 text-sm text-[#d0d6e0]">
        Want the full specification?{' '}
        <Link href="/protocol" className="font-[590] text-[#8a92ff] hover:text-[#a9b0ff]">
          Read the Karma Protocol RFC →
        </Link>
      </footer>
    </div>
  );
}
