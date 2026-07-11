import type { Metadata } from 'next';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { readAgent } from '@/integrations/erc8004-celo';
import { getAkConnectedFeedback } from '@/db/client';
import { DisclosureList } from '@/components/karma/disclosure-list';
import { METADATA_RUBRIC, METADATA_SCHEME_VERSION } from '@/scoring/celo-metadata';
import { AK_VALIDATOR, celoscanAddress } from '@/config/ak-validator';

export const metadata: Metadata = {
  title: 'AgentKarma on Celo — multi-chain reputation primitive',
  description:
    'AgentKarma is registered on Celo as ERC-8004 agentId 9058, publishing portable reputation feedback across Solana and Celo.',
};

// Max points the rubric can award — derived from the rubric itself so the
// headline "/100" stays in sync if a dimension's weight ever changes.
const RUBRIC_MAX = METADATA_RUBRIC.reduce((sum, d) => sum + d.max, 0);

// Server-render the on-chain state. ISR keeps it fresh without hammering RPC.
export const revalidate = 300;

const AK_AGENT_ID = BigInt(AK_VALIDATOR.agentId);
// Controller wallet — single-sourced from config (owns identity 9058 + treasury).
const AK_OWNER = AK_VALIDATOR.controller;

// AK signs giveFeedback from TWO wallets, both disclosed in AK_VALIDATOR and
// both in the AK-rater set. Each wallet's Celoscan address page is its full
// transaction list — every giveFeedback tx lives there. The registry VIEW
// (readAllFeedback) the mirror is built from returns no per-record tx hash, so
// there is no per-row celoscan.io/tx link to surface; we link the wallets.
const AK_CONTROLLER_CELOSCAN_URL = celoscanAddress(AK_VALIDATOR.controller);
const AK_VALIDATOR_CELOSCAN_URL = celoscanAddress(AK_VALIDATOR.validator);

// Exact per-wallet counts of successful giveFeedback transactions AK has sent to
// the Celo mainnet ReputationRegistry, verified on-chain (asOf 2026-06-29). This
// is on-chain TRANSACTION activity — verifiable on Celoscan — and is distinct
// from the indexed per-agent list length below (which can lag the chain or fold
// revocations differently). The split reflects least-privilege: the cold
// controller seeded the early attestations; the operational validator wallet
// signs the automated batch now.
const AK_GIVEFEEDBACK_TX = { controller: 26, validator: 42, asOf: '2026-06-29' } as const;
const AK_GIVEFEEDBACK_TX_COUNT = AK_GIVEFEEDBACK_TX.controller + AK_GIVEFEEDBACK_TX.validator;

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
          <p className="mb-3 text-sm text-muted-foreground">
            AK has published{' '}
            <span className="font-medium text-foreground">
              {AK_GIVEFEEDBACK_TX_COUNT} giveFeedback attestations
            </span>{' '}
            to the Celo ReputationRegistry — each an on-chain transaction, scoring
            an agent&apos;s registration quality on a 0-100 scale via the open{' '}
            <span className="font-mono text-foreground">agentkarma_metadata</span>{' '}
            scheme. Deterministic, revokable. Early records were written under
            rubric <span className="font-mono text-foreground">v0.1</span>; the
            current rubric is{' '}
            <span className="font-mono text-foreground">{METADATA_SCHEME_VERSION}</span>{' '}
            (see <em>How AgentKarma scores</em> below). Expand any row for AK&apos;s
            current breakdown of that agent&apos;s metadata. Independent reviews left
            through AK&apos;s give-feedback UX appear here too.
          </p>
          <p className="mb-3 text-sm text-muted-foreground">
            AK signs these attestations from{' '}
            <span className="font-medium text-foreground">two wallets</span>, by
            least-privilege design: the{' '}
            <span className="font-medium text-foreground">controller</span> (owns
            identity {AK_VALIDATOR.agentId} and the treasury, kept cold —{' '}
            {AK_GIVEFEEDBACK_TX.controller} attestations) and the{' '}
            <span className="font-medium text-foreground">validator</span> (the hot
            operational signer for automated attestations —{' '}
            {AK_GIVEFEEDBACK_TX.validator} attestations). Both are AK-controlled
            and disclosed; neither is presented as an independent third party.
          </p>
          <div className="mb-4 rounded-md border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
            <span>
              On-chain count is verifiable — every giveFeedback tx lives in each
              wallet&apos;s transaction list (asOf {AK_GIVEFEEDBACK_TX.asOf}).
            </span>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
              <a
                href={AK_CONTROLLER_CELOSCAN_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
              >
                Verify controller on Celoscan ({AK_GIVEFEEDBACK_TX.controller})
                <ExternalLink className="size-3" />
              </a>
              <a
                href={AK_VALIDATOR_CELOSCAN_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
              >
                Verify validator on Celoscan ({AK_GIVEFEEDBACK_TX.validator})
                <ExternalLink className="size-3" />
              </a>
            </div>
          </div>
          <DisclosureList records={akFeedback} />
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">How AgentKarma scores</h2>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              agentkarma_metadata {METADATA_SCHEME_VERSION}
            </span>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            Every <span className="font-medium text-foreground">AK rated N/100</span>{' '}
            above is a pure, deterministic function of the agent&apos;s ERC-8004
            registration JSON — same registration always yields the same score, no
            network calls, no clock, no randomness. It is a{' '}
            <span className="font-medium text-foreground">Tier-3 declared / registration-quality</span>{' '}
            signal: it measures how completely and tamper-resistantly an agent has
            described itself. It is{' '}
            <span className="text-foreground">not a behavioral judgement</span> and{' '}
            <span className="text-foreground">not a verdict on whether the agent is &ldquo;good&rdquo;</span>.
            The methodology is open, the scheme is versioned, and each attestation
            is revokable on-chain.
          </p>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-card/40 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Dimension</th>
                  <th className="w-16 px-3 py-2 text-right font-medium">Max</th>
                  <th className="px-3 py-2 font-medium">What it checks</th>
                </tr>
              </thead>
              <tbody>
                {METADATA_RUBRIC.map((dim) => (
                  <tr key={dim.key} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-medium text-foreground">{dim.label}</td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">{dim.max}</td>
                    <td className="px-3 py-2 text-muted-foreground">{dim.checks}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-card/40 text-xs">
                  <td className="px-3 py-2 font-medium text-foreground">Total</td>
                  <td className="px-3 py-2 text-right font-mono text-foreground">{RUBRIC_MAX}</td>
                  <td className="px-3 py-2 text-muted-foreground">Sum of all dimensions</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-4 rounded-md border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
            Endpoint <em>reachability</em> is deliberately excluded from the score —
            a live check would be non-deterministic and network-bound. Liveness, if
            published, is a separate signal, never folded into this number.
          </p>
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
