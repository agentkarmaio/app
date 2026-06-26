'use client';

/**
 * ProveOwnership — in-place upgrade for an already-claimed agent whose original
 * claim-time signature was never retained (claims predating the claim_signature
 * column). Renders when `isClaimed && !claim_signature`.
 *
 * Claiming already proved ownership; this re-runs the SAME challenge purely to
 * capture the receipt, then POSTs to /api/agent/prove (metadata-free — nothing
 * on the profile is re-entered or overwritten). One shared card; per-chain
 * signers reuse each wallet's native signing primitive (Solana wallet-adapter,
 * EVM EIP-1193, Stellar Freighter).
 */
import { useCallback, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useEvmWallet } from '@/components/wallet/evm-wallet-provider';
import { useStellarClaimWallet } from '@/hooks/use-stellar-claim-wallet';
import type { Chain } from '@/db/schema';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { uint8ArrayToBase58 } from '@/lib/base58';

type ProveChain = Extract<Chain, 'solana' | 'stellar' | 'celo' | 'arc'>;
type Status = 'idle' | 'signing' | 'submitting' | 'success' | 'error';

export function ProveOwnership({ chain, address }: { chain: ProveChain; address: string }) {
  switch (chain) {
    case 'solana':
      return <ProveSolana address={address} />;
    case 'stellar':
      return <ProveStellar address={address} />;
    case 'celo':
    case 'arc':
      return <ProveEvm address={address} chain={chain} />;
    default:
      return null;
  }
}

async function postProof(body: { address: string; chain: ProveChain; signature: string; message: string }) {
  const res = await fetch('/api/agent/prove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? 'Could not record proof');
  }
}

// ── Solana ──────────────────────────────────────────────────────────────────
function ProveSolana({ address }: { address: string }) {
  const { publicKey, connected, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const onProve = useCallback(async () => {
    setErrorMsg('');
    if (!connected || !publicKey || !signMessage) {
      setVisible(true);
      return;
    }
    if (publicKey.toBase58() !== address) {
      setErrorMsg("Connected wallet doesn't match this agent.");
      setStatus('error');
      return;
    }
    setStatus('signing');
    try {
      const message = `AgentKarma: Claim wallet ${address} at ${Date.now()}`;
      const sig = await signMessage(new TextEncoder().encode(message));
      setStatus('submitting');
      await postProof({ address, chain: 'solana', signature: uint8ArrayToBase58(sig), message });
      setStatus('success');
      setTimeout(() => window.location.reload(), 1000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed');
      setStatus('error');
    }
  }, [address, connected, publicKey, signMessage, setVisible]);

  return <ProveCard status={status} errorMsg={errorMsg} connected={connected} onProve={onProve} />;
}

// ── EVM (Celo / Arc) ─────────────────────────────────────────────────────────
function ProveEvm({ address, chain }: { address: string; chain: Extract<Chain, 'celo' | 'arc'> }) {
  const { address: walletAddr, connect, signMessage } = useEvmWallet();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const onProve = useCallback(async () => {
    setErrorMsg('');
    let active = walletAddr;
    if (!active) {
      active = await connect();
      if (!active) {
        setErrorMsg('Connect your EVM wallet from the top-right button, then try again.');
        setStatus('error');
        return;
      }
    }
    if (active.toLowerCase() !== address.toLowerCase()) {
      setErrorMsg("Connected wallet doesn't match this agent.");
      setStatus('error');
      return;
    }
    setStatus('signing');
    try {
      const message = `AgentKarma: Claim wallet ${address} at ${Date.now()}`;
      const signature = await signMessage(message);
      setStatus('submitting');
      await postProof({ address, chain, signature, message });
      setStatus('success');
      setTimeout(() => window.location.reload(), 1000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed');
      setStatus('error');
    }
  }, [address, chain, walletAddr, connect, signMessage]);

  return <ProveCard status={status} errorMsg={errorMsg} connected={Boolean(walletAddr)} onProve={onProve} />;
}

// ── Stellar ──────────────────────────────────────────────────────────────────
function ProveStellar({ address }: { address: string }) {
  const { address: walletAddr, connected, connect, signChallenge } = useStellarClaimWallet();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const onProve = useCallback(async () => {
    setErrorMsg('');
    let active = walletAddr;
    if (!connected || !active) {
      active = await connect();
      if (!active) {
        setErrorMsg('Connect your Stellar wallet to continue.');
        return;
      }
    }
    if (active !== address) {
      setErrorMsg("Connected wallet doesn't match this agent.");
      setStatus('error');
      return;
    }
    setStatus('signing');
    try {
      const { message, signatureHex } = await signChallenge(address);
      setStatus('submitting');
      await postProof({ address, chain: 'stellar', signature: signatureHex, message });
      setStatus('success');
      setTimeout(() => window.location.reload(), 1000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed');
      setStatus('error');
    }
  }, [address, walletAddr, connected, connect, signChallenge]);

  return <ProveCard status={status} errorMsg={errorMsg} connected={connected} onProve={onProve} />;
}

// ── Shared card chrome ───────────────────────────────────────────────────────
function ProveCard({
  status,
  errorMsg,
  connected,
  onProve,
}: {
  status: Status;
  errorMsg: string;
  connected: boolean;
  onProve: () => void;
}) {
  if (status === 'success') {
    return (
      <Card className="rounded-lg border-[rgb(48_168_108/0.2)] bg-[rgb(48_168_108/0.05)] py-1.5">
        <CardContent className="flex items-center gap-2.5 px-3 py-0">
          <ShieldCheck className="size-3.5 text-[#30a46c]" />
          <p className="text-[12px] text-[#30a46c] font-[510] leading-4">Ownership proof recorded. Refreshing…</p>
        </CardContent>
      </Card>
    );
  }

  const busy = status === 'signing' || status === 'submitting';
  return (
    <Card className="rounded-lg border-[rgb(94_106_210/0.15)] bg-[rgb(94_106_210/0.04)] py-1.5">
      <CardContent className="px-3 py-0">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <ShieldCheck className="size-3.5 text-[#828fff] shrink-0" />
            <div className="flex min-w-0 items-baseline gap-1.5">
              <p className="shrink-0 text-[12px] text-[#f7f8f8] font-[510] leading-4">Prove ownership</p>
              <p className="truncate text-[11px] text-[#62666d] leading-4">
                Sign once to publish a re-verifiable receipt for this claim — no data re-entry.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="xs"
            className="shrink-0 border-[rgb(94_106_210/0.3)] text-[#828fff] hover:bg-[rgb(94_106_210/0.1)]"
            onClick={onProve}
            disabled={busy}
          >
            {status === 'signing' ? 'Sign…' : status === 'submitting' ? 'Saving…' : connected ? 'Prove ownership' : 'Connect & prove'}
          </Button>
        </div>
        {errorMsg && <p className="mt-1.5 text-[12px] text-[#e5484d]">{errorMsg}</p>}
      </CardContent>
    </Card>
  );
}
