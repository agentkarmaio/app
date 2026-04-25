import { ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/**
 * "Also active on MPP / Tempo" — Tier 3 declared-identity card.
 *
 * Surfaces an agent's self-declared Tempo (MPP) address. mppscan does not
 * expose stable per-address detail pages today, so we link to the explorer
 * root and render the full address inline. This signal is declared-only and
 * MUST NOT be blended into the displayed Karma score (RFC §5.5 invariant for
 * orthogonal signals; SIGNAL-ARCHITECTURE Tier 3 cap).
 *
 * Future work: signed cross-rail pairing statement promotes this from
 * Tier 3 declared (⚪) to Tier 1 receipt-backed (🟢).
 */
export function TempoCard({ tempoAddress }: { tempoAddress: string }) {
  const explorerUrl = `https://mppscan.com/?address=${encodeURIComponent(tempoAddress)}`;
  const truncated = `${tempoAddress.slice(0, 10)}…${tempoAddress.slice(-8)}`;

  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
              Also active on MPP / Tempo
            </CardTitle>
            <Badge
              variant="outline"
              className="gap-1 bg-[rgb(255_255_255/0.04)] text-[#8a8f98] border-[rgb(255_255_255/0.10)] text-[10px] px-1.5 py-0 font-[510]"
              title="Declared by the operator. Not verified — does not contribute to Karma."
            >
              <span aria-hidden className="size-1.5 rounded-full bg-[#8a8f98]" />
              Declared
            </Badge>
          </div>
          <span
            className="text-[10px] font-[510] uppercase tracking-[0.08em] text-[#62666d]"
            title="Tier 3 declared signal — does not contribute to the Karma score."
          >
            Not in score
          </span>
        </div>
        <p className="mt-1 text-[11px] text-[#62666d]">
          Parallel agent-payment rail. AgentKarma is x402-first, not x402-only —
          a verified cross-rail pairing would promote this to Tier 1 in a future release.
        </p>
      </CardHeader>
      <CardContent>
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between gap-3 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)] px-3 py-2 text-[12px] transition-colors hover:border-[rgb(255_255_255/0.12)] hover:bg-[rgb(255_255_255/0.04)]"
          title={tempoAddress}
        >
          <div className="flex flex-col min-w-0">
            <span className="text-[10px] font-[510] uppercase tracking-[0.12em] text-[#62666d]">
              Tempo address
            </span>
            <span className="font-mono text-[12px] text-[#d0d6e0] truncate">
              <span className="hidden sm:inline">{tempoAddress}</span>
              <span className="sm:hidden">{truncated}</span>
            </span>
          </div>
          <span className="flex items-center gap-1 text-[11px] text-[#8a8f98] shrink-0">
            mppscan
            <ExternalLink className="size-3" />
          </span>
        </a>
      </CardContent>
    </Card>
  );
}
