'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, Star } from 'lucide-react';
import { useStellarClaimWallet } from '@/hooks/use-stellar-claim-wallet';
import { MAX_COMMENT_LEN } from '@/lib/feedback-comment';
import type { StellarFeedbackRecord } from '@/lib/stellar-feedback';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function StellarGiveFeedbackCard({ agentId }: { agentId: number }) {
  const { address, connect } = useStellarClaimWallet();
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const submission = useRef<AbortController | null>(null);
  const feeDecision = useRef<((approved: boolean) => void) | null>(null);
  const [feeStroops, setFeeStroops] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    state: 'confirmed' | 'pending';
    txHash: string;
    record?: StellarFeedbackRecord;
  } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submission.current?.abort();
      feeDecision.current?.(false);
    };
  }, []);

  function decideFee(approved: boolean) {
    const decide = feeDecision.current;
    feeDecision.current = null;
    setFeeStroops(null);
    decide?.(approved);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stars || inFlight.current || result) return;
    inFlight.current = true;
    const controller = new AbortController();
    submission.current = controller;
    setBusy(true);
    setError('');
    try {
      const reviewer = address ?? await connect();
      if (!mounted.current) return;
      if (!reviewer) {
        setError('Connect your Stellar wallet to publish feedback.');
        return;
      }
      const { submitStellarFeedback } = await import('@/lib/stellar-feedback');
      if (!mounted.current) return;
      const published = await submitStellarFeedback(
        { agentId, stars, comment: comment.trim() || undefined, address: reviewer },
        {
          signal: controller.signal,
          confirmFee: (fee: string) => new Promise<boolean>((resolve) => {
            if (!mounted.current) { resolve(false); return; }
            feeDecision.current = resolve;
            setFeeStroops(fee);
          }),
        },
      );
      if (mounted.current) setResult(published);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not publish feedback. Try again.');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base" role="status">
            {result.state === 'confirmed' && <CheckCircle2 className="size-4" aria-hidden="true" />}
            {result.state === 'confirmed' ? 'Feedback published on-chain' : 'Confirmation pending'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {result.record ? (
            <div className="space-y-2">
              <p aria-label={`${result.record.value / 20} out of 5`}>
                {result.record.value / 20} / 5 stars
              </p>
              {result.record.comment && <p className="whitespace-pre-wrap break-words">{result.record.comment}</p>}
              <p className="text-muted-foreground">Read back from your confirmed Stellar transaction.</p>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Your transaction may still confirm. Check its status before submitting another review.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <a
              href={`https://stellar.expert/explorer/public/tx/${result.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-10 items-center gap-1 text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              View transaction <ExternalLink className="size-3" aria-hidden="true" />
            </a>
            <Button type="button" variant="outline" onClick={() => window.location.reload()}>
              Refresh feedback
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Leave on-chain feedback</CardTitle>
        <p className="text-sm text-muted-foreground">
          Publish a public review with your Stellar wallet. Network fees are paid in XLM.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" aria-busy={busy}>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="text-sm font-medium">Rating</legend>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((rating) => (
                <button
                  key={rating}
                  type="button"
                  aria-label={`${rating} star${rating === 1 ? '' : 's'}`}
                  aria-pressed={stars === rating}
                  onClick={() => setStars(rating)}
                  className="flex size-11 items-center justify-center rounded-md text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <Star className={`size-5 ${rating <= stars ? 'fill-current' : 'text-muted-foreground'}`} aria-hidden="true" />
                </button>
              ))}
            </div>
          </fieldset>
          <div className="space-y-2">
            <label htmlFor={`stellar-feedback-comment-${agentId}`} className="text-sm font-medium">
              Comment <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <textarea
              id={`stellar-feedback-comment-${agentId}`}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={MAX_COMMENT_LEN}
              rows={3}
              disabled={busy}
              className="block w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              aria-describedby={`stellar-feedback-comment-help-${agentId}`}
            />
            <p id={`stellar-feedback-comment-help-${agentId}`} className="text-xs text-muted-foreground">
              Public on-chain · {comment.length}/{MAX_COMMENT_LEN}
            </p>
          </div>
          {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
          {feeStroops != null ? (
            <div className="space-y-3 rounded-md border border-border p-3" role="status">
              <p className="text-sm">
                Maximum network fee:{' '}
                <strong>{BigInt(feeStroops) / 10_000_000n}.{(BigInt(feeStroops) % 10_000_000n).toString().padStart(7, '0')} XLM</strong>
              </p>
              <p className="text-sm text-muted-foreground">Review the fee before opening your wallet to sign.</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => decideFee(true)} className="min-h-11">Continue to wallet</Button>
                <Button type="button" variant="outline" onClick={() => decideFee(false)} className="min-h-11">Cancel</Button>
              </div>
            </div>
          ) : (
            <>
              <Button type="submit" disabled={!stars || busy} className="min-h-11">
                {busy ? 'Publishing…' : address ? 'Review fee & publish' : 'Connect wallet & review fee'}
              </Button>
              {busy && <p role="status" className="text-sm text-muted-foreground">Preparing your review and waiting for wallet confirmation.</p>}
            </>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
