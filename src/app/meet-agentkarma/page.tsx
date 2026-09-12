import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { arcTestnet } from 'viem/chains';
import { AgentKarmaPlayground } from '@/components/agentkarma-playground';
import { AgentKarmaOnboarding } from '@/components/agentkarma-onboarding';
import { AK_ARC, AK_STELLAR, AK_VALIDATOR, celoscanAddress } from '@/config/ak-validator';
import { SPECIMEN_CONSUMER_ADDRESS } from '@/config/specimen';
import { STELLAR_IDENTITY_REGISTRY } from '@/integrations/stellar-config';
import { agentHref } from '@/lib/agent-href';

export const metadata: Metadata = {
  title: 'Meet AgentKarma',
  description: 'Meet the reputation agent: inspect its published chain identities, run a real reputation query, and add AgentKarma to your agent through MCP, A2A, or Telegram.',
  alternates: { canonical: '/meet-agentkarma' },
  openGraph: {
    title: 'Meet AgentKarma',
    description: 'Published identities. Inspectable evidence. A real reputation query for your next agent decision.',
    url: '/meet-agentkarma',
  },
};

const linkClass = 'inline-flex min-h-11 items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring';
const stellarExplorer = (kind: 'account' | 'contract', address: string) => `https://stellar.expert/explorer/public/${kind}/${address}`;

const registrations = [
  {
    chain: 'Celo', network: 'Mainnet', id: AK_VALIDATOR.agentId,
    address: AK_VALIDATOR.controller,
    profile: agentHref({ chain: 'celo', address: AK_VALIDATOR.controller, agentId: AK_VALIDATOR.agentId }),
    registry: celoscanAddress(AK_VALIDATOR.identityRegistry),
  },
  {
    chain: 'Stellar', network: 'Mainnet', id: AK_STELLAR.agentId,
    address: AK_STELLAR.account,
    profile: agentHref({ chain: 'stellar', address: AK_STELLAR.account }),
    registry: stellarExplorer('contract', STELLAR_IDENTITY_REGISTRY),
  },
  {
    chain: 'Arc', network: 'Testnet', id: AK_ARC.agentId,
    address: AK_ARC.controller,
    profile: agentHref({ chain: 'arc', address: AK_ARC.controller, agentId: AK_ARC.agentId }),
    registry: `${arcTestnet.blockExplorers.default.url}/address/${AK_ARC.identityRegistry}`,
  },
];

export default function MeetAgentKarmaPage() {
  return (
    <div className="mx-auto max-w-3xl pb-4 pt-6 sm:pt-10">
      <header className="mb-8 sm:mb-10">
        <div className="flex items-center gap-3">
          <Image src="/brand/agentkarma-dark-X-transparent.png" alt="" width={36} height={36} className="size-9" priority />
          <h1 className="text-balance text-2xl font-medium tracking-tight">Meet AgentKarma</h1>
        </div>
        <p className="mt-4 max-w-xl text-pretty text-sm leading-relaxed text-muted-foreground">The reputation agent. Check the evidence before you delegate, or add AgentKarma to your own agent.</p>
        <div id="onboard" className="mt-5 scroll-mt-24">
          <AgentKarmaOnboarding />
        </div>
      </header>

      <AgentKarmaPlayground examples={[
        { label: 'Celo', value: `agentId ${AK_VALIDATOR.agentId} on celo` },
        { label: 'Stellar', value: `${AK_STELLAR.account} on stellar` },
        { label: 'Specimen consumer', value: `${SPECIMEN_CONSUMER_ADDRESS} on solana` },
        { label: 'Arc testnet', value: `agentId ${AK_ARC.agentId} on arc` },
      ]} />

      <section id="identities" aria-labelledby="identities-title" className="mt-9 scroll-mt-24 border-t border-border pt-6">
        <h2 id="identities-title" className="text-balance text-sm font-medium">AgentKarma on-chain</h2>
        <div className="mt-3 divide-y divide-border">
          {registrations.map((registration) => (
            <div key={registration.chain} className="flex min-h-14 items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm">{registration.chain}</span>
                <span className="text-xs text-muted-foreground">{registration.network}</span>
                <span className="font-mono text-xs text-muted-foreground">#{registration.id}</span>
              </div>
              <Link href={registration.profile} className={`${linkClass} shrink-0`} aria-label={`${registration.chain} AgentKarma profile`}>Profile <ArrowUpRight aria-hidden className="size-3.5" /></Link>
            </div>
          ))}
        </div>
        <details className="group mt-1">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden className="size-3.5 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" />
            Registrations & verification
          </summary>
          <div className="pb-4 pt-2">
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">These are published registrations, not endorsements. AgentKarma&apos;s metadata attestations are its own attributed assessments.</p>
            <dl className="mt-4 space-y-4">
              {registrations.map((registration) => (
                <div key={registration.chain}>
                  <dt className="text-xs font-medium">{registration.chain} controller</dt>
                  <dd className="mt-1 break-all font-mono text-xs leading-relaxed text-muted-foreground">{registration.address}</dd>
                  <dd><a href={registration.registry} target="_blank" rel="noopener noreferrer" className={`${linkClass} text-xs`}>{registration.chain} identity registry <ArrowUpRight aria-hidden className="size-3" /></a></dd>
                </div>
              ))}
            </dl>
            <div className="mt-2 flex flex-wrap gap-x-5 border-t border-border pt-2">
              <a href="/.well-known/agent.json" className={linkClass}>Registration file</a>
              <Link href="/validator" className={linkClass}>Validator disclosure</Link>
              <a href={celoscanAddress(AK_VALIDATOR.validator)} target="_blank" rel="noopener noreferrer" className={linkClass}>Celo activity <ArrowUpRight aria-hidden className="size-3" /></a>
              <a href={stellarExplorer('account', AK_STELLAR.account)} target="_blank" rel="noopener noreferrer" className={linkClass}>Stellar activity <ArrowUpRight aria-hidden className="size-3" /></a>
              <Link href="/specimen" className={linkClass}>Solana specimen</Link>
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}
