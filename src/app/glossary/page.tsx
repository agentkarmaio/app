import { promises as fs } from 'fs';
import path from 'path';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { parseMarkdown, Section } from '@/lib/markdown';

const SITE_URL = 'https://agentkarma.io';

export const metadata: Metadata = {
  title: 'Glossary',
  description:
    'Canonical definitions for every AgentKarma term — Provider Karma, Consumer Karma, confidence badge, signal tiers, x402, pay.sh, ERC-8004, MCP, autonomy confidence, sybil resistance.',
  alternates: { canonical: '/glossary' },
  openGraph: {
    type: 'article',
    url: `${SITE_URL}/glossary`,
    title: 'AgentKarma Glossary',
    description: 'Quick-reference definitions for terms used across pitches, docs, and code.',
  },
};

interface Term {
  name: string;
  description: string;
}

/**
 * Parse a glossary.md file into atomic { term, definition } pairs.
 *
 * Glossary entries follow `**Term** — definition...` (em-dash). Multi-line
 * definitions are flattened to the first sentence — that's enough for the
 * structured-data block. The full markdown still renders below.
 */
function parseGlossaryTerms(md: string): Term[] {
  const lines = md.split('\n');
  const terms: Term[] = [];
  for (const line of lines) {
    const m = line.match(/^\*\*([^*]+?)\*\*\s+—\s+(.+)$/);
    if (m) {
      terms.push({ name: m[1].trim(), description: m[2].trim() });
    }
  }
  return terms;
}

export default async function GlossaryPage() {
  const glossaryPath = path.join(process.cwd(), 'docs', 'glossary.md');
  const content = await fs.readFile(glossaryPath, 'utf-8').catch(() => '');
  const sections = parseMarkdown(content);
  const terms = parseGlossaryTerms(content);

  const definedTermSetLd = {
    '@context': 'https://schema.org',
    '@type': 'DefinedTermSet',
    name: 'AgentKarma Glossary',
    url: `${SITE_URL}/glossary`,
    description:
      'Canonical definitions for AgentKarma — the reputation layer for autonomous on-chain agents on Solana.',
    hasDefinedTerm: terms.map((t) => ({
      '@type': 'DefinedTerm',
      name: t.name,
      description: t.description,
      inDefinedTermSet: `${SITE_URL}/glossary`,
    })),
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'AgentKarma', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Glossary', item: `${SITE_URL}/glossary` },
    ],
  };

  return (
    <div className="space-y-8">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
        dangerouslySetInnerHTML={{ __html: JSON.stringify(definedTermSetLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured-data emission
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
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
          Glossary
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-[#8a8f98] tracking-[-0.165px]">
          Quick-reference definitions for terms used across pitches, docs, code, and
          the Karma Protocol RFC. {terms.length} terms.
        </p>
      </header>

      <article className="prose prose-invert max-w-none">
        {sections.map((s, i) => (
          <Section key={i} {...s} />
        ))}
      </article>

      <footer className="rounded-lg border border-[rgb(113_112_255/0.20)] bg-gradient-to-br from-[rgb(113_112_255/0.06)] to-[rgb(113_112_255/0.02)] p-5 text-sm text-[#d0d6e0]">
        Looking for the formal specification?{' '}
        <Link href="/protocol" className="font-[590] text-[#8a92ff] hover:text-[#a9b0ff]">
          Read the Karma Protocol RFC →
        </Link>
      </footer>
    </div>
  );
}
