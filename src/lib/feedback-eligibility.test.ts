/// <reference types="bun-types" />
/**
 * Feedback is receipt-gated: only the payer of a transaction may rate the
 * payee of that transaction. Reproduces the hole where /api/feedback checked
 * the payer's signature but never that the tx paid the rated agent, so any
 * payer could rate any wallet with any of its own transactions.
 *
 * Run: bun test src/lib/feedback-eligibility.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { feedbackIneligibility } from './feedback-eligibility';

const PAYER = 'PAYER111';
const AGENT = 'AGENT111';
const tx = { wallet_address: PAYER, counterparty: AGENT };

describe('feedbackIneligibility', () => {
  test('payer rating the payee of its own tx is eligible', () => {
    expect(feedbackIneligibility(tx, { agentWallet: AGENT, consumerWallet: PAYER })).toBeNull();
  });

  test('rating a wallet the tx did not pay is rejected', () => {
    expect(feedbackIneligibility(tx, { agentWallet: 'SOMEONE_ELSE', consumerWallet: PAYER }))
      .toBe('tx_not_paid_to_agent');
  });

  test('a tx with no recorded payee cannot back feedback', () => {
    expect(feedbackIneligibility({ ...tx, counterparty: null }, { agentWallet: AGENT, consumerWallet: PAYER }))
      .toBe('tx_payee_unknown');
  });

  test('the rater must be the tx payer', () => {
    expect(feedbackIneligibility(tx, { agentWallet: AGENT, consumerWallet: 'NOT_THE_PAYER' }))
      .toBe('consumer_not_payer');
  });

  test('self-rating (payer pays itself) is rejected', () => {
    const self = { wallet_address: AGENT, counterparty: AGENT };
    expect(feedbackIneligibility(self, { agentWallet: AGENT, consumerWallet: AGENT }))
      .toBe('self_feedback');
  });
});
