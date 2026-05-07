/**
 * /specimen — public landing page for the AgentKarma specimen agent.
 *
 * Documents the wallet, endpoints, payment scheme, and links to the live
 * reputation profile. Server component — no client JS.
 */

import { Metadata } from 'next';
import Link from 'next/link';

import {
  SPECIMEN_PROVIDER_ADDRESS,
  SPECIMEN_CONSUMER_ADDRESS,
  SPECIMEN_PRICE_USDC,
} from '@/config/specimen';
import { ConfidenceBadge } from '@/components/karma/confidence-badge';

export const metadata: Metadata = {
  title: 'Specimen Agent · AgentKarma',
  description:
    'Reference x402-compatible micro-API hosted by AgentKarma. Generates real on-chain payment flow on Solana mainnet so the full reputation pipeline can be exercised end-to-end.',
};

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';

const ENDPOINTS = [
  {
    method: 'GET',
    path: '/api/specimen/echo',
    description: 'Returns a deterministic echo payload after payment.',
  },
  {
    method: 'GET',
    path: '/api/specimen/quote',
    description: 'Returns a rotating quote after payment.',
  },
  {
    method: 'GET',
    path: '/specimen/agentkarma.json',
    description: 'Tier 3 declared-identity manifest.',
  },
];

export default function SpecimenPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 font-mono text-sm leading-relaxed text-foreground">
      <header className="mb-12">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">specimen</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">AgentKarma Specimen</h1>
        <p className="mt-3 max-w-prose text-muted-foreground">
          A reference x402-compatible micro-API on Solana mainnet. We run it so the full
          reputation pipeline (payment → indexer → scoring → 8004 attestation) can be
          exercised against real on-chain state instead of synthetic data.
        </p>
      </header>

      <section className="mb-10 space-y-2">
        <h2 className="text-base font-semibold">Wallets</h2>
        <p className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-muted-foreground">provider</span>
          <Link href={`/agent/${SPECIMEN_PROVIDER_ADDRESS}`} className="break-all underline-offset-2 hover:underline">
            {SPECIMEN_PROVIDER_ADDRESS}
          </Link>
        </p>
        <p className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-muted-foreground">consumer</span>
          <Link href={`/agent/${SPECIMEN_CONSUMER_ADDRESS}`} className="break-all underline-offset-2 hover:underline">
            {SPECIMEN_CONSUMER_ADDRESS}
          </Link>
        </p>
      </section>

      <section className="mb-10 space-y-3">
        <h2 className="text-base font-semibold">Endpoints</h2>
        <ul className="space-y-2">
          {ENDPOINTS.map((e) => (
            <li key={e.path} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
              <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs">{e.method} {e.path}</code>
              <span className="text-muted-foreground">{e.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-10 space-y-3">
        <h2 className="text-base font-semibold">Payment scheme</h2>
        <p className="text-muted-foreground">
          USDC SPL transfer ({SPECIMEN_PRICE_USDC} USDC per request) with a memo binding the
          payment to a single resource + nonce. Consumers receive a 402 with{' '}
          <code>PaymentRequirements</code>, sign the prescribed transfer, then retry with{' '}
          <code>X-Payment-Tx</code>, <code>X-Payment-Nonce</code>, and{' '}
          <code>X-Payment-Resource</code> headers. The server verifies on-chain via Helius
          and gates the resource.
        </p>
        <p className="text-muted-foreground">
          Replay-protected (one redemption per signature), age-bounded (120s window).
        </p>
      </section>

      <section className="mb-10 space-y-3">
        <h2 className="text-base font-semibold">Live reputation</h2>
        <p className="text-muted-foreground">
          As the specimen consumer issues real x402 payments, watch the wallet&apos;s
          confidence badge climb from{' '}
          <ConfidenceBadge badge="declared" size="sm" />{' '}→{' '}
          <ConfidenceBadge badge="behavior-inferred" size="sm" />{' '}→{' '}
          <ConfidenceBadge badge="receipt-backed" size="sm" />{' '}
          on its{' '}
          <Link href={`/agent/${SPECIMEN_CONSUMER_ADDRESS}`} className="underline">profile</Link>.
        </p>
      </section>

      <footer className="text-xs text-muted-foreground">
        <p>
          Manifest:{' '}
          <a href={`${APP_URL}/specimen/agentkarma.json`} className="underline">
            {APP_URL}/specimen/agentkarma.json
          </a>
        </p>
      </footer>
    </main>
  );
}
