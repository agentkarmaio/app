import Link from 'next/link';
import type { Metadata } from 'next';
import { AK_ARC } from '@/config/ak-validator';
import { agentHref } from '@/lib/agent-href';
import { arcTestnet } from '@/config/arc-chain';

export const metadata: Metadata = {
  title: 'Arc testnet archive — AgentKarma',
  alternates: { canonical: '/arc' },
  description: 'Arc testnet has retired from AgentKarma. Historical profiles remain available read-only; active Arc coverage is on mainnet.',
};

const linkClass = 'inline-flex min-h-11 items-center rounded underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring';

export default function ArcPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">Historical coverage · Chain {arcTestnet.id}</p>
        <h1 className="text-3xl font-medium tracking-tight">Arc testnet is retired</h1>
        <p className="max-w-xl text-muted-foreground">
          Testnet indexing, scoring, and writes have ended. Existing profiles and
          payment history remain available read-only, separate from Arc mainnet.
        </p>
      </header>
      <Link href="/arc/mainnet" className={linkClass}>View Arc mainnet coverage</Link>
      <section className="space-y-3 border-t border-border pt-6" aria-labelledby="archive-title">
        <h2 id="archive-title" className="text-base font-medium">Historical records</h2>
        <p className="text-sm text-muted-foreground">
          Existing testnet profile and API links remain valid with their original
          chain and agent ID. Testnet scores do not enter active rankings or totals.
        </p>
        <div className="flex flex-wrap gap-x-6 text-sm">
          <Link href={agentHref({ chain: 'arc', address: AK_ARC.controller, agentId: AK_ARC.agentId })} className={linkClass}>
            AgentKarma testnet identity #{AK_ARC.agentId}
          </Link>
          <a href={`${arcTestnet.blockExplorers.default.url}/address/${AK_ARC.identityRegistry}`} target="_blank" rel="noopener noreferrer" className={linkClass}>
            Testnet identity registry
          </a>
        </div>
      </section>
    </main>
  );
}
