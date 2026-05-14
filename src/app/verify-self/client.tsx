'use client';

import { useEffect, useState } from 'react';
import { SelfQRcodeWrapper, SelfAppBuilder } from '@selfxyz/qrcode';
import { Card, CardContent } from '@/components/ui/card';
import { CheckCircle2, AlertCircle, Wallet } from 'lucide-react';

const SELF_SCOPE = 'agentkarma';
const APP_URL =
  typeof window !== 'undefined'
    ? window.location.origin
    : (process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io');

// Celo chainId (eip155:42220) — when MetaMask / Rabby / Rainbow / Valora are
// connected to the wrong chain we ask them to switch before signing.
const CELO_CHAIN_ID_HEX = '0xa4ec';

type Status = 'idle' | 'success' | 'error';

interface Eip1193Provider {
  request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

function isHexAddress(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

export default function VerifySelfClient() {
  const [userId, setUserId] = useState<`0x${string}` | null>(null);
  const [selfApp, setSelfApp] = useState<ReturnType<typeof buildApp> | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  function buildApp(addr: `0x${string}`) {
    return new SelfAppBuilder({
      version: 2,
      appName: 'AgentKarma',
      scope: SELF_SCOPE,
      endpoint: `${APP_URL}/api/v2/self/verify`,
      logoBase64: `${APP_URL}/brand/agent-karma-symbol-v2.svg`,
      userId: addr,
      userIdType: 'hex',
      endpointType: 'https',
      disclosures: {
        // No demographic disclosure — AK only needs proof-of-human +
        // sybil-resistance nullifier. Minimal-disclosure on purpose.
      },
    }).build();
  }

  async function connect() {
    setConnectError(null);
    if (!window.ethereum) {
      setConnectError(
        'No EVM wallet detected. Install MetaMask / Rabby / Rainbow / Valora and reload.',
      );
      return;
    }
    setConnecting(true);
    try {
      const accounts = await window.ethereum.request<string[]>({
        method: 'eth_requestAccounts',
      });
      const addr = accounts?.[0];
      if (!isHexAddress(addr)) {
        throw new Error('wallet returned no address');
      }
      // Best-effort chain switch to Celo. Some wallets (e.g. mobile in-app
      // browsers) won't expose wallet_switchEthereumChain — that's fine, the
      // signing surface is on the user's phone via Self anyway. Don't block.
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CELO_CHAIN_ID_HEX }],
        });
      } catch {
        /* non-fatal */
      }
      setUserId(addr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConnectError(msg);
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    if (userId) setSelfApp(buildApp(userId));
  }, [userId]);

  if (status === 'success' && userId) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-6">
          <CheckCircle2 className="size-6 text-emerald-400" />
          <div>
            <p className="font-medium">Verification successful</p>
            <p className="text-sm text-muted-foreground">
              Tier 3 anchor recorded for {userId.slice(0, 6)}…{userId.slice(-4)}.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!userId) {
    return (
      <Card>
        <CardContent className="space-y-5 p-6">
          <div className="space-y-2">
            <p className="font-medium">Connect the wallet you want to anchor</p>
            <p className="text-sm text-muted-foreground">
              The proof binds this EVM address to a passport-backed nullifier under
              AgentKarma&apos;s Self scope. Switch your wallet to Celo Mainnet first.
            </p>
          </div>

          <button
            type="button"
            onClick={connect}
            disabled={connecting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-border bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <Wallet className="size-4" />
            {connecting ? 'Waiting for wallet…' : 'Connect wallet'}
          </button>

          {connectError && (
            <div className="flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <p>{connectError}</p>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            No personal data is collected. The wallet signature is only used to bind
            the EVM address you connect to the Self ZK proof generated on your phone.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-6 p-6">
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">Anchoring wallet</p>
          <div className="flex items-center justify-between gap-3">
            <p className="break-all font-mono text-xs">{userId}</p>
            <button
              type="button"
              onClick={() => {
                setUserId(null);
                setSelfApp(null);
                setStatus('idle');
              }}
              className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              switch
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-white p-4">
          {selfApp ? (
            <SelfQRcodeWrapper
              selfApp={selfApp}
              onSuccess={() => setStatus('success')}
              onError={() => setStatus('error')}
            />
          ) : (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              Generating QR code…
            </div>
          )}
        </div>

        {status === 'error' && (
          <div className="flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>Verification failed. Re-scan the QR with the Self mobile app.</p>
          </div>
        )}

        <ol className="space-y-2 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">1.</span> Install the Self app
            (iOS / Android) and complete passport setup.
          </li>
          <li>
            <span className="font-medium text-foreground">2.</span> Scan the QR above.
          </li>
          <li>
            <span className="font-medium text-foreground">3.</span> AK&apos;s backend
            verifies the ZK proof and stores the nullifier — only proof-of-presence,
            never raw passport data.
          </li>
        </ol>
      </CardContent>
    </Card>
  );
}
