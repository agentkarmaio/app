import Link from 'next/link';
import { ExternalLink, ShieldCheck, ScrollText, Users, Eye } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { AK_VALIDATOR, AK_RATER_ADDRESSES, celoscanAddress } from '@/config/ak-validator';
import { supabase } from '@/db/client';

export const metadata = {
  title: 'Validator disclosure — AgentKarma on Celo',
  description:
    'AgentKarma publishes openly-attributed ERC-8004 metadata-quality attestations on Celo. Full disclosure of validator identity, scheme, and how to verify each record on-chain.',
};

export const revalidate = 300;

/** Best-effort count of AK's published metadata attestations (mirror may lag). */
async function attestationCount(): Promise<number | null> {
  try {
    const { data } = await supabase
      .from('erc8004_feedback')
      .select('client')
      .eq('chain', 'celo')
      .eq('tag1', AK_VALIDATOR.scheme.tag1);
    if (!data) return null;
    return data.filter((r) => AK_RATER_ADDRESSES.includes(String(r.client).toLowerCase())).length;
  } catch {
    return null;
  }
}

function Address({ label, address, note }: { label: string; address: string; note: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 py-3 first:border-t-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{note}</div>
      </div>
      <Link
        href={celoscanAddress(address)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 font-mono text-xs text-indigo-400 hover:text-indigo-300"
      >
        {address}
        <ExternalLink className="size-3" />
      </Link>
    </div>
  );
}

export default async function ValidatorPage() {
  const count = await attestationCount();

  return (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-16">
      <div className="mb-12 space-y-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-300">
          <ShieldCheck className="size-3.5" />
          Celo · Mainnet · Disclosed validator
        </div>
        <h1 className="text-4xl font-semibold tracking-tight">Validator disclosure</h1>
        <p className="max-w-2xl text-balance text-lg text-muted-foreground">
          AgentKarma acts as an openly-attributed ERC-8004 reputation validator on Celo. It reads
          each registered agent&apos;s declared metadata and publishes a metadata-quality
          attestation to the on-chain ReputationRegistry
          {count !== null && (
            <>
              {' '}— <span className="font-mono text-foreground">{count.toLocaleString()}</span>{' '}
              published so far
            </>
          )}
          .
        </p>
      </div>

      {/* What these are */}
      <Card className="mb-6">
        <CardContent className="space-y-3 p-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Eye className="size-4 text-indigo-400" />
            What these attestations are — and aren&apos;t
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every record below is signed by an AgentKarma-controlled wallet and attributed to AK.
            They are <span className="text-foreground">oracle signals</span> — AK&apos;s algorithmic
            read of an agent&apos;s declared metadata — <span className="text-foreground">not</span>{' '}
            independent third-party reviews. We publish them from a single disclosed identity on
            purpose. Spreading AK&apos;s own attestations across throwaway wallets to simulate
            independent raters would fabricate the exact Sybil/rater-diversity signal AgentKarma
            exists to measure, so we don&apos;t do it. Independent feedback has its own path
            (below).
          </p>
        </CardContent>
      </Card>

      {/* Identities */}
      <Card className="mb-6">
        <CardContent className="space-y-1 p-6">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-indigo-400" />
            Validator identity
          </div>
          <Address
            label="Validator wallet"
            address={AK_VALIDATOR.validator}
            note="Dedicated key — signs metadata attestations only"
          />
          <Address
            label="Controller / treasury wallet"
            address={AK_VALIDATOR.controller}
            note={`Owns AK's ERC-8004 identity (agentId ${AK_VALIDATOR.agentId})`}
          />
          <Address
            label="ReputationRegistry"
            address={AK_VALIDATOR.reputationRegistry}
            note="ERC-8004 contract receiving each giveFeedback"
          />
        </CardContent>
      </Card>

      {/* Scheme */}
      <Card className="mb-6">
        <CardContent className="space-y-3 p-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ScrollText className="size-4 text-indigo-400" />
            Attestation scheme
          </div>
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <Field k="tag1" v={AK_VALIDATOR.scheme.tag1} />
            <Field k="tag2" v={AK_VALIDATOR.scheme.tag2} />
            <Field k="value" v="0–100 metadata-quality score" />
            <Field k="valueDecimals" v="0" />
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Positive-bias by design: AK only writes a record when an agent clears the quality
            threshold. A missing AK rating is not a negative signal — it means the agent&apos;s
            declared metadata was unreachable or below bar. The off-chain assessment is committed via{' '}
            <span className="font-mono text-foreground">feedbackHash</span> and resolves at the
            record&apos;s <span className="font-mono text-foreground">feedbackURI</span>.
          </p>
        </CardContent>
      </Card>

      {/* Verify */}
      <Card className="mb-6">
        <CardContent className="space-y-3 p-6">
          <div className="text-sm font-semibold">Verify any record yourself</div>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              Open the{' '}
              <Link
                href={celoscanAddress(AK_VALIDATOR.validator)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-400 hover:text-indigo-300"
              >
                validator wallet on Celoscan
              </Link>{' '}
              and pick any transaction.
            </li>
            <li>
              In <span className="text-foreground">Logs</span>, the decoded{' '}
              <span className="font-mono text-foreground">NewFeedback</span> event shows the target
              agentId, value, tags, endpoint, feedbackURI, and feedbackHash.
            </li>
            <li>
              Fetch the <span className="font-mono text-foreground">feedbackURI</span> — it resolves
              to AK&apos;s live record for that agent, and the attestation folds into the
              agent&apos;s on-chain reputation aggregate.
            </li>
          </ol>
        </CardContent>
      </Card>

      {/* Independent feedback */}
      <Card>
        <CardContent className="space-y-3 p-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Users className="size-4 text-indigo-400" />
            Want to add independent feedback?
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Real rater diversity comes from real raters. Connect any EVM wallet on an agent&apos;s
            profile and publish your own review straight to the ReputationRegistry — it&apos;s your
            signature, your record, under a separate{' '}
            <span className="font-mono text-foreground">agentkarma_review</span> scheme, fully
            distinct from AK&apos;s algorithmic attestations.
          </p>
          <Link
            href="/explore?chain=celo"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-400 hover:text-indigo-300"
          >
            Browse Celo agents
            <ExternalLink className="size-3.5" />
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-md border border-border/60 px-3 py-2">
      <div className="font-mono text-xs text-muted-foreground">{k}</div>
      <div className="font-mono text-sm text-foreground">{v}</div>
    </div>
  );
}
