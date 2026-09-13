import Link from 'next/link';
import { resolveKarma } from '@/lib/karma-resolver';
import { collectArcMainnetReceipts } from '@/scoring/arc-mainnet-receipts';
import { getSignalEventsForWallet } from '@/db/client';
import { getAdapter } from '@/chain-adapters/registry';
import { formatUsdcAmount } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfidenceBadge } from './confidence-badge';
import { NotIndexedBlock } from './not-indexed-block';
import { AutonomyChip } from './autonomy-chip';

/** Read-only mainnet evidence. No testnet registry or legacy claim workflow. */
export async function ArcMainnetAgentProfile({ wallet }: { wallet: string }) {
  const [snapshot, events] = await Promise.all([
    resolveKarma(wallet, 'arc-mainnet'),
    getSignalEventsForWallet(wallet, 50, 'arc-mainnet'),
  ]);
  const receipts = collectArcMainnetReceipts(wallet, events).observations
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.logIndex - a.logIndex);
  const adapter = getAdapter('arc-mainnet');
  return (
    <div className="space-y-6">
      <Link href="/arc/mainnet" className="inline-flex min-h-10 items-center text-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Arc mainnet coverage</Link>
      <header className="space-y-3">
        <h1 className="text-2xl font-medium tracking-tight">{snapshot?.identity.displayName ?? 'Agent profile'}</h1>
        <p className="text-sm text-muted-foreground">Arc mainnet</p>
        {snapshot?.autonomy.score != null && snapshot.autonomy.label ? <AutonomyChip score={snapshot.autonomy.score} label={snapshot.autonomy.label} /> : <p className="text-sm text-muted-foreground">Autonomy: not enough activity to assess yet.</p>}
        <a href={adapter.explorerAddressUrl(wallet)} target="_blank" rel="noopener noreferrer" className="block break-all font-mono text-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{wallet}</a>
      </header>
      {!snapshot ? <NotIndexedBlock chain="arc-mainnet" /> : (
        <div className="grid gap-4 sm:grid-cols-2">
          {[snapshot.provider, snapshot.consumer].map(face => <Card key={face.face}>
            <CardHeader><CardTitle className="text-base">{face.face === 'provider' ? 'Provider Karma' : 'Consumer Karma'}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="font-mono text-2xl tabular-nums">{face.hasSignal && Number.isFinite(face.score) ? `${face.score.toFixed(1)} / 100` : 'Unrated'}</p>
              <ConfidenceBadge badge={face.confidenceBadge} />
              <p className="text-xs text-muted-foreground">{face.face === 'provider' ? 'Observed incoming payments' : 'Observed outgoing payments'}. Transfer activity does not verify service delivery.</p>
            </CardContent>
          </Card>)}
        </div>
      )}
      {snapshot?.receiptEvidence && <p className="text-xs text-muted-foreground">
        Scores use observed transfer activity. Reciprocal transfers are discounted within the observed window.
        {snapshot.receiptEvidence.saturated ? ' The history limit was reached; older activity is outside this score.' : ''}
      </p>}
      <Card>
        <CardHeader><CardTitle className="text-base">Recent mainnet receipts</CardTitle></CardHeader>
        <CardContent>
          {receipts.length === 0 ? <p className="text-sm text-muted-foreground">No mainnet receipts indexed for this address yet.</p> : <ul className="divide-y divide-border">
            {receipts.map(event => <li key={event.eventKey} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <a href={adapter.explorerTxUrl(event.eventKey)} target="_blank" rel="noopener noreferrer" className="min-h-10 max-w-full content-center break-all font-mono underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{event.rawTxHash.slice(0, 12)}… · {event.face === 'provider' ? 'Received' : 'Sent'}</a>
              <span className="font-mono tabular-nums" title={`${event.amountDecimal} USDC`}>{formatUsdcAmount(Number(event.amountDecimal))} USDC</span>
            </li>)}
          </ul>}
        </CardContent>
      </Card>
    </div>
  );
}
