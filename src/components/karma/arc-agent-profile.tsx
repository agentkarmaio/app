/**
 * ArcAgentProfile — rendered when /agent/[wallet] resolves to an Arc wallet
 * row that has a known ERC-8004 agentId. Reads the on-chain IdentityRegistry +
 * ReputationRegistry directly so the page reflects current chain state, not
 * whatever the indexer last persisted.
 *
 * Arc is testnet today (Arc mainnet ships summer 2026), so the page carries a
 * visible TESTNET marker. On-chain reads are best-effort — if the RPC blips we
 * fall back to the DB row alone, same pattern as CeloAgentProfile.
 *
 * Receipt-gated Tier-1 history is x402/Solana-only today; this view stays
 * focused on declared identity + ERC-8004 feedback aggregate. No tx list, no
 * score trend, no consumer feedback form (those wire to Solana data shapes).
 */
import Link from 'next/link';
import { ArrowLeft, ExternalLink, Globe, Verified } from 'lucide-react';
import {
  readAgent,
  aggregateFeedback,
  type ArcAgent,
} from '@/integrations/erc8004-arc';
import { ScoreRing } from '@/components/karma/score-ring';
import { AgentAvatar } from '@/components/karma/agent-avatar';
import { TierBadge } from '@/components/karma/tier-badge';
import { ConfidenceBadge } from '@/components/karma/confidence-badge';
import { WalletAddress } from '@/components/karma/wallet-address';
import { BadgeButton } from '@/components/karma/badge-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { resolveRaters, type RaterInfo } from '@/db/client';
import type { Wallet, TrustTier, ConfidenceBadge as ConfidenceBadgeValue } from '@/db/schema';
import { safeHref } from '@/lib/safe-url';
import { EvmClaimBanner } from '@/components/wallet/evm-claim-banner';
import { GiveFeedbackCard } from '@/components/karma/give-feedback-card';
import { FeedbackRecordsCard } from '@/components/karma/feedback-records-card';
import { ClaimProof } from '@/components/karma/claim-proof';
import { ProveOwnership } from '@/components/wallet/prove-ownership';

const CATEGORY_LABELS: Record<string, string> = {
  ai: 'AI / ML',
  data: 'Data Feed',
  defi: 'DeFi',
  infra: 'Infrastructure',
  social: 'Social',
  utility: 'Utility',
  other: 'Other',
};

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export async function ArcAgentProfile({
  wallet,
  walletRow,
  agentId,
  deadMansSwitch,
}: {
  wallet: string;
  walletRow: Wallet;
  agentId: number;
  /** Observe-only Succession + Bonding grid, loaded chain-aware in the page. */
  deadMansSwitch?: React.ReactNode;
}) {
  // Read on-chain identity + aggregate feedback in parallel. If the chain call
  // fails (Arc testnet RPC blip, contract redeploys, etc.), fall back to the
  // DB row alone — we still want to show something useful.
  const [agent, feedback] = await Promise.all([
    readAgent(BigInt(agentId)).catch(() => null as ArcAgent | null),
    // includeRevoked: surface retracted records in the list (struck-through);
    // count/average still exclude them inside aggregateFeedback.
    aggregateFeedback(BigInt(agentId), { includeRevoked: true }).catch(() => null),
  ]);

  // Resolve rater addresses to names + AK profile links (best-effort, one DB
  // round-trip). Depends on the feedback list, so it follows the parallel read.
  const raters = feedback?.records.length
    ? await resolveRaters(feedback.records.map((r) => r.client), 'arc').catch(
        () => new Map<string, RaterInfo>(),
      )
    : new Map<string, RaterInfo>();

  const registrationName = agent?.registration?.name ?? null;
  const registrationDescription = agent?.registration?.description ?? null;
  const services = agent?.registration?.services ?? [];

  const displayName = walletRow.display_name ?? registrationName ?? `Agent ${shortAddr(wallet)}`;
  const description = walletRow.description ?? registrationDescription;
  // Sanitize: registration.website is attacker-controlled. Reject anything
  // that isn't http(s) so a malicious agent can't ship `javascript:` URIs.
  const website = safeHref(walletRow.website);
  const category = walletRow.category ?? null;
  const score = Number(walletRow.provider_score ?? walletRow.score ?? 0);
  const tier = (walletRow.trust_tier ?? 'Unrated') as TrustTier;
  const confidenceBadge: ConfidenceBadgeValue = walletRow.confidence_badge ?? 'declared';
  const isClaimed = walletRow.claimed ?? false;

  // Arc Testnet explorer (arcscan.app — confirmed in src/config/arc-chain.ts).
  const explorerUrl = `https://testnet.arcscan.app/address/${wallet}`;
  const eightthousandfourUrl = `https://8004scan.io/agent/${agentId}`;

  return (
    <div className="space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <AgentAvatar src={agent?.registration?.image} name={displayName} />
          <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[24px] font-[510] tracking-[-0.288px] text-[#f7f8f8]">
              {displayName}
            </h1>
            <TierBadge tier={tier} />
            <ConfidenceBadge badge={confidenceBadge} size="sm" />
            <Badge
              variant="outline"
              className="border-yellow-500/30 bg-yellow-500/10 text-yellow-400 text-[10px] px-1.5 py-0 font-[510]"
            >
              Arc
            </Badge>
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-amber-400 text-[10px] px-1.5 py-0 font-[510] tracking-wider"
              title="Arc mainnet ships summer 2026; current data is from Arc Testnet."
            >
              TESTNET
            </Badge>
            {isClaimed && (
              <Badge
                variant="outline"
                className="bg-[rgb(94_106_210/0.08)] text-[#828fff] border-[rgb(94_106_210/0.15)] text-[10px] px-1.5 py-0 font-[510]"
              >
                <Verified className="size-3 mr-0.5" />
                Claimed
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            <WalletAddress address={wallet} truncate={false} className="text-muted-foreground" />
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
              aria-label="View on Arcscan"
            >
              <ExternalLink className="size-3.5" />
            </a>
            <BadgeButton wallet={wallet} chain="arc" />
          </div>
          {description && (
            <p className="text-[14px] text-[#8a8f98] leading-relaxed max-w-lg">
              {description}
            </p>
          )}
          <div className="flex items-center gap-3">
            {category && (
              <Badge variant="outline" className="bg-[rgb(255_255_255/0.04)] text-[#8a8f98] border-[rgb(255_255_255/0.08)] text-[11px] px-1.5 py-0">
                {CATEGORY_LABELS[category] ?? category}
              </Badge>
            )}
            {website && (
              <a
                href={website}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-[#8a8f98] hover:text-[#f7f8f8] transition-colors"
              >
                <Globe className="size-3" />
                {(() => {
                  try {
                    return new URL(website).hostname;
                  } catch {
                    return website;
                  }
                })()}
              </a>
            )}
          </div>
          </div>
        </div>
        <ScoreRing score={score} tier={tier} size={90} strokeWidth={7} />
      </div>

      <Separator />

      {!isClaimed && <EvmClaimBanner walletAddress={walletRow.address} chain="arc" />}

      {isClaimed && !walletRow.claim_signature && (
        <ProveOwnership chain="arc" address={walletRow.address} />
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-4">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
              ERC-8004 identity
            </CardTitle>
            <p className="mt-1 text-[11px] text-[#62666d]">
              Read directly from Arc IdentityRegistry (testnet)
            </p>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="agentId" value={<span className="font-mono">{agentId}</span>} />
            <Separator />
            <Row
              label="Owner"
              value={
                <span className="font-mono text-[12px] break-all">
                  {agent?.owner ?? wallet}
                </span>
              }
            />
            <Separator />
            <Row
              label="agentURI"
              value={
                agent?.tokenURI ? (
                  <span className="break-all text-[12px] text-muted-foreground">
                    {agent.tokenURI.length > 60
                      ? `${agent.tokenURI.slice(0, 60)}…`
                      : agent.tokenURI}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              }
            />
            <Separator />
            <Row
              label="IdentityRegistry"
              value={
                <span className="font-mono text-[12px] break-all text-muted-foreground">
                  0x8004A818…BD9e
                </span>
              }
            />
            <Separator />
            <Row
              label="Profile"
              value={
                <a
                  href={eightthousandfourUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[#828fff] hover:underline underline-offset-2"
                >
                  8004scan.io/agent/{agentId}
                  <ExternalLink className="size-3" />
                </a>
              }
            />
          </CardContent>
        </Card>

        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-4">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
              Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <Row
                label="Provider Karma"
                value={<span className="font-bold tabular-nums">{score.toFixed(1)} / 100</span>}
              />
              <Separator />
              <Row label="Trust Tier" value={<TierBadge tier={tier} size="sm" />} />
              <Separator />
              <Row label="Confidence" value={<ConfidenceBadge badge={confidenceBadge} size="sm" />} />
              <Separator />
              <Row
                label="Feedback (on-chain)"
                value={
                  feedback ? (
                    <span className="tabular-nums">
                      {feedback.count} {feedback.count === 1 ? 'record' : 'records'}
                      {feedback.average != null && (
                        <span className="text-muted-foreground"> · avg {feedback.average.toFixed(0)}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
              />
              <Separator />
              <Row
                label="First Seen"
                value={
                  <span className="text-muted-foreground">
                    {walletRow.first_seen
                      ? new Date(walletRow.first_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                      : '—'}
                  </span>
                }
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      {feedback && feedback.records.length > 0 && (
        <FeedbackRecordsCard records={feedback.records} raters={raters} chain="arc" />
      )}

      <GiveFeedbackCard agentId={agentId} chain="arc" ownerAddress={agent?.owner ?? walletRow.address} />

      {services.length > 0 && (
        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
              Declared services
            </CardTitle>
            <p className="mt-1 text-[11px] text-[#62666d]">
              From the agent&apos;s registration JSON. AgentKarma does not proxy
              these endpoints; we link, we do not relay.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {services.map((s, idx) => (
              <div
                key={`${s.endpoint}-${idx}`}
                className="flex items-center justify-between rounded-md border border-border bg-card/40 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-[510] text-[#f7f8f8]">{s.name}</div>
                  <div className="truncate font-mono text-[11.5px] text-muted-foreground">
                    {s.endpoint}
                  </div>
                </div>
                {s.version && (
                  <span className="ml-3 shrink-0 rounded-full bg-[rgb(255_255_255/0.04)] px-2 py-0.5 text-[10px] text-muted-foreground">
                    {s.version}
                  </span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {agent?.registrationError && !registrationName && (
        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardContent className="space-y-2 py-4 text-[12.5px] text-muted-foreground">
            <p>Could not fetch the agent&apos;s registration JSON.</p>
            <p className="font-mono text-[11px]">{agent.registrationError}</p>
          </CardContent>
        </Card>
      )}

      {isClaimed && walletRow.claim_signature && walletRow.claim_message && (
        <ClaimProof
          chain="arc"
          address={walletRow.address}
          message={walletRow.claim_message}
          signature={walletRow.claim_signature}
        />
      )}

      {deadMansSwitch}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{value}</dd>
    </div>
  );
}
