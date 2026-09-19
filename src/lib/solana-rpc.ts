/**
 * Solana read endpoints, in preference order.
 *
 * Two very different callers want the same list and the same preference: the
 * indexer (bulk signature + transaction reads) and the 8004 attestation reader
 * (one `getAccountInfo` per wallet). Both are plain reads any standard RPC can
 * serve, so both should prefer a free endpoint and treat metered credentials as
 * the fallback rather than the default.
 *
 * It lives in `lib/` rather than in `indexer/helius.ts` on purpose:
 * `src/integrations/attestation.ts` sits on the LIVE SCORE REQUEST PATH
 * (`karma-resolver`, `live-agent-score`, `/api/v2/score/[wallet]`), and
 * importing the indexer from there would pull facilitator config, pay.sh
 * fingerprinting and the rest of the ingest graph into every score request.
 *
 * `optionalEnv` semantics, never `??`: an unset CI secret expands to the EMPTY
 * STRING, which `??` accepts as configured. That exact defect caused the
 * 2026-06-23 floor outage and again the 2026-09-17 empty `SOLANA_RPC_URL`.
 */

import { heliusRpcUrls } from './helius-keys';

/** Public endpoint. Always last: no credential, heavily shared, but it answers. */
export const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

type Env = Record<string, string | undefined>;

/**
 * Every usable Solana read endpoint, preferred first:
 * `SOLANA_RPC_URL` (free/standard) → configured Helius endpoints → public.
 *
 * Deduped and blank-stripped, so the result is always non-empty and each entry
 * is worth trying exactly once.
 */
export function solanaReadRpcUrls(env: Env = process.env): string[] {
  const urls: string[] = [];
  const push = (value: string | undefined) => {
    const url = (value ?? '').trim();
    if (url && !urls.includes(url)) urls.push(url);
  };

  push(env.SOLANA_RPC_URL);
  for (const url of heliusRpcUrls(env)) push(url);
  push(DEFAULT_SOLANA_RPC);

  return urls;
}
