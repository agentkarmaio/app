import { CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { supabase } from '@/db/client';
import VerifySelfClient from './client';

export const metadata = {
  title: 'Verify with Self — AgentKarma',
  description:
    "Anchor your wallet's Tier 3 Autonomy Confidence by completing Self Protocol's proof-of-human ZK passport scan. Sybil-resistant, privacy-preserving, no personal data revealed.",
};

// Always lowercase for DB lookup — the /verify endpoint stores addresses
// lowercased (matching what Self's userIdentifier returns). The displayed
// version with checksum casing comes from the verified-state component.
const AK_OWNER = '0xCfc0A11C75519FAf85B7872E27733CFaa4295b96';
const AK_OWNER_LC = AK_OWNER.toLowerCase();

// Force dynamic rendering — the page reads DB state per request to surface
// the anchored Self verification. Static prerender would fail at build time
// because Supabase env vars aren't present in the Docker builder stage.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function getAkAnchor() {
  const { data } = await supabase
    .from('wallets')
    .select('self_nullifier, self_verified_at, self_scope')
    .eq('chain', 'celo')
    .eq('address', AK_OWNER_LC)
    .maybeSingle();
  return data as
    | { self_nullifier: string | null; self_verified_at: string | null; self_scope: string | null }
    | null;
}

async function getAnchoredCount() {
  const { count } = await supabase
    .from('wallets')
    .select('address', { count: 'exact', head: true })
    .eq('chain', 'celo')
    .not('self_verified_at', 'is', null);
  return count ?? 0;
}

export default async function VerifySelfPage() {
  const [anchor, anchoredCount] = await Promise.all([getAkAnchor(), getAnchoredCount()]);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-16">
      <div className="mb-8 space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Verify with Self</h1>
        <p className="text-balance text-muted-foreground">
          Anchor your wallet&apos;s <strong>Tier 3 Autonomy Confidence</strong> by completing
          a Self Protocol proof-of-human ZK passport scan. The proof is generated on
          your phone; no passport data leaves the device. We store only a Sybil-resistance
          nullifier.
        </p>
      </div>

      {anchor?.self_verified_at && (
        <AkAnchorBanner
          anchor={anchor as { self_verified_at: string | null; self_scope: string | null }}
          anchoredCount={anchoredCount}
        />
      )}

      <VerifySelfClient />

      <p className="mt-6 text-center text-xs text-muted-foreground">
        {anchoredCount === 0
          ? 'Be the first wallet anchored against AgentKarma\'s scope.'
          : `${anchoredCount} wallet${anchoredCount === 1 ? '' : 's'} anchored against AgentKarma's scope so far.`}
      </p>
    </main>
  );
}

function AkAnchorBanner({
  anchor,
  anchoredCount,
}: {
  anchor: { self_verified_at: string | null; self_scope: string | null };
  anchoredCount: number;
}) {
  const verifiedAt = anchor.self_verified_at
    ? new Date(anchor.self_verified_at).toUTCString()
    : 'recently';
  return (
    <Card className="mb-6">
      <CardContent className="flex items-start gap-3 p-5">
        <CheckCircle2 className="size-5 shrink-0 text-emerald-400" />
        <div className="space-y-1">
          <p className="text-sm font-medium">
            AgentKarma is Self-verified ({anchoredCount} wallet
            {anchoredCount === 1 ? '' : 's'} anchored)
          </p>
          <p className="text-xs text-muted-foreground">
            Operator anchored {verifiedAt} · scope <span className="font-mono">{anchor.self_scope ?? 'agentkarma'}</span> · verifier
            Self Protocol IdentityVerificationHub on Celo mainnet
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
