/**
 * NotIndexedBlock — chain-aware "Not indexed yet" copy variants.
 *
 * Replaces the Solana-flavored block that used to render for every unknown
 * address. Each chain gets honest copy: Solana keeps the x402 + pay.sh
 * explanation; Celo/Arc point at the ERC-8004 IdentityRegistry path; Stellar
 * stays minimal until the U-series indexer materializes more rows.
 *
 * No CTAs that don't actually work. No em-dashes (project voice rule).
 */
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Chain } from '@/db/schema';

type SupportedChain = Chain | 'evm-ambiguous' | 'unknown';

interface CopyVariant {
  title: string;
  body: React.ReactNode;
}

function copyFor(chain: SupportedChain): CopyVariant {
  switch (chain) {
    case 'solana':
      return {
        title: 'Not indexed yet',
        body: (
          <>
            <p>
              AgentKarma hasn&apos;t indexed any on-chain activity for this
              wallet. The indexer currently ingests x402 payments and pay.sh
              routed settlement; arbitrary wallet activity is rolled in via
              seeded-graph expansion as the wallet shows up as a counterparty
              of a known agent.
            </p>
            <p>Two ways to surface this wallet in AgentKarma:</p>
            <ul className="ml-4 list-disc space-y-1.5 text-[13px]">
              <li>
                Have the wallet send or receive an x402 payment (or a pay.sh
                routed settlement); the indexer picks it up automatically on
                the next webhook tick.
              </li>
              <li>
                Claim it: prove ownership with a wallet signature, declare a
                public manifest, and the agent enters the directory immediately
                with a{' '}
                <span aria-hidden>&#9675;</span>{' '}
                <span className="font-[510] text-[#d0d6e0]">Declared</span>{' '}
                confidence badge.
              </li>
            </ul>
          </>
        ),
      };

    case 'celo':
      return {
        title: 'Not indexed yet on Celo',
        body: (
          <>
            <p>
              AgentKarma indexes the Celo ERC-8004 IdentityRegistry. If this is
              a registered Celo agent (agentId 1..N on the IdentityRegistry at{' '}
              <span className="font-mono text-[12.5px] text-[#d0d6e0]">
                0x8004A169&hellip;a432
              </span>
              ), it will appear after the next index pass.
            </p>
            <p>
              Receipt-gated x402 history is Solana-only today. On Celo,
              AgentKarma surfaces the declared identity (registration JSON +
              services) plus the metadata-quality validator score AK publishes
              back to the ReputationRegistry.
            </p>
            <p>
              See{' '}
              <Link
                href="/celo"
                className="text-[#828fff] underline-offset-2 hover:underline"
              >
                /celo
              </Link>{' '}
              for AK&apos;s own Celo identity and the validator scheme.
            </p>
          </>
        ),
      };

    case 'arc':
      return {
        title: 'Not indexed yet on Arc',
        body: (
          <>
            <p>
              AgentKarma indexes the Arc ERC-8004 IdentityRegistry plus the
              ERC-8183 PaymentReleased event stream for receipt-gated signals.
              Arc is currently testnet; registered agents appear after the next
              index pass.
            </p>
            <p>
              See{' '}
              <Link
                href="/arc"
                className="text-[#828fff] underline-offset-2 hover:underline"
              >
                /arc
              </Link>{' '}
              for the Arc integration status and AK&apos;s registered identity.
            </p>
          </>
        ),
      };

    case 'stellar':
      return {
        title: 'Not indexed yet on Stellar',
        body: (
          <p>
            AgentKarma reads ERC-8004 identity and feedback from Stellar&apos;s
            Soroban registry, but this wallet hasn&apos;t registered an agentId
            yet. Once it does, the profile materializes here.
          </p>
        ),
      };

    case 'evm-ambiguous':
      return {
        title: 'Not indexed yet',
        body: (
          <p>
            This is an EVM address. AgentKarma supports Celo and Arc; neither
            chain currently has a record for it. If this is a registered agent
            on either ERC-8004 IdentityRegistry, it will appear after the next
            index pass.
          </p>
        ),
      };

    default:
      return {
        title: 'Not indexed yet',
        body: (
          <p>
            AgentKarma hasn&apos;t indexed any activity for this address.
          </p>
        ),
      };
  }
}

export function NotIndexedBlock({ chain }: { chain: SupportedChain }) {
  const { title, body } = copyFor(chain);
  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-[13.5px] leading-relaxed text-[#b4bcd0]">
        {body}
      </CardContent>
    </Card>
  );
}

export type NotIndexedChain = SupportedChain;
