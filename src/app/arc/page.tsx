import Link from 'next/link';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { arcTestnet } from '@/config/arc-chain';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AgentKarma on Arc — receipt-grade reputation from USDC settlements',
  description:
    'Arc is Circle\'s USDC-native EVM L1. AgentKarma indexes Arc\'s ERC-8183 agentic-commerce job settlements as Tier-1 receipt-grade signals and reads ERC-8004 reputation, publishing portable karma any 8004-aware client can read.',
};

// Static explainer page. Arc is testnet-only and AK has not yet registered an
// on-chain identity here, so there is nothing live to read per-request — the
// page documents the integration surface (verified contract addresses, signal
// model, status) rather than rendering on-chain state. The Arc ChainAdapter
// (getAdapter('arc')) is being wired in parallel; this page intentionally does
// NOT depend on it so it renders standalone. Default static render.

// ─── Verified Arc Testnet contract surface ──────────────────────────────────
// Ground truth from docs.arc.io + live RPC probe. The 0x8004… vanity prefix
// marks the CANONICAL ERC-8004 reference contracts — same family as Celo, so
// the Celo ABIs port verbatim. Move to src/config when an Arc adapter lands.
const ARC_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const ARC_REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const ARC_AGENTIC_COMMERCE = '0x0747EEf0706327138c69792bF28Cd525089e4583';
// USDC ERC-20 token — 6-decimal token units. DECIMALS TRAP: native gas is
// 18-dec (publish-tx cost), USDC token + ERC-8183 job amounts are 6-dec.
const ARC_USDC_TOKEN = '0x3600000000000000000000000000000000000000';

// A sample Arc address to thread through the "Try it" block. Honestly degrades
// (🟡 / em-dash, never a fake number) when the address has no Arc signal yet.
const DEMO_ADDRESS = '0x0747EEf0706327138c69792bF28Cd525089e4583';

const explorerAddressUrl = (addr: string) =>
  `${arcTestnet.blockExplorers.default.url}/address/${addr}`;

export default function ArcPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 pb-24 pt-16">
      <div className="mb-12 space-y-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-400/30 bg-slate-400/10 px-3 py-1 text-xs font-medium text-slate-300">
          <span className="size-1.5 rounded-full bg-slate-400" />
          Arc · Testnet
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

      {/* Honest status: no fabricated AK agentId or rated-wallet list here —
          Arc is testnet-only and AK has not registered an identity yet. */}
      <Card className="mb-8 border-slate-400/20 bg-slate-400/[0.03]">
        <CardContent className="p-6">
          <div className="mb-2 inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-slate-300">
            <span className="size-1.5 rounded-full bg-slate-400" />
            Arc Testnet — indexing live, mainnet signal volume pending
          </div>
          <p className="text-sm text-muted-foreground">
            AK indexes Arc&apos;s ERC-8183 settlements today, but Arc is
            testnet-only and AgentKarma has not yet minted an on-chain identity
            here (unlike Celo, where AK is{' '}
            <span className="font-mono text-foreground">agentId 9058</span>). So
            there is no AK identity card or rated-wallet roster to show yet — the
            score API returns honest, badge-gated reads from whatever signal the
            address already carries. Identity registration + mainnet volume land
            when Arc opens its mainnet.
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
              wallets stay badge-gated (🟡 Behavior-inferred / ⚪ Declared) until
              they claim — never a single collapsed score, never a receipt-backed
              number without a settlement behind it.
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
            score route — chain auto-detected from the 0x address, or pinned with{' '}
            <span className="font-mono">?chain=arc</span>. Returns honest,
            badge-gated reads while Arc testnet signal volume builds.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
