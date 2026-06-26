/**
 * FeedbackRecordsCard — lists the individual ERC-8004 feedback records read
 * from a Celo / Arc agent's ReputationRegistry. The Summary card shows the
 * count + average; this surfaces the records behind it: who attested, the
 * score, and under which scheme. Server-rendered from data the profile already
 * fetched via aggregateFeedback (no extra RPC).
 *
 * Raters are resolved (best-effort, server-side) to a name + AK profile link
 * when the rater is itself a known agent — see resolveRaters. Unknown raters
 * keep a bare address linked to the chain explorer. AK's own human-review scheme
 * (REVIEW_TAG1) renders 1–5 stars; every other scheme keeps its raw 0–100 value.
 * Revoked records are kept for transparency but greyed + struck-through and sunk
 * below live ones (the headline aggregate already excludes them).
 *
 * Long histories (agents accrue 1000+ records) render behind progressive
 * disclosure: the first INITIAL_VISIBLE show by default, "Show more" reveals the
 * rest in PAGE_STEP chunks. All records ship in the payload (already fetched);
 * this only bounds the DOM so the page stays short.
 */
'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Star, BadgeCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { agentHref } from '@/lib/agent-href';
import { REVIEW_TAG1 } from '@/lib/evm-feedback';
import type { FeedbackRecord } from '@/integrations/erc8004-celo';
import type { RaterInfo } from '@/db/client';

const EXPLORER_ADDR: Record<'celo' | 'arc', string> = {
  celo: 'https://celoscan.io/address/',
  arc: 'https://testnet.arcscan.app/address/',
};

/** How many records render before "Show more", and the reveal increment. */
const INITIAL_VISIBLE = 10;
const PAGE_STEP = 25;

/** AK's published schemes get a friendly label; anything else shows its raw tag. */
function schemeLabel(tag1: string): string {
  if (tag1 === REVIEW_TAG1) return 'Review';
  if (tag1 === 'agentkarma_metadata') return 'AgentKarma score';
  return tag1 || 'Feedback';
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** 0–100 review value → filled-star count (1–5). */
function stars(value: number): number {
  return Math.max(1, Math.min(5, Math.round(value / 20)));
}

function StarRating({ value }: { value: number }) {
  const filled = stars(value);
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${filled} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={
            i <= filled
              ? 'size-3.5 fill-[#828fff] text-[#828fff]'
              : 'size-3.5 text-[#2c2d33]'
          }
        />
      ))}
    </span>
  );
}

export function FeedbackRecordsCard({
  records,
  raters,
  comments,
  chain,
}: {
  records: FeedbackRecord[];
  /** Resolved rater identities keyed by lowercased address (resolveRaters). */
  raters?: Map<string, RaterInfo>;
  /** On-chain review text keyed by `${lowercasedClient}-${index}` (getFeedbackComments). */
  comments?: Map<string, { comment: string; verified: boolean }>;
  chain: 'celo' | 'arc';
}) {
  const base = EXPLORER_ADDR[chain];
  const [visible, setVisible] = useState(INITIAL_VISIBLE);

  // Live records first; revoked sink to the bottom (their score is struck and
  // they don't count toward the headline aggregate). Stable within each group.
  const ordered = useMemo(
    () => [...records].sort((a, b) => Number(a.revoked) - Number(b.revoked)),
    [records],
  );

  if (records.length === 0) return null;
  const shown = ordered.slice(0, visible);
  const remaining = ordered.length - shown.length;

  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
          On-chain feedback
        </CardTitle>
        <p className="mt-1 text-[11px] text-[#62666d]">
          Every record from the {chain === 'celo' ? 'Celo' : 'Arc'} ReputationRegistry — independent and portable.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {shown.map((r) => {
          const addrLc = r.client.toLowerCase();
          const rater = raters?.get(addrLc);
          const isReview = r.tag1 === REVIEW_TAG1;
          const review = comments?.get(`${addrLc}-${r.feedbackIndex.toString()}`);

          return (
            <div
              key={`${r.client}-${r.feedbackIndex.toString()}`}
              className={`flex flex-col gap-2 rounded-md border border-border bg-card/40 px-3 py-2 ${
                r.revoked ? 'opacity-50' : ''
              }`}
            >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                {rater ? (
                  // Known agent → link into AK (resolved by agentId, or by the
                  // claimed wallet row when no agentId). Address lowercased to
                  // match the stored EVM rows the /agent route resolves against.
                  <Link
                    href={agentHref({ chain, address: addrLc, agentId: rater.agentId })}
                    className="truncate text-[12px] text-[#828fff] hover:underline underline-offset-2"
                    title={r.client}
                  >
                    {rater.name ?? shortAddr(r.client)}
                  </Link>
                ) : (
                  <a
                    href={`${base}${r.client}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[12px] text-[#828fff] hover:underline underline-offset-2"
                  >
                    {shortAddr(r.client)}
                    <ExternalLink className="size-3" />
                  </a>
                )}
                <span className="text-[10.5px] text-[#62666d]">
                  {schemeLabel(r.tag1)}
                  {r.tag2 ? ` · ${r.tag2}` : ''}
                  {r.revoked ? ' · revoked' : ''}
                </span>
              </div>
              <div className={`shrink-0 text-right ${r.revoked ? 'line-through' : ''}`}>
                {isReview ? (
                  <StarRating value={r.value} />
                ) : (
                  <>
                    <span className="font-bold tabular-nums text-[13px] text-[#f7f8f8]">
                      {Math.round(r.value)}
                    </span>
                    <span className="text-[11px] text-[#62666d]"> / 100</span>
                  </>
                )}
              </div>
            </div>

              {review && (
                <div className="flex items-start gap-1.5 border-t border-[rgb(255_255_255/0.06)] pt-2">
                  <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-[1.5] text-[#b4b8c0]">
                    {review.comment}
                  </p>
                  {review.verified && (
                    <span
                      title="Comment matches the on-chain feedbackHash — integrity verified"
                      className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-[10px] text-[#30a46c]"
                    >
                      <BadgeCheck className="size-3" /> verified
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {remaining > 0 && (
          <button
            type="button"
            onClick={() => setVisible((v) => v + PAGE_STEP)}
            className="mt-1 w-full rounded-md border border-[rgb(255_255_255/0.08)] bg-card/40 py-2 text-[12px] font-[510] text-[#828fff] transition-colors hover:bg-card/60"
          >
            Show {Math.min(PAGE_STEP, remaining)} more
            <span className="text-[#62666d]"> · {remaining} remaining</span>
          </button>
        )}
      </CardContent>
    </Card>
  );
}
