/**
 * Chain-neutral policy shared by AgentKarma's attestation publishers.
 *
 * Only what genuinely must not diverge between chains lives here. The gates
 * themselves stay per-chain, because the agent shapes, fee units and failure
 * modes differ: Stellar prices in stroops with a base reserve and a send path
 * that can blackhole, Celo prices in wei and gets a receipt. Forcing those into
 * one abstraction would hide the differences that matter.
 */

/**
 * Minimum metadata-quality score AK will publish, on any chain.
 *
 * One definition because it IS one policy: the rubric (`scoring/celo-metadata`)
 * is chain-agnostic, so a 71 must mean the same thing on Celo and Stellar.
 * Below this, agents get silence rather than a low broadcast — an off-chain
 * hosting hiccup should not earn a permanent public mark.
 */
export const ATTEST_MIN_SCORE = 70;

/**
 * Raised when a transaction's fee exceeds what policy or the balance allows.
 *
 * A fee is only knowable after simulation, so this is the last gate before a
 * signature on every chain — which is why the shape is shared: callers branch
 * on `code`, never on message text, and the batch runners treat it as
 * "stop, the network is charging too much" rather than a per-agent error.
 *
 * Learned the hard way on 2026-09-10: a balance floor passed with 34.5 XLM
 * while the network wanted 53.89, so the run got rejected mid-batch instead of
 * refusing up front.
 */
export interface FeeCeilingError extends Error {
  code: 'fee_ceiling';
  /** Fee the network would charge, in the chain's smallest unit. */
  feeUnits: number | bigint;
  /** Ceiling that was exceeded, same unit. */
  ceilingUnits: number | bigint;
}

/** Build a tagged fee-ceiling error. `detail` should name both amounts in human units. */
export function feeCeilingError(
  detail: string,
  feeUnits: number | bigint,
  ceilingUnits: number | bigint,
): FeeCeilingError {
  return Object.assign(new Error(detail), {
    code: 'fee_ceiling' as const,
    feeUnits,
    ceilingUnits,
  });
}

/** Branch on the tagged code, never on message text. */
export function isFeeCeilingError(err: unknown): err is FeeCeilingError {
  return err instanceof Error && (err as Partial<FeeCeilingError>).code === 'fee_ceiling';
}
