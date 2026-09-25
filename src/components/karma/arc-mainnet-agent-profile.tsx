import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveKarma } from '@/lib/karma-resolver';
import { collectArcMainnetReceipts } from '@/scoring/arc-mainnet-receipts';
import { getArcMainnetReceiptEvents, getErc8004Agent, supabase } from '@/db/client';
import { getRegistryFeedbackForAgents } from '@/db/enrichment-queries';
import {
  buildProfileActivity, displayTier, matchesProfileRegistry, profileScoreHistory,
  PROFILE_FEEDBACK_LIMIT, PROFILE_RECEIPT_LIMIT,
} from '@/lib/arc-mainnet-profile';
import type { TrustTier } from '@/db/schema';
import { CardSkeleton } from './card-skeleton';
import { NotIndexedBlock } from './not-indexed-block';
import { ScoreChart } from './score-chart';
import {
  ArcMainnetActivityDetails, ArcMainnetProfileOverview, ArcMainnetRegistryFeedback, ProfilePanel,
} from './arc-mainnet-profile-details';

/** Read-only mainnet evidence. Never dispatch to Solana/testnet claim or feedback flows. */
export async function ArcMainnetAgentProfile({ wallet, agentId, deadMansSwitch }: {
  wallet: string; agentId?: number | null; deadMansSwitch?: ReactNode;
}) {
  const snapshot = await resolveKarma(wallet, 'arc-mainnet', { agentId });
  if (agentId != null && !snapshot) notFound();
  if (!snapshot) return <div className="space-y-6">
    <Link href="/arc/mainnet" className="inline-flex min-h-10 items-center text-sm underline">Arc mainnet coverage</Link>
    <h1 className="text-2xl font-medium">Agent profile</h1>
    <p className="break-all font-mono text-sm">{wallet}</p>
    <NotIndexedBlock chain="arc-mainnet" />
  </div>;

  // The resolver has ownership-checked agentId and selected the PAYMENT wallet.
  // Every supplementary read must use that address, never the owner in the URL.
  let registry: Record<string, unknown> | null = null;
  let registryUnavailable = false;
  if (snapshot.agentId != null) {
    try {
      const row = await getErc8004Agent('arc-mainnet', snapshot.agentId);
      if (row && matchesProfileRegistry(row, snapshot.address, snapshot.agentId)) registry = row;
      else registryUnavailable = true; // changed/missing since resolution, not an unregistered agent
    } catch { registryUnavailable = true; }
  }

  return <ArcMainnetProfileOverview snapshot={snapshot} registry={registry} registryUnavailable={registryUnavailable}>
    <Suspense fallback={<CardSkeleton title="Score Trend" rows={3} />}>
      <ScoreHistory address={snapshot.address} tier={displayTier(snapshot.provider)} />
    </Suspense>
    <Suspense fallback={<CardSkeleton title="Registry Feedback" rows={3} />}>
      <RegistryFeedback agentId={snapshot.agentId} />
    </Suspense>
    <Suspense fallback={<CardSkeleton title="Payment Relationships & Receipts" rows={6} />}>
      <ReceiptDetails address={snapshot.address} />
    </Suspense>
    {deadMansSwitch}
  </ArcMainnetProfileOverview>;
}

async function ReceiptDetails({ address }: { address: string }) {
  try {
    const window = await getArcMainnetReceiptEvents(address, PROFILE_RECEIPT_LIMIT);
    const validated = collectArcMainnetReceipts(address, window.events);
    return <ArcMainnetActivityDetails activity={buildProfileActivity(validated.observations)}
      saturated={window.saturated} sampled={window.events.length} invalid={validated.invalid} />;
  } catch {
    return <ProfilePanel id="payments" title="Payment Relationships & Receipts">
      <p role="status" className="text-sm text-muted-foreground">Recent activity could not be loaded. Refresh to retry. This is a read failure, not evidence of zero payments.</p>
    </ProfilePanel>;
  }
}

async function RegistryFeedback({ agentId }: { agentId?: number }) {
  if (agentId == null) return <ProfilePanel id="feedback" title="Registry Feedback">
    <p className="text-sm text-muted-foreground">No registry agent is associated with this payment wallet. Feedback requires a selected registry identity.</p>
  </ProfilePanel>;
  try {
    const rows = await getRegistryFeedbackForAgents('arc-mainnet', [agentId], PROFILE_FEEDBACK_LIMIT);
    return <ArcMainnetRegistryFeedback rows={rows} />;
  } catch {
    return <ProfilePanel id="feedback" title="Registry Feedback">
      <p role="status" className="text-sm text-muted-foreground">Registry feedback could not be loaded. Refresh to retry; feedback is not part of the transfer score.</p>
    </ProfilePanel>;
  }
}

async function ScoreHistory({ address, tier }: { address: string; tier: TrustTier }) {
  try {
    // getScoreHistory currently limits in ascending order (the first 30 rows).
    // Read the latest bounded window here without changing other chain profiles.
    const { data, error } = await supabase.from('scores').select('score, calculated_at')
      .eq('chain', 'arc-mainnet').eq('wallet_address', address)
      .order('calculated_at', { ascending: false }).limit(30);
    if (error) throw error;
    const points = profileScoreHistory((data ?? []) as Array<{ score: unknown; calculated_at: unknown }>);
    return <ProfilePanel id="score-trend" title="Score Trend" intro="Latest 30 stored Arc mainnet score snapshots, shown chronologically. These are persisted values, not a reconstructed history of today's scoring model.">
      {points.length >= 2 ? <ScoreChart data={points} tier={tier} />
        : <p className="text-sm text-muted-foreground">{points.length ? 'One score snapshot is stored; at least two are needed for a trend.' : 'No score history is stored for this wallet yet.'} The current Karma snapshot above remains available. Missing history is not filled with zeroes.</p>}
    </ProfilePanel>;
  } catch {
    return <ProfilePanel id="score-trend" title="Score Trend">
      <p role="status" className="text-sm text-muted-foreground">Stored score history could not be loaded. Refresh to retry; the current Karma snapshot is unaffected.</p>
    </ProfilePanel>;
  }
}
