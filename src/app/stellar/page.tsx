import { Suspense } from 'react';
import Link from 'next/link';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { getAdapter } from '@/chain-adapters/registry';
import {
  STELLAR_IDENTITY_REGISTRY,
  STELLAR_REPUTATION_REGISTRY,
} from '@/integrations/stellar-config';
import ScoreComparison from '@/components/stellar/score-comparison';

export const metadata = {
  title: 'AgentKarma on Stellar — settlement-backed reputation',
  description:
    'stellar-8004 gives agents free star scores anyone can inflate. AgentKarma scores the same agents by real USDC settlements on the public Stellar ledger — settlement-backed, ledger-auditable, published back to the Soroban ReputationRegistry.',
};

// The side-by-side reads live on-chain (Soroban) + DB state, so the page is
// rendered per-request rather than prebaked at build time. force-dynamic keeps
// the two scores current and avoids prerendering DB/RPC reads with no env.
export const dynamic = 'force-dynamic';

// A registered stellar-8004 agent to show the side-by-side against. Sample
// G-address; the comparison degrades honestly (🟡 + em-dash, never a fake
// number) when the agent is unregistered or has no AK settlement on record.
const DEMO_AGENT = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

export default function StellarPage() {
  const stellar = getAdapter('stellar');

  return (
    <main className="mx-auto max-w-4xl px-4 pb-24 pt-16">
      <div className="mb-12 space-y-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-300">
          <span className="size-1.5 rounded-full bg-sky-400" />
          Stellar · Mainnet
        </div>
        <h1 className="text-4xl font-semibold tracking-tight">
          AgentKarma adds the trust layer stellar-8004 lacks
        </h1>
        <p className="max-w-2xl text-balance text-lg text-muted-foreground">
          stellar-8004 gives agents free star scores anyone can inflate.
          AgentKarma scores the same agents by real USDC settlements on the
          public Stellar ledger — every point is backed by a payment anyone can
          verify on-ledger. Verifiable, not gameable.
        </p>
      </div>

      {/* The money shot: same agent, two numbers. Suspense so a slow Soroban
          read never blocks the page; the comparison itself degrades honestly. */}
      <div className="mb-8">
        <Suspense fallback={<ComparisonSkeleton />}>
          <ScoreComparison address={DEMO_AGENT} />
        </Suspense>
      </div>

      <Card className="mb-8">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">On-chain attestation surface</h2>
            <a
              href="https://stellar8004.com"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              View on stellar8004
              <ExternalLink className="size-3" />
            </a>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-[12rem_1fr]">
            <dt className="text-muted-foreground">Standard</dt>
            <dd className="font-mono">ERC-8004 (Soroban)</dd>
            <dt className="text-muted-foreground">ReputationRegistry</dt>
            <dd className="font-mono break-all">{STELLAR_REPUTATION_REGISTRY}</dd>
            <dt className="text-muted-foreground">IdentityRegistry</dt>
            <dd className="font-mono break-all">{STELLAR_IDENTITY_REGISTRY}</dd>
            <dt className="text-muted-foreground">Address format</dt>
            <dd className="font-mono">StrKey G… (Ed25519, 56 chars)</dd>
            <dt className="text-muted-foreground">Explorer</dt>
            <dd className="break-all">
              <a
                href={stellar.explorerAddressUrl(DEMO_AGENT)}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                stellar.expert
              </a>
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-4 text-xl font-semibold">A validator on stellar-8004&apos;s layer</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            AK reuses stellar-8004&apos;s agent identity and discovery, then signs{' '}
            <span className="font-mono text-foreground">give_feedback</span> on the
            Soroban ReputationRegistry as a third-party rater — two entries per
            agent (<span className="font-mono text-foreground">provider</span> /{' '}
            <span className="font-mono text-foreground">consumer</span>), the
            confidence badge and four-tier provenance carried in the evidence
            payload. A validator on their layer, not a competing aggregator. Same
            cross-chain model AK already runs on Celo.
          </p>
          <div className="rounded-md border border-sky-500/40 bg-sky-500/[0.06] p-3 text-sm">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-sky-300">
              Identity-gated, like Celo
            </div>
            <div>
              Registered or claimed agents are attested on-chain. Unregistered
              wallets stay badge-gated (🟡 Behavior-inferred / ⚪ Declared) until
              they claim — never a single collapsed score, never a settlement-backed
              number without a settlement behind it.
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-3 text-xl font-semibold">How it stays honest</h2>
          <p className="text-sm text-muted-foreground">
            Every AgentKarma point references a real USDC SAC{' '}
            <span className="font-mono text-foreground">transfer</span> on the
            Stellar ledger. The transaction hash is immutable on-ledger, so anyone
            with an RPC endpoint can re-derive the same settlement fact — an
            auditable oracle that reports what the ledger already proves. AK never
            receives, holds, escrows, or releases funds. It observes a completed
            settlement and records an attestation. Witness, not gatekeeper.
          </p>
        </CardContent>
      </Card>

      <Card className="mb-8 border-sky-500/20 bg-sky-500/[0.03]">
        <CardContent className="p-6">
          <h2 className="mb-4 text-2xl font-semibold leading-tight">
            One reputation, every rail.
          </h2>
          <p className="mb-5 text-sm text-muted-foreground">
            Reputation is only useful if it&apos;s portable. AK reads x402 and MPP
            receipts on Stellar, scores the wallet, and writes the same ERC-8004
            attestation any 8004-aware client can read — on Solana, Celo, or
            Stellar. x402-first, not x402-only: settlement is Tier 1; behavioral,
            declared, and social signals fill Tiers 2–4.
          </p>
          <div className="flex flex-wrap gap-1.5 text-[10px] font-medium uppercase tracking-wider">
            {['Settlement-backed', 'Ledger-auditable', 'Two-faced', 'Autonomy-aware', 'Cross-chain', 'No token'].map((chip) => (
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
              href={`/api/score/${DEMO_AGENT}?chain=stellar`}
              className="flex items-center justify-between rounded-md bg-card/50 px-3 py-2 hover:bg-card"
            >
              <span>GET /api/score/&lt;G…&gt;?chain=stellar</span>
              <ArrowRight className="size-4" />
            </Link>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Public read API. No auth. Same two-faced karma payload as the Solana
            score route — chain auto-detected from the StrKey address, or pinned
            with <span className="font-mono">?chain=stellar</span>. The MCP tool{' '}
            <span className="font-mono">get_stellar_karma</span> wraps the same
            read for agent clients.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

function ComparisonSkeleton() {
  return (
    <Card className="border-sky-500/20 bg-sky-500/[0.03]">
      <CardContent className="p-6">
        <div className="mb-1 h-6 w-48 animate-pulse rounded bg-card" />
        <div className="mb-5 mt-2 h-4 w-full animate-pulse rounded bg-card" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="h-36 animate-pulse rounded-lg bg-card" />
          <div className="h-36 animate-pulse rounded-lg bg-card" />
        </div>
      </CardContent>
    </Card>
  );
}
