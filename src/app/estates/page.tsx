import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, ShieldOff } from 'lucide-react';
import {
  getReapableSuccessions,
  getLastMeaningfulTxAt,
  REAPABLE_STATUSES,
} from '@/db/client';
import { deriveSuccessionLiveness } from '@/scoring/succession';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { WalletAddress } from '@/components/karma/wallet-address';
import { SuccessionChip } from '@/components/karma/succession-chip';
import { HeartbeatIndicator } from '@/components/karma/heartbeat-indicator';
import { CHAIN_META, chainOptions } from '@/lib/chain-meta';
import { formatInterval } from '@/lib/succession-format';
import { isChain, type Chain, type Succession, type SuccessionStatus } from '@/db/schema';

export const dynamic = 'force-dynamic';

const SITE_URL = 'https://agentkarma.io';

export const metadata: Metadata = {
  title: 'Agent Estates — Dead Man’s Switch',
  description:
    'Public feed of declared agent wills whose heartbeat has lapsed or is lapsing. AgentKarma indexes the succession lifecycle on-chain — heirs act, AK witnesses. Never holds funds, never executes a will.',
  alternates: { canonical: '/estates' },
  openGraph: {
    title: 'Agent Estates — AgentKarma',
    description:
      'Declared agent wills whose heartbeat has lapsed. AK is the notary of agent succession — it witnesses, never holds.',
    url: `${SITE_URL}/estates`,
  },
};

interface EstateRow {
  succession: Succession;
  liveStatus: SuccessionStatus;
  lastHeartbeatAt: string | null;
}

export default async function EstatesPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string }>;
}) {
  const { chain: chainParam } = await searchParams;
  const chainFilter: Chain | undefined =
    chainParam && isChain(chainParam) ? chainParam : undefined;

  let page: { successions: Succession[]; total: number } = { successions: [], total: 0 };
  let dbError = false;
  try {
    page = await getReapableSuccessions(50, 0, { chain: chainFilter });
  } catch {
    dbError = true;
  }

  // Derive live status per row from the agent's chain-scoped last meaningful tx.
  const rows: EstateRow[] = await Promise.all(
    page.successions.map(async (s): Promise<EstateRow> => {
      const lastTx = await getLastMeaningfulTxAt(s.agent_wallet, s.chain).catch(() => s.last_heartbeat_at);
      const liveness = deriveSuccessionLiveness({ succession: s, lastMeaningfulTxAt: lastTx });
      return { succession: s, liveStatus: liveness.status, lastHeartbeatAt: liveness.heartbeatLastAt };
    }),
  );

  const lapsedCount = rows.filter((r) => r.liveStatus === 'lapsed').length;
  const lapsingCount = rows.filter((r) => r.liveStatus === 'lapsing').length;
  const executedCount = rows.filter((r) => r.liveStatus === 'executed').length;

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
        <h1 className="text-[32px] font-[560] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
          Agent Estates
        </h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-[#8a8f98]">
          Declared agent wills whose heartbeat has lapsed or is approaching its deadline.
          AgentKarma is the notary of agent succession: it derives each heartbeat from on-chain
          liveness and witnesses the lifecycle. It never holds a key, holds funds, or executes a
          will.
        </p>
      </header>

      {/* Non-routing / non-custody callout */}
      <div className="flex items-center gap-2 rounded-lg border border-[rgb(94_106_210/0.18)] bg-[rgb(94_106_210/0.04)] px-3 py-2 text-[12px] text-[#8a92ff]">
        <ShieldOff className="size-3.5 shrink-0" />
        <span className="font-[510]">AK indexes, heirs act.</span>
        <span className="text-[#62666d]">
          The will and any inheritance transfer live in an edge contract — AgentKarma only witnesses them on-chain.
        </span>
      </div>

      {/* Fleet stats */}
      <div className="grid gap-3 sm:grid-cols-4">
        <FleetStat label="Reapable estates" value={page.total.toLocaleString()} />
        <FleetStat label="Lapsed" value={lapsedCount.toString()} dot="#e5484d" />
        <FleetStat label="Lapsing" value={lapsingCount.toString()} dot="#f5a623" />
        <FleetStat label="Executed" value={executedCount.toString()} dot="#828fff" />
      </div>

      <ChainFilter active={chainFilter} />

      {dbError ? (
        <EmptyCard
          title="Estates feed is catching up"
          body="The succession index is temporarily unavailable. Try again shortly."
        />
      ) : rows.length === 0 ? (
        <EmptyCard
          title="No reapable estates yet"
          body={`No declared will is currently ${REAPABLE_STATUSES.join(', ')}${chainFilter ? ` on ${CHAIN_META[chainFilter].label}` : ''}. Healthy agents checking in normally don't appear here.`}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <EstateCard key={`${row.succession.chain}:${row.succession.agent_wallet}`} row={row} />
          ))}
        </div>
      )}
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
        <FilterLink href="/estates" label="All" active={!active} />
        {options.map((c) => (
          <FilterLink
            key={c}
            href={`/estates?chain=${c}`}
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

function EstateCard({ row }: { row: EstateRow }) {
  const { succession: s } = row;
  return (
    <Link
      href={`/agent/${s.agent_wallet}?chain=${s.chain}`}
      className="group block rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] p-4 transition-all hover:border-[rgb(255_255_255/0.16)] hover:bg-[rgb(255_255_255/0.04)]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-[rgb(255_255_255/0.05)] px-1.5 py-0.5 text-[10px] font-[510] text-[#8a8f98]">
          {CHAIN_META[s.chain]?.label ?? s.chain}
        </span>
        <SuccessionChip status={row.liveStatus} size="sm" />
      </div>
      <div className="mt-3">
        <WalletAddress address={s.agent_wallet} copyable={false} className="text-[13px] text-[#d0d6e0]" />
      </div>
      <Separator className="my-3 bg-[rgb(255_255_255/0.06)]" />
      <HeartbeatIndicator status={row.liveStatus} lastHeartbeatAt={row.lastHeartbeatAt} size="sm" />
      <div className="mt-2 flex items-center justify-between text-[11px] text-[#62666d]">
        <span>Interval {formatInterval(s.interval_seconds)}</span>
        <span>
          {Array.isArray(s.heirs) ? s.heirs.length : 0} heir
          {(Array.isArray(s.heirs) ? s.heirs.length : 0) === 1 ? '' : 's'}
        </span>
      </div>
    </Link>
  );
}
