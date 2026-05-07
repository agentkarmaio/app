/**
 * Per-agent dynamic Open Graph image.
 *
 * Convention: any {wallet} URL — e.g. /agent/{wallet}.png — renders a 1200×630
 * card with the agent's display name, Karma score, tier, and confidence badge.
 * Used as the social preview when an agent profile is shared on X / Discord /
 * Slack / iMessage.
 *
 * Runtime: nodejs (default in Next 16). Edge would be cheaper but @supabase
 * client + Helius env access keep us on Node here for simplicity.
 */

import { ImageResponse } from 'next/og';
import { getWallet } from '@/db/client';

export const runtime = 'nodejs';
export const contentType = 'image/png';
export const size = { width: 1200, height: 630 };
export const alt = 'AgentKarma agent reputation card';

const TIER_COLORS: Record<string, string> = {
  Excellent: '#10b981',
  'Very Good': '#4ade80',
  Good: '#8a92ff',
  Fair: '#f5a623',
  Poor: '#ef4444',
  Unrated: '#6b7280',
};

const BADGE_TEXT: Record<string, { dot: string; label: string }> = {
  'receipt-backed':   { dot: '#10b981', label: 'Receipt-backed' },
  'behavior-inferred':{ dot: '#eab308', label: 'Behavior-inferred' },
  'declared':         { dot: '#6b7280', label: 'Declared' },
};

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

export default async function AgentOGImage(
  { params }: { params: Promise<{ wallet: string }> },
) {
  const { wallet } = await params;
  const row = await getWallet(wallet).catch(() => null);

  const name = row?.display_name ?? `Agent ${shortAddr(wallet)}`;
  const score = Number(row?.provider_score ?? row?.score ?? 0);
  const tier = (row?.trust_tier ?? 'Unrated') as keyof typeof TIER_COLORS;
  const badge = (row?.confidence_badge ?? 'declared') as keyof typeof BADGE_TEXT;
  const txCount = row?.tx_count ?? 0;

  const tierColor = TIER_COLORS[tier] ?? TIER_COLORS.Unrated;
  const badgeMeta = BADGE_TEXT[badge] ?? BADGE_TEXT.declared;
  const isClaimed = row?.claimed ?? false;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(135deg, #08090a 0%, #0e1116 60%, #11132a 100%)',
          color: '#f7f8f8',
          padding: 64,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          position: 'relative',
        }}
      >
        {/* Subtle grid */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            opacity: 0.5,
            display: 'flex',
          }}
        />

        {/* Top row: brand + claim */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: -0.4,
              color: '#f7f8f8',
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background:
                  'linear-gradient(135deg, #8a92ff 0%, #7170ff 50%, #5e6ad2 100%)',
                display: 'flex',
              }}
            />
            AgentKarma
          </div>
          {isClaimed && (
            <div
              style={{
                display: 'flex',
                fontSize: 14,
                fontWeight: 510,
                color: '#8a92ff',
                background: 'rgba(113,112,255,0.10)',
                border: '1px solid rgba(113,112,255,0.25)',
                padding: '6px 12px',
                borderRadius: 6,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
              }}
            >
              Claimed agent
            </div>
          )}
        </div>

        {/* Middle: name + score */}
        <div
          style={{
            display: 'flex',
            flex: 1,
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 48,
            marginTop: 32,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              flex: 1,
              minWidth: 0,
            }}
          >
            <div
              style={{
                fontSize: 56,
                fontWeight: 600,
                lineHeight: 1.05,
                letterSpacing: -1.6,
                color: '#f7f8f8',
                display: 'flex',
                maxWidth: 700,
                overflow: 'hidden',
              }}
            >
              {name.length > 28 ? `${name.slice(0, 27)}…` : name}
            </div>
            <div
              style={{
                fontSize: 22,
                color: '#8a8f98',
                fontFamily: 'ui-monospace, monospace',
                display: 'flex',
              }}
            >
              {shortAddr(wallet)}
            </div>
            <div
              style={{
                display: 'flex',
                gap: 12,
                marginTop: 8,
                alignItems: 'center',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 18,
                  fontWeight: 510,
                  color: '#d0d6e0',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  padding: '8px 14px',
                  borderRadius: 6,
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    background: badgeMeta.dot,
                    display: 'flex',
                  }}
                />
                {badgeMeta.label}
              </div>
              <div
                style={{
                  display: 'flex',
                  fontSize: 18,
                  fontWeight: 510,
                  color: tierColor,
                  background: `${tierColor}15`,
                  border: `1px solid ${tierColor}40`,
                  padding: '8px 14px',
                  borderRadius: 6,
                }}
              >
                {tier}
              </div>
            </div>
          </div>

          {/* Score ring — SVG because Satori doesn't support conic-gradient. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 280,
              height: 280,
              position: 'relative',
            }}
          >
            {(() => {
              const r = 124;
              const c = 2 * Math.PI * r;
              const dash = c * Math.min(score, 100) / 100;
              return (
                <svg width="280" height="280" viewBox="0 0 280 280" style={{ display: 'flex' }}>
                  <circle
                    cx="140"
                    cy="140"
                    r={r}
                    fill="none"
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth="14"
                  />
                  <circle
                    cx="140"
                    cy="140"
                    r={r}
                    fill="none"
                    stroke={tierColor}
                    strokeWidth="14"
                    strokeLinecap="round"
                    strokeDasharray={`${dash} ${c - dash}`}
                    strokeDashoffset={c / 4}
                    transform="rotate(-90 140 140)"
                  />
                </svg>
              );
            })()}
            <div
              style={{
                position: 'absolute',
                width: 240,
                height: 240,
                borderRadius: 120,
                background: '#0a0c10',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <div
                style={{
                  fontSize: 72,
                  fontWeight: 700,
                  color: '#f7f8f8',
                  letterSpacing: -2.4,
                  display: 'flex',
                }}
              >
                {score.toFixed(0)}
              </div>
              <div
                style={{
                  fontSize: 14,
                  color: '#62666d',
                  letterSpacing: 1.2,
                  textTransform: 'uppercase',
                  display: 'flex',
                  marginTop: -4,
                }}
              >
                Provider Karma
              </div>
            </div>
          </div>
        </div>

        {/* Bottom: stats + url */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 32,
            paddingTop: 20,
            borderTop: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 32,
              fontSize: 16,
              color: '#8a8f98',
            }}
          >
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={{ color: '#f7f8f8', fontWeight: 590, fontVariantNumeric: 'tabular-nums' }}>
                {txCount.toLocaleString()}
              </span>
              transactions
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={{ color: '#f7f8f8', fontWeight: 590 }}>4-tier</span>
              signal spectrum
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 16,
              color: '#62666d',
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            agentkarma.io
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
