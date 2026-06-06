'use client';

/**
 * StellarClaimBanner — Stellar (G…) agent claim banner. Mirrors the Solana
 * ClaimBanner markup/states (collapsed CTA → expanded form → success), swapping
 * the Solana wallet hooks for useStellarClaimWallet (Freighter signMessage),
 * dropping the Tempo field, and posting to /api/agent/claim/stellar.
 *
 * Interaction primitive (wallet connect + sign) → "use client" justified.
 */
import { useState } from 'react';
import { Shield } from 'lucide-react';
import { useStellarClaimWallet } from '@/hooks/use-stellar-claim-wallet';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const CATEGORIES = [
  { value: 'ai', label: 'AI / ML' },
  { value: 'data', label: 'Data Feed' },
  { value: 'defi', label: 'DeFi' },
  { value: 'infra', label: 'Infrastructure' },
  { value: 'social', label: 'Social' },
  { value: 'utility', label: 'Utility' },
  { value: 'other', label: 'Other' },
];

export function StellarClaimBanner({ walletAddress }: { walletAddress: string }) {
  const [expanded, setExpanded] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<'idle' | 'signing' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const { address, connected, connect, signChallenge } = useStellarClaimWallet();

  async function handleClaim() {
    if (!displayName.trim()) return;
    setErrorMsg('');

    let active = address;
    if (!connected || !active) {
      active = await connect();
      if (!active) {
        setErrorMsg('Connect your Stellar wallet to continue.');
        return;
      }
    }
    if (active !== walletAddress) {
      setErrorMsg(`Connected wallet (${active.slice(0, 6)}…) doesn't match this agent's wallet.`);
      setStatus('error');
      return;
    }

    setStatus('signing');
    try {
      const { message, signatureHex } = await signChallenge(walletAddress);
      setStatus('submitting');
      const res = await fetch('/api/agent/claim/stellar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: walletAddress,
          displayName: displayName.trim(),
          description: description.trim() || null,
          website: website.trim() || null,
          category: category || null,
          signature: signatureHex,
          message,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Claim failed');
      }
      setStatus('success');
      setTimeout(() => window.location.reload(), 1000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Claim failed');
      setStatus('error');
    }
  }

  if (status === 'success') {
    return (
      <Card className="rounded-lg border-[rgb(48_168_108/0.2)] bg-[rgb(48_168_108/0.05)] py-1.5">
        <CardContent className="flex items-center gap-2.5 px-3 py-0">
          <Shield className="size-3.5 text-[#30a46c]" />
          <p className="text-[12px] text-[#30a46c] font-[510] leading-4">
            Agent claimed successfully. Refreshing…
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-lg border-[rgb(94_106_210/0.15)] bg-[rgb(94_106_210/0.04)] py-1.5">
      <CardContent className="px-3 py-0">
        {!expanded ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Shield className="size-3.5 text-[#828fff] shrink-0" />
              <div className="flex min-w-0 items-baseline gap-1.5">
                <p className="shrink-0 text-[12px] text-[#f7f8f8] font-[510] leading-4">
                  Is this your agent?
                </p>
                <p className="truncate text-[11px] text-[#62666d] leading-4">
                  Claim this Stellar wallet to add a name, description, and website — and mint its on-chain identity.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="xs"
              className="shrink-0 border-[rgb(94_106_210/0.3)] text-[#828fff] hover:bg-[rgb(94_106_210/0.1)]"
              onClick={() => setExpanded(true)}
            >
              Claim Agent
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Shield className="size-4 text-[#828fff] shrink-0" />
              <p className="text-[13px] text-[#f7f8f8] font-[510]">Claim this agent</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                placeholder="Display name *"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={50}
                className="bg-[rgb(255_255_255/0.03)] border-[rgb(255_255_255/0.08)] text-[13px] h-8"
              />
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-8 rounded-md border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.03)] px-3 text-[13px] text-[#f7f8f8] outline-none"
              >
                <option value="">Category (optional)</option>
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <Input
              placeholder="Short description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={280}
              className="bg-[rgb(255_255_255/0.03)] border-[rgb(255_255_255/0.08)] text-[13px] h-8"
            />
            <Input
              placeholder="Website URL (optional)"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              className="bg-[rgb(255_255_255/0.03)] border-[rgb(255_255_255/0.08)] text-[13px] h-8"
            />
            {errorMsg && <p className="text-[12px] text-[#e5484d]">{errorMsg}</p>}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="text-[12px] bg-[#5e6ad2] hover:bg-[#6e79d6] text-white"
                onClick={handleClaim}
                disabled={!displayName.trim() || status === 'signing' || status === 'submitting'}
              >
                {status === 'signing' ? 'Sign with wallet…' :
                 status === 'submitting' ? 'Saving…' :
                 connected ? 'Sign & Claim' : 'Connect & Claim'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-[12px] text-[#62666d]"
                onClick={() => { setExpanded(false); setErrorMsg(''); setStatus('idle'); }}
              >
                Cancel
              </Button>
              <p className="text-[11px] text-[#62666d] ml-auto">
                Requires wallet signature to prove ownership
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
