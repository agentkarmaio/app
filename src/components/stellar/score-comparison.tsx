/**
 * Side-by-side score comparison — the AgentKarma × Stellar money shot
 * (design note, copy notes §3). For ONE Stellar agent, two numbers next to
 * each other:
 *
 *   - "Declared trust"  — stellar-8004's ungated star score. Free to write,
 *     anyone can inflate it. Read via the 8004 read path WITHOUT the
 *     `agentkarma` tag filter (overall feedback). Always ⚪ Declared.
 *   - "Settlement-backed trust" — AgentKarma's score. Each point traces to a
 *     real USDC `transfer` on the public Stellar ledger; AK reads its own
 *     tagged feedback (tag2 = 'agentkarma'). 🟢 Receipt-backed when present.
 *     When the agent is unregistered or AK has left no feedback, the score is
 *     ABSENT (badge-gated → 🟡 Behavior-inferred / ⚪ Declared) and the column
 *     renders an em-dash, never a fabricated number.
 *
 * Honest framing only (copy notes §5): "settlement-backed, ledger-auditable".
 * Never "fully trustless", "no oracle", or "credit bureau". A witness (AK's
 * indexer) exists; the proof points at a public tx anyone can falsify.
 *
 * Server Component (async default export). No "use client" — pure render +
 * server-side reads. The presentational view + the resolver are split so the
 * money shot is unit-testable without RPC/DB (deps injected).
 */
import type { ConfidenceBadge as ConfidenceBadgeValue } from '@/db/schema';
import { ConfidenceBadge } from '@/components/karma/confidence-badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  computeAttestationScore,
  readStellarSummary,
  getStellarRpc,
} from '@/integrations/erc8004-stellar';
import { getValidatorAddress } from '@/integrations/erc8004-stellar-publish';
import { getStellarAgentId } from '@/db/client';

// ─── Data contract ───────────────────────────────────────────────────────────

export interface DeclaredFace {
  /** stellar-8004 ungated aggregate (0–100), rounded. */
  score: number;
  /** Number of star-score raters behind it. */
  count: number;
  badge: ConfidenceBadgeValue;
}

export interface SettlementFace {
  /** AK settlement-backed score (0–100), or null when badge-gated. */
  score: number | null;
  /** True when no on-chain AK attestation exists (unregistered / no feedback). */
  gated: boolean;
  badge: ConfidenceBadgeValue;
  /** Machine reason when gated (e.g. 'no_stellar_agent_id'). */
  reason?: string;
}

export interface ScoreComparisonData {
  address: string;
  declared: DeclaredFace;
  settlement: SettlementFace;
}

// ─── Injectable reads (the two seams the resolver depends on) ────────────────

export interface ScoreComparisonReads {
  /**
   * stellar-8004's ungated overall reputation for the agent (their star score),
   * read WITHOUT the 'agentkarma' tag filter. Returns the rounded 0–100
   * aggregate and the rater count.
   */
  readDeclared: (agentId: number) => Promise<{ score: number; count: number }>;
  /**
   * AgentKarma's settlement-backed score (0–100) for the agent — AK's own
   * tagged feedback. 0 when AK has left none.
   */
  readSettlement: (agentId: number) => Promise<number>;
  /** Resolve the agent's stellar_agent_id; null when unregistered. */
  resolveAgentId: (address: string) => Promise<number | null>;
}

// ─── Resolver (async, injectable — no network in tests) ──────────────────────

export interface ResolveArgs {
  address: string;
  reads: ScoreComparisonReads;
}

/**
 * Resolve both faces for one agent. The AK (settlement-backed) face is
 * badge-gated: with no agentId, or when AK has left no feedback (score 0), the
 * score is reported as ABSENT (null) with a 🟡 Behavior-inferred badge — we
 * never dress a 0 up as a settlement-backed score. The declared face never
 * throws the whole comparison: a read failure degrades to 0/0 (the contrast
 * still renders).
 */
export async function resolveScoreComparison(a: ResolveArgs): Promise<ScoreComparisonData> {
  const agentId = await a.reads.resolveAgentId(a.address);

  let declared: DeclaredFace;
  if (agentId == null) {
    declared = { score: 0, count: 0, badge: 'declared' };
  } else {
    try {
      const d = await a.reads.readDeclared(agentId);
      declared = { score: Math.round(d.score), count: d.count, badge: 'declared' };
    } catch {
      // Honest degrade — never fabricate, never throw out the money shot.
      declared = { score: 0, count: 0, badge: 'declared' };
    }
  }

  let settlement: SettlementFace;
  if (agentId == null) {
    settlement = {
      score: null,
      gated: true,
      badge: 'behavior-inferred',
      reason: 'no_stellar_agent_id',
    };
  } else {
    const akScore = await a.reads.readSettlement(agentId);
    settlement = akScore > 0
      ? { score: Math.round(akScore), gated: false, badge: 'receipt-backed' }
      : { score: null, gated: true, badge: 'behavior-inferred', reason: 'no_ak_settlement' };
  }

  return { address: a.address, declared, settlement };
}

// ─── Presentational view (pure — renderToStaticMarkup-testable) ──────────────

function FaceColumn({
  label,
  sublabel,
  score,
  count,
  badge,
  accent,
}: {
  label: string;
  sublabel: string;
  score: number | null;
  count?: number;
  badge: ConfidenceBadgeValue;
  accent: 'muted' | 'emerald';
}) {
  return (
    <div
      className={
        accent === 'emerald'
          ? 'rounded-lg border border-emerald-500/30 bg-emerald-500/[0.05] p-5'
          : 'rounded-lg border border-border bg-card/50 p-5'
      }
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <ConfidenceBadge badge={badge} size="sm" />
      </div>
      <div
        className={
          accent === 'emerald'
            ? 'font-mono text-5xl font-semibold tracking-tight tabular-nums text-emerald-400'
            : 'font-mono text-5xl font-semibold tracking-tight tabular-nums text-foreground'
        }
      >
        {score === null ? '—' : score}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{sublabel}</p>
      {typeof count === 'number' && score !== null ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          from {count} {count === 1 ? 'rater' : 'raters'}
        </p>
      ) : null}
    </div>
  );
}

export function ScoreComparisonView({ data }: { data: ScoreComparisonData }) {
  const { declared, settlement } = data;
  return (
    <Card className="border-sky-500/20 bg-sky-500/[0.03]">
      <CardContent className="p-6">
        <h2 className="mb-1 text-xl font-semibold">Same agent, two numbers</h2>
        <p className="mb-5 text-sm text-muted-foreground">
          stellar-8004 lets any registered wallet leave free star scores. Free to
          write means free to inflate. AgentKarma scores the same agent by real
          USDC settlements on the public Stellar ledger — settlement-backed,
          ledger-auditable.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <FaceColumn
            label="Declared trust"
            sublabel="stellar-8004 star score. Anyone can mint it."
            score={declared.score}
            count={declared.count}
            badge={declared.badge}
            accent="muted"
          />
          <FaceColumn
            label="Settlement-backed trust"
            sublabel={
              settlement.gated
                ? 'No settlement on record yet. Badge-gated until a USDC payment settles.'
                : 'Every point traces to a USDC transfer anyone can verify on-ledger.'
            }
            score={settlement.score}
            badge={settlement.badge}
            accent="emerald"
          />
        </div>

        <p className="mt-5 text-sm font-medium">
          One number anyone can inflate for free. One number that costs real USDC
          to move.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Default export: async Server Component wiring production reads ───────────

/**
 * Production wiring. Declared = stellar-8004 ungated overall feedback (no
 * 'agentkarma' tag). Settlement = AK's own tagged feedback via the U3 read
 * path. agentId resolved from walletsTable.stellar_agent_id (U1/U4). The
 * declared read scopes to AK's validator as a client (get_summary requires ≥1
 * client and caps at 5); with empty tags it returns the agent's overall,
 * ungated star aggregate rather than AK's tagged slice.
 */
export default async function ScoreComparison({ address }: { address: string }) {
  const reads: ScoreComparisonReads = {
    resolveAgentId: (addr) => getStellarAgentId(addr),
    readDeclared: async (agentId) => {
      const summary = await readStellarSummary(
        getStellarRpc(),
        agentId,
        [getValidatorAddress()],
        '', // tag1 empty → overall (not provider/consumer slice)
        '', // tag2 empty → ungated (NOT scoped to 'agentkarma')
      );
      return { score: summary.summaryValue, count: summary.count };
    },
    readSettlement: (agentId) =>
      computeAttestationScore({
        agentId,
        server: getStellarRpc(),
        validatorAddress: getValidatorAddress(),
        tag1: 'provider',
      }),
  };

  const data = await resolveScoreComparison({ address, reads });
  return <ScoreComparisonView data={data} />;
}
