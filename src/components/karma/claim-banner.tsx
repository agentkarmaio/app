'use client';

import { useState } from 'react';
import { Shield } from 'lucide-react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
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

const TEMPO_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export function ClaimBanner({ walletAddress }: { walletAddress: string }) {
  const [expanded, setExpanded] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [category, setCategory] = useState('');
  const [tempoAddress, setTempoAddress] = useState('');
  const [status, setStatus] = useState<'idle' | 'signing' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const { publicKey, connected, signMessage } = useWallet();
  const { setVisible } = useWalletModal();

  async function handleClaim() {
    if (!displayName.trim()) return;

    setErrorMsg('');

    if (!connected || !publicKey || !signMessage) {
      setVisible(true);
      setErrorMsg('Connect your wallet to continue.');
      return;
    }

    if (publicKey.toBase58() !== walletAddress) {
      setErrorMsg(
        `Connected wallet (${publicKey.toBase58().slice(0, 8)}…) doesn't match this agent's wallet.`,
      );
      setStatus('error');
      return;
    }

    const trimmedTempo = tempoAddress.trim();
    if (trimmedTempo && !TEMPO_ADDRESS_REGEX.test(trimmedTempo)) {
      setErrorMsg('Tempo address must be a valid EVM-style 0x… 42-character address.');
      setStatus('error');
      return;
    }

    setStatus('signing');
    try {
      const timestamp = Date.now().toString();
      const message = `AgentKarma: Claim wallet ${walletAddress} at ${timestamp}`;
      const messageBytes = new TextEncoder().encode(message);

      const signatureBytes = await signMessage(messageBytes);
      const signatureB58 = uint8ArrayToBase58(signatureBytes);

      setStatus('submitting');

      const res = await fetch('/api/agent/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: walletAddress,
          displayName: displayName.trim(),
          description: description.trim() || null,
          website: website.trim() || null,
          category: category || null,
          tempoAddress: trimmedTempo || null,
          signature: signatureB58,
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
                  Claim this wallet to add a name, description, and website to your profile.
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
            <Input
              placeholder="Tempo / MPP address (optional, 0x…)"
              value={tempoAddress}
              onChange={(e) => setTempoAddress(e.target.value)}
              maxLength={42}
              className="bg-[rgb(255_255_255/0.03)] border-[rgb(255_255_255/0.08)] text-[13px] h-8 font-mono"
            />
            <p className="text-[10px] text-[#62666d] -mt-1.5">
              Optional Tier 3 declared signal. If you also operate on the Tempo / MPP rail,
              link your address — displayed alongside Karma but not blended into your score.
            </p>
            {errorMsg && (
              <p className="text-[12px] text-[#e5484d]">{errorMsg}</p>
            )}
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
