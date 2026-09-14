/**
 * Arc facilitator addresses, in a module with no server-only imports so both
 * the indexer and client-rendered components can name them.
 *
 * These mirror the constants the Arc indexers write into
 * `transactions.facilitator`. They are duplicated here rather than imported
 * from `@/indexer/*` because those modules pull the RPC clients in with them,
 * which must never reach a client bundle. The values are contract addresses:
 * they change only if Arc redeploys, and `arc-facilitators.test.ts` fails the
 * build if either drifts from its indexer source of truth.
 */

/** Native USDC on Arc — the sentinel `arc-transfers.ts` writes for a plain
 *  transfer that went through no facilitator. */
export const ARC_USDC_CONTRACT = '0x3600000000000000000000000000000000000000';

/** ERC-8183 job escrow contract — a real router, not a sentinel. */
export const ARC_ESCROW_FACILITATOR = '0x0747EEf0706327138c69792bF28Cd525089e4583';
