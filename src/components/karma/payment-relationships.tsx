import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RollupList, type RollupRow } from '@/components/karma/rollup-list';
import { RawReceipts } from '@/components/karma/raw-receipts';
import { TransactionList } from '@/components/karma/transaction-list';
import {
  getCounterpartyProfiles,
  getPaymentRollupsForAddress,
  type CounterpartyProfile,
} from '@/db/enrichment-queries';
import { getFeedbackRatingsForSignatures, getTransactionCount } from '@/db/client';
import { buildPaymentRollups, type DirectionSummary, type RollupEntry } from '@/lib/payment-rollups';
import { computeReciprocity, type ReciprocityVerdict } from '@/scoring/reciprocity';
import { formatUsdcAmount } from '@/lib/format';
import { agentHref } from '@/lib/agent-href';
import { ENRICH_FLOW_WINDOW, normalizeAddressForChain } from '@/lib/karma-enrichment';
import type { Chain } from '@/db/schema';

/**
 * Relationships rendered (and name-resolved) per direction. A wallet can have
 * thousands of counterparties; past this many rows the list stops informing and
 * starts costing DOM. The direction header always reports the true total, and
 * the expand button says when it is showing a top slice.
 */
const RENDER_PER_DIRECTION = 50;
/** Facilitators worth naming in the strip before it becomes a list of noise. */
const FACILITATOR_STRIP_MAX = 5;
/** Receipts handed to the collapsed raw table; it paginates from there. */
const RAW_RECEIPT_PAGE = 25;

const VERDICT_COPY: Record<ReciprocityVerdict, { label: string; className: string; title: string }> = {
  independent: {
    label: 'Independent revenue',
    className: 'border-[rgb(16_185_129/0.2)] bg-[rgb(16_185_129/0.10)] text-[#10b981]',
    title: 'Most inbound value comes from addresses this wallet does not also pay.',
  },
  mixed: {
    label: 'Partly circular',
    className: 'border-[rgb(255_165_0/0.2)] bg-[rgb(255_165_0/0.10)] text-[#f5a623]',
    title: 'A meaningful share of inbound value comes from addresses this wallet also pays.',
  },
  circular: {
    label: 'Circular revenue',
    className: 'border-[rgb(229_72_77/0.2)] bg-[rgb(229_72_77/0.10)] text-[#e5484d]',
    title: 'Most inbound value comes from addresses this wallet also pays.',
  },
  'insufficient-data': {
    label: 'Independence unknown',
    className: 'border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.04)] text-[#62666d]',
    title:
      'Not enough payee data to say whether this wallet’s revenue is independent. Unknown is not the same as independent.',
  },
};

function VerdictChip({ verdict }: { verdict: ReciprocityVerdict }) {
  const copy = VERDICT_COPY[verdict];
  return (
    <span
      title={copy.title}
      className={`inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-[11px] font-[510] ${copy.className}`}
    >
      {copy.label}
    </span>
  );
}

/**
 * Attach names, trust tiers, links and value shares to the top entries of one
 * direction. Only the resolved slice is rendered; the rest of the rollup is
 * still counted in the direction header, so the summary never disagrees with
 * the list.
 */
function toRows(
  entries: RollupEntry[],
  chain: Chain,
  profiles: Map<string, CounterpartyProfile>,
  directionTotal: number,
): RollupRow[] {
  return entries.map((entry) => {
    const profile = profiles.get(normalizeAddressForChain(entry.address, chain));
    return {
      address: entry.address,
      href: agentHref({ chain, address: entry.address }),
      displayName: profile?.displayName ?? null,
      trustTier: profile?.trustTier ?? null,
      count: entry.count,
      total: entry.total,
      lastSeen: entry.lastSeen,
      share: directionTotal > 0 ? entry.total / directionTotal : 0,
    };
  });
}

function Direction({
  title,
  face,
  summary,
  rows,
  partyNoun,
  emptyLabel,
}: {
  title: string;
  face: string;
  summary: DirectionSummary;
  rows: RollupRow[];
  partyNoun: string;
  emptyLabel: string;
}) {
  const parties = summary.entries.length;
  return (
    <section>
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 pb-1.5">
        <h3 className="text-[13px] font-[590] tracking-[-0.13px] text-[#f7f8f8]">
          {title}
          <span className="ml-2 text-[11px] font-[400] text-[#4f5258]">{face}</span>
        </h3>
        <p className="text-[12px] tabular-nums text-[#62666d]">
          {parties.toLocaleString()} {parties === 1 ? partyNoun : `${partyNoun}s`}
          <span className="mx-1.5 text-[#3a3d42]">·</span>
          <span title={`${summary.total.toFixed(6)} USDC credited`}>
            {formatUsdcAmount(summary.total, true)} credited
          </span>
        </p>
      </header>
      <RollupList rows={rows} emptyLabel={emptyLabel} totalCount={parties} />
      {(summary.unattributed > 0 || summary.facilitatorCredited > 0) && (
        <p className="px-3 pt-1.5 text-[11px] text-[#4f5258]">
          {summary.unattributed > 0 && (
            <span>
              {summary.unattributed.toLocaleString()} receipt
              {summary.unattributed === 1 ? '' : 's'} with no payee extracted
            </span>
          )}
          {summary.unattributed > 0 && summary.facilitatorCredited > 0 && (
            <span className="mx-1.5 text-[#3a3d42]">·</span>
          )}
          {summary.facilitatorCredited > 0 && (
            <span>
              {summary.facilitatorCredited.toLocaleString()} credited to a tracked facilitator
            </span>
          )}
        </p>
      )}
    </section>
  );
}

function FacilitatorStrip({ entries, total }: { entries: RollupEntry[]; total: number }) {
  if (entries.length === 0 || total === 0) return null;
  const shown = entries.slice(0, FACILITATOR_STRIP_MAX);
  const restCount = entries.length - shown.length;

  return (
    <section className="px-3">
      <h3 className="pb-1.5 text-[13px] font-[590] tracking-[-0.13px] text-[#f7f8f8]">
        Routed via
        <span className="ml-2 text-[11px] font-[400] text-[#4f5258]">payment plumbing</span>
      </h3>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {shown.map((entry) => {
          const exact = (entry.count / total) * 100;
          // A share that rounds to 0% is not zero — the receipts exist. Saying
          // "0%" next to them reads as a bug; "<1%" reads as what it is.
          const pct = exact > 0 && exact < 1 ? '<1%' : `${Math.round(exact)}%`;
          return (
            <span key={entry.label ?? entry.address} className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-[#5e6ad2]" />
              <span
                className={
                  entry.label
                    ? 'text-[12px] font-[510] capitalize text-[#d0d6e0]'
                    : 'font-mono text-[11px] text-[#8a8f98]'
                }
                title={entry.address}
              >
                {entry.label ?? `${entry.address.slice(0, 4)}…${entry.address.slice(-4)}`}
              </span>
              <span className="text-[11px] tabular-nums text-[#62666d]">{pct}</span>
            </span>
          );
        })}
        {restCount > 0 && (
          <span className="text-[11px] tabular-nums text-[#4f5258]">
            +{restCount.toLocaleString()} more
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * The profile's payment view: who this agent trades with, in both directions,
 * rather than a per-row ledger.
 *
 * The direction split is the point. `Earned from` is the Provider face and
 * `Paid to` is the Consumer face — two-faced karma made visible instead of only
 * scored (architectural invariant #3).
 *
 * Every total here says "credited", never "spent": `transactions.amount` is the
 * value credited to the counterparty by one transaction, not the payer's outlay
 * (see schema.ts, and the open decision in
 * docs/superpowers/specs/2026-09-11-transaction-amount-semantics.md).
 *
 * Four reads: one receipt window per direction, one name/tier lookup over the
 * visible rows only, one feedback-rating lookup for the collapsed raw table.
 * The reciprocity verdict is computed from the rows already in hand.
 */
export async function PaymentRelationships({ wallet, chain }: { wallet: string; chain: Chain }) {
  const [{ outbound, inbound, saturated }, txTotal] = await Promise.all([
    getPaymentRollupsForAddress(chain, wallet),
    getTransactionCount(wallet, chain),
  ]);

  const rollups = buildPaymentRollups({ outbound, inbound, chain, saturated });
  const reciprocity = computeReciprocity({
    outbound: outbound.map((r) => ({ counterparty: r.counterparty, amount: r.amount })),
    inbound: rollups.earnedFrom.entries.map((e) => ({
      payer: e.address,
      total: e.total,
      count: e.count,
    })),
    chain,
  });

  const paidTop = rollups.paidTo.entries.slice(0, RENDER_PER_DIRECTION);
  const earnedTop = rollups.earnedFrom.entries.slice(0, RENDER_PER_DIRECTION);

  const rawRows = outbound.slice(0, RAW_RECEIPT_PAGE);
  const [profiles, feedbackMap] = await Promise.all([
    getCounterpartyProfiles(chain, [...paidTop, ...earnedTop].map((e) => e.address)),
    getFeedbackRatingsForSignatures(rawRows.map((r) => r.tx_signature), chain),
  ]);

  const hasAnyRelationship =
    rollups.paidTo.entries.length > 0 || rollups.earnedFrom.entries.length > 0;

  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
        <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
          Payment Relationships
        </CardTitle>
        {hasAnyRelationship && <VerdictChip verdict={reciprocity.verdict} />}
      </CardHeader>

      <CardContent className="space-y-5 p-0 pb-3">
        <Direction
          title="Earned from"
          face="provider side"
          summary={rollups.earnedFrom}
          rows={toRows(earnedTop, chain, profiles, rollups.earnedFrom.total)}
          partyNoun="payer"
          emptyLabel="No inbound payments indexed — nobody has paid this wallet yet."
        />

        <Direction
          title="Paid to"
          face="consumer side"
          summary={rollups.paidTo}
          rows={toRows(paidTop, chain, profiles, rollups.paidTo.total)}
          partyNoun="payee"
          emptyLabel="No outbound payments indexed — this wallet has not paid anyone yet."
        />

        <FacilitatorStrip entries={rollups.routedVia} total={rollups.paidTo.receipts} />

        <p className="px-3 text-[11px] leading-relaxed text-[#4f5258]">
          Amounts are the USDC <em className="not-italic text-[#62666d]">credited to the
          counterparty</em> by each payment, not the payer&apos;s total outlay — a settlement that
          splits between a provider and a gateway records the credited leg only.
          {chain === 'solana' && ' On Solana, an unlisted gateway address can still appear as a counterparty.'}
          {rollups.saturated &&
            ` Based on the most recent ${ENRICH_FLOW_WINDOW.toLocaleString()} receipts per direction, not full history.`}
        </p>
      </CardContent>

      <RawReceipts count={txTotal}>
        <TransactionList
          walletAddress={wallet}
          total={txTotal}
          pageSize={RAW_RECEIPT_PAGE}
          transactions={rawRows.map((tx) => ({
            id: tx.id,
            facilitator: tx.facilitator,
            amount: tx.amount,
            timestamp: tx.timestamp,
            success: tx.success,
            tx_signature: tx.tx_signature,
            feedback: feedbackMap.get(tx.tx_signature) ?? null,
          }))}
        />
      </RawReceipts>
    </Card>
  );
}
