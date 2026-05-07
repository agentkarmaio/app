/**
 * Provider-side payment verification — fetches the claimed payment tx from
 * Helius and confirms it satisfies the request bound by headers.
 *
 * Helius enhanced parsing is required (HELIUS_RPC_URL must contain api-key).
 * Replay protection is a separate layer — see `web/specimen/lib/replay.ts`.
 */

import type { PublicKey } from '@solana/web3.js';

import { decodeMemo } from './protocol';
import { USDC_MINT } from './usdc';

export interface VerifyInput {
  signature: string;
  expectedRecipient: PublicKey;
  expectedAmountUsdc: number;
  expectedResource: string;
  expectedNonce: string;
  /** Reject if tx is older than this (seconds). */
  maxAgeSec: number;
}

export interface VerifyOk {
  ok: true;
  payerWallet: string;
  amountUsdc: number;
  txTimestamp: number;
  memo: string;
}

export type VerifyFailCode =
  | 'helius_unconfigured'
  | 'helius_error'
  | 'tx_not_found'
  | 'tx_failed'
  | 'no_usdc_transfer'
  | 'wrong_recipient'
  | 'amount_too_low'
  | 'memo_missing'
  | 'memo_invalid'
  | 'memo_mismatch'
  | 'tx_too_old';

export interface VerifyFail {
  ok: false;
  code: VerifyFailCode;
  message: string;
}

export type VerifyResult = VerifyOk | VerifyFail;

interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
}

interface HeliusInstruction {
  programId: string;
  data?: string;
}

interface HeliusEnhancedTransaction {
  signature: string;
  timestamp: number;
  transactionError: unknown;
  tokenTransfers: HeliusTokenTransfer[];
  instructions: HeliusInstruction[];
}

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

function getHeliusApiKey(): string | null {
  const url = process.env.HELIUS_RPC_URL;
  if (!url) return null;
  const m = url.match(/api-key=([^&]+)/);
  return m?.[1] ?? null;
}

async function fetchHeliusTx(signature: string): Promise<HeliusEnhancedTransaction | null | 'error'> {
  const apiKey = getHeliusApiKey();
  if (!apiKey) return 'error';

  try {
    const res = await fetch(`https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [signature] }),
    });
    if (!res.ok) return 'error';
    const data = (await res.json()) as HeliusEnhancedTransaction[];
    return data[0] ?? null;
  } catch {
    return 'error';
  }
}

export async function verifyPayment(input: VerifyInput): Promise<VerifyResult> {
  const apiKey = getHeliusApiKey();
  if (!apiKey) {
    return { ok: false, code: 'helius_unconfigured', message: 'HELIUS_RPC_URL not set' };
  }

  const tx = await fetchHeliusTx(input.signature);
  if (tx === 'error') return { ok: false, code: 'helius_error', message: 'Helius fetch failed' };
  if (tx == null) return { ok: false, code: 'tx_not_found', message: `No tx for ${input.signature}` };
  if (tx.transactionError != null) return { ok: false, code: 'tx_failed', message: 'Tx execution failed' };

  const recipientStr = input.expectedRecipient.toBase58();
  const usdcXfers = tx.tokenTransfers.filter((t) => t.mint === USDC_MINT.toBase58());
  const matching = usdcXfers.find((t) => t.toUserAccount === recipientStr);

  if (!matching) {
    return {
      ok: false,
      code: usdcXfers.length > 0 ? 'wrong_recipient' : 'no_usdc_transfer',
      message: usdcXfers.length > 0
        ? `USDC transfer found but not to ${recipientStr}`
        : 'No USDC transfer in tx',
    };
  }

  if (matching.tokenAmount < input.expectedAmountUsdc) {
    return {
      ok: false,
      code: 'amount_too_low',
      message: `Got ${matching.tokenAmount} USDC, need ${input.expectedAmountUsdc}`,
    };
  }

  const memoIx = tx.instructions.find((ix) => ix.programId === MEMO_PROGRAM_ID);
  if (!memoIx?.data) return { ok: false, code: 'memo_missing', message: 'No memo instruction' };

  // Helius enhanced returns memo program data base58-encoded; decode then
  // parse as UTF-8. Falls back to UTF-8-direct in case API behaviour changes.
  const memoStr = decodeMemoData(memoIx.data);
  const memo = memoStr ? decodeMemo(memoStr) : null;
  if (!memo) return { ok: false, code: 'memo_invalid', message: `Bad memo format: ${memoIx.data}` };
  if (memo.resource !== input.expectedResource || memo.nonce !== input.expectedNonce) {
    return {
      ok: false,
      code: 'memo_mismatch',
      message: `Memo bound to (${memo.resource}, ${memo.nonce}); request claims (${input.expectedResource}, ${input.expectedNonce})`,
    };
  }

  const ageSec = Math.floor(Date.now() / 1000) - tx.timestamp;
  if (ageSec > input.maxAgeSec) {
    return { ok: false, code: 'tx_too_old', message: `Tx is ${ageSec}s old, max ${input.maxAgeSec}s` };
  }

  return {
    ok: true,
    payerWallet: matching.fromUserAccount,
    amountUsdc: matching.tokenAmount,
    txTimestamp: tx.timestamp,
    memo: memoStr ?? memoIx.data,
  };
}

const BS58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function bs58Decode(str: string): Uint8Array | null {
  const BASE = BigInt(58);
  const MASK = BigInt(0xff);
  const EIGHT = BigInt(8);
  const ZERO = BigInt(0);

  let num = ZERO;
  for (const ch of str) {
    const idx = BS58_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    num = num * BASE + BigInt(idx);
  }
  let leadingZeros = 0;
  for (const ch of str) {
    if (ch === '1') leadingZeros++;
    else break;
  }
  const bytes: number[] = [];
  while (num > ZERO) {
    bytes.unshift(Number(num & MASK));
    num = num >> EIGHT;
  }
  return Uint8Array.from([...new Array(leadingZeros).fill(0), ...bytes]);
}

function decodeMemoData(raw: string): string | null {
  if (raw.startsWith('agentkarma-specimen:')) return raw;
  const bytes = bs58Decode(raw);
  if (!bytes) return null;
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}
