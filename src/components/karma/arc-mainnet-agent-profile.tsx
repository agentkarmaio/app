import { Suspense, type ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { resolveKarma } from '@/lib/karma-resolver';
import { collectArcMainnetReceipts } from '@/scoring/arc-mainnet-receipts';
import {
  getArcMainnetReceiptEvents, getErc8004Agent, getFeedbackComments, resolveRaters, supabase, type RaterInfo,
} from '@/db/client';
import { getCachedEvmAgentOnchain } from '@/db/cached';
import { getRegistryFeedbackForAgents } from '@/db/enrichment-queries';
import { scoreMetadataQuality, METADATA_SCHEME_VERSION } from '@/scoring/celo-metadata';
import {
  buildProfileActivity, displayTier, matchesProfileRegistry, profileScoreHistory,
  PROFILE_FEEDBACK_LIMIT, PROFILE_RECEIPT_LIMIT,
} from '@/lib/arc-mainnet-profile';
import type { TrustTier } from '@/db/schema';
import { CardSkeleton } from './card-skeleton';
import { NotIndexedBlock } from './not-indexed-block';
import { AgentProfileShell } from './agent-profile-shell';
import { ScoreChart } from './score-chart';
import { FeedbackRecordsCard } from './feedback-records-card';
import { GiveFeedbackCard } from './give-feedback-card';
import {
  ArcMainnetActivityDetails, ArcMainnetProfileOverview, ArcMainnetRegistryFeedback, ProfilePanel,
} from './arc-mainnet-profile-details';

/**
 * Mainnet evidence + ERC-8004 feedback. Never dispatch to Solana/testnet claim
 * flows; feedback is written straight to the Arc ReputationRegistry
 * from the visitor's own wallet (GiveFeedbackCard), never through AK.
 */
export async function ArcMainnetAgentProfile({ wallet, agentId, deadMansSwitch }: {
  wallet: string; agentId?: number | null; deadMansSwitch?: ReactNode;
}) {
  const snapshot = await resolveKarma(wallet, 'arc-mainnet', { agentId });
  if (agentId != null && !snapshot) notFound();
  if (!snapshot) return <AgentProfileShell back={{ href: '/arc/mainnet', label: 'Arc coverage' }} address={wallet} chain="arc-mainnet">
    <NotIndexedBlock chain="arc-mainnet" />
  </AgentProfileShell>;

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
      <RegistryFeedback agentId={snapshot.agentId} owner={registry ? String(registry.owner ?? '') || undefined : undefined} />
    </Suspense>
    <Suspense fallback={<CardSkeleton title="Payment Relationships & Receipts" rows={6} />}>
      <ReceiptDetails address={snapshot.address} />
    </Suspense>
    {deadMansSwitch}
  </ArcMainnetProfileOverview>;
}

/** Exported for tests: server-rendered in isolation, since the profile streams it. */
export async function ReceiptDetails({ address }: { address: string }) {
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

/**
 * Registry records (AK validator attestations + third-party reviews) and the
 * give-feedback form. Live Arc RPC first, registry mirror when it is
 * down (getCachedEvmAgentOnchain); the plain mirror list is the last resort.
 */
async function RegistryFeedback({ agentId, owner }: { agentId?: number; owner?: string }) {
  if (agentId == null) return <ProfilePanel id="feedback" title="Registry Feedback">
    <p className="text-sm text-muted-foreground">No registry agent is associated with this payment wallet. Feedback requires a selected registry identity.</p>
  </ProfilePanel>;
  const form = <GiveFeedbackCard agentId={agentId} chain="arc-mainnet" ownerAddress={owner} />;
  const { agent, feedback } = await getCachedEvmAgentOnchain('arc-mainnet', agentId);
  if (feedback) {
    const clients = feedback.records.map(r => r.client);
    const [raters, comments] = await Promise.all([
      clients.length ? resolveRaters(clients, 'arc-mainnet').catch(() => new Map<string, RaterInfo>()) : new Map<string, RaterInfo>(),
      clients.length
        ? getFeedbackComments('arc-mainnet', agentId).catch(() => new Map<string, { comment: string; verified: boolean }>())
        : new Map<string, { comment: string; verified: boolean }>(),
    ]);
    const metadataAssessment = agent?.registration
      ? { result: scoreMetadataQuality(agent), schemeVersion: METADATA_SCHEME_VERSION }
      : null;
    return <div id="feedback" className="scroll-mt-24 space-y-6">
      {feedback.records.length > 0
        ? <FeedbackRecordsCard records={feedback.records} raters={raters} comments={comments} chain="arc-mainnet" metadataAssessment={metadataAssessment} />
        : <ProfilePanel title="Registry Feedback"><p className="text-sm text-muted-foreground">No feedback has been recorded for this agent yet. Be the first below.</p></ProfilePanel>}
      {form}
    </div>;
  }
  const rows = await getRegistryFeedbackForAgents('arc-mainnet', [agentId], PROFILE_FEEDBACK_LIMIT).catch(() => null);
  return <div className="space-y-6">
    {rows ? <ArcMainnetRegistryFeedback rows={rows} /> : <ProfilePanel id="feedback" title="Registry Feedback">
      <p role="status" className="text-sm text-muted-foreground">Registry feedback could not be loaded. Refresh to retry; feedback is not part of the transfer score.</p>
    </ProfilePanel>}
    {form}
  </div>;
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
    return <ProfilePanel id="score-trend" title="Score Trend" intro="Latest 30 stored Arc score snapshots, shown chronologically. These are persisted values, not a reconstructed history of today's scoring model.">
      {points.length >= 2 ? <ScoreChart data={points} tier={tier} />
        : <p className="text-sm text-muted-foreground">{points.length ? 'One score snapshot is stored; at least two are needed for a trend.' : 'No score history is stored for this wallet yet.'} The current Karma snapshot above remains available. Missing history is not filled with zeroes.</p>}
    </ProfilePanel>;
  } catch {
    return <ProfilePanel id="score-trend" title="Score Trend">
      <p role="status" className="text-sm text-muted-foreground">Stored score history could not be loaded. Refresh to retry; the current Karma snapshot is unaffected.</p>
    </ProfilePanel>;
  }
}
