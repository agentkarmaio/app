import Link from 'next/link';
import Image from 'next/image';

const NAV_GROUPS: { heading: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Leaderboard', href: '/' },
      { label: 'Explore agents', href: '/explore' },
      { label: 'pay.sh providers', href: '/paysh' },
      { label: 'Enterprise', href: '/enterprise' },
      { label: 'Specimen agent', href: '/specimen' },
    ],
  },
  {
    heading: 'Developers',
    links: [
      { label: 'Karma Protocol RFC', href: '/protocol' },
      { label: 'MCP server', href: '/docs/mcp' },
      { label: 'Embeddable widget', href: '/widget' },
      { label: 'Score API', href: '/api/v2/score/BPMEefwk2VV3Ntt7ZKvBT5KDgTcRJ9Wy28Qj5r1mQCiD', external: true },
      { label: 'Stats API', href: '/api/stats', external: true },
    ],
  },
  {
    heading: 'Reference',
    links: [
      { label: 'FAQ', href: '/faq' },
      { label: 'Glossary', href: '/glossary' },
      { label: 'Pitch deck', href: '/deck.pdf', external: true },
      { label: 'agentkarma.json', href: '/.well-known/agentkarma.json', external: true },
      { label: 'llms.txt', href: '/llms.txt', external: true },
    ],
  },
];

const SOCIAL_LINKS: { label: string; href: string }[] = [
  { label: 'X', href: 'https://x.com/agentkarmaio' },
  { label: 'GitHub', href: 'https://github.com/agentkarma' },
];

function XGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function GitHubGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.18c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.07.78 2.16v3.2c0 .31.21.68.79.56 4.57-1.52 7.86-5.83 7.86-10.91C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

const SOCIAL_GLYPHS: Record<string, (props: { className?: string }) => React.ReactNode> = {
  X: XGlyph,
  GitHub: GitHubGlyph,
};

export function Footer() {
  return (
    <footer className="mt-20 border-t border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.01)]">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(0,1fr))] lg:gap-8">
          <div className="space-y-3">
            <Link href="/" className="inline-flex items-center gap-2">
              <Image
                src="/brand/agentkarma-dark-X-transparent.png"
                alt="AgentKarma"
                width={28}
                height={28}
                className="size-7"
              />
              <span className="text-[14px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
                AgentKarma
              </span>
            </Link>
            <p className="max-w-xs text-[12.5px] leading-relaxed text-[#62666d]">
              The reputation layer for autonomous on-chain agents on Solana.
              Four-tier signal spectrum, two-faced karma, ERC-8004 attestations.
            </p>
            <div className="flex items-center gap-3 pt-1">
              {SOCIAL_LINKS.map((s) => {
                const Glyph = SOCIAL_GLYPHS[s.label];
                return (
                  <a
                    key={s.label}
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={s.label}
                    className="text-[#62666d] transition-colors hover:text-[#d0d6e0]"
                  >
                    {Glyph ? <Glyph className="size-4" /> : <span>{s.label}</span>}
                  </a>
                );
              })}
            </div>
          </div>

          {NAV_GROUPS.map((group) => (
            <div key={group.heading} className="space-y-3">
              <h3 className="text-[10px] font-[510] uppercase tracking-[0.12em] text-[#4f5258]">
                {group.heading}
              </h3>
              <ul className="space-y-1.5">
                {group.links.map((l) => (
                  <li key={l.href}>
                    {l.external ? (
                      <a
                        href={l.href}
                        target={l.href.startsWith('/') ? undefined : '_blank'}
                        rel={l.href.startsWith('/') ? undefined : 'noopener noreferrer'}
                        className="text-[12.5px] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
                      >
                        {l.label}
                      </a>
                    ) : (
                      <Link
                        href={l.href}
                        className="text-[12.5px] text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
                      >
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-[rgb(255_255_255/0.04)] pt-5 sm:flex-row sm:items-center">
          <p className="text-[11px] text-[#4f5258]">
            © {new Date().getFullYear()} AgentKarma · Built by{' '}
            <a
              href="https://x.com/agentkarmaio"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#62666d] transition-colors hover:text-[#d0d6e0]"
            >
              Kerem Noras
            </a>{' '}
            for Colosseum Frontier
          </p>
          <p className="text-[11px] text-[#4f5258]">
            <a href="/sitemap.xml" className="transition-colors hover:text-[#d0d6e0]">
              sitemap
            </a>{' '}
            ·{' '}
            <a href="/robots.txt" className="transition-colors hover:text-[#d0d6e0]">
              robots
            </a>{' '}
            ·{' '}
            <a href="/.well-known/mcp/server-card.json" className="transition-colors hover:text-[#d0d6e0]">
              MCP card
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
