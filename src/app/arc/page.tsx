import Link from 'next/link';
import { Suspense } from 'react';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { SettlementQualityPill } from '@/components/settlement-quality-badge';
import { ConfidenceBadge } from '@/components/karma/confidence-badge';
import { ArcDashboard } from '@/components/karma/arc-dashboard';
import { arcTestnet } from '@/config/arc-chain';
import { getArcDashboardStats } from '@/db/client';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AgentKarma on Arc — receipt-grade reputation from USDC settlements',
  description:
    'Arc is Circle\'s USDC-native EVM L1. AgentKarma indexes Arc\'s ERC-8183 agentic-commerce job settlements as Tier-1 receipt-grade signals and reads ERC-8004 reputation, publishing portable karma any 8004-aware client can read.',
};

// Live Arc dashboard (matched settlements + quality) — revalidate so grant demos
// see fresh numbers without hammering RPC. Narrative cards below stay static.
export const revalidate = 60;

// ─── Verified Arc Testnet contract surface ──────────────────────────────────
// Ground truth from docs.arc.io + live RPC probe. The 0x8004… vanity prefix
// marks the CANONICAL ERC-8004 reference contracts — same family as Celo, so
// the Celo ABIs port verbatim.
const ARC_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const ARC_REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const ARC_AGENTIC_COMMERCE = '0x0747EEf0706327138c69792bF28Cd525089e4583';
// USDC ERC-20 token — 6-decimal token units. DECIMALS TRAP: native gas is
// 18-dec (publish-tx cost), USDC token + ERC-8183 job amounts are 6-dec.
const ARC_USDC_TOKEN = '0x3600000000000000000000000000000000000000';

// AgentKarma's registered ERC-8004 identity on Arc Testnet. Real on-chain values
// — agentId read from the mint's Transfer log + verified via ownerOf
// (tx 0x2ac3a26e…). Minted by scripts/arc-register-identity.ts.
const AK_ARC_AGENT_ID = 72077;
const AK_ARC_VALIDATOR = '0xeE2a20AEF0f5F9B52FC334806256014F4DDcB8fc';
const AK_AGENT_URI = 'https://agentkarma.io/.well-known/agent.json';

// A sample Arc address to thread through the "Try it" block. Honestly degrades
// (🟡 / em-dash, never a fake number) when the address has no Arc signal yet.
const DEMO_ADDRESS = '0x0747EEf0706327138c69792bF28Cd525089e4583';

const explorerAddressUrl = (addr: string) =>
  `${arcTestnet.blockExplorers.default.url}/address/${addr}`;

async function ArcDashboardSection() {
  const stats = await getArcDashboardStats().catch(() => null);
  if (!stats) {
    // Absolute last resort — page still renders narrative without KPIs.
    return (
      <p className="mb-10 rounded-lg border border-border px-4 py-6 text-center text-sm text-muted-foreground">
        Arc dashboard temporarily unavailable.
      </p>
    );
  }
  return <ArcDashboard data={stats} />;
}

function DashboardSkeleton() {
  return (
    <div className="mb-10 space-y-6" aria-hidden>
      <div className="h-28 animate-pulse rounded-lg border border-slate-400/15 bg-slate-400/[0.04]" />
      <div className="grid gap-6 md:grid-cols-2">
        <div className="h-40 animate-pulse rounded-lg border border-slate-400/15 bg-slate-400/[0.04]" />
        <div className="h-40 animate-pulse rounded-lg border border-slate-400/15 bg-slate-400/[0.04]" />
      </div>
      <div className="h-48 animate-pulse rounded-lg border border-slate-400/15 bg-slate-400/[0.04]" />
    </div>
  );
}

export default function ArcPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 pb-24 pt-16">
      <div className="mb-10 space-y-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-400/30 bg-slate-400/10 px-3 py-1 text-xs font-medium text-slate-300">
          <span className="size-1.5 rounded-full bg-slate-400" />
          Arc · Testnet · USDC-native
        </div>
        <h1 className="text-4xl font-semibold tracking-tight">
          AgentKarma scores Arc&apos;s USDC settlements
        </h1>
        <p className="max-w-2xl text-balance text-lg text-muted-foreground">
          Arc is Circle&apos;s USDC-native EVM L1 — gas is paid in USDC, and
          agentic commerce settles through an on-chain ERC-8183 job escrow.
          AgentKarma indexes those settlements as Tier-1 receipt-grade signals
          and reads ERC-8004 reputation, publishing one portable karma score any
          8004-aware client can read.
        </p>
      </div>

      {/* Grant-demo dashboard: matched settlements first, narrative below. */}
      <Suspense fallback={<DashboardSkeleton />}>
        <ArcDashboardSection />
      </Suspense>

      {/* AK's registered ERC-8004 identity on Arc Testnet. Real on-chain values
          (agentId from the mint's Transfer log, verified via ownerOf) — no
          fabrication. */}
      <Card className="mb-8 border-slate-400/20 bg-slate-400/[0.03]">
        <CardContent className="p-6">
          <div className="mb-3 inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-slate-300">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            AgentKarma is live on Arc — ERC-8004 identity registered
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-[14rem_1fr]">
            <dt className="text-muted-foreground">AK agentId</dt>
            <dd className="font-mono">
              <a
                href={`${arcTestnet.blockExplorers.default.url}/token/${ARC_IDENTITY_REGISTRY}?a=${AK_ARC_AGENT_ID}`}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {AK_ARC_AGENT_ID}
              </a>
            </dd>
            <dt className="text-muted-foreground">Validator wallet</dt>
            <dd className="font-mono break-all">
              <a
                href={explorerAddressUrl(AK_ARC_VALIDATOR)}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {AK_ARC_VALIDATOR}
              </a>
            </dd>
            <dt className="text-muted-foreground">agentURI</dt>
            <dd className="break-all">
              <a
                href={AK_AGENT_URI}
                target="_blank"
                rel="noreferrer"
                className="font-mono underline-offset-2 hover:underline"
              >
                /.well-known/agent.json
              </a>
            </dd>
          </dl>
          <p className="mt-4 text-sm text-muted-foreground">
            AK is <span className="font-mono text-foreground">agentId {AK_ARC_AGENT_ID}</span> on
            Arc&apos;s IdentityRegistry (mirroring{' '}
            <span className="font-mono text-foreground">agentId 9058</span> on Celo). Arc is
            testnet-only today, so signal volume builds as agents transact — AK reads ERC-8183
            settlements + ERC-8004 reputation and writes karma back as a validator. Unregistered
            wallets stay badge-gated (<ConfidenceBadge badge="behavior-inferred" size="sm" /> /{' '}
            <ConfidenceBadge badge="declared" size="sm" />) until they claim — never a fabricated score.
          </p>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">On-chain integration surface</h2>
            <a
              href={arcTestnet.blockExplorers.default.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              View on Arcscan
              <ExternalLink className="size-3" />
            </a>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-[14rem_1fr]">
            <dt className="text-muted-foreground">Standard</dt>
            <dd className="font-mono">ERC-8004 + ERC-8183 (EVM)</dd>
            <dt className="text-muted-foreground">Chain ID</dt>
            <dd className="font-mono">{arcTestnet.id}</dd>
            <dt className="text-muted-foreground">IdentityRegistry</dt>
            <dd className="font-mono break-all">
              <a
                href={explorerAddressUrl(ARC_IDENTITY_REGISTRY)}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {ARC_IDENTITY_REGISTRY}
              </a>
            </dd>
            <dt className="text-muted-foreground">ReputationRegistry</dt>
            <dd className="font-mono break-all">
              <a
                href={explorerAddressUrl(ARC_REPUTATION_REGISTRY)}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {ARC_REPUTATION_REGISTRY}
              </a>
            </dd>
            <dt className="text-muted-foreground">AgenticCommerce (ERC-8183)</dt>
            <dd className="font-mono break-all">
              <a
                href={explorerAddressUrl(ARC_AGENTIC_COMMERCE)}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {ARC_AGENTIC_COMMERCE}
              </a>
            </dd>
            <dt className="text-muted-foreground">USDC token (6-dec)</dt>
            <dd className="font-mono break-all">
              <a
                href={explorerAddressUrl(ARC_USDC_TOKEN)}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {ARC_USDC_TOKEN}
              </a>
            </dd>
            <dt className="text-muted-foreground">Gas token</dt>
            <dd className="font-mono">USDC (native, 18-dec accounting)</dd>
            <dt className="text-muted-foreground">Address format</dt>
            <dd className="font-mono">EVM 0x… (20-byte, 42 chars)</dd>
            <dt className="text-muted-foreground">Faucet</dt>
            <dd className="break-all">
              <a
                href="https://faucet.circle.com"
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                faucet.circle.com
              </a>
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-4 text-xl font-semibold">Settlements are the signal</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Arc routes agentic commerce through an on-chain ERC-8183 job escrow.
            When an agent completes a paid job, the USDC settlement is recorded
            on-chain — an immutable receipt of work delivered and paid. AK reads
            those job amounts (6-decimal USDC) as{' '}
            <span className="font-mono text-foreground">Tier 1</span> receipt-grade
            signals, the strongest evidence in the four-tier spectrum, then layers
            ERC-8004 reputation on top. x402-first, not x402-only: an Arc
            settlement is a receipt, same as an x402 payment on Solana.
          </p>
          <div className="rounded-md border border-slate-400/40 bg-slate-400/[0.06] p-3 text-sm">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-300">
              Witness, not gatekeeper
            </div>
            <div>
              AK never receives, holds, escrows, or releases funds. The ERC-8183
              contract settles the job; AK observes the completed settlement on
              the public ledger and records an attestation. Non-routing mandate
              holds on Arc exactly as on every other rail.
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Honest finding: on Arc's testnet registry both feedback AND settlements
          are farmable, so AK scores neither by raw count — it gates on receipts
          from distinct, independent counterparties. */}
      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-4 text-xl font-semibold">Reviews can be farmed. Receipts can&apos;t.</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Arc&apos;s ERC-8004 IdentityRegistry is farmed-heavy on testnet. Most agents
            carry on-chain feedback — but ungated ERC-8004 reviews and unpaired{' '}
            <span className="font-mono text-foreground">PaymentReleased</span> events
            are not proof. Neither a review count nor a raw settlement count is evidence.
          </p>
          <p className="mb-4 text-sm text-muted-foreground">
            So AgentKarma scores delivery by <span className="text-foreground">settlement
            quality</span>: receipts that clear the ERC-8183 escrow, weighted by how many{' '}
            <span className="text-foreground">distinct, independent</span> counterparties actually
            paid — never a self-reported percentage. The dashboard above shows that split live.
          </p>
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <SettlementQualityPill label="reliable" />
              <span className="text-sm text-muted-foreground">
                3+ receipts across 3+ distinct, non-clustered counterparties.
              </span>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <SettlementQualityPill label="mixed" />
              <span className="text-sm text-muted-foreground">
                Receipts exist, but the counterparty breadth is thin (1–2 payers).
              </span>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <SettlementQualityPill label="unproven" />
              <span className="text-sm text-muted-foreground">
                Too few receipts, or high volume funneled through &lt;3 counterparties (a wash
                pattern).
              </span>
            </div>
          </div>
          <div className="mt-4 rounded-md border border-slate-400/40 bg-slate-400/[0.06] p-3 text-sm">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-300">
              The counterparty is the proof
            </div>
            <div>
              A score means nothing unless the party on the other side was real and independent.
              Self-issued reviews and wash settlements collapse to <SettlementQualityPill label="unproven" /> —
              the one signal a spam operator can&apos;t manufacture is a distinct counterparty who actually paid.
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-4 text-xl font-semibold">A validator on Arc&apos;s ERC-8004 layer</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            The <span className="font-mono text-foreground">0x8004…</span> vanity
            prefix marks the canonical ERC-8004 reference contracts — the same
            contract family AK already reads on Celo, so the Identity and
            Reputation ABIs port verbatim. AK reuses Arc&apos;s agent identity and
            discovery, scores the wallet by its settlement history, and writes
            two-faced karma (<span className="font-mono text-foreground">provider</span>{' '}
            / <span className="font-mono text-foreground">consumer</span>) back to
            the ReputationRegistry as a third-party rater — confidence badge and
            four-tier provenance carried in the evidence payload. A validator on
            their layer, not a competing aggregator.
          </p>
          <div className="rounded-md border border-slate-400/40 bg-slate-400/[0.06] p-3 text-sm">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-300">
              Identity-gated, like Celo
            </div>
            <div>
              Registered or claimed agents are attested on-chain. Unregistered
              wallets stay badge-gated (<ConfidenceBadge badge="behavior-inferred" size="sm" /> /{' '}
              <ConfidenceBadge badge="declared" size="sm" />) until they claim — never a single
              collapsed score, never a receipt-backed number without a settlement behind it.
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-8 border-slate-400/20 bg-slate-400/[0.03]">
        <CardContent className="p-6">
          <h2 className="mb-4 text-2xl font-semibold leading-tight">
            One reputation, every rail.
          </h2>
          <p className="mb-5 text-sm text-muted-foreground">
            Reputation is only useful if it&apos;s portable. AK reads x402 and
            MPP receipts on Solana, ERC-8004 feedback on Celo, USDC settlements on
            Stellar and Arc, then writes the same ERC-8004 attestation any
            8004-aware client can read on any chain. Agents operating across rails
            keep their score; consumers preflight on whichever rail they paid
            through.
          </p>
          <div className="flex flex-wrap gap-1.5 text-[10px] font-medium uppercase tracking-wider">
            {['Receipt-gated', 'USDC-native', 'Two-faced', 'Autonomy-aware', 'Cross-chain', 'No token'].map((chip) => (
              <span key={chip} className="rounded-full border border-border bg-card/50 px-2 py-0.5 text-muted-foreground">
                {chip}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <h2 className="mb-3 text-xl font-semibold">Try it</h2>
          <div className="space-y-2 font-mono text-sm">
            <Link
              href={`/api/score/${DEMO_ADDRESS}?chain=arc`}
              className="flex items-center justify-between rounded-md bg-card/50 px-3 py-2 hover:bg-card"
            >
              <span>GET /api/score/&lt;0x…&gt;?chain=arc</span>
              <ArrowRight className="size-4" />
            </Link>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Public read API. No auth. Same two-faced karma payload as the Solana
            score route. Celo and Arc share the EVM <span className="font-mono">0x</span> format,
            so pin the chain with <span className="font-mono">?chain=arc</span>. Returns honest,
            badge-gated reads while Arc testnet signal volume builds.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
