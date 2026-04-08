'use client';

import { useState } from 'react';
import { ThumbsUp, ThumbsDown, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

interface FeedbackSummary {
  total: number;
  delivered: number;
  failed: number;
  deliveryRate: number;
}

export function FeedbackSection({
  agentWallet,
  feedbackSummary,
}: {
  agentWallet: string;
  feedbackSummary: FeedbackSummary;
}) {
  const [showForm, setShowForm] = useState(false);
  const [txSig, setTxSig] = useState('');
  const [selectedRating, setSelectedRating] = useState<'delivered' | 'failed' | null>(null);
  const [status, setStatus] = useState<'idle' | 'signing' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const { total, delivered, failed, deliveryRate } = feedbackSummary;

  async function handleSubmit() {
    if (!txSig.trim() || !selectedRating) return;

    setStatus('signing');
    setErrorMsg('');

    try {
      const provider = (window as unknown as Record<string, unknown>).solana as {
        connect: () => Promise<{ publicKey: { toString: () => string } }>;
        signMessage: (message: Uint8Array, encoding: string) => Promise<{ signature: Uint8Array }>;
      } | undefined;

      if (!provider?.signMessage) {
        setErrorMsg('Solana wallet not found. Install Phantom or Backpack.');
        setStatus('error');
        return;
      }

      await provider.connect();

      const timestamp = Date.now().toString();
      const message = `AgentKarma: Feedback ${selectedRating} for ${txSig.trim()} at ${timestamp}`;
      const messageBytes = new TextEncoder().encode(message);
      const { signature } = await provider.signMessage(messageBytes, 'utf8');
      const signatureB58 = uint8ArrayToBase58(new Uint8Array(signature));

      setStatus('submitting');

      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentWallet,
          rating: selectedRating,
          txSignature: txSig.trim(),
          signature: signatureB58,
          message,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Feedback submission failed');
      }

      setStatus('success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      if (status !== 'error') {
        setErrorMsg(err instanceof Error ? err.message : 'Submission failed');
        setStatus('error');
      }
    }
  }

  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8] flex items-center gap-2">
            <MessageSquare className="size-4" />
            Delivery Feedback
          </CardTitle>
          {!showForm && status !== 'success' && (
            <Button
              variant="outline"
              size="sm"
              className="text-[12px] border-[rgb(255_255_255/0.1)] text-[#8a8f98] hover:text-[#f7f8f8]"
              onClick={() => setShowForm(true)}
            >
              Submit Feedback
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary stats */}
        {total > 0 ? (
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <ThumbsUp className="size-3.5 text-[#30a46c]" />
                <span className="text-[13px] font-[510] tabular-nums text-[#30a46c]">{delivered}</span>
              </div>
              <span className="text-[11px] text-[#62666d]">delivered</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <ThumbsDown className="size-3.5 text-[#e5484d]" />
                <span className="text-[13px] font-[510] tabular-nums text-[#e5484d]">{failed}</span>
              </div>
              <span className="text-[11px] text-[#62666d]">failed</span>
            </div>
            <div className="ml-auto text-right">
              <span className="text-[13px] font-[590] tabular-nums text-[#f7f8f8]">
                {(deliveryRate * 100).toFixed(0)}%
              </span>
              <span className="text-[11px] text-[#62666d] ml-1">delivery rate</span>
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-[#62666d]">
            No delivery feedback yet. If you&apos;ve used this agent via x402, submit feedback to help others.
          </p>
        )}

        {/* Submission form */}
        {showForm && status !== 'success' && (
          <div className="space-y-3 pt-2 border-t border-[rgb(255_255_255/0.06)]">
            <p className="text-[12px] text-[#8a8f98]">
              Paste the transaction signature of an x402 payment you made to this agent, then rate the delivery.
            </p>
            <Input
              placeholder="Transaction signature"
              value={txSig}
              onChange={(e) => setTxSig(e.target.value)}
              className="bg-[rgb(255_255_255/0.03)] border-[rgb(255_255_255/0.08)] text-[13px] h-8 font-mono"
            />
            <div className="flex items-center gap-2">
              <Button
                variant={selectedRating === 'delivered' ? 'default' : 'outline'}
                size="sm"
                className={
                  selectedRating === 'delivered'
                    ? 'text-[12px] bg-[rgb(48_164_108/0.15)] text-[#30a46c] border-[rgb(48_164_108/0.3)] hover:bg-[rgb(48_164_108/0.25)]'
                    : 'text-[12px] border-[rgb(255_255_255/0.08)] text-[#8a8f98]'
                }
                onClick={() => setSelectedRating('delivered')}
              >
                <ThumbsUp className="size-3 mr-1" />
                Delivered
              </Button>
              <Button
                variant={selectedRating === 'failed' ? 'default' : 'outline'}
                size="sm"
                className={
                  selectedRating === 'failed'
                    ? 'text-[12px] bg-[rgb(229_72_77/0.15)] text-[#e5484d] border-[rgb(229_72_77/0.3)] hover:bg-[rgb(229_72_77/0.25)]'
                    : 'text-[12px] border-[rgb(255_255_255/0.08)] text-[#8a8f98]'
                }
                onClick={() => setSelectedRating('failed')}
              >
                <ThumbsDown className="size-3 mr-1" />
                Failed
              </Button>
              <div className="flex-1" />
              <Button
                size="sm"
                className="text-[12px] bg-[#5e6ad2] hover:bg-[#6e79d6] text-white"
                disabled={!txSig.trim() || !selectedRating || status === 'signing' || status === 'submitting'}
                onClick={handleSubmit}
              >
                {status === 'signing' ? 'Sign with wallet...' :
                 status === 'submitting' ? 'Submitting...' :
                 'Sign & Submit'}
              </Button>
            </div>
            {errorMsg && (
              <p className="text-[12px] text-[#e5484d]">{errorMsg}</p>
            )}
            <p className="text-[11px] text-[#62666d]">
              You must be the sender of the referenced transaction. One feedback per transaction.
            </p>
          </div>
        )}

        {status === 'success' && (
          <div className="pt-2 border-t border-[rgb(255_255_255/0.06)]">
            <p className="text-[13px] text-[#30a46c] font-[510]">
              Feedback submitted. Refreshing...
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function uint8ArrayToBase58(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt(0);
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte);
  }
  let str = '';
  while (num > BigInt(0)) {
    str = ALPHABET[Number(num % BigInt(58))] + str;
    num = num / BigInt(58);
  }
  for (const byte of bytes) {
    if (byte === 0) str = '1' + str;
    else break;
  }
  return str || '1';
}
