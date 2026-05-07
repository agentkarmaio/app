/**
 * pay.sh-routed transaction fingerprint detector.
 *
 * Per docs/SIGNAL-ARCHITECTURE.md §"pay.sh and operator-attested settlement",
 * a transaction is high-confidence pay.sh-routed when ALL FOUR conditions hold:
 *
 *   1. SPL Token (Tokenkeg…) **or** Token-2022 (TokenzQd…) `transfer`
 *      instructions split into ≥2 parts under one signer.
 *   2. A separate Memo program (MemoSq…) instruction carrying the literal
 *      strings `Operator fee` and/or `Platform fee`.
 *   3. feePayer ≠ first signer (sponsored gas via fee delegation).
 *   4. Recipient or feePayer matches a known pay.sh operator address.
 *
 * Three of four = Tier 2 fallback (the existing x402 behavioral path already
 * emits that signal, so we simply do not classify it as Tier 1 here).
 *
 * Pure function. No I/O. Easy to unit-test against captured fixtures.
 */

import type { HeliusEnhancedTransaction } from './helius';
import {
  PAYSH_OPERATOR_ADDRESSES,
  getPayshOperatorByAddress,
  type PayshOperator,
} from '../config/paysh-operators';

// ─── Program addresses ───────────────────────────────────────────────────────

export const SPL_TOKEN_PROGRAM    = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM   = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const MEMO_PROGRAM         = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MEMO_PROGRAM_LEGACY  = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

const OPERATOR_FEE_LITERAL = 'Operator fee';
const PLATFORM_FEE_LITERAL = 'Platform fee';

// ─── Types — relaxed view of Helius `instructions` shape ────────────────────
//
// Helius' Enhanced Transactions API returns top-level + inner instructions
// alongside the typed `tokenTransfers` array. The instruction objects expose
// the program id and decoded data string (for memo / unparsed programs). We
// keep the shape narrow: only the fields we read for fingerprinting.

interface HeliusInstruction {
  programId: string;
  accounts?: string[];
  data?: string;
  /** Decoded UTF-8 view of `data` for Memo program invocations. */
  parsed?: { type?: string; info?: unknown } | null;
  innerInstructions?: HeliusInstruction[];
}

/** Helius enhanced parser puts inner ixs alongside top-level ixs. We accept
 *  either (top-level array + an `innerInstructions` array, or both nested) —
 *  the detector flattens before scanning. */
interface ParsedTxWithInstructions extends HeliusEnhancedTransaction {
  instructions?: HeliusInstruction[];
  innerInstructions?: Array<{ index?: number; instructions: HeliusInstruction[] }>;
  signers?: string[];
  signer?: string;
}

// ─── Result shape ────────────────────────────────────────────────────────────

export interface PayshDetectionResult {
  isPaysh: boolean;
  operator?: string;
  operatorId?: string;
  protocol?: 'x402' | 'mpp' | 'hybrid';
  /** Bag of which conditions passed — useful for logs + diagnosing near-miss. */
  conditions: {
    multiSplitTransfer: boolean;
    feeMemo: boolean;
    sponsoredGas: boolean;
    knownOperator: boolean;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function flattenInstructions(tx: ParsedTxWithInstructions): HeliusInstruction[] {
  const out: HeliusInstruction[] = [];
  if (Array.isArray(tx.instructions)) {
    for (const ix of tx.instructions) {
      out.push(ix);
      if (Array.isArray(ix.innerInstructions)) {
        for (const inner of ix.innerInstructions) out.push(inner);
      }
    }
  }
  if (Array.isArray(tx.innerInstructions)) {
    for (const group of tx.innerInstructions) {
      if (Array.isArray(group.instructions)) {
        for (const ix of group.instructions) out.push(ix);
      }
    }
  }
  return out;
}

/** Decode the memo data field. Helius emits memo `data` as the raw memo string
 *  (or sometimes base58-encoded — try both). Returns the string or null. */
function decodeMemo(ix: HeliusInstruction): string | null {
  // Some Helius responses surface memo content under parsed.info or data
  if (ix.parsed && typeof ix.parsed === 'object') {
    const parsed = ix.parsed as { info?: unknown };
    if (typeof parsed.info === 'string') return parsed.info;
  }
  if (typeof ix.data === 'string' && ix.data.length > 0) {
    // The memo program payload is UTF-8. Some responses give the literal
    // string already; others base58-encode it. We try the raw string first
    // because that's the common Helius case for memos.
    return ix.data;
  }
  return null;
}

function isTokenProgram(programId: string): boolean {
  return programId === SPL_TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM;
}

function isMemoProgram(programId: string): boolean {
  return programId === MEMO_PROGRAM || programId === MEMO_PROGRAM_LEGACY;
}

function getFirstSigner(tx: ParsedTxWithInstructions): string | null {
  if (typeof tx.signer === 'string' && tx.signer.length > 0) return tx.signer;
  if (Array.isArray(tx.signers) && tx.signers.length > 0) return tx.signers[0];
  return null;
}

// ─── Condition checks ────────────────────────────────────────────────────────

/** Condition 1: ≥2 token-program transfer instructions sharing the same source
 *  authority — i.e. one signer splits a single payment across multiple
 *  recipients in one tx. */
function hasMultiSplitTransfer(tx: ParsedTxWithInstructions): boolean {
  // tokenTransfers is the typed view from Helius — count distinct token
  // transfers grouped by `fromUserAccount`. A multi-split has 2+ entries
  // from the same source.
  const transfers = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
  if (transfers.length < 2) return false;

  const bySource = new Map<string, number>();
  for (const t of transfers) {
    const src = t.fromUserAccount;
    if (!src) continue;
    bySource.set(src, (bySource.get(src) ?? 0) + 1);
  }
  for (const count of bySource.values()) {
    if (count >= 2) return true;
  }

  // Fallback: scan raw token-program instructions if tokenTransfers is
  // empty/unstructured for Token-2022 (Helius typed view sometimes omits
  // them when extensions are involved).
  const ixs = flattenInstructions(tx);
  let tokenIxCount = 0;
  for (const ix of ixs) {
    if (isTokenProgram(ix.programId)) tokenIxCount += 1;
    if (tokenIxCount >= 2) return true;
  }
  return false;
}

/** Condition 2: Memo program ix carrying `Operator fee` and/or `Platform fee`. */
function hasFeeMemo(tx: ParsedTxWithInstructions): boolean {
  const ixs = flattenInstructions(tx);
  for (const ix of ixs) {
    if (!isMemoProgram(ix.programId)) continue;
    const memo = decodeMemo(ix);
    if (!memo) continue;
    if (memo.includes(OPERATOR_FEE_LITERAL) || memo.includes(PLATFORM_FEE_LITERAL)) {
      return true;
    }
  }
  return false;
}

/** Condition 3: feePayer ≠ first signer (sponsored gas). */
function hasSponsoredGas(tx: ParsedTxWithInstructions): boolean {
  const fp = tx.feePayer;
  if (!fp) return false;
  const firstSigner = getFirstSigner(tx);
  if (!firstSigner) {
    // No explicit signer list; fall back to nativeTransfers — the first
    // SOL-paying account in a sponsored-fee tx is the operator, not the user.
    // Without a signer view we can't verify this; return false (conservative).
    return false;
  }
  return fp !== firstSigner;
}

/** Condition 4: recipient or feePayer matches a known pay.sh operator. */
function findOperatorMatch(
  tx: ParsedTxWithInstructions,
): { address: string; operator: PayshOperator; id: string } | null {
  // FeePayer hit — the strongest match (operator's own keypair signed the tx).
  if (tx.feePayer && PAYSH_OPERATOR_ADDRESSES.has(tx.feePayer)) {
    const hit = getPayshOperatorByAddress(tx.feePayer);
    if (hit) return { address: tx.feePayer, operator: hit.operator, id: hit.id };
  }
  // Recipient hit — any token transfer landing at a known operator address.
  const transfers = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
  for (const t of transfers) {
    const dst = t.toUserAccount;
    if (dst && PAYSH_OPERATOR_ADDRESSES.has(dst)) {
      const hit = getPayshOperatorByAddress(dst);
      if (hit) return { address: dst, operator: hit.operator, id: hit.id };
    }
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify a parsed Helius transaction as pay.sh-routed or not.
 *
 * Returns `isPaysh: true` only when ALL FOUR conditions hold. Three of four
 * is intentionally NOT promoted to Tier 1 — the existing x402 behavioral
 * (Tier 2) signal already covers that case.
 */
export function detectPayshRouted(
  tx: HeliusEnhancedTransaction,
): PayshDetectionResult {
  const t = tx as ParsedTxWithInstructions;

  const knownMatch = findOperatorMatch(t);
  const conditions = {
    multiSplitTransfer: hasMultiSplitTransfer(t),
    feeMemo:            hasFeeMemo(t),
    sponsoredGas:       hasSponsoredGas(t),
    knownOperator:      knownMatch !== null,
  };

  const isPaysh =
    conditions.multiSplitTransfer &&
    conditions.feeMemo &&
    conditions.sponsoredGas &&
    conditions.knownOperator;

  if (!isPaysh) return { isPaysh: false, conditions };

  return {
    isPaysh: true,
    operator: knownMatch!.address,
    operatorId: knownMatch!.id,
    protocol: knownMatch!.operator.protocol,
    conditions,
  };
}
