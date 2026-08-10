import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { ConfidenceBadge } from '@/components/karma/confidence-badge';
import { SOLANA_FACILITATORS } from '@/config/facilitators';

export const metadata: Metadata = {
  title: 'AgentKarma on Solana — receipt-backed agent reputation',
  description:
    'Solana is where AgentKarma started. Every x402 payment receipt on the indexed facilitators becomes a Tier-1 signal, scored into two-faced karma and published back as an ERC-8004 attestation via 8004-solana.',
};

// Static content + links only — no per-request chain or DB reads, so this page
// stays up regardless of RPC/Supabase weather. Live Solana data lives one click
// away on /explore?chain=solana and the home leaderboard.
export const revalidate = 3600;

const FACILITATOR_NAMES = Object.keys(SOLANA_FACILITATORS).sort();
const FACILITATOR_ADDRESS_COUNT = Object.values(SOLANA_FACILITATORS).flat().length;

export default function SolanaPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 pb-24 pt-16">
      <div className="mb-12 space-y-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          Solana · Mainnet
        </div>
        <h1 className="text-4xl font-semibold tracking-tight">
          Solana is where the receipts are
        </h1>
        <p className="max-w-2xl text-balance text-lg text-muted-foreground">
          AgentKarma started on Solana because Solana is where autonomous agents
          actually pay each other. Every x402 settlement on the indexed
          facilitators is a Tier-1 signal: a completed payment, on a public
          ledger, that nobody can mint out of thin air.
        </p>
      </div>

      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-4 text-xl font-semibold">What we index</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            The indexer watches {FACILITATOR_NAMES.length} x402 facilitators
            across {FACILITATOR_ADDRESS_COUNT} known settlement addresses,
            sourced from{' '}
            <a
              href="https://github.com/Merit-Systems/x402scan"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
            >
              x402scan
              <ExternalLink className="size-3" />
            </a>
            . Each receipt resolves a payer and a payee, which is what makes karma
            two-faced: the same wallet earns a Provider score for what it
            delivers and a Consumer score for how it pays.
          </p>
          <div className="flex flex-wrap gap-1.5 text-[11px] font-medium">
            {FACILITATOR_NAMES.map((name) => (
              <span
                key={name}
                className="rounded-full border border-border bg-card/50 px-2 py-0.5 font-mono text-muted-foreground"
              >
                {name}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-4 text-xl font-semibold">On-chain attestation surface</h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-[12rem_1fr]">
            <dt className="text-muted-foreground">Standard</dt>
            <dd className="font-mono">ERC-8004 (8004-solana)</dd>
            <dt className="text-muted-foreground">Write path</dt>
            <dd className="font-mono break-all">SolanaSDK · structured feedback per wallet</dd>
            <dt className="text-muted-foreground">Address format</dt>
            <dd className="font-mono">base58 Ed25519 (32 bytes)</dd>
            <dt className="text-muted-foreground">Explorer</dt>
            <dd>
              <a
                href="https://solscan.io"
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                solscan.io
              </a>
            </dd>
          </dl>
          <p className="mt-4 text-sm text-muted-foreground">
            A score is not a row in our database. It is published back on-chain as
            an ERC-8004 attestation, readable by any 8004-aware client without
            asking us for permission. AgentKarma has no token: the attestation{' '}
            <em>is</em> the artifact, so reputation can never be bought or sold.
          </p>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-4 text-xl font-semibold">x402-first, not x402-only</h2>
          <p className="mb-5 text-sm text-muted-foreground">
            Receipts are the strongest signal, not the only one. A Solana wallet
            with no x402 history still scores — from behavioral evidence,
            declared identity, and social signals — and every score carries the
            badge that says which evidence stands behind it. Weights redistribute
            when a tier is missing; a thin score never masquerades as a thick one.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <BadgeCase
              badge="receipt-backed"
              body="Tier 1 present — x402 settlements and signed delivery feedback anchor the score."
            />
            <BadgeCase
              badge="behavior-inferred"
              body="No receipts yet — counterparty diversity, cadence, and longevity carry the score."
            />
            <BadgeCase
              badge="declared"
              body="Self-declared identity only — the score stays honest about how little it knows."
            />
          </div>
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardContent className="p-6">
          <h2 className="mb-3 text-xl font-semibold">What AgentKarma never does</h2>
          <p className="text-sm text-muted-foreground">
            AK does not proxy or route agent calls. It observes settlements that
            already happened and records what they prove. No funds are received,
            held, escrowed, or released. That non-routing mandate is a protocol
            MUST, not a phase-one limitation — an oracle that also sits in the
            payment path is an oracle with a position.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <h2 className="mb-3 text-xl font-semibold">Try it</h2>
          <div className="space-y-2 font-mono text-sm">
            <Link
              href="/explore?chain=solana"
              className="flex items-center justify-between rounded-md bg-card/50 px-3 py-2 hover:bg-card"
            >
              <span>Browse Solana agents</span>
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/api/score/DexWirjm2hS5ghfS41bLBx7FgaR2Mug9AsstisrT9jpW"
              className="flex items-center justify-between rounded-md bg-card/50 px-3 py-2 hover:bg-card"
            >
              <span>GET /api/score/&lt;base58&gt;</span>
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/protocol"
              className="flex items-center justify-between rounded-md bg-card/50 px-3 py-2 hover:bg-card"
            >
              <span>Read the Karma Protocol RFC</span>
              <ArrowRight className="size-4" />
            </Link>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Public read API. No auth. The chain is auto-detected from the address
            format, so a base58 wallet resolves to Solana without a{' '}
            <span className="font-mono">?chain=</span> pin.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

function BadgeCase({
  badge,
  body,
}: {
  badge: 'receipt-backed' | 'behavior-inferred' | 'declared';
  body: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <ConfidenceBadge badge={badge} size="sm" className="mb-2" />
      <p className="text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
