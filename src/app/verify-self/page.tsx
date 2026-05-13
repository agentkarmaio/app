import VerifySelfClient from './client';

export const metadata = {
  title: 'Verify with Self — AgentKarma',
  description:
    "Anchor your wallet's Tier 3 Autonomy Confidence by completing Self Protocol's proof-of-human ZK passport scan. Sybil-resistant, privacy-preserving, no personal data revealed.",
};

export default function VerifySelfPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-16">
      <div className="mb-8 space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Verify with Self</h1>
        <p className="text-balance text-muted-foreground">
          Anchor your wallet&apos;s <strong>Tier 3 Autonomy Confidence</strong> by completing a
          Self Protocol proof-of-human ZK passport scan. The proof is generated on your phone;
          no passport data leaves your device. We store only a Sybil-resistance nullifier.
        </p>
      </div>
      <VerifySelfClient />
    </main>
  );
}
