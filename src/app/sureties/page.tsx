import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, ShieldOff } from 'lucide-react';
import { getSuretyLeaderboard } from '@/db/client';
import { Card, CardContent } from '@/components/ui/card';
import { WalletAddress } from '@/components/karma/wallet-address';
import { SuretyChip } from '@/components/karma/surety-chip';
import { StatusPill } from '@/components/karma/status-pill';
import { CHAIN_META, chainOptions } from '@/lib/chain-meta';
import { isChain, type Chain, type SuretyLabel, type Wallet } from '@/db/schema';

export const dynamic = 'force-dynamic';

const SITE_URL = 'https://agentkarma.io';

export const metadata: Metadata = {
  title: 'Sureties — Lloyd’s of London for autonomous agents',
  description:
    'Wallets ranked by Surety Karma: how well each underwriter judges which agents deliver. An orthogonal reputation axis. AgentKarma witnesses the bond on-chain, never holds the funds.',
  alternates: { canonical: '/sureties' },
  openGraph: {
    title: 'Sureties — AgentKarma',
    description:
      'Lloyd’s of London for autonomous agents — underwriters ranked by Surety Karma. AK witnesses, never holds.',
    url: `${SITE_URL}/sureties`,
  },
};

export default async function SuretiesPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string }>;
}) {
  const { chain: chainParam } = await searchParams;
  const chainFilter: Chain | undefined =
    chainParam && isChain(chainParam) ? chainParam : undefined;

  let page: { wallets: Wallet[]; total: number } = { wallets: [], total: 0 };
  let dbError = false;
  try {
    page = await getSuretyLeaderboard(50, 0, { chain: chainFilter });
  } catch {
    dbError = true;
  }

  const reliableCount = page.wallets.filter((w) => w.surety_label === 'reliable').length;

  return (
    <div className="space-y-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[32px] font-[560] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
            Sureties
          </h1>
          <StatusPill tone="planned">planned · contingent</StatusPill>
        </div>
        <p className="max-w-2xl text-[15px] leading-relaxed text-[#8a8f98]">
          Lloyd’s of London for autonomous agents. Underwriters stake USDC in an edge escrow vouching
          a young agent will deliver — AgentKarma reads the bond lifecycle and ranks each wallet by
          Surety Karma: how well it judges which agents deliver. Surety is an orthogonal axis, shown
          alongside Karma and never blended into it.
        </p>
      </header>

      {/* Non-custody callout */}
      <div className="flex items-center gap-2 rounded-lg border border-[rgb(94_106_210/0.18)] bg-[rgb(94_106_210/0.04)] px-3 py-2 text-[12px] text-[#8a92ff]">
        <ShieldOff className="size-3.5 shrink-0" />
        <span className="font-[510]">We witness, we never hold.</span>
        <span className="text-[#62666d]">
          The escrow lives in an edge contract. AgentKarma indexes the bond on-chain; it never holds or moves the stake.
        </span>
      </div>

      {/* Fleet stats */}
      <div className="grid gap-3 sm:grid-cols-3">
        <FleetStat label="Underwriters ranked" value={page.total.toLocaleString()} />
        <FleetStat label="Reliable" value={reliableCount.toString()} dot="#10b981" />
        <FleetStat label="Axis" value="Orthogonal" />
      </div>

      <ChainFilter active={chainFilter} />

      {dbError ? (
        <EmptyCard
          title="Sureties feed is catching up"
          body="The surety index is temporarily unavailable. Try again shortly."
        />
      ) : page.wallets.length === 0 ? (
        <EmptyCard
          title="No sureties yet"
          body={`No wallet has underwritten a bond${chainFilter ? ` on ${CHAIN_META[chainFilter].label}` : ''} yet. Bonding is contingent on sign-off — until then this feed reads demo data only.`}
        />
      ) : (
        <LloydsLeaderboardTable wallets={page.wallets} />
      )}
    </div>
  );
}

function LloydsLeaderboardTable({ wallets }: { wallets: Wallet[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[rgb(255_255_255/0.06)]">
      <div className="grid grid-cols-[40px_minmax(0,1fr)_120px_140px] items-center gap-3 border-b border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] px-4 py-2.5 text-[10px] font-[590] uppercase tracking-[0.08em] text-[#62666d]">
        <span>#</span>
        <span>Underwriter</span>
        <span className="text-right">Surety</span>
        <span className="text-right">Standing</span>
      </div>
      {wallets.map((w, i) => (
        <Link
          key={`${w.chain}:${w.address}`}
          href={`/agent/${w.address}?chain=${w.chain}`}
          className="group grid grid-cols-[40px_minmax(0,1fr)_120px_140px] items-center gap-3 border-b border-[rgb(255_255_255/0.04)] px-4 py-3 transition-colors last:border-0 hover:bg-[rgb(255_255_255/0.025)]"
        >
          <span className="text-[12px] tabular-nums text-[#62666d]">{i + 1}</span>
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-[rgb(255_255_255/0.05)] px-1.5 py-0.5 text-[10px] font-[510] text-[#8a8f98]">
              {CHAIN_META[w.chain]?.label ?? w.chain}
            </span>
            <span className="truncate text-[13px] font-[510] text-[#d0d6e0]">
              {w.display_name ?? `${w.address.slice(0, 4)}…${w.address.slice(-4)}`}
            </span>
            <WalletAddress address={w.address} copyable={false} className="text-[11px] text-[#62666d]" />
          </div>
          <span className="text-right text-[14px] font-[590] tabular-nums text-[#f7f8f8]">
            {w.surety_score != null ? Number(w.surety_score).toFixed(0) : '—'}
          </span>
          <div className="flex justify-end">
            <SuretyChip
              score={w.surety_score != null ? Number(w.surety_score) : null}
              label={(w.surety_label ?? null) as SuretyLabel | null}
              size="sm"
            />
          </div>
        </Link>
      ))}
    </div>
  );
}

function ChainFilter({ active }: { active?: Chain }) {
  const options = chainOptions();
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-[510] uppercase tracking-[0.08em] text-[#62666d]">
        Chain
      </span>
      <div className="flex items-center gap-0.5">
        <FilterLink href="/sureties" label="All" active={!active} />
        {options.map((c) => (
          <FilterLink
            key={c}
            href={`/sureties?chain=${c}`}
            label={CHAIN_META[c].label}
            active={active === c}
          />
        ))}
      </div>
    </div>
  );
}

function FilterLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={
        active
          ? 'rounded-[5px] bg-[rgb(255_255_255/0.06)] px-1.5 py-0.5 text-[11px] font-[510] text-[#f7f8f8]'
          : 'rounded-[5px] px-1.5 py-0.5 text-[11px] font-[510] text-[#8a8f98] transition-colors hover:text-[#f7f8f8]'
      }
    >
      {label}
    </Link>
  );
}

function FleetStat({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <div className="rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] px-4 py-3">
      <p className="text-[10px] font-[510] uppercase tracking-[0.12em] text-[#62666d]">{label}</p>
      <div className="mt-1.5 flex items-center gap-2 text-[20px] font-[590] tracking-[-0.22px] text-[#f7f8f8]">
        {dot && <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: dot }} />}
        <span className="tabular-nums">{value}</span>
      </div>
    </div>
  );
}

function EmptyCard({ title, body }: { title: string; body: string }) {
  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardContent className="py-12 text-center">
        <p className="text-[14px] font-[510] text-[#d0d6e0]">{title}</p>
        <p className="mx-auto mt-1.5 max-w-md text-[12.5px] text-[#62666d]">{body}</p>
      </CardContent>
    </Card>
  );
}
