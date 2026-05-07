/**
 * x402-compatible payment protocol for the AgentKarma specimen agent.
 *
 * The wire format is a USDC SPL transfer (consumer → provider) with a memo
 * that binds the payment to a specific request:
 *
 *   memo := "agentkarma-specimen:v1:<resource>:<nonce>:<unix_ts>"
 *
 * Headers on the second request (after payment landed):
 *
 *   X-Payment-Tx: <base58 signature>
 *   X-Payment-Nonce: <nonce>
 *   X-Payment-Resource: <resource>
 *
 * Server verifies on-chain that:
 *   1. signature exists and tx succeeded
 *   2. ≥ SPECIMEN_PRICE_USDC was transferred from consumer ATA → provider ATA
 *   3. memo matches the resource+nonce in the headers
 *   4. tx is recent (within SPECIMEN_PAYMENT_MAX_AGE_SEC)
 *   5. signature has not already been redeemed (replay guard)
 */

export const PROTOCOL_VERSION = 'v1';
export const PROTOCOL_PREFIX = 'agentkarma-specimen';

export const HEADERS = {
  TX:       'x-payment-tx',
  NONCE:    'x-payment-nonce',
  RESOURCE: 'x-payment-resource',
} as const;

export interface PaymentMemo {
  prefix: typeof PROTOCOL_PREFIX;
  version: string;
  resource: string;
  nonce: string;
  timestamp: number;
}

export function encodeMemo(input: { resource: string; nonce: string; timestamp?: number }): string {
  const ts = input.timestamp ?? Math.floor(Date.now() / 1000);
  return `${PROTOCOL_PREFIX}:${PROTOCOL_VERSION}:${input.resource}:${input.nonce}:${ts}`;
}

export function decodeMemo(raw: string): PaymentMemo | null {
  const parts = raw.split(':');
  if (parts.length !== 5) return null;
  const [prefix, version, resource, nonce, tsStr] = parts;
  if (prefix !== PROTOCOL_PREFIX || version !== PROTOCOL_VERSION) return null;
  const timestamp = Number(tsStr);
  if (!Number.isFinite(timestamp)) return null;
  return { prefix: PROTOCOL_PREFIX, version, resource, nonce, timestamp };
}

/** Random URL-safe nonce, ~16 chars. */
export function makeNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export interface PaymentRequirements {
  scheme: 'agentkarma-specimen';
  network: 'solana-mainnet';
  resource: string;
  nonce: string;
  asset: string;          // USDC mint
  recipient: string;      // provider wallet
  amount: number;         // USDC, human units
  memo: string;
  expiresInSec: number;
}
