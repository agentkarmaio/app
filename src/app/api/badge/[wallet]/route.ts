import { NextRequest, NextResponse } from 'next/server';
import { getWallet, getTransactions, getFeedbackSummary } from '@/db/client';
import { calculateScore } from '@/scoring/index';
import { computeCadence } from '@/scoring/cadence';
import { getLivenessStatus } from '@/db/schema';
import type { TrustTier, LivenessStatus, ConfidenceBadge } from '@/db/schema';

/**
 * GET /api/badge/[wallet]?format=svg|json&theme=dark|light
 *
 * Returns an embeddable trust badge for an agent wallet.
 * - SVG: Self-contained dark badge with score ring, tier, and liveness dot
 * - JSON: Structured data for programmatic consumption
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ wallet: string }> },
) {
  const { wallet } = await params;
  const { searchParams } = new URL(request.url);
  const format = searchParams.get('format') ?? 'svg';

  if (!wallet || wallet.length < 32) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }

  const [walletRow, transactions] = await Promise.all([
    getWallet(wallet),
    getTransactions(wallet, 1000),
  ]);

  if (!walletRow && transactions.length === 0) {
    return NextResponse.json({ error: 'Wallet not found' }, { status: 404 });
  }

  let feedback = { deliveryRate: 0, total: 0 };
  try { feedback = await getFeedbackSummary(wallet); } catch { /* ok */ }

  const cadence = transactions.length > 0
    ? computeCadence(transactions.map((tx) => new Date(tx.timestamp)))
    : null;
  const liveScore = transactions.length > 0
    ? calculateScore(
        transactions, 0, feedback.deliveryRate, feedback.total,
        cadence?.automationScore ?? null,
      )
    : null;

  const score = liveScore?.score ?? Number(walletRow?.score ?? 0);
  const providerScore = liveScore?.providerScore
    ?? (walletRow?.provider_score != null ? Number(walletRow.provider_score) : score);
  const consumerScore = liveScore?.consumerScore
    ?? (walletRow?.consumer_score != null ? Number(walletRow.consumer_score) : null);
  const tier = (liveScore?.trustTier ?? walletRow?.trust_tier ?? 'Unrated') as TrustTier;
  const confidenceBadge: ConfidenceBadge = (liveScore?.confidenceBadge
    ?? walletRow?.confidence_badge ?? 'declared');
  const displayName = walletRow?.display_name ?? null;
  const liveness: LivenessStatus = walletRow?.last_seen
    ? getLivenessStatus(walletRow.last_seen)
    : 'Inactive';
  const txCount = liveScore?.txCount ?? walletRow?.tx_count ?? 0;

  if (format === 'json') {
    return NextResponse.json({
      address: wallet,
      score,
      providerScore,
      consumerScore,
      confidenceBadge,
      trustTier: tier,
      displayName,
      liveness,
      txCount,
      feedbackCount: feedback.total,
      deliveryRate: feedback.deliveryRate,
    }, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  // SVG badge
  const svg = renderBadgeSVG({ score, tier, confidenceBadge, displayName, liveness, wallet });

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// --- SVG Renderer ---

const TIER_COLORS: Record<TrustTier, string> = {
  Unrated: '#62666d',
  Poor: '#e5484d',
  Fair: '#f5a623',
  Good: '#5e6ad2',
  'Very Good': '#10b981',
  Excellent: '#7170ff',
};

const LIVENESS_COLORS: Record<LivenessStatus, string> = {
  Active: '#30a46c',
  Recent: '#f5a623',
  Dormant: '#62666d',
  Inactive: '#e5484d',
};

const CONFIDENCE_DOT_COLOR: Record<ConfidenceBadge, string> = {
  'receipt-backed': '#10b981',
  'behavior-inferred': '#f5a623',
  declared: '#8a8f98',
};

function renderBadgeSVG({
  score,
  tier,
  confidenceBadge,
  displayName,
  liveness,
  wallet,
}: {
  score: number;
  tier: TrustTier;
  confidenceBadge: ConfidenceBadge;
  displayName: string | null;
  liveness: LivenessStatus;
  wallet: string;
}): string {
  const tierColor = TIER_COLORS[tier];
  const livenessColor = LIVENESS_COLORS[liveness];
  const confidenceColor = CONFIDENCE_DOT_COLOR[confidenceBadge];
  const label = displayName ?? `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
  const scoreText = score.toFixed(1);

  const ringR = 18;
  const ringC = 2 * Math.PI * ringR;
  const ringOffset = ringC - (score / 100) * ringC;

  const width = 240;
  const height = 56;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;display=swap');
      text { font-family: 'Inter', -apple-system, sans-serif; }
    </style>
  </defs>
  <rect width="${width}" height="${height}" rx="10" fill="#111113" stroke="${tierColor}" stroke-width="1" stroke-opacity="0.3"/>

  <!-- Score ring -->
  <g transform="translate(28, 28)">
    <circle cx="0" cy="0" r="${ringR}" fill="none" stroke="#ffffff" stroke-opacity="0.06" stroke-width="3"/>
    <circle cx="0" cy="0" r="${ringR}" fill="none" stroke="${tierColor}" stroke-width="3"
      stroke-dasharray="${ringC}" stroke-dashoffset="${ringOffset}"
      stroke-linecap="round" transform="rotate(-90)"/>
    <text x="0" y="1" text-anchor="middle" dominant-baseline="central"
      fill="#f7f8f8" font-size="11" font-weight="600">${scoreText}</text>
  </g>

  <!-- Agent info -->
  <g transform="translate(56, 16)">
    <circle cx="0" cy="5" r="3" fill="${livenessColor}"/>
    <text x="8" y="9" fill="#f7f8f8" font-size="12" font-weight="500">${escapeXml(label)}</text>
  </g>

  <!-- Tier + confidence badges -->
  <g transform="translate(56, 32)">
    <rect x="0" y="0" width="${tier.length * 7 + 12}" height="18" rx="4"
      fill="${tierColor}" fill-opacity="0.12" stroke="${tierColor}" stroke-opacity="0.25" stroke-width="0.5"/>
    <text x="6" y="13" fill="${tierColor}" font-size="10" font-weight="500">${tier}</text>
  </g>

  <g transform="translate(${56 + tier.length * 7 + 18}, 32)">
    <circle cx="6" cy="9" r="3" fill="${confidenceColor}"/>
    <text x="14" y="13" fill="#8a8f98" font-size="10" font-weight="500">${confidenceLabel(confidenceBadge)}</text>
  </g>

  <text x="${width - 8}" y="${height - 6}" text-anchor="end" fill="#62666d" font-size="8" font-weight="400">karma</text>
</svg>`;
}

function confidenceLabel(b: ConfidenceBadge): string {
  if (b === 'receipt-backed') return 'Receipts';
  if (b === 'behavior-inferred') return 'Behavior';
  return 'Declared';
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
