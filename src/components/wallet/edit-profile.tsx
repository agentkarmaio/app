'use client';

/**
 * EditProfile — owner-only metadata editor for an ALREADY-CLAIMED agent. Renders
 * when `isClaimed`; the owner check (connected wallet === agent address) happens
 * client-side at sign time, exactly as ClaimBanner / ProveOwnership do.
 *
 * Chain-dispatched like ProveOwnership: each variant calls ONLY its own wallet
 * hook, so mounting the Solana variant never invokes useEvmWallet (whose provider
 * isn't present on the Solana page). The form fields + card chrome live once in
 * <EditCard>; each variant supplies the per-chain signing primitive. On save it
 * signs an operation-scoped "Edit wallet …" challenge — DISTINCT from the claim
 * challenge, so a publicly-displayed claim/prove receipt can't be replayed to
 * authorize an edit — and POSTs to /api/agent/edit (full-replace: a blank field
 * clears it). The edit signature is intentionally NOT persisted/displayed.
 */
import { useCallback, useState } from 'react';
import { Pencil } from 'lucide-react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useEvmWallet } from '@/components/wallet/evm-wallet-provider';
import { useStellarClaimWallet } from '@/hooks/use-stellar-claim-wallet';
import type { Chain } from '@/db/schema';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { uint8ArrayToBase58 } from '@/lib/base58';

type EditChain = Extract<Chain, 'solana' | 'stellar' | 'celo' | 'arc'>;
type Phase = 'signing' | 'submitting';

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

export interface EditProfileValues {
  displayName: string;
  description: string;
  website: string;
  category: string;
  imageUrl: string;
  tempoAddress: string;
}

export interface EditProfileProps {
  chain: EditChain;
  address: string;
  /** Pre-fill from the current wallet row (raw, NOT safeHref'd). */
  current: EditProfileValues;
}

export function EditProfile({ chain, address, current }: EditProfileProps) {
  switch (chain) {
    case 'solana':
      return <EditSolana address={address} current={current} />;
    case 'stellar':
      return <EditStellar address={address} current={current} />;
    case 'celo':
    case 'arc':
      return <EditEvm address={address} chain={chain} current={current} />;
    default:
      return null;
  }
}

/**
 * Operation-scoped EDIT challenge — distinct verb from the claim/prove challenge
 * so a displayed claim receipt can't be replayed to edit. MUST stay byte-identical
 * to buildEditChallenge in src/lib/claim-verify.ts (the server verifier).
 */
const buildEditMessage = (address: string, timestampMs: number | string = Date.now()) =>
  `AgentKarma: Edit wallet ${address} at ${timestampMs}`;

/** Build the POST body, normalizing blanks → null. Tempo only on Solana. */
function buildEditBody(
  chain: EditChain,
  address: string,
  f: EditProfileValues,
  signature: string,
  message: string,
) {
  return {
    address,
    chain,
    displayName: f.displayName.trim(),
    description: f.description.trim() || null,
    website: f.website.trim() || null,
    category: f.category || null,
    imageUrl: f.imageUrl.trim() || null,
    ...(chain === 'solana' ? { tempoAddress: f.tempoAddress.trim() || null } : {}),
    signature,
    message,
  };
}

async function postEdit(body: ReturnType<typeof buildEditBody>) {
  const res = await fetch('/api/agent/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? 'Could not save changes');
  }
}

// ── Solana ──────────────────────────────────────────────────────────────────
function EditSolana({ address, current }: { address: string; current: EditProfileValues }) {
  const { publicKey, connected, signMessage } = useWallet();
  const { setVisible } = useWalletModal();

  const submit = useCallback(
    async (fields: EditProfileValues, setPhase: (p: Phase) => void) => {
      if (!connected || !publicKey || !signMessage) {
        setVisible(true);
        throw new Error('Connect your wallet to continue.');
      }
      if (publicKey.toBase58() !== address) {
        throw new Error("Connected wallet doesn't match this agent.");
      }
      setPhase('signing');
      const message = buildEditMessage(address);
      const sig = await signMessage(new TextEncoder().encode(message));
      setPhase('submitting');
      await postEdit(buildEditBody('solana', address, fields, uint8ArrayToBase58(sig), message));
    },
    [address, connected, publicKey, signMessage, setVisible],
  );

  return <EditCard current={current} showTempo connected={connected} submit={submit} />;
}

// ── EVM (celo / arc) ──────────────────────────────────────────────────────────
function EditEvm({
  address,
  chain,
  current,
}: {
  address: string;
  chain: Extract<Chain, 'celo' | 'arc'>;
  current: EditProfileValues;
}) {
  const { address: walletAddr, connect, signMessage } = useEvmWallet();

  const submit = useCallback(
    async (fields: EditProfileValues, setPhase: (p: Phase) => void) => {
      let active = walletAddr;
      if (!active) {
        active = await connect();
        if (!active) throw new Error('Connect your EVM wallet from the top-right button, then try again.');
      }
      if (active.toLowerCase() !== address.toLowerCase()) {
        throw new Error("Connected wallet doesn't match this agent.");
      }
      setPhase('signing');
      const message = buildEditMessage(address);
      const signature = await signMessage(message);
      setPhase('submitting');
      await postEdit(buildEditBody(chain, address, fields, signature, message));
    },
    [address, chain, walletAddr, connect, signMessage],
  );

  return <EditCard current={current} showTempo={false} connected={Boolean(walletAddr)} submit={submit} />;
}

// ── Stellar ──────────────────────────────────────────────────────────────────
function EditStellar({ address, current }: { address: string; current: EditProfileValues }) {
  const { address: walletAddr, connected, connect, signChallenge } = useStellarClaimWallet();

  const submit = useCallback(
    async (fields: EditProfileValues, setPhase: (p: Phase) => void) => {
      let active = walletAddr;
      if (!connected || !active) {
        active = await connect();
        if (!active) throw new Error('Connect your Stellar wallet to continue.');
      }
      if (active !== address) {
        throw new Error("Connected wallet doesn't match this agent.");
      }
      setPhase('signing');
      const { message, signatureHex } = await signChallenge(address, buildEditMessage);
      setPhase('submitting');
      await postEdit(buildEditBody('stellar', address, fields, signatureHex, message));
    },
    [address, walletAddr, connected, connect, signChallenge],
  );

  return <EditCard current={current} showTempo={false} connected={connected} submit={submit} />;
}

// ── Shared card + form ────────────────────────────────────────────────────────
function EditCard({
  current,
  showTempo,
  connected,
  submit,
}: {
  current: EditProfileValues;
  showTempo: boolean;
  connected: boolean;
  submit: (fields: EditProfileValues, setPhase: (p: Phase) => void) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fields, setFields] = useState<EditProfileValues>(current);
  const [status, setStatus] = useState<'idle' | 'signing' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const set = <K extends keyof EditProfileValues>(key: K, value: EditProfileValues[K]) =>
    setFields((f) => ({ ...f, [key]: value }));

  async function handleSave() {
    setErrorMsg('');
    if (!fields.displayName.trim()) {
      setErrorMsg('Display name is required.');
      setStatus('error');
      return;
    }
    if (showTempo && fields.tempoAddress.trim() && !TEMPO_ADDRESS_REGEX.test(fields.tempoAddress.trim())) {
      setErrorMsg('Tempo address must be a valid EVM-style 0x… 42-character address.');
      setStatus('error');
      return;
    }
    try {
      await submit(fields, setStatus);
      setStatus('success');
      setTimeout(() => window.location.reload(), 1000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not save changes');
      setStatus('error');
    }
  }

  if (status === 'success') {
    return (
      <Card className="rounded-lg border-[rgb(48_168_108/0.2)] bg-[rgb(48_168_108/0.05)] py-1.5">
        <CardContent className="flex items-center gap-2.5 px-3 py-0">
          <Pencil className="size-3.5 text-[#30a46c]" />
          <p className="text-[12px] text-[#30a46c] font-[510] leading-4">Profile updated. Refreshing…</p>
        </CardContent>
      </Card>
    );
  }

  const busy = status === 'signing' || status === 'submitting';

  return (
    <Card className="rounded-lg border-[rgb(94_106_210/0.15)] bg-[rgb(94_106_210/0.04)] py-1.5">
      <CardContent className="px-3 py-0">
        {!expanded ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Pencil className="size-3.5 text-[#828fff] shrink-0" />
              <div className="flex min-w-0 items-baseline gap-1.5">
                <p className="shrink-0 text-[12px] text-[#f7f8f8] font-[510] leading-4">Own this agent?</p>
                <p className="truncate text-[11px] text-[#62666d] leading-4">
                  If this is your agent, update its name, description, logo, and links.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="xs"
              className="shrink-0 border-[rgb(94_106_210/0.3)] text-[#828fff] hover:bg-[rgb(94_106_210/0.1)]"
              onClick={() => setExpanded(true)}
            >
              Edit Profile
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Pencil className="size-4 text-[#828fff] shrink-0" />
              <p className="text-[13px] text-[#f7f8f8] font-[510]">Edit your agent profile</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                placeholder="Display name *"
                value={fields.displayName}
                onChange={(e) => set('displayName', e.target.value)}
                maxLength={50}
                className="bg-[rgb(255_255_255/0.03)] border-[rgb(255_255_255/0.08)] text-[13px] h-8"
              />
              <select
                value={fields.category}
                onChange={(e) => set('category', e.target.value)}
                className="h-8 rounded-md border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.03)] px-3 text-[13px] text-[#f7f8f8] outline-none"
              >
                <option value="">Category (optional)</option>
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <Input
              placeholder="Short description (optional)"
              value={fields.description}
              onChange={(e) => set('description', e.target.value)}
              maxLength={280}
              className="bg-[rgb(255_255_255/0.03)] border-[rgb(255_255_255/0.08)] text-[13px] h-8"
            />
            <Input
              placeholder="Website URL (optional)"
              value={fields.website}
              onChange={(e) => set('website', e.target.value)}
              className="bg-[rgb(255_255_255/0.03)] border-[rgb(255_255_255/0.08)] text-[13px] h-8"
            />
            <Input
              placeholder="Logo image URL (optional, https://…)"
              value={fields.imageUrl}
              onChange={(e) => set('imageUrl', e.target.value)}
              className="bg-[rgb(255_255_255/0.03)] border-[rgb(255_255_255/0.08)] text-[13px] h-8"
            />
            {showTempo && (
              <Input
                placeholder="Tempo / MPP address (optional, 0x…)"
                value={fields.tempoAddress}
                onChange={(e) => set('tempoAddress', e.target.value)}
                maxLength={42}
                className="bg-[rgb(255_255_255/0.03)] border-[rgb(255_255_255/0.08)] text-[13px] h-8 font-mono"
              />
            )}
            {errorMsg && <p className="text-[12px] text-[#e5484d]">{errorMsg}</p>}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="text-[12px] bg-[#5e6ad2] hover:bg-[#6e79d6] text-white"
                onClick={handleSave}
                disabled={!fields.displayName.trim() || busy}
              >
                {status === 'signing'
                  ? 'Sign with wallet…'
                  : status === 'submitting'
                    ? 'Saving…'
                    : connected
                      ? 'Sign & Save'
                      : 'Connect & Save'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-[12px] text-[#62666d]"
                onClick={() => {
                  setExpanded(false);
                  setErrorMsg('');
                  setStatus('idle');
                  setFields(current);
                }}
              >
                Cancel
              </Button>
              <p className="text-[11px] text-[#62666d] ml-auto">Requires wallet signature</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
