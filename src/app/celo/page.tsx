import Link from 'next/link';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { readAgent, aggregateFeedback } from '@/integrations/erc8004-celo';

export const metadata = {
  title: 'AgentKarma on Celo — multi-chain reputation primitive',
  description:
    'AgentKarma is registered on Celo as ERC-8004 agentId 9058, publishing portable reputation feedback across Solana and Celo.',
};

// Server-render the on-chain state. ISR keeps it fresh without hammering RPC.
export const revalidate = 300;

const AK_AGENT_ID = BigInt(9058);
const AK_OWNER = '0xCfc0A11C75519FAf85B7872E27733CFaa4295b96';

export default async function CeloPage() {
  // Read AK's own on-chain identity + the feedback AK has issued (as client).
  // aggregateFeedback by agentId returns feedback RECEIVED by an agent; AK has
  // 0 received because it's a writer, not a target. We surface the WRITES via
  // a known list — for now hand-curated; the indexer (M2) will materialize this.
  const akAgent = await readAgent(AK_AGENT_ID).catch(() => null);

  // First feedback AK published (M0 evidence) — agent 1 / 85 metadata_quality
  const writtenTargets = [{ agentId: 1, scoreNote: '85/100 metadata_quality' }];
  const writtenWithData = await Promise.all(
    writtenTargets.map(async (t) => {
      const agent = await readAgent(BigInt(t.agentId)).catch(() => null);
      const agg = await aggregateFeedback(BigInt(t.agentId)).catch(() => null);
      return {
        ...t,
        agent,
        feedbackCount: agg?.count ?? 0,
        average: agg?.average ?? null,
      };
    }),
  );

  return (
    <main className="mx-auto max-w-4xl px-4 pb-24 pt-16">
      <div className="mb-12 space-y-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-3 py-1 text-xs font-medium text-yellow-400">
          <span className="size-1.5 rounded-full bg-yellow-400" />
          Celo · Mainnet
        </div>
        <h1 className="text-4xl font-semibold tracking-tight">
          AgentKarma on Celo
        </h1>
        <p className="max-w-2xl text-balance text-lg text-muted-foreground">
          The reputation primitive AK runs on Solana is now multi-chain.
          AgentKarma is registered on Celo as ERC-8004{' '}
          <span className="font-mono text-foreground">agentId 9058</span>,
          actively publishing portable reputation feedback across both ecosystems.
        </p>
      </div>

      <Card className="mb-8">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">AK&apos;s on-chain identity</h2>
            <a
              href="https://8004scan.io/agent/9058"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              View on 8004scan
              <ExternalLink className="size-3" />
            </a>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">agentId</dt>
            <dd className="font-mono">9058</dd>
            <dt className="text-muted-foreground">Controller wallet</dt>
            <dd className="font-mono break-all">{akAgent?.owner ?? AK_OWNER}</dd>
            <dt className="text-muted-foreground">IdentityRegistry</dt>
            <dd className="font-mono break-all">0x8004A169FB4a3325136EB29fA0ceB6D2e539a432</dd>
            <dt className="text-muted-foreground">agentURI</dt>
            <dd className="break-all">
              <Link href="/.well-known/agent.json" className="underline-offset-2 hover:underline">
                {akAgent?.tokenURI ?? '/.well-known/agent.json'}
              </Link>
            </dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                Active
              </span>
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-4 text-xl font-semibold">As a 8004 validator</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            AK publishes <span className="font-mono text-foreground">agentkarma_metadata v0.1</span>{' '}
            feedback to the Celo ReputationRegistry — scoring each agent&apos;s
            on-chain registration JSON quality on a 0-100 scale. Open scheme,
            deterministic, revokable.
          </p>
          <div className="space-y-3">
            {writtenWithData.map((t) => (
              <div
                key={t.agentId}
                className="flex items-center justify-between rounded-lg border border-border bg-card/50 px-4 py-3"
              >
                <div>
                  <div className="font-medium">
                    {t.agent?.registration?.name ?? `Agent ${t.agentId}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    agentId {t.agentId} · {t.feedbackCount} total feedback · avg {t.average?.toFixed(0) ?? '—'}
                  </div>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
                    AK rated: {t.scoreNote}
                  </span>
                  <Link
                    href={`/api/v2/celo/${t.agentId}`}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ArrowRight className="size-4" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="mb-8 border-yellow-500/20 bg-yellow-500/[0.03]">
        <CardContent className="p-6">
          <h2 className="mb-3 text-xl font-semibold">How this sits next to 8004scan</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            <strong className="text-foreground">8004scan tells you an agent exists and what others say about it. AgentKarma is one of those others</strong> — but with receipt-gated signals, two-faced scoring, autonomy detection, and a published methodology. The relationship is layered, not competitive.
          </p>
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-border bg-card/50 p-3">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Explorer / aggregator</div>
              <div>
                <a href="https://8004scan.io" target="_blank" rel="noreferrer" className="font-semibold underline-offset-2 hover:underline">8004scan.io</a>
                {' '}— indexes every IdentityRegistry, rolls raw on-chain feedback into a displayed score. AK does <em>not</em> compete with this.
              </div>
            </div>
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] p-3">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-emerald-400">Validator ← AK lives here</div>
              <div>
                One of the addresses behind 8004scan&apos;s scores. The aggregate is only as good as the raters. AK publishes thoughtful, signal-gated, methodology-open assessments — not anonymous integer scores.
              </div>
            </div>
            <div className="rounded-md border border-border bg-card/50 p-3">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Reputation primitive</div>
              <div>
                AK&apos;s open{' '}
                <Link href="/protocol" className="font-semibold underline-offset-2 hover:underline">Karma Protocol RFC</Link>
                {' '}— the schema other validators can adopt to publish reproducible, contestable scores.
              </div>
            </div>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            What AK contributes that an anonymous integer doesn&apos;t: receipt-gated Tier 1 · two-faced karma · Autonomy Confidence · published methodology · cross-chain native · no token.
          </p>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-3 text-xl font-semibold">Why both chains</h2>
          <p className="text-sm text-muted-foreground">
            Reputation is only useful if it&apos;s portable. AgentKarma reads
            x402 receipts, ERC-8004 attestations, and behavioral signals from
            Solana <em>and</em> Celo, then publishes one unified karma score back
            to ERC-8004 — so any 8004-aware client on any chain can read it.
            Agents operating on multiple chains keep their score; consumers
            preflight on whichever rail they paid through.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <h2 className="mb-3 text-xl font-semibold">Try it</h2>
          <div className="space-y-2 font-mono text-sm">
            <Link
              href="/api/v2/celo/9058"
              className="block rounded-md bg-card/50 px-3 py-2 hover:bg-card"
            >
              GET /api/v2/celo/9058 — AK&apos;s own profile
            </Link>
            <Link
              href="/api/v2/celo/1"
              className="block rounded-md bg-card/50 px-3 py-2 hover:bg-card"
            >
              GET /api/v2/celo/1 — the first agent ever registered
            </Link>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Public read API. No auth. Returns IdentityRegistry record + parsed
            registration JSON + aggregate ReputationRegistry feedback.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
