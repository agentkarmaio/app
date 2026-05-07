import { promises as fs } from 'fs';
import path from 'path';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { parseMarkdown, Section } from '@/lib/markdown';

const SITE_URL = 'https://agentkarma.io';

export const metadata = {
  title: 'Karma Protocol — Specification',
  description: 'Open specification for multi-tier reputation scoring of autonomous on-chain agents on Solana. Four-tier signal spectrum, two-faced karma, ERC-8004 export.',
  alternates: { canonical: '/protocol' },
  openGraph: {
    type: 'article' as const,
    url: `${SITE_URL}/protocol`,
    title: 'Karma Protocol — open specification',
    description: 'Multi-tier reputation scoring for autonomous on-chain agents on Solana.',
  },
};

export default async function ProtocolPage() {
  const rfcPath = path.join(process.cwd(), 'docs', 'rfc', 'karma-protocol.md');
  let content: string;
  try {
    content = await fs.readFile(rfcPath, 'utf-8');
  } catch {
    content = 'RFC document not found.';
  }

  const { version, status, date } = extractRFCMetadata(content);
  const sections = parseMarkdown(content);

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: `Karma Protocol — Specification (${status} v${version})`,
    description:
      'Open specification for multi-tier reputation scoring of autonomous on-chain agents on Solana.',
    inLanguage: 'en',
    author: { '@type': 'Person', name: 'Kerem Noras' },
    publisher: {
      '@type': 'Organization',
      name: 'AgentKarma',
      logo: { '@type': 'ImageObject', url: `${SITE_URL}/brand/agentkarma-dark-X.png` },
    },
    datePublished: date,
    dateModified: date,
    url: `${SITE_URL}/protocol`,
    mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE_URL}/protocol` },
    keywords:
      'reputation, autonomous agents, Solana, x402, pay.sh, ERC-8004, MCP, Karma protocol',
    articleSection: 'Specification',
    isPartOf: { '@type': 'WebSite', name: 'AgentKarma', url: SITE_URL },
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'AgentKarma', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Protocol', item: `${SITE_URL}/protocol` },
    ],
  };

  return (
    <div className="space-y-8">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      <div>
        <h1 className="text-[32px] font-[510] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
          Karma Protocol
        </h1>
        <p className="mt-1.5 text-[15px] text-[#8a8f98] tracking-[-0.165px]">
          Open specification for multi-tier reputation scoring of autonomous on-chain agents on Solana.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <span className="inline-flex items-center rounded-md bg-[rgb(255_165_0/0.12)] px-2 py-0.5 text-[11px] font-[510] text-[#f5a623] border border-[rgb(255_165_0/0.2)]">
            {status} v{version}
          </span>
          <span className="text-[12px] text-[#62666d]">
            Last updated: {date}
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] p-6 sm:p-8">
        <article className="prose-protocol space-y-6">
          {sections.map((section, i) => (
            <Section key={i} {...section} />
          ))}
        </article>
      </div>
    </div>
  );
}

function extractRFCMetadata(md: string): { version: string; status: string; date: string } {
  const head = md.split('\n').slice(0, 40).join('\n');
  const version = head.match(/\*\*Version:\*\*\s*([^\s(]+)/)?.[1] ?? '0.0.0';
  const status = head.match(/\*\*Status:\*\*\s*(\w+)/)?.[1] ?? 'Draft';
  const rawDate = head.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/)?.[1];
  const date = rawDate
    ? new Date(rawDate + 'T00:00:00Z').toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : 'unknown';
  return { version, status, date };
}
