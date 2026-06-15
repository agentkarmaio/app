import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { WalletAddress } from '@/components/karma/wallet-address';
import { HeartbeatIndicator } from '@/components/karma/heartbeat-indicator';
import { CHAIN_META } from '@/lib/chain-meta';
import {
  SUCCESSION_STATUS_META,
  formatInterval,
  formatRelativePast,
} from '@/lib/succession-format';
import type { SuccessionView } from '@/lib/succession-view';

/**
 * SuccessionCard — the Dead Man's Switch read on an agent profile.
 *
 * TWO-FACED KARMA (rendered, not just claimed): a declared will is read into
 * BOTH the Provider face (durability / clean handoff — the agent's work won't
 * orphan) and the Consumer face (an heir inheriting receives a clean receipt).
 * The card visibly splits these so two-faced karma is shown.
 *
 * Custody boundary stated up front: AK indexes the lifecycle and derives the
 * heartbeat from on-chain liveness. The will + any execution live in an edge
 * contract; AK never holds a key, holds funds, or executes. Heirs act, AK
 * witnesses.
 */
export function SuccessionCard({ succession }: { succession: SuccessionView }) {
  const meta = SUCCESSION_STATUS_META[succession.status] ?? SUCCESSION_STATUS_META.declared;
  const declaredBadgeNote =
    succession.status === 'declared'
      ? 'A declared will is a promise, not proof — the badge only moves once heartbeats accrue.'
      : null;

  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            Succession
          </CardTitle>
          <span className="text-[11px] font-[510]" style={{ color: meta.color }}>
            {meta.label}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-[#62666d]">
          Dead Man’s Switch · AK derives the heartbeat from on-chain liveness, witnesses the will, never holds or executes it
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <HeartbeatIndicator
            status={succession.status}
            lastHeartbeatAt={succession.lastHeartbeatAt}
          />
          {declaredBadgeNote && (
            <p className="text-[11px] italic text-[#62666d]">{declaredBadgeNote}</p>
          )}
        </div>

        <dl className="space-y-2.5 text-[13px]">
          <Row label="Heartbeat interval" value={formatInterval(succession.intervalSeconds)} />
          <Row
            label="Last heartbeat"
            value={formatRelativePast(succession.lastHeartbeatAt)}
          />
          {succession.deadlineAt && (
            <Row
              label="Next deadline"
              value={new Date(succession.deadlineAt).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            />
          )}
          <Row
            label="Declared"
            value={new Date(succession.declaredAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          />
          <Row label="Source" value={succession.sourceType === 'self_hosted' ? 'agentkarma.json' : 'Claim form'} />
        </dl>

        <Separator className="bg-[rgb(255_255_255/0.06)]" />

        {/* Two-faced karma — Provider vs Consumer face of the same will. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <FaceBlock
            face="Provider face"
            color="#828fff"
            line="Durability + clean handoff — a declared successor means this agent's work won't orphan when it goes dark."
          />
          <FaceBlock
            face="Consumer face"
            color="#10b981"
            line="Heir clean receipt — an heir inheriting this agent picks up a verifiable, receipt-backed history."
          />
        </div>

        {/* Heirs — addresses are declared on-chain references; AK never holds them. */}
        <div className="space-y-2">
          <p className="text-[10px] font-[590] uppercase tracking-[0.1em] text-[#62666d]">
            Declared heirs ({succession.heirCount})
          </p>
          {succession.heirs.length === 0 ? (
            <p className="text-[12px] text-[#62666d]">No heirs declared.</p>
          ) : (
            <ul className="space-y-1.5">
              {succession.heirs.map((heir, i) => (
                <li
                  key={`${heir.chain}:${heir.address}:${i}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] px-2.5 py-1.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 rounded bg-[rgb(255_255_255/0.05)] px-1.5 py-0.5 text-[10px] font-[510] text-[#8a8f98]">
                      {CHAIN_META[heir.chain]?.label ?? heir.chain}
                    </span>
                    <WalletAddress address={heir.address} className="text-[12px] text-[#d0d6e0]" />
                    {heir.label && (
                      <span className="truncate text-[11px] text-[#62666d]">{heir.label}</span>
                    )}
                  </div>
                  {heir.share != null && (
                    <span className="shrink-0 text-[11px] tabular-nums text-[#8a8f98]">
                      {heir.share}×
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-[10px] leading-relaxed text-[#62666d]">
          AK indexes, heirs act. The heartbeat feeds Karma durability only — Autonomy reads activity
          cadence separately, never double-counted.
        </p>
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[#8a8f98]">{label}</dt>
      <dd className="tabular-nums text-[#d0d6e0]">{value}</dd>
    </div>
  );
}

function FaceBlock({ face, color, line }: { face: string; color: string; line: string }) {
  return (
    <div className="rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] p-3">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-[11px] font-[590] uppercase tracking-[0.08em]" style={{ color }}>
          {face}
        </span>
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-[#8a8f98]">{line}</p>
    </div>
  );
}
