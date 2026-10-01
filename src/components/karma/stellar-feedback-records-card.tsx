import { ExternalLink } from 'lucide-react';
import { AK_REVIEW_TAG1 } from '@/config/ak-validator';
import type { StellarFeedbackRecord } from '@/lib/stellar-feedback';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function StellarFeedbackRecordsCard({
  records,
  count,
  complete,
  commentsComplete,
}: {
  records: StellarFeedbackRecord[];
  count: number | null;
  complete: boolean;
  commentsComplete: boolean;
}) {
  return (
    <Card id="stellar-feedback">
      <CardHeader>
        <CardTitle className="text-base">On-chain feedback</CardTitle>
        <p className="text-sm text-muted-foreground">
          {complete && count != null ? `${count} active record${count === 1 ? '' : 's'}` : `${records.length} records loaded · incomplete coverage`}
        </p>
      </CardHeader>
      <CardContent>
        {!complete && (
          <p role="status" className="mb-3 text-sm text-muted-foreground">
            Some feedback could not be loaded. Reload the page to try again.
          </p>
        )}
        {records.length === 0 && complete && <p className="text-sm text-muted-foreground">No on-chain feedback yet.</p>}
        {records.length > 0 && (
          <ul className="divide-y divide-border">
            {records.map((record) => {
              const isReview = record.tag1 === AK_REVIEW_TAG1
                && record.valueDecimals === 0
                && record.value >= 20 && record.value <= 100 && record.value % 20 === 0;
              return (
                <li key={`${record.client}:${record.feedbackIndex}`} className="space-y-2 py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <a
                      href={`https://stellar.expert/explorer/public/account/${record.client}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={record.client}
                      className="inline-flex min-h-10 items-center gap-1 font-mono text-primary focus-visible:ring-2 focus-visible:ring-ring hover:underline"
                    >
                      {record.client.slice(0, 6)}…{record.client.slice(-4)}
                      <ExternalLink className="size-3" aria-hidden="true" />
                    </a>
                    <span className={record.revoked ? 'text-muted-foreground line-through' : 'tabular-nums'}>
                      {isReview ? `${record.value / 20} / 5 stars` : `${record.value} · ${record.tag1 || 'Feedback'}`}
                    </span>
                    {record.revoked && <span className="text-xs text-muted-foreground">Revoked</span>}
                  </div>
                  {record.comment && (
                    <>
                      <p className="whitespace-pre-wrap break-words text-sm">{record.comment}</p>
                      <p className="text-xs text-muted-foreground">
                        {record.commentVerified ? 'Comment verified against the transaction' : 'Comment indexed by Stellar8004 · not verified on-chain'}
                      </p>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!commentsComplete && records.length > 0 && (
          <p className="mt-4 text-xs text-muted-foreground">Some indexed comments may be unavailable. Ratings are read from the Stellar registry.</p>
        )}
      </CardContent>
    </Card>
  );
}
