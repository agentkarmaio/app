/**
 * Shared payment-gating logic — used by both the standalone Bun server and
 * the Next.js Route Handlers.
 *
 * Returns either a 402-with-PaymentRequirements or a 200-with-payload after
 * verifying the on-chain payment matches the request bound by headers.
 */

import { PublicKey } from '@solana/web3.js';

import {
  SPECIMEN_PROVIDER_ADDRESS,
  SPECIMEN_PRICE_USDC,
  SPECIMEN_PAYMENT_MAX_AGE_SEC,
} from '@/config/specimen';

import { HEADERS, makeNonce, type PaymentRequirements } from './protocol';
import { USDC_MINT } from './usdc';
import { verifyPayment } from './verify';
import { isRedeemed, markRedeemed } from './replay';

const PROVIDER = new PublicKey(SPECIMEN_PROVIDER_ADDRESS);

export interface GatedResponse {
  status: number;
  body: unknown;
  extraHeaders?: Record<string, string>;
}

export function buildRequirements(resource: string): PaymentRequirements {
  return {
    scheme: 'agentkarma-specimen',
    network: 'solana-mainnet',
    resource,
    nonce: makeNonce(),
    asset: USDC_MINT.toBase58(),
    recipient: PROVIDER.toBase58(),
    amount: SPECIMEN_PRICE_USDC,
    memo: `agentkarma-specimen:v1:${resource}:<nonce>:<unix_ts>`,
    expiresInSec: SPECIMEN_PAYMENT_MAX_AGE_SEC,
  };
}

interface GatedRequest {
  txSig: string | null;
  nonce: string | null;
  claimedResource: string | null;
}

export function readGatedHeaders(headers: { get(name: string): string | null }): GatedRequest {
  return {
    txSig:           headers.get(HEADERS.TX),
    nonce:           headers.get(HEADERS.NONCE),
    claimedResource: headers.get(HEADERS.RESOURCE),
  };
}

export async function handleGated(
  headers: { get(name: string): string | null },
  resource: string,
  payload: () => unknown,
): Promise<GatedResponse> {
  const { txSig, nonce, claimedResource } = readGatedHeaders(headers);

  if (!txSig || !nonce || !claimedResource) {
    return {
      status: 402,
      body: buildRequirements(resource),
      extraHeaders: { 'www-authenticate': 'x402 scheme="agentkarma-specimen"' },
    };
  }

  if (claimedResource !== resource) {
    return {
      status: 400,
      body: { error: 'resource_mismatch', message: `Header claims ${claimedResource}, this is ${resource}` },
    };
  }

  if (isRedeemed(txSig)) {
    return {
      status: 409,
      body: { error: 'replay', message: `Tx ${txSig.slice(0, 12)}… already redeemed` },
    };
  }

  const result = await verifyPayment({
    signature:           txSig,
    expectedRecipient:   PROVIDER,
    expectedAmountUsdc:  SPECIMEN_PRICE_USDC,
    expectedResource:    resource,
    expectedNonce:       nonce,
    maxAgeSec:           SPECIMEN_PAYMENT_MAX_AGE_SEC,
  });

  if (!result.ok) {
    const status = result.code === 'tx_not_found' ? 404 : 402;
    return { status, body: { error: result.code, message: result.message } };
  }

  markRedeemed(txSig);

  return {
    status: 200,
    body: {
      ok: true,
      resource,
      payment: {
        tx: txSig,
        payer: result.payerWallet,
        amountUsdc: result.amountUsdc,
        timestamp: result.txTimestamp,
      },
      payload: payload(),
    },
  };
}
