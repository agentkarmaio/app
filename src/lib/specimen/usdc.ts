/**
 * USDC SPL transfer + memo builder used by the specimen consumer.
 *
 * Builds a single transaction that:
 *   - creates the recipient ATA if missing (idempotent)
 *   - transfers SPECIMEN_PRICE_USDC from sender to recipient (TransferChecked)
 *   - attaches a memo binding the transfer to a specific resource+nonce
 *
 * Splits across two instructions when needed; otherwise one transfer + one
 * memo. Returns the unsigned versioned tx; caller signs + sends.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { encodeMemo } from './protocol';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;

export interface BuildPaymentInput {
  connection: Connection;
  payer: Keypair;
  recipient: PublicKey;
  amountUsdc: number;
  resource: string;
  nonce: string;
  /** Optional explicit timestamp (for tests). Default: now. */
  timestamp?: number;
  /** Optional priority fee microLamports/CU. Default: 0. */
  priorityFeeMicros?: number;
}

export interface BuiltPayment {
  tx: VersionedTransaction;
  memo: string;
  amountRaw: bigint;
}

export async function buildUsdcPayment(input: BuildPaymentInput): Promise<BuiltPayment> {
  const {
    connection,
    payer,
    recipient,
    amountUsdc,
    resource,
    nonce,
    timestamp,
    priorityFeeMicros = 0,
  } = input;

  const amountRaw = BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS));
  const memo = encodeMemo({ resource, nonce, timestamp });

  const payerAta = getAssociatedTokenAddressSync(USDC_MINT, payer.publicKey);
  const recipientAta = getAssociatedTokenAddressSync(USDC_MINT, recipient);

  const ixs = [];

  if (priorityFeeMicros > 0) {
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicros }));
  }

  // Idempotent: succeeds whether ATA exists or not. Payer covers ~0.002 SOL rent on first run.
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      recipientAta,
      recipient,
      USDC_MINT,
    ),
  );

  ixs.push(
    createTransferCheckedInstruction(
      payerAta,
      USDC_MINT,
      recipientAta,
      payer.publicKey,
      amountRaw,
      USDC_DECIMALS,
    ),
  );

  ixs.push({
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, 'utf8'),
  });

  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  return { tx, memo, amountRaw };
}

export { USDC_MINT, USDC_DECIMALS, MEMO_PROGRAM_ID };
