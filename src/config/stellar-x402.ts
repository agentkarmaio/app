/**
 * Stellar x402 + MPP settlement-token registry and facilitator config.
 *
 * USDC on Stellar is a SEP-41 Soroban Asset Contract (SAC). AK indexes
 * `transfer` events emitted by the SAC contract (the `C...` address), NOT the
 * classic `G...` issuer. 7 decimals (not 6 like EVM USDC). SAC addresses are
 * verified against the OZ x402 `@x402/stellar` exported constants.
 *
 * x402 on Stellar settles via the OZ Channels facilitator, which fee-bumps and
 * submits the settlement transaction. That means the facilitator's `G...`
 * account is the `tx.source_account` of every settled x402 payment.
 */

export type StellarNetwork = 'pubnet' | 'testnet';

/** USDC SAC (Soroban Asset Contract) `C...` addresses. 7 decimals on both. */
export const USDC_SAC: Record<StellarNetwork, string> = {
  pubnet:  'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  testnet: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
};

/**
 * Circle's USDC *issuing* `G…` accounts — the classic-asset half of the same
 * asset the SAC above wraps.
 *
 * Needed because Horizon reports assets as `code` + `issuer`, not as a contract
 * id. Matching on `asset_code === 'USDC'` alone is spoofable: anyone can issue a
 * token coded `USDC`, and a bare-code filter would score a stranger's token as
 * Circle's. Every asset comparison MUST pin `CODE:ISSUER`.
 *
 * These are not independent constants — `Asset(code, issuer).contractId(network)`
 * derives the SAC — and `stellar-transfers.test.ts` asserts exactly that for both
 * networks, so a wrong issuer fails at test time instead of silently matching
 * nothing in production.
 */
export const USDC_ISSUER: Record<StellarNetwork, string> = {
  pubnet:  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
};

/** Stellar USDC base-unit precision. 1 USDC = 10^7 stroops-equivalent. */
export const STELLAR_USDC_DECIMALS = 7;

/**
 * Addresses that must NEVER enter the Stellar transfer indexer's seed set, even
 * though they legitimately appear in `wallets`.
 *
 * `wallets` is an open-membership table — a row can be minted by anything that
 * resolves an address, including a profile-page visit. Circle's USDC issuer is
 * in there today (score 0, Unrated, no registry row behind it), and a probe of
 * its first 200 operations returned 145 USDC operations: every issuance and
 * redemption of USDC on Stellar touches the issuing account.
 *
 * Left in the seed set it would pull a large share of Circle's issuance traffic
 * into `transactions` and record it as agent-to-agent payment reputation — the
 * firehose the seed set exists to prevent (see arc-transfers.ts, paused for
 * exactly this reason). It also means an unprivileged party could aim the
 * indexer at an arbitrary high-volume account just by causing a `wallets` row.
 *
 * Both entries are asset infrastructure, never a payment counterparty:
 * the issuing account (the mint) and the SAC (the token contract itself).
 */
export const STELLAR_SEED_EXCLUSIONS: ReadonlySet<string> = new Set<string>([
  USDC_ISSUER.pubnet,
  USDC_ISSUER.testnet,
  USDC_SAC.pubnet,
  USDC_SAC.testnet,
]);

/**
 * Extension point: partner agents to index that are not (yet) discoverable from
 * `erc8004_agents` or `wallets`.
 *
 * Add a `G…` account here to bring it into scope without touching indexer code.
 * Entries are shape-gated and exclusion-filtered like every other seed source,
 * so a typo drops out rather than widening the scan.
 */
export const STELLAR_SEED_EXTRA: readonly string[] = [];

/**
 * OZ Channels facilitator `G...` accounts (the `tx.source_account` of settled
 * x402 payments). EMPTY until discovered — see DISCOVERY below.
 *
 * ── DISCOVERY (blocked-on-external-data, spec §6.2) ──────────────────────────
 * The OZ Channels facilitator address is not published in any AK reference.
 * Discover it by observing one settled testnet x402 payment, then read its
 * source account:
 *
 *   1. Stand up the x402 testnet seller+buyer from
 *      ~/.claude/plugins/marketplaces/stellar-dev/skills/agentic-payments/SKILL.md
 *      (Part 1, "Testnet runbook"). Generate an OZ key at
 *      https://channels.openzeppelin.com/testnet/gen and run one paid request.
 *   2. The client logs / PAYMENT-RESPONSE header carries the settlement tx hash.
 *      Read its source account from Horizon:
 *
 *        curl -s "https://horizon-testnet.stellar.org/transactions/<TX_HASH>" \
 *          | jq -r '.source_account, .fee_account'
 *
 *      The facilitator account is `fee_account` (the fee-bump outer source).
 *      Confirm it is stable across several payments before trusting it.
 *   3. For PUBNET, repeat against the mainnet facilitator
 *      (https://channels.openzeppelin.com/x402, mainnet OZ key) and read
 *      `https://horizon.stellar.org/transactions/<TX_HASH>`.
 *   4. Add the discovered account(s) below, redeploy. The indexer is a no-op
 *      (returns 0 fetched) until at least one entry exists — identical policy
 *      to CELO_X402_FACILITATORS in src/config/celo-x402.ts.
 *
 * TODO(stellar-facilitators): seed after running the probe above. Do NOT guess.
 */
export interface StellarFacilitator {
  /** Classic `G...` account that fee-bumps + submits x402 settlements. */
  account: string;
  /** Display name. */
  name: string;
  /** When AK first observed this facilitator. ISO date. */
  discoveredAt: string;
}

export const STELLAR_FACILITATORS: StellarFacilitator[] = [];

/** O(1) membership set over facilitator accounts. */
export const STELLAR_FACILITATOR_SET: ReadonlySet<string> = new Set(
  STELLAR_FACILITATORS.map((f) => f.account),
);

/**
 * Curated MPP Charge / Channel recipient `G...` accounts (provider settlement
 * targets). EMPTY until seeded from pay.sh registry inspection (spec §6.6).
 * Mirrors MPP_OPERATOR_ADDRESSES on the Solana path.
 *
 * TODO(stellar-mpp-recipients): seed from pay.sh provider inspection.
 */
export const STELLAR_MPP_RECIPIENTS: ReadonlySet<string> = new Set<string>([]);

// ─── Address shape gates ──────────────────────────────────────────────────────
// StrKey: G... accounts and C... contracts are both 56 chars, base32 (A-Z, 2-7).
// Cheap shape gate; full validation uses StrKey.isValidEd25519PublicKey /
// StrKey.isValidContract in the SDK-backed adapter (U1/U3).
export const STELLAR_G_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
export const STELLAR_C_ADDRESS_RE = /^C[A-Z2-7]{55}$/;

export function isStellarAccount(address: string): boolean {
  return STELLAR_G_ADDRESS_RE.test(address);
}

export function isStellarContract(address: string): boolean {
  return STELLAR_C_ADDRESS_RE.test(address);
}

export function getStellarUsdcSac(network: StellarNetwork): string {
  return USDC_SAC[network];
}
