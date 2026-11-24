import Link from 'next/link';
import type { Metadata } from 'next';
import { readIndexingStates } from '@/db/indexing-state';
import { buildIndexingHealth } from '@/lib/indexing-health';
import { INDEXING_STATUS_LABELS } from '@/components/karma/live-flow-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'Robinhood Chain coverage — AgentKarma',
  description: 'ERC-8004 agent registry coverage on Robinhood Chain and its indexing status.',
};
export const revalidate = 30;

const LINK = 'inline-flex min-h-10 items-center underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export default async function RobinhoodPage() {
  const rows = await readIndexingStates().catch(() => null);
  const coverage = rows ? buildIndexingHealth(rows).chains.find(chain => chain.chain === 'robinhood') : null;
  const registry = coverage?.paths.find(path => path.path === 'registry');
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">Network coverage</p>
        <h1 className="text-3xl font-medium tracking-tight">Robinhood Chain</h1>
        <p className="text-muted-foreground">
          Agents registered on the Robinhood Chain ERC-8004 IdentityRegistry, with their ReputationRegistry feedback.
          AgentKarma is an independent reader and is not affiliated with Robinhood.
        </p>
      </header>
      <Card>
        <CardHeader><CardTitle className="text-base">Agent registry</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p role="status">{registry ? INDEXING_STATUS_LABELS[registry.status] : 'Status temporarily unavailable'}</p>
          <p className="text-muted-foreground">Last checked: {registry?.lastCheckedAt ? <time dateTime={registry.lastCheckedAt}>{new Date(registry.lastCheckedAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</time> : 'Not yet verified'}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">How these agents are scored</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>Provider Karma comes from the quality of each agent&apos;s declared registration, so every score here carries the Declared badge. No payments are indexed on Robinhood Chain yet, so Consumer Karma is not measured.</p>
          <p>Registry feedback is shown on each profile but does not move the score.</p>
          <p>Agents minted in bulk by a single registrant (templated or test cards) are left out, so the list reflects independently registered agents.</p>
        </CardContent>
      </Card>
      <nav className="flex flex-wrap gap-4 text-sm">
        <Link href="/explore?chain=robinhood" className={LINK}>Browse Robinhood Chain agents</Link>
      </nav>
    </main>
  );
}
