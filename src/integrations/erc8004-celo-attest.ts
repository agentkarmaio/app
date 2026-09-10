/**
 * Fee policy for AgentKarma's Celo attestation drip — the Celo counterpart to
 * `erc8004-celo-publish.ts`'s write path, holding the two questions a scheduled
 * run must answer before it signs anything: can this account still pay, and is
 * this particular write priced sanely?
 *
 * Deliberately smaller than the Stellar policy module. Celo's target gating
 * already lives in `scripts/celo-batch-feedback.ts` and works: the ≥70 score
 * floor excludes unresolvable metadata on its own, because a registration AK
 * cannot read scores far below 70 and is skipped for that reason. Porting the
 * Stellar gate types over would restate existing behaviour on a money path for
 * no behavioural gain.
 *
 * What Celo genuinely lacked was payment safety. Measured 2026-09-10: one
 * attestation costs ~0.0445 CELO, and the dedicated validator wallet held
 * 0.2596 CELO — about five writes before a scheduled drip would start failing
 * on the invisible side.
 */

import { createPublicClient, http, formatEther, parseEther } from 'viem';
import { celo } from 'viem/chains';

/**
 * CELO floor below which a run refuses to start.
 *
 * ~22 writes of runway at the measured 0.0445 CELO each, so at three writes a
 * day the alert fires with a week of warning rather than on the morning the
 * wallet empties. Necessary, not sufficient — {@link celoFeeCeilingWei} still
 * gates each transaction on its own estimate.
 */
export const MIN_CELO_BALANCE = 1;

/**
 * Hard ceiling on what a single attestation may cost, in CELO.
 *
 * Sized on the real number: 0.0445 CELO measured 2026-09-10 at a 202.5 gwei
 * gas price. Half a CELO is ~11× that — room for a genuine gas spike, while
 * still refusing anything an order of magnitude out of band.
 *
 * This is not hypothetical caution. The same class of gap on Stellar let a run
 * clear its balance floor and then get rejected by the network for a fee that
 * had moved ~360× since the previous write.
 */
export const MAX_FEE_CELO = 0.5;

/**
 * Effective per-transaction fee ceiling in wei: the policy cap, further limited
 * by the balance actually held.
 *
 * BigInt throughout — wei is exact, and the Stellar version had to be rewritten
 * once because subtracting in decimal units left float residue.
 */
export function celoFeeCeilingWei(balanceWei: bigint, maxFeeCelo = MAX_FEE_CELO): bigint {
  const cap = parseEther(String(maxFeeCelo));
  return balanceWei < cap ? balanceWei : cap;
}

export type CeloBalanceState = 'ok' | 'low';

export interface CeloFeeAccount {
  state: CeloBalanceState;
  celo: string;
  wei: bigint;
}

/**
 * Read the signer's CELO balance.
 *
 * Raises on an RPC failure rather than assuming health: not knowing the balance
 * is not the same as knowing it is fine. There is no "absent account" state on
 * an EVM chain — an unfunded address simply reads zero, which lands in `low`.
 */
export async function readCeloFeeAccount(
  address: `0x${string}`,
  opts: { rpcUrl?: string; minCelo?: number; getBalance?: (a: `0x${string}`) => Promise<bigint> } = {},
): Promise<CeloFeeAccount> {
  const getBalance =
    opts.getBalance ??
    ((a: `0x${string}`) =>
      createPublicClient({ chain: celo, transport: http(opts.rpcUrl ?? process.env.CELO_RPC_URL) })
        .getBalance({ address: a }));

  const wei = await getBalance(address);
  const floor = parseEther(String(opts.minCelo ?? MIN_CELO_BALANCE));
  return { state: wei >= floor ? 'ok' : 'low', celo: formatEther(wei), wei };
}
