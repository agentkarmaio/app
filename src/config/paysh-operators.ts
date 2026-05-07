/**
 * pay.sh operator registry — fee-payer + recipient addresses for known
 * pay.sh-routed gateways. A transaction whose feePayer or any token-transfer
 * recipient lives in this set is a candidate for Tier 1 `paysh_routed`
 * classification (final classification also requires the multi-split + memo
 * fingerprint — see indexer/paysh-fingerprint.ts).
 *
 * Functional, frozen object. No class. Hand-curated for v1; the
 * `refresh-paysh-catalog.ts` script (Track A2) will add operators
 * automatically once it lands.
 */

export interface PayshOperator {
  /** Display label for UI / logs. */
  label: string;
  /** Recipient (provider) address — fee-split goes here. */
  recipient: string;
  /** Fee payer (operator's gas-sponsoring keypair). */
  feePayer: string;
  /** Settlement protocol. `mpp` for solana-foundation/* providers, `x402` for
   *  vanilla x402 routed through pay.sh, `hybrid` for operators that run both.
   */
  protocol: 'x402' | 'mpp' | 'hybrid';
}

export const PAYSH_OPERATORS = Object.freeze({
  'google-cloud-apis': {
    label: 'Google Cloud APIs (pay.sh / MPP)',
    recipient: 'Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP',
    feePayer:  'BcdwLA62UPEAvRn7AWauMUXKtYMXxdLzTPaSQg5tNaFc',
    protocol:  'mpp',
  },
  'paysponge': {
    label: 'paysponge (pay.sh / x402+MPP hybrid)',
    recipient: '7r4e5dwNS68MDaxbw7N8jbzHq7RCMBp9z6smHFH4NXWw',
    feePayer:  '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
    protocol:  'hybrid',
  },
} as const) satisfies Readonly<Record<string, PayshOperator>>;

export type PayshOperatorId = keyof typeof PAYSH_OPERATORS;

/** Flat set of every recipient + feePayer address known to belong to a
 *  pay.sh operator. Used for fast O(1) membership checks during fingerprinting. */
export const PAYSH_OPERATOR_ADDRESSES: ReadonlySet<string> = new Set(
  Object.values(PAYSH_OPERATORS).flatMap((o) => [o.recipient, o.feePayer]),
);

/** Reverse lookup: address → canonical operator id (or null). When both
 *  recipient and feePayer match different operators, the first hit wins —
 *  v1 has disjoint address sets so no collision. */
export function getPayshOperatorByAddress(address: string): {
  id: PayshOperatorId;
  operator: PayshOperator;
} | null {
  for (const [id, op] of Object.entries(PAYSH_OPERATORS) as [PayshOperatorId, PayshOperator][]) {
    if (op.recipient === address || op.feePayer === address) return { id, operator: op };
  }
  return null;
}
