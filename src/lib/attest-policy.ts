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

/**
 * How a finished attestation batch should be reported.
 *
 * `blocked` is the case the alerting got wrong: a gate refused BEFORE signing,
 * so nothing was sent and nothing can be half-landed. On 2026-09-13 Soroban
 * priced `give_feedback` at 53.89 XLM against a 1 XLM ceiling, and the daily
 * job paged for weeks over a network price nobody could act on — while telling
 * the reader to go check Horizon for a submission that provably never existed.
 *
 * Only `failed` — a write that was sent and did not confirm — earns a page.
 * A real failure outranks a blocked one: the unconfirmed write needs the human.
 */
export type AttestRunVerdict = 'ok' | 'blocked' | 'failed';

export function attestRunVerdict(counts: {
  failed: number;
  blocked: number;
}): AttestRunVerdict {
  if (counts.failed > 0) return 'failed';
  if (counts.blocked > 0) return 'blocked';
  return 'ok';
}

/**
 * Prefix that makes a line a GitHub Actions annotation. A blocked run exits 0,
 * so without this it is a green run with the reason buried in the log — which
 * is how a silent stall hides. Empty outside CI, where it is just noise.
 */
export function ciWarningPrefix(): string {
  return process.env.GITHUB_ACTIONS === 'true' ? '::warning::' : '';
}
