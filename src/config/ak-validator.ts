/**
 * AgentKarma's disclosed ERC-8004 validator identity on Celo — single source of
 * truth for the publish path, the `/.well-known/agent.json` declaration, and the
 * public `/validator` disclosure page.
 *
 * Transparency, by design: AK acts as an *openly attributed* metadata-quality
 * oracle. Its attestations are signed by AK-controlled wallets and disclosed
 * here — they are NOT presented as independent third-party reviews. Independent
 * feedback comes from real connected wallets via the give-feedback UX on each
 * agent profile (a distinct, un-prefixed scheme). Conflating the two — e.g.
 * spreading AK's own attestations across throwaway wallets to fake rater
 * diversity — would poison the very Sybil/diversity signal AK publishes, so we
 * don't.
 */

export const AK_VALIDATOR = {
  chain: 'celo',
  /** Treasury/controller wallet — owns AK's ERC-8004 identity (agentId 9058). */
  controller: '0xCfc0A11C75519FAf85B7872E27733CFaa4295b96',
  /** Dedicated validator wallet — signs metadata-quality attestations only. */
  validator: '0xf9c63815A7396a45676cD6260856A10df66B2F0d',
  agentId: 9058,
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  /** AK's algorithmic attestation scheme. Human reviews use `agentkarma_review`.
   *  tag2 is the metadata-rubric version (see src/scoring/celo-metadata.ts).
   *  Bumped to v0.2 for the deepened deterministic rubric; the 26 pre-existing
   *  on-chain attestations remain v0.1 (AK skips already-rated agents, so they
   *  are never rewritten — the version on chain is honest about which rubric ran). */
  scheme: { tag1: 'agentkarma_metadata', tag2: 'v0.2' },
  keyfile: '.keys/agentkarma-celo-validator.json',
} as const;

/**
 * AK's disclosed identity on Stellar (stellar-8004 mainnet). Same transparency
 * contract as AK_VALIDATOR above; one account plays both controller and
 * validator roles until write volume justifies splitting them (Celo precedent).
 * Registry contract IDs stay in src/integrations/stellar-config.ts — importing
 * them here would pull @stellar/stellar-sdk into every ak-validator consumer.
 */
export const AK_STELLAR = {
  chain: 'stellar',
  /** AK's Stellar account — owner of AK's stellar-8004 identity, signs metadata attestations. */
  account: 'GA6OBKNSBCY2I4PQLGNNQQXRXWXRUBRLSKLM7YP7QBBSRW7LCZFLHODV',
  /** Registered 2026-08-04 via scripts/register-stellar-identity.ts
   *  (tx 8f7dff2562cc2affa50b67b9086cde83e60520f899d9549bdc357848b4fa31ae, ledger 63793223). */
  agentId: 66 as number | null,
  /** Same rubric + version as Celo — the scheme is chain-agnostic by design. */
  scheme: AK_VALIDATOR.scheme,
  keyfile: '.keys/agentkarma-stellar.json',
} as const;

/** Every address AK may sign attestations from — used to dedup AK's own ratings. */
export const AK_RATER_ADDRESSES: readonly string[] = [
  AK_VALIDATOR.controller.toLowerCase(),
  AK_VALIDATOR.validator.toLowerCase(),
];

/** AK's algorithmic metadata-quality scheme tag (= AK_VALIDATOR.scheme.tag1). */
export const AK_METADATA_TAG1 = AK_VALIDATOR.scheme.tag1;

/**
 * AK's independent human-review scheme tag — feedback published through AK's
 * give-feedback UX by any connected wallet, distinct from AK's own algorithmic
 * attestations above. Single source of truth; re-exported as REVIEW_TAG1 by
 * lib/evm-feedback (the write path) so the value can't drift across modules.
 */
export const AK_REVIEW_TAG1 = 'agentkarma_review';

export function isAkRater(address: string): boolean {
  return AK_RATER_ADDRESSES.includes(address.toLowerCase());
}

export const celoscanAddress = (a: string) => `https://celoscan.io/address/${a}`;
export const celoscanTx = (h: string) => `https://celoscan.io/tx/${h}`;
