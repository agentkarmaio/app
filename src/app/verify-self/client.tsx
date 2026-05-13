'use client';

import { useEffect, useState } from 'react';
import { SelfQRcodeWrapper, SelfAppBuilder } from '@selfxyz/qrcode';
import { Card, CardContent } from '@/components/ui/card';
import { CheckCircle2, AlertCircle } from 'lucide-react';

const SELF_SCOPE = 'agentkarma';
const APP_URL =
  typeof window !== 'undefined'
    ? window.location.origin
    : (process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io');

type Status = 'idle' | 'success' | 'error';

export default function VerifySelfClient() {
  // The Celo wallet whose Tier 3 anchor we're establishing. Hard-coded to AK's
  // controller for v1 — anyone else verifying for their own wallet would pass
  // their address via a connected wallet UI (not in scope tonight).
  const [userId] = useState<`0x${string}`>('0xCfc0A11C75519FAf85B7872E27733CFaa4295b96');
  const [selfApp, setSelfApp] = useState<ReturnType<typeof buildApp> | null>(null);
  const [status, setStatus] = useState<Status>('idle');

  function buildApp(addr: `0x${string}`) {
    return new SelfAppBuilder({
      version: 2,
      appName: 'AgentKarma',
      scope: SELF_SCOPE,
      endpoint: `${APP_URL}/api/v2/self/verify`,
      logoBase64: `${APP_URL}/brand/agent-karma-symbol-v2.svg`,
      userId: addr,
      userIdType: 'hex',
      endpointType: 'https', // production endpoint, not staging
      disclosures: {
        // No demographic disclosure — AK only needs proof-of-human +
        // sybil-resistance nullifier. Minimal-disclosure on purpose.
      },
    }).build();
  }

  useEffect(() => {
    setSelfApp(buildApp(userId));
  }, [userId]);

  if (status === 'success') {
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

  return (
    <Card>
      <CardContent className="space-y-6 p-6">
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">Anchoring wallet</p>
          <p className="break-all font-mono text-xs">{userId}</p>
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
