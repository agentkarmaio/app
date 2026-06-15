import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { WalletAddress } from '@/components/karma/wallet-address';
import { StatusPill } from '@/components/karma/status-pill';
import { formatUsdcAmount } from '@/lib/format';
import type { BondView } from '@/lib/succession-view';
import type { BondStatus } from '@/db/schema';

/**
 * BondCard — Agent Bonding read on an agent profile. A third party stakes USDC
 * in an EDGE escrow vouching this young agent will deliver; AK reads the bond
 * lifecycle as a Tier-1 vouched-capacity signal. Lloyd's of London for agents.
 *
 * CARDINAL RULE (stated in UI): a bond lifts the confidence badge + Tier-presence,
 * NEVER the trust-tier ceiling — no buying your way to Excellent. The custody
 * boundary is explicit: the escrow lives in an edge contract; AK witnesses the
 * bond on-chain, never holds or moves the stake.
 *
 * Bonding is contingent on founder sign-off — the card is headed by a
 * `planned · contingent` StatusPill, and any demo bond is visibly labeled.
 */

const STATUS_META: Record<BondStatus, { label: string; color: string }> = {
  open: { label: 'In flight', color: '#f5a623' },
  resolved_success: { label: 'Delivered', color: '#10b981' },
  resolved_failure: { label: 'Failed', color: '#e5484d' },
  expired: { label: 'Expired', color: '#62666d' },
};

export interface BondBlock {
  open: BondView[];
  resolved: BondView[];
  totalBondedUsdc: number;
  hasDemo: boolean;
}

export function BondCard({ bond }: { bond: BondBlock }) {
  const all = [...bond.open, ...bond.resolved];
  if (all.length === 0) return null;

  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            Bonds
          </CardTitle>
          <StatusPill tone="planned">planned · contingent</StatusPill>
          {bond.hasDemo && (
            <Badge
              variant="outline"
              className="bg-[rgb(245_166_35/0.10)] text-[#f5a623] border-[rgb(245_166_35/0.22)] text-[10px] px-1.5 py-0 font-[510]"
            >
              Demo data
            </Badge>
          )}
        </div>
        <p className="mt-1 text-[11px] text-[#62666d]">
          Vouched-capacity · the escrow lives in an edge contract, AK witnesses the bond on-chain and never holds the funds
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] px-3 py-2">
          <span className="text-[12px] text-[#8a8f98]">Total vouched</span>
          <span className="text-[14px] font-[590] tabular-nums text-[#f7f8f8]">
            {formatUsdcAmount(bond.totalBondedUsdc)}
            <span className="ml-1 text-[10px] font-[510] text-[#62666d]">USDC</span>
          </span>
        </div>

        <ul className="space-y-2">
          {all.map((b) => {
            const meta = STATUS_META[b.status] ?? STATUS_META.open;
            return (
              <li
                key={b.id}
                className="flex items-center justify-between gap-3 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)] px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
                  <span className="shrink-0 text-[12px] font-[510]" style={{ color: meta.color }}>
                    {meta.label}
                  </span>
                  <span className="text-[11px] text-[#62666d]">to</span>
                  <WalletAddress address={b.beneficiary} copyable={false} className="text-[12px] text-[#d0d6e0]" />
                  {b.isDemo && (
                    <Badge
                      variant="outline"
                      className="shrink-0 bg-[rgb(245_166_35/0.08)] text-[#f5a623] border-[rgb(245_166_35/0.18)] text-[9px] px-1 py-0 font-[510]"
                    >
                      demo
                    </Badge>
                  )}
                </div>
                <span className="shrink-0 text-[12px] font-[510] tabular-nums text-[#d0d6e0]">
                  {formatUsdcAmount(b.amount)}
                  <span className="ml-1 text-[10px] text-[#62666d]">{b.currency}</span>
                </span>
              </li>
            );
          })}
        </ul>

        <Separator className="bg-[rgb(255_255_255/0.06)]" />

        <p className="text-[10px] leading-relaxed text-[#62666d]">
          A bond lifts the confidence badge and Tier-presence — never the trust-tier ceiling. No
          agent buys its way to Excellent on borrowed capital.
        </p>
      </CardContent>
    </Card>
  );
}
