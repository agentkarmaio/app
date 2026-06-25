'use client';

/**
 * ClaimProof — the re-verifiable receipt for a claimed agent.
 *
 * Claiming proves key control via an off-chain signature, not an on-chain tx.
 * This block surfaces the actual artifact (signed challenge + signature + signer)
 * so a visitor can confirm the "Claimed" badge independently — copy the fields
 * into any Ed25519 / EIP-191 verifier, or hit "Verify" to re-check in-browser.
 *
 * Rendered by every agent-profile variant (celo / arc / stellar / solana) when a
 * proof is stored. Renders nothing for pre-feature claims (no signature captured).
 */
import { useCallback, useState } from 'react';
import { ShieldCheck, Copy, Check, Loader2, BadgeCheck, ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { verifyClaimProof, type ClaimProofChain } from '@/lib/claim-proof-verify';

const SCHEME_LABEL: Record<ClaimProofChain, string> = {
  solana: 'Ed25519 · wallet signMessage',
  stellar: 'Ed25519 · SEP-53',
  celo: 'EIP-191 · personal_sign',
  arc: 'EIP-191 · personal_sign',
};

type VerifyState = 'idle' | 'checking' | 'valid' | 'invalid';

export function ClaimProof({
  chain,
  address,
  message,
  signature,
}: {
  chain: ClaimProofChain;
  address: string;
  message: string;
  signature: string;
}) {
  const [state, setState] = useState<VerifyState>('idle');

  const verify = useCallback(async () => {
    setState('checking');
    const ok = await verifyClaimProof({ chain, address, message, signature });
    setState(ok ? 'valid' : 'invalid');
  }, [chain, address, message, signature]);

  const scheme = SCHEME_LABEL[chain];
  const tool = scheme.split(' · ')[0];

  return (
    <Card className="bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="gap-2.5">
        <CardTitle className="flex items-center gap-2.5 text-[15px] font-[590] tracking-[-0.18px] text-[#f7f8f8]">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(130_143_255/0.08)]">
            <ShieldCheck className="size-4 text-[#828fff]" />
          </span>
          Proof of ownership
        </CardTitle>
        <p className="max-w-[68ch] text-[12px] leading-[1.6] text-[#8a8f98]">
          Off-chain signature, not an on-chain transaction. The keyholder signed this
          challenge to prove control of the address — verify it yourself with any {tool}{' '}
          tool, or re-check it in your browser.
        </p>
      </CardHeader>

      <CardContent>
        <dl className="divide-y divide-[rgb(255_255_255/0.05)] overflow-hidden rounded-lg border border-[rgb(255_255_255/0.06)] bg-[rgb(0_0_0/0.22)]">
          <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
            <RowLabel>Scheme</RowLabel>
            <dd className="font-mono text-[12px] text-[#c8ccd2]">{scheme}</dd>
          </div>
          <ProofRow label="Signed message" value={message} />
          <ProofRow label="Signature" value={signature} />
          <ProofRow label="Signer" value={address} />
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={verify}
            disabled={state === 'checking'}
            className="h-8 gap-1.5 border-[rgb(255_255_255/0.1)] bg-[rgb(255_255_255/0.03)] text-[12px] text-[#c8ccd2] transition-colors hover:bg-[rgb(255_255_255/0.05)] hover:text-[#f7f8f8]"
          >
            {state === 'checking' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="size-3.5" />
            )}
            {state === 'checking' ? 'Verifying…' : state === 'idle' ? 'Verify signature' : 'Re-verify'}
          </Button>

          <VerifyStatus state={state} />
        </div>
      </CardContent>
    </Card>
  );
}

/** Verdict line shown after an in-browser re-check. */
function VerifyStatus({ state }: { state: VerifyState }) {
  if (state === 'valid') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-[510] text-emerald-500 duration-200 animate-in fade-in slide-in-from-left-1 motion-reduce:animate-none">
        <BadgeCheck className="size-3.5" />
        Signature valid — signer controls this address
      </span>
    );
  }
  if (state === 'invalid') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-[510] text-[#e5484d] duration-200 animate-in fade-in slide-in-from-left-1 motion-reduce:animate-none">
        <ShieldAlert className="size-3.5" />
        Could not verify this signature
      </span>
    );
  }
  return null;
}

/** A single label + monospace artifact with a quiet copy affordance. */
function ProofRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="group/row space-y-1.5 px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <RowLabel>{label}</RowLabel>
        <CopyButton value={value} />
      </div>
      <dd className="break-all font-mono text-[11.5px] leading-[1.55] text-[#c8ccd2]">
        {value}
      </dd>
    </div>
  );
}

function RowLabel({ children }: { children: React.ReactNode }) {
  return (
    <dt className="text-[10px] font-[510] uppercase tracking-[0.09em] text-[#6b7079]">
      {children}
    </dt>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
      className="inline-flex size-5 items-center justify-center rounded text-[#52555c] transition-colors hover:text-[#f7f8f8] focus-visible:text-[#f7f8f8] focus-visible:outline-none group-hover/row:text-[#8a8f98]"
    >
      {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3" />}
    </button>
  );
}
