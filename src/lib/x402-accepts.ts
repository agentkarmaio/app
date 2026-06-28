/**
 * Pure parser for an x402 `402 Payment Required` response body → the Celo
 * stablecoin payees it declares.
 *
 * The endpoint-driven payee self-seeder (scripts/celo-x402-discover-payees.ts)
 * probes each indexed Celo agent's declared service endpoints. A real x402
 * paywall answers an unpaid request with HTTP 402 and a JSON body of the shape
 * (x402 spec v1/v2, coinbase/x402):
 *
 *   {
 *     "x402Version": 1 | 2,
 *     "accepts": [
 *       { "scheme", "network", "asset", "payTo",
 *         "maxAmountRequired" | "amount", "maxTimeoutSeconds", "extra": {…} },
 *       …
 *     ]
 *   }
 *
 * This module is PURE (no IO) so the accept/reject decisions are unit-testable
 * without a live HTTP probe. The SSRF-guarded fetch lives in the runner script.
 *
 * Acceptance rules (a `payTo` is extracted only when ALL hold):
 *   1. `network` resolves to Celo mainnet — CAIP-2 `eip155:42220`, or one of the
 *      legacy string aliases (`celo`, `celo-mainnet`). Celo chainId = 42220.
 *   2. `asset` resolves to a known Celo x402 stablecoin — either the token
 *      CONTRACT ADDRESS (cross-checked against CELO_X402_TOKENS) or its SYMBOL
 *      (USDC / USDT / USDm). The x402 spec allows either form.
 *   3. `payTo` is a syntactically valid EVM address (0x + 40 hex).
 *
 * Anything else — 200s, non-Celo networks, unknown assets, malformed bodies —
 * yields zero extracted payees. We never guess.
 */

import { CELO_X402_TOKENS, type CeloX402Token } from '@/config/celo-x402';

/** Celo mainnet chainId. CAIP-2 network id is `eip155:42220`. */
export const CELO_CHAIN_ID = 42220;

/** Lowercased `network` strings accepted as "this is Celo mainnet". */
const CELO_NETWORK_ALIASES: ReadonlySet<string> = new Set([
  `eip155:${CELO_CHAIN_ID}`,
  'celo',
  'celo-mainnet',
  'celo-mainnet-beta',
]);

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A single payee extracted from one accepted x402 `accepts` entry. */
export interface ExtractedPayee {
  /** Lowercased EVM payee address (the `payTo`). */
  payTo: `0x${string}`;
  /** The Celo stablecoin the price is denominated in. */
  token: CeloX402Token;
  /** Raw `network` value from the accepts entry (for audit / persistence). */
  network: string;
  /** Raw `asset` value from the accepts entry (address or symbol). */
  asset: string;
}

/** True when `network` denotes Celo mainnet (CAIP-2 or a legacy alias). */
export function isCeloNetwork(network: unknown): boolean {
  return typeof network === 'string' && CELO_NETWORK_ALIASES.has(network.trim().toLowerCase());
}

/**
 * Resolve an x402 `asset` field to a known Celo stablecoin, or null. Accepts
 * the token contract address (the spec's canonical form) OR a bare symbol
 * (USDC / USDT / USDm — the legacy/loose form some servers emit).
 */
export function resolveCeloAsset(asset: unknown): CeloX402Token | null {
  if (typeof asset !== 'string') return null;
  const a = asset.trim();
  if (a === '') return null;
  if (EVM_ADDRESS.test(a)) {
    const lc = a.toLowerCase();
    return CELO_X402_TOKENS.find((t) => t.address.toLowerCase() === lc) ?? null;
  }
  // Symbol form — case-insensitive match against the known token symbols.
  const up = a.toUpperCase();
  return CELO_X402_TOKENS.find((t) => t.symbol.toUpperCase() === up) ?? null;
}

/** Shape of one entry in the x402 `accepts` array (all fields untrusted). */
interface AcceptsEntry {
  network?: unknown;
  asset?: unknown;
  payTo?: unknown;
  scheme?: unknown;
}

/**
 * Pure: extract every valid Celo-stablecoin payee from a parsed 402 response
 * body. Returns a de-duplicated list keyed by (payTo, token.address). A body
 * that is not an object, lacks an `accepts` array, or whose entries all fail
 * the acceptance rules yields `[]`.
 */
export function extractCeloPayees(body: unknown): ExtractedPayee[] {
  if (body === null || typeof body !== 'object') return [];
  const accepts = (body as { accepts?: unknown }).accepts;
  if (!Array.isArray(accepts)) return [];

  const out: ExtractedPayee[] = [];
  const seen = new Set<string>();

  for (const raw of accepts) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as AcceptsEntry;

    if (!isCeloNetwork(entry.network)) continue;
    const token = resolveCeloAsset(entry.asset);
    if (!token) continue;
    if (typeof entry.payTo !== 'string' || !EVM_ADDRESS.test(entry.payTo.trim())) continue;

    const payTo = entry.payTo.trim().toLowerCase() as `0x${string}`;
    const key = `${payTo}:${token.address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      payTo,
      token,
      network: String(entry.network).trim(),
      asset: String(entry.asset).trim(),
    });
  }

  return out;
}
