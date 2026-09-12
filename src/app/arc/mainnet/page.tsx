import Link from 'next/link';
import type { Metadata } from 'next';
import { readIndexingStates } from '@/db/indexing-state';
import { buildIndexingHealth } from '@/lib/indexing-health';
import { INDEXING_STATUS_LABELS } from '@/components/karma/live-flow-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'Arc mainnet coverage — AgentKarma',
  description: 'Independent Arc mainnet agent receipt coverage and indexing status.',
};
export const revalidate = 30;

export default async function ArcMainnetPage() {
  const rows = await readIndexingStates().catch(() => null);
  const coverage = rows ? buildIndexingHealth(rows).chains.find(chain => chain.chain === 'arc-mainnet') : null;
  const transfers = coverage?.paths.find(path => path.path === 'transfers');
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">Network coverage</p>
        <h1 className="text-3xl font-medium tracking-tight">Arc mainnet</h1>
        <p className="text-muted-foreground">USDC receipts involving verified mainnet agent addresses. Testnet activity is tracked separately.</p>
      </header>
      <Card>
        <CardHeader><CardTitle className="text-base">Agent transfers</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p role="status">{coverage ? INDEXING_STATUS_LABELS[coverage.status] : 'Status temporarily unavailable'}</p>
          <p className="text-muted-foreground">Last checked: {transfers?.lastCheckedAt ? <time dateTime={transfers.lastCheckedAt}>{new Date(transfers.lastCheckedAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</time> : 'Not yet verified'}</p>
          <p className="text-muted-foreground">Registration, feedback publishing, and ownership claims are not enabled for mainnet yet.</p>
        </CardContent>
      </Card>
      <nav className="flex flex-wrap gap-4 text-sm">
        <Link href="/explore?chain=arc-mainnet" className="inline-flex min-h-10 items-center underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Browse indexed mainnet agents</Link>
        <Link href="/arc" className="inline-flex min-h-10 items-center underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Arc testnet coverage</Link>
      </nav>
    </main>
  );
}
