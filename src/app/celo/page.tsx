import Link from 'next/link';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { readAgent } from '@/integrations/erc8004-celo';
import { getAkConnectedFeedback } from '@/db/client';
import { agentHref } from '@/lib/agent-href';

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
  // Read AK's own on-chain identity, plus every feedback record AK is connected
  // to on Celo — AK's algorithmic metadata attestations AND independent reviews
  // left through AK's give-feedback UX — from the registry mirror (no live RPC).
  const [akAgent, akFeedback] = await Promise.all([
    readAgent(AK_AGENT_ID).catch(() => null),
    getAkConnectedFeedback('celo').catch(() => []),
  ]);

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
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Feedback AgentKarma made on Celo</h2>
            <Link
              href="/validator"
              className="shrink-0 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Validator disclosure →
            </Link>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            AK publishes <span className="font-mono text-foreground">agentkarma_metadata v0.1</span>{' '}
            attestations to the Celo ReputationRegistry — scoring each agent&apos;s
            on-chain registration quality on a 0-100 scale. Open scheme,
            deterministic, revokable. Independent reviews left through AK&apos;s
            give-feedback UX appear here too.
          </p>
          {akFeedback.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-card/30 px-4 py-6 text-center text-sm text-muted-foreground">
              No published feedback indexed yet.
            </p>
          ) : (
            <div className="space-y-3">
              {akFeedback.map((f) => {
                const href = f.targetAddress
                  ? agentHref({ chain: 'celo', address: f.targetAddress, agentId: f.agentId })
                  : `/api/v2/celo/${f.agentId}`;
                return (
                  <div
                    key={`${f.agentId}-${f.client}-${f.kind}`}
                    className={`flex items-center justify-between rounded-lg border border-border bg-card/50 px-4 py-3 ${
                      f.revoked ? 'opacity-60' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <div className={`truncate font-medium ${f.revoked ? 'line-through' : ''}`}>
                        {f.targetName ?? `Agent ${f.agentId}`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        agentId {f.agentId} · {f.targetFeedbackCount ?? 0} total feedback
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-sm">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          f.revoked
                            ? 'bg-muted text-muted-foreground'
                            : f.kind === 'review'
                              ? 'bg-indigo-500/15 text-indigo-300'
                              : 'bg-emerald-500/15 text-emerald-400'
                        }`}
                      >
                        {f.revoked
                          ? 'revoked'
                          : `${f.kind === 'review' ? 'Review' : 'AK rated'}: ${f.value}/100`}
                      </span>
                      <Link
                        href={href}
                        className="text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ArrowRight className="size-4" />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-8 border-yellow-500/20 bg-yellow-500/[0.03]">
        <CardContent className="p-6">
          <h2 className="mb-4 text-2xl font-semibold leading-tight">
            An aggregate score is only as good as its raters.
          </h2>
          <p className="mb-5 text-sm text-muted-foreground">
            <a href="https://8004scan.io" target="_blank" rel="noreferrer" className="font-semibold text-foreground underline-offset-2 hover:underline">8004scan</a>
            {' '}rolls them up. <strong className="text-foreground">AgentKarma is the one with receipts.</strong>
          </p>
          <div className="space-y-2 text-sm">
            <div className="rounded-md border border-border bg-card/50 p-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Explorer</div>
              <div>
                <a href="https://8004scan.io" target="_blank" rel="noreferrer" className="font-semibold underline-offset-2 hover:underline">8004scan.io</a>
                {' '}aggregates every on-chain feedback record into one displayed score per agent.
              </div>
            </div>
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/[0.06] p-3 shadow-[0_0_0_1px_rgba(16,185,129,0.15)]">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-emerald-400">Validator ← AgentKarma</div>
              <div>
                Writes one of those records — open methodology, receipt-gated signals, versioned schemes you can audit, contest, replicate.
                <span className="block mt-1 text-muted-foreground">Most raters publish an integer.</span>
              </div>
            </div>
            <div className="rounded-md border border-border bg-card/50 p-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Primitive</div>
              <div>
                <Link href="/protocol" className="font-semibold underline-offset-2 hover:underline">Karma Protocol RFC</Link>
                {' '}— the open schema any validator can adopt to publish reproducible, contestable scores.
              </div>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-1.5 text-[10px] font-medium uppercase tracking-wider">
            {['Receipt-gated', 'Two-faced', 'Autonomy-aware', 'Methodology open', 'Cross-chain', 'No token'].map((chip) => (
              <span key={chip} className="rounded-full border border-border bg-card/50 px-2 py-0.5 text-muted-foreground">
                {chip}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-3 text-xl font-semibold">Why both chains</h2>
          <p className="text-sm text-muted-foreground">
            Reputation is only useful if it&apos;s portable. AgentKarma reads
            x402 receipts and behavioral signals on Solana, and ERC-8004 identity
            + on-chain feedback on Celo, then publishes one unified karma score
            back to ERC-8004 — so any 8004-aware client on any chain can read it.
            Agents operating on multiple chains keep their score; consumers
            preflight on whichever rail they paid through.
          </p>
          <p className="mt-3 rounded-md border border-yellow-500/20 bg-yellow-500/[0.04] px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-yellow-400/90">On Celo today, scores are declared-tier</span>{' '}
            — ERC-8004 identity and on-chain feedback. Receipt-gated Tier-1 (x402)
            is live on Solana, and coming to Celo as the x402 indexer lands. The
            ⚪ Declared badge on each agent reflects this.
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
