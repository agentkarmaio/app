/**
 * Karma Resolver — shared scoring read-path used by `/api/v2/score/[wallet]`
 * and the MCP server (`/mcp`).
 *
 * Read-only. Never marks a wallet dirty for rescore. Returns the live two-faced
 * Karma snapshot with confidence badge + autonomy. If the wallet has no
 * indexed transactions, falls back to the cached `wallets` row.
 *
 * This file extracts the existing v2 logic into a single function so MCP tools
 * can compose it without duplicating the score recipe.
 */

import {
  getWallet,
  getTransactions,
  getFeedbackSummary,
  getLatestSignalValues,
  getSignalEventsForWallet,
} from '@/db/client';
import { calculateScore } from '@/scoring/index';
import { computeCadence } from '@/scoring/cadence';
import { computeAutonomy } from '@/scoring/autonomy';
import { readAttestation } from '@/integrations/attestation';
import type {
  ConfidenceBadge,
  KarmaFace,
  AutonomyLabel,
  TrustTier,
  SignalEvent,
} from '@/db/schema';

export interface KarmaIdentity {
  claimed: boolean;
  displayName?: string | null;
  description?: string | null;
  website?: string | null;
  category?: string | null;
}

export interface KarmaFaceBlock {
  face: KarmaFace;
  score: number;
  trustTier: TrustTier | string;
  confidenceBadge: ConfidenceBadge;
  hasSignal: boolean;
  metrics: Record<string, number> | null;
  tierAggregates: Record<string, number | null> | null;
}

export interface KarmaAutonomy {
  score: number | null;
  label: AutonomyLabel | null;
  signals: Record<string, number | null> | null;
  effectiveWeights: Record<string, number> | null;
  txCount: number;
  lastUpdated: string | null;
}

export interface KarmaSnapshot {
  address: string;
  identity: KarmaIdentity;
  txCount: number;
  lastActive: string | null;
  provider: KarmaFaceBlock;
  consumer: KarmaFaceBlock;
  confidenceBadge: ConfidenceBadge;
  autonomy: KarmaAutonomy;
  // Top-level convenience badge — mirrors `provider.confidenceBadge` because
  // the provider face is the canonical "is this agent trustworthy" surface.
  found: boolean;
}

export const SNAPSHOT_NOT_FOUND = Symbol('karma_not_found');

/**
 * Resolve both faces of Karma for `wallet`, plus confidence badge and autonomy.
 *
 * Returns `null` when the wallet has neither a `wallets` row NOR any indexed
 * transactions. Callers should treat that as 404.
 */
export async function resolveKarma(wallet: string): Promise<KarmaSnapshot | null> {
  const [walletRow, transactions, signalEvents] = await Promise.all([
    getWallet(wallet),
    getTransactions(wallet, 1000),
    getSignalEventsForWallet(wallet, 200).catch(() => [] as SignalEvent[]),
  ]);

  if (!walletRow && transactions.length === 0) return null;

  let feedback = { deliveryRate: 0, total: 0 };
  try { feedback = await getFeedbackSummary(wallet); } catch { /* ok */ }

  const [attestation, manifestMap] = await Promise.all([
    readAttestation(wallet).catch(() => 0),
    getLatestSignalValues([wallet], 'manifest').catch(() => new Map<string, number>()),
  ]);

  const cadence = transactions.length > 0
    ? computeCadence(transactions.map((tx) => new Date(tx.timestamp)))
    : null;

  const autonomyRaw = transactions.length > 0
    ? computeAutonomy(
        transactions.map((tx) => ({ timestamp: tx.timestamp, counterparty: tx.facilitator })),
      )
    : null;

  const live = transactions.length > 0
    ? calculateScore(
        transactions,
        attestation,
        feedback.deliveryRate,
        feedback.total,
        cadence?.automationScore ?? null,
        manifestMap.get(wallet) ?? null,
        null,
        signalEvents,
      )
    : null;

  const identity: KarmaIdentity = walletRow?.claimed
    ? {
        claimed: true,
        displayName: walletRow.display_name ?? null,
        description: walletRow.description ?? null,
        website: walletRow.website ?? null,
        category: walletRow.category ?? null,
      }
    : { claimed: false };

  const providerLive: KarmaFaceBlock = live
    ? {
        face: 'provider',
        score: live.providerScore,
        trustTier: live.trustTier,
        confidenceBadge: live.confidenceBadge,
        hasSignal: hasProviderSignal(live.tierAggregates),
        metrics: live.metrics as unknown as Record<string, number> | null,
        tierAggregates: live.tierAggregates as unknown as Record<string, number | null>,
      }
    : {
        face: 'provider',
        score: walletRow?.provider_score != null ? Number(walletRow.provider_score) : 0,
        trustTier: walletRow?.trust_tier ?? 'Unrated',
        confidenceBadge: (walletRow?.confidence_badge as ConfidenceBadge) ?? 'declared',
        hasSignal: false,
        metrics: null,
        tierAggregates: null,
      };

  const consumerLive: KarmaFaceBlock = live?.consumerFace
    ? {
        face: 'consumer',
        score: live.consumerFace.score,
        trustTier: live.consumerFace.trustTier,
        confidenceBadge: live.consumerFace.confidenceBadge,
        hasSignal: true,
        metrics: live.consumerFace.metrics as unknown as Record<string, number> | null,
        tierAggregates: live.consumerFace.tierAggregates as unknown as Record<string, number | null>,
      }
    : {
        face: 'consumer',
        score: walletRow?.consumer_score != null ? Number(walletRow.consumer_score) : 0,
        trustTier: 'Unrated',
        confidenceBadge: (walletRow?.confidence_badge as ConfidenceBadge) ?? 'declared',
        hasSignal: false,
        metrics: null,
        tierAggregates: null,
      };

  const autonomy: KarmaAutonomy = autonomyRaw
    ? {
        score: autonomyRaw.score,
        label: autonomyRaw.label,
        signals: autonomyRaw.components as unknown as Record<string, number | null>,
        effectiveWeights: autonomyRaw.effectiveWeights as unknown as Record<string, number>,
        txCount: autonomyRaw.txCount,
        lastUpdated: new Date().toISOString(),
      }
    : {
        score: walletRow?.autonomy_score != null ? Number(walletRow.autonomy_score) : null,
        label: (walletRow?.autonomy_label as AutonomyLabel | null) ?? null,
        signals: null,
        effectiveWeights: null,
        txCount: 0,
        lastUpdated: walletRow?.updated_at ?? null,
      };

  return {
    address: wallet,
    identity,
    txCount: live?.txCount ?? walletRow?.tx_count ?? 0,
    lastActive: toIsoOrNull(live?.lastActive ?? walletRow?.last_seen ?? null),
    provider: providerLive,
    consumer: consumerLive,
    confidenceBadge: providerLive.confidenceBadge,
    autonomy,
    found: true,
  };
}

/**
 * Provider has real signal when Tier 1 or Tier 3 is present. Tier 2 alone is
 * ambiguous (could be consumer behavior mislabelled as provider). Mirrors the
 * gate used by `api/v2/score/[wallet]/route.ts`.
 */
function hasProviderSignal(t: { tier1?: number | null; tier3?: number | null }): boolean {
  return (t.tier1 != null && t.tier1 >= 0) || (t.tier3 != null && t.tier3 >= 0);
}

function toIsoOrNull(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

// --- Attestations -----------------------------------------------------------

export interface AttestationsBundle {
  wallet: string;
  /** ERC-8004 on-chain attestation summary (averageScore 0–1 normalized). */
  erc8004: {
    averageScore: number | null;
    /** Raw [0–100] form to mirror the 8004 spec. */
    averageScore100: number | null;
  };
  /** Voluntary tier 1/3 attestations recorded as `signal_events`. */
  voluntary: Array<{
    kind: string;
    tier: number;
    face: KarmaFace;
    weight: number;
    value: number | null;
    signedBy: string | null;
    txRef: string | null;
    observedAt: string;
    payload: Record<string, unknown> | null;
  }>;
}

export async function resolveAttestations(wallet: string, limit = 50): Promise<AttestationsBundle> {
  const [erc8004Score, events] = await Promise.all([
    readAttestation(wallet).catch(() => 0),
    getSignalEventsForWallet(wallet, limit).catch(() => [] as SignalEvent[]),
  ]);

  // Tier 1 + Tier 3 = the attested signal surface. Tier 2 is behavioral, Tier 4
  // is social. Filter to just the attestations.
  const voluntary = events
    .filter((ev) => ev.tier === 1 || ev.tier === 3)
    .map((ev) => ({
      kind: ev.kind,
      tier: ev.tier,
      face: ev.face,
      weight: Number(ev.weight),
      value: ev.value != null ? Number(ev.value) : null,
      signedBy: ev.signed_by,
      txRef: ev.tx_ref,
      observedAt: ev.observed_at,
      payload: ev.payload,
    }));

  return {
    wallet,
    erc8004: {
      averageScore: erc8004Score > 0 ? erc8004Score : null,
      averageScore100: erc8004Score > 0 ? Math.round(erc8004Score * 100) : null,
    },
    voluntary,
  };
}

// --- Search -----------------------------------------------------------------

export interface KarmaSearchResult {
  address: string;
  chain: string;
  displayName: string | null;
  score: number;
  trustTier: string;
  txCount: number;
}

export async function searchAgents(query: string, limit = 8): Promise<KarmaSearchResult[]> {
  // Matches address OR display_name (case-insensitive), ranked by score.
  // Shared with the homepage search box via db/client.searchWallets.
  const { searchWallets } = await import('@/db/client');
  const rows = await searchWallets(query, limit);
  return rows.map((w) => ({
    address: w.address,
    chain: w.chain,
    displayName: w.displayName,
    score: w.score,
    trustTier: w.trustTier,
    txCount: w.txCount,
  }));
}
