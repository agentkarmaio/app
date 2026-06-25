/**
 * Client-side re-verification of a stored claim proof.
 *
 * Claiming is a signature, not an on-chain tx (see the claim routes): the
 * keyholder signs `AgentKarma: Claim wallet {address} at {ts}` and the server
 * verifies it before persisting. A stored proof is therefore always valid — this
 * re-check is a TRANSPARENCY convenience, letting a visitor confirm the signature
 * in their own browser instead of trusting the "Claimed" badge. NOT a security gate.
 *
 * Delegates to the canonical, isomorphic verifier (lib/claim-verify) shared with
 * the claim + prove routes, so client and server can never disagree. The heavy
 * crypto is dynamically imported — it loads only when the visitor clicks "Verify",
 * never weighing down the agent page's initial bundle.
 */
import type { Chain } from '@/db/schema';

export type ClaimProofChain = Extract<Chain, 'solana' | 'stellar' | 'celo' | 'arc'>;

export async function verifyClaimProof(params: {
  chain: ClaimProofChain;
  address: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  try {
    const { verifyClaimSignature } = await import('@/lib/claim-verify');
    return await verifyClaimSignature(params.chain, params.address, params.message, params.signature);
  } catch {
    return false;
  }
}
