/**
 * Pinned configuration for AgentKarma's Stellar 8004 client (D1: adopt
 * trionlabs/stellar-8004 LIVE mainnet contracts).
 *
 * Source of truth for contract addresses — never hardcode IDs elsewhere
 * (keeps an Appendix-A migration to AK-owned registries a config swap, not a
 * rewrite). Mirrors the address-centralization role of `erc8004-celo.ts`.
 *
 * Mainnet IDs verified 2026-06-06 against trionlabs/stellar-8004
 * webapp/packages/sdk/src/core/config.ts → MAINNET_CONFIG (deployVersion
 * 2026-04-11, deployLedger 62071546).
 */
import { Networks } from '@stellar/stellar-sdk';

// ─── Pinned mainnet contract IDs ────────────────────────────────────────────
export const STELLAR_IDENTITY_REGISTRY = 'CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35' as const;
export const STELLAR_REPUTATION_REGISTRY = 'CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA' as const;
export const STELLAR_VALIDATION_REGISTRY = 'CBT6WWEVEPT2UFGFGVJJ7ELYGLQAGRYSVGDTGMCJTRWXOH27MWUO7UJG' as const;

export const STELLAR_NETWORK_PASSPHRASE = Networks.PUBLIC;

/** USDC SAC on Stellar uses 7 decimals (also AK's feedback fixed-point scale). */
export const USDC_DECIMALS = 7;

// ─── WASM SHA256 pinning (Correction C4 — risk #1 supply-chain gate) ─────────
//
// trionlabs/stellar-8004 is a days-old single-org project. We pin the
// reproducible-build WASM hash of each registry so that an upgrade (Soroban
// contracts here ship a 3-day-timelocked `propose_upgrade`/`execute_upgrade`)
// becomes an explicit REVIEW GATE, not a silent dependency drift.
//
// Populate each hash via stellar-cli against the live network:
//
//   stellar contract info interface --network mainnet \
//     --id <CONTRACT_ID> --output json | jq -r '.hash'
//
// (equivalently `stellar contract info --id <C...> --output json` on older
// CLI builds). Record the SHA256 hex string of the on-chain WASM executable.
//
// OPERATIONAL TODO(U3-followup): stellar-cli is NOT available in the build
// environment that produced this slice (`which stellar` → not found), so the
// three hashes below are left EMPTY. assertPinnedWasm() treats an empty pin as
// "unset" — it logs and no-ops rather than failing the build. Run the command
// above on a machine with stellar-cli installed, paste the hashes here, and the
// guard activates automatically (mismatch → throw).
export const STELLAR_WASM_SHA256: Record<'identity' | 'reputation' | 'validation', string> = {
  // Verified 2026-06-06 against Stellar mainnet via `stellar contract fetch` +
  // sha256 — all three match trionlabs/stellar-8004's published reproducible-build
  // hashes byte-for-byte (deployed contracts == audited source). Re-verify on any
  // upstream upgrade (3-day timelock gives warning); a mismatch is a review gate.
  identity: 'f25af88f3e26f603a6569b2554b3f85ccc8af9a88f3b904fba873637c64eb2ab',
  reputation: '74af1a031934346260f7265dacb633209dba507c1416f1e37d52405b53478f71',
  validation: '9e5d7dc78ca00fc7c7afc914a0b3ecbcec61b4e7b1893a84bf47c3b811c68aa1',
};

const DEFAULT_MAINNET_RPC = 'https://mainnet.sorobanrpc.com';

/** Resolve the Soroban RPC URL: env override wins, else mainnet default. */
export function resolveStellarRpcUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.STELLAR_RPC_URL || DEFAULT_MAINNET_RPC;
}

export interface AssertPinnedWasmOpts {
  /** The pinned hash to compare against (defaults to STELLAR_WASM_SHA256[name]). */
  pinned?: string;
  /**
   * Fetch the live on-chain WASM SHA256 for this contract. Injected so the
   * guard is unit-testable without a live RPC / stellar-cli. Production wiring
   * (a script) supplies a real fetcher.
   */
  fetchLiveHash: (contract: 'identity' | 'reputation' | 'validation') => Promise<string>;
}

export interface AssertPinnedWasmResult {
  /** True when no pin was configured (empty) — guard skipped, logged. */
  skipped: boolean;
  /** True when a configured pin matched the live hash. */
  matched: boolean;
}

function normHash(h: string): string {
  return h.trim().toLowerCase();
}

/**
 * Verify a registry's on-chain WASM matches its pinned SHA256.
 *
 * - Empty pin (unset): no-op — does NOT fetch, does NOT throw. Logs loudly so
 *   the operator knows the supply-chain gate is inactive for that contract.
 * - Non-empty pin: fetches the live hash and THROWS on mismatch (review gate).
 *
 * Correction C4: the guard must exist and handle empty regardless of whether
 * stellar-cli was available when the hashes were pinned.
 */
export async function assertPinnedWasm(
  contract: 'identity' | 'reputation' | 'validation',
  opts: AssertPinnedWasmOpts,
): Promise<AssertPinnedWasmResult> {
  const pinned = normHash(opts.pinned ?? STELLAR_WASM_SHA256[contract]);

  if (pinned === '') {
    console.warn(
      `[stellar-config] WASM pin for "${contract}" is UNSET — supply-chain ` +
        `verification skipped. Populate STELLAR_WASM_SHA256.${contract} via ` +
        `\`stellar contract info\` to activate the review gate.`,
    );
    return { skipped: true, matched: false };
  }

  const live = normHash(await opts.fetchLiveHash(contract));
  if (live !== pinned) {
    throw new Error(
      `[stellar-config] WASM hash mismatch for "${contract}": pinned ${pinned} ` +
        `but live on-chain is ${live}. The contract was upgraded — re-verify ` +
        `the trionlabs/stellar-8004 reproducible build before trusting it, then ` +
        `update STELLAR_WASM_SHA256.${contract}.`,
    );
  }
  return { skipped: false, matched: true };
}
