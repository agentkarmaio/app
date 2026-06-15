/**
 * DeadMansSwitchBlock — the observe-only Succession + Bonding grid shared by the
 * Solana profile and the ERC-8004 chain profiles (Celo / Arc / Stellar).
 *
 * Extracted so the blocks render on EVERY chain, not just Solana. The loader
 * (`loadDeadMansSwitchBlocks`) runs chain-aware in the page above the per-chain
 * render branch; this component is purely presentational.
 *
 * DMS (Succession) ships with REAL liveness-derived data on all four chains.
 * Bonds run on is_demo data this round (founder decision — no on-chain deploy),
 * which the BondCard labels visibly. Either card may be null; this renders
 * nothing when both are absent.
 */
import { SuccessionCard } from '@/components/karma/succession-card';
import { BondCard, type BondBlock } from '@/components/karma/bond-card';
import type { SuccessionView } from '@/lib/succession-view';

export function DeadMansSwitchBlock({
  succession,
  bond,
}: {
  succession: SuccessionView | null;
  bond: BondBlock | null;
}) {
  if (!succession && !bond) return null;
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {succession && <SuccessionCard succession={succession} />}
      {bond && <BondCard bond={bond} />}
    </div>
  );
}
