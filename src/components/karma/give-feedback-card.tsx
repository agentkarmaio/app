'use client';

/**
 * GiveFeedbackCard — lets any connected EVM wallet publish an ERC-8004
 * `giveFeedback` review about a Celo / Arc agent, on-chain, from the browser.
 * This is AgentKarma's independent-attestation surface: a partner (e.g. another
 * agent operator) rates an agent and the record lands on the public
 * ReputationRegistry, flowing into the profile's on-chain feedback aggregate.
 *
 * Interaction primitive (wallet connect + on-chain tx) → "use client" justified.
 */
import { useState } from 'react';
import { Star, ExternalLink, CheckCircle2 } from 'lucide-react';
import { useEvmWallet } from '@/components/wallet/evm-wallet-provider';
import {
  submitFeedback,
  starsToValue,
  feedbackChainConfig,
  type EvmFeedbackChain,
} from '@/lib/evm-feedback';
import { MAX_COMMENT_LEN } from '@/lib/feedback-comment';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type Status = 'idle' | 'submitting' | 'success' | 'error';

export function GiveFeedbackCard({
  agentId,
  chain,
  ownerAddress,
}: {
  agentId: number;
  chain: EvmFeedbackChain;
  /** On-chain owner of the agent — used to block self-review (the contract reverts on it). */
  ownerAddress?: string;
}) {
  const { address, connect, getProvider } = useEvmWallet();
  const [stars, setStars] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [txHash, setTxHash] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const isOwner = Boolean(
    address && ownerAddress && address.toLowerCase() === ownerAddress.toLowerCase(),
  );

  async function submit() {
    if (!stars || isOwner) return;
    setErrorMsg('');

    let active = address;
    if (!active) {
      active = await connect();
      if (!active) {
        setErrorMsg('Connect your EVM wallet from the top-right button, then try again.');
        setStatus('error');
        return;
      }
    }
    if (ownerAddress && active.toLowerCase() === ownerAddress.toLowerCase()) {
      setErrorMsg("You can't review your own agent.");
      setStatus('error');
      return;
    }

    const provider = getProvider();
    if (!provider) {
      setErrorMsg('Wallet provider unavailable. Reconnect and try again.');
      setStatus('error');
      return;
    }

    setStatus('submitting');
    try {
      const hash = await submitFeedback(provider, active, chain, {
        agentId,
        value: starsToValue(stars),
        stars,
        comment: comment.trim() || undefined,
      });
      setTxHash(hash);
      setStatus('success');
    } catch (err) {
      // User rejection and RPC errors both land here — surface the wallet's message.
      const msg = err instanceof Error ? err.message : 'Transaction failed';
      setErrorMsg(msg.length > 160 ? `${msg.slice(0, 160)}…` : msg);
      setStatus('error');
    }
  }

  if (status === 'success') {
    const explorer = feedbackChainConfig(chain).explorerTxUrl(txHash);
    return (
      <Card className="border-[rgb(48_168_108/0.2)] bg-[rgb(48_168_108/0.05)]">
        <CardContent className="flex items-center gap-3 py-4">
          <CheckCircle2 className="size-5 shrink-0 text-[#30a46c]" />
          <div className="min-w-0">
            <p className="text-[13px] font-[510] text-[#f7f8f8]">Feedback published on-chain</p>
            <a
              href={explorer}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12px] text-[#828fff] hover:underline underline-offset-2"
            >
              View transaction
              <ExternalLink className="size-3" />
            </a>
          </div>
        </CardContent>
      </Card>
    );
  }

  const activeStars = hover || stars;

  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-3">
        <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
          Leave on-chain feedback
        </CardTitle>
        <p className="mt-1 text-[11px] text-[#62666d]">
          Publishes an ERC-8004 review to the {chain === 'celo' ? 'Celo' : 'Arc'} ReputationRegistry
          from your wallet. Independent, portable, public.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} star${n > 1 ? 's' : ''}`}
              disabled={isOwner || status === 'submitting'}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setStars(n)}
              className="p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Star
                className={
                  n <= activeStars
                    ? 'size-6 fill-[#f5b301] text-[#f5b301] transition-colors'
                    : 'size-6 text-[#3a3d44] transition-colors'
                }
              />
            </button>
          ))}
          {stars > 0 && !isOwner && (
            <span className="ml-2 text-[12px] tabular-nums text-[#8a8f98]">{starsToValue(stars)} / 100</span>
          )}
        </div>

        {!isOwner && (
          <div className="space-y-1">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT_LEN))}
              maxLength={MAX_COMMENT_LEN}
              rows={2}
              disabled={status === 'submitting'}
              placeholder="Add a comment (optional) — stored on-chain with your rating"
              className="w-full resize-none rounded-md border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] px-2.5 py-2 text-[12px] text-[#f7f8f8] placeholder:text-[#62666d] outline-none focus:border-[#5e6ad2] disabled:opacity-50"
            />
            {comment.length > 0 && (
              <p className="text-right text-[10.5px] tabular-nums text-[#62666d]">
                {comment.length} / {MAX_COMMENT_LEN}
              </p>
            )}
          </div>
        )}

        {isOwner ? (
          <p className="text-[12px] text-[#62666d]">
            You can&apos;t review your own agent — the registry blocks self-feedback.
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="text-[12px] bg-[#5e6ad2] hover:bg-[#6e79d6] text-white"
              onClick={submit}
              disabled={!stars || status === 'submitting'}
            >
              {status === 'submitting'
                ? 'Confirm in wallet…'
                : address
                  ? 'Publish feedback'
                  : 'Connect & publish'}
            </Button>
            <span className="text-[11px] text-[#62666d]">Gas paid by your wallet</span>
          </div>
        )}

        {errorMsg && <p className="text-[12px] text-[#e5484d]">{errorMsg}</p>}
      </CardContent>
    </Card>
  );
}
