/**
 * Receipt-gated feedback rule (RFC §10.1): a rating counts only when the
 * consumer is the payer of the referenced transaction and the rated agent is
 * that transaction's payee. Applied at write (/api/feedback) and at every
 * feedback read, so rows written before the check existed can never reach a
 * score.
 */

export type FeedbackIneligibility =
  | 'tx_payee_unknown'
  | 'tx_not_paid_to_agent'
  | 'consumer_not_payer'
  | 'self_feedback';

export interface FeedbackTx {
  /** Payer of the transaction. */
  wallet_address: string;
  /** Payee of the transaction; null when the indexer could not extract it. */
  counterparty?: string | null;
}

/** Null when the rating is eligible; otherwise the reason it is not. */
export function feedbackIneligibility(
  tx: FeedbackTx,
  rating: { agentWallet: string; consumerWallet: string },
): FeedbackIneligibility | null {
  if (tx.counterparty == null) return 'tx_payee_unknown';
  if (rating.consumerWallet !== tx.wallet_address) return 'consumer_not_payer';
  if (tx.wallet_address === tx.counterparty) return 'self_feedback';
  if (tx.counterparty !== rating.agentWallet) return 'tx_not_paid_to_agent';
  return null;
}
