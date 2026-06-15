/**
 * Succession declaration write-path — validate a plan, upsert the will, emit the
 * Tier-3 `will_declared` signal. Shared by the claim form (POST /api/agent/claim)
 * and the self-hosted manifest resolver (`agentkarma.json` "succession" field).
 *
 * AK only OBSERVES + scores; declaring a will is a metadata write, never a
 * custody or execution action (RFC §12 Non-Routing AND Non-Custody). The
 * `will_declared` signal is Tier 3 by construction (see scoring/signals.ts), so
 * declaring a will NEVER lifts the confidence badge off ⚪ on its own — heartbeat
 * (T2) or inheritance (T1) corroboration is required for 🟡/🟢.
 */

import type { Chain } from '@/db/schema';
import { upsertSuccession, insertSignalEvents, markWalletsDirty } from '@/db/client';
import { buildWillDeclaredSignal } from '@/scoring/signals';
import {
  validateSuccessionPlan,
  type SuccessionValidationResult,
} from './validate';

export interface DeclareSuccessionInput {
  agentWallet: string;
  chain: Chain;
  sourceType: 'claim_form' | 'self_hosted';
  /** Raw plan blob (from the claim form body or the manifest `succession` field). */
  plan: unknown;
  willHash?: string | null;
}

export type DeclareSuccessionResult =
  | { ok: true; intervalSeconds: number; heirCount: number }
  | { ok: false; error: string };

/**
 * Validate + persist a declared succession plan and emit the will_declared
 * signal. Returns a discriminated result; validation failures are returned
 * (never thrown) so HTTP callers can map them to 400s. DB errors propagate.
 */
export async function declareSuccession(
  input: DeclareSuccessionInput,
): Promise<DeclareSuccessionResult> {
  const validation: SuccessionValidationResult = validateSuccessionPlan(
    input.plan,
    input.chain,
    input.agentWallet,
  );
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const { intervalSeconds, heirs } = validation.plan;

  await upsertSuccession({
    agentWallet: input.agentWallet,
    chain: input.chain,
    sourceType: input.sourceType,
    intervalSeconds,
    heirs,
    willHash: input.willHash ?? null,
  });

  await insertSignalEvents(
    [
      {
        ...buildWillDeclaredSignal(input.agentWallet, {
          sourceType: input.sourceType,
          intervalSeconds,
          willHash: input.willHash ?? null,
        }),
        // Key the signal to the agent's real chain so the (chain, agent_wallet)
        // FK + dedup index resolve — never default to solana for EVM/Stellar.
        chain: input.chain,
      },
    ],
    { overwrite: true },
  );

  // Queue a rescore so the persisted score + leaderboard reflect the new
  // Tier-3 will_declared signal (the live v2 GET already recomputes with it).
  await markWalletsDirty([input.agentWallet]);

  return { ok: true, intervalSeconds, heirCount: heirs.length };
}
