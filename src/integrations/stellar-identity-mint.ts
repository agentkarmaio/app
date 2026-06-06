/**
 * stellar-8004 Identity registration — PREVIEW (simulate) ONLY.
 *
 * register_with_uri(caller, agentURI) → agentId mints the agent's 8004 identity
 * on the trionlabs/stellar-8004 Identity Registry so U3's publishAttestation has
 * a registered agentId to target (give_feedback reverts without one, spec §2).
 *
 * ⚠️ AUTH MODEL (verified against identity-registry/src/contract.rs):
 * register_with_uri calls `caller.require_auth()` and makes `caller` BOTH the
 * owner AND the agentWallet of the new agentId. So the AGENT must sign its own
 * register — the caller's authorization is mandatory.
 *
 * AK CANNOT mint this for the agent:
 *   - If AK passes caller = agent's G-address but signs/sources the tx with AK's
 *     validator key, the agent's `require_auth()` is unsatisfied → the tx FAILS
 *     on execute (simulate may mask it, which is exactly the trap this module
 *     used to fall into — see the removed execute path below).
 *   - If AK instead passes caller = AK's own key, the mint succeeds but binds
 *     agentWallet to AK, breaking spec §3 (payee == agentWallet). Not acceptable.
 *
 * CORRECT DESIGN (on-chain-write milestone, STOP-and-confirm before mainnet):
 * the agent signs register_with_uri CLIENT-SIDE via Freighter (the same wallet
 * that signed the claim challenge). The browser builds the tx with the agent's
 * G-address as caller+source, Freighter `signTransaction` authorizes it, and the
 * server (or the browser) submits it. Only then does an agentId exist; persist it
 * via setStellarAgentId. TODO(U4-onchain): implement that agent-signed flow.
 *
 * Until that lands, this module exposes ONLY a simulate/preview helper. There is
 * deliberately NO AK-signed execute path — it would silent-fail or violate the
 * spec. `mode: 'execute'` is hard-guarded to throw so it can never be invoked
 * against mainnet by accident.
 *
 * DI for testability (AK rule: no live network in unit tests). The Soroban RPC
 * server and the source keypair are INJECTED via `opts.server` / `opts.keypair`.
 * Tests inject a mocked rpc.Server and assert the simulate-only path decodes the
 * agentId — they never sign or send.
 *
 * v1 supports only G… Ed25519 wallets. C… Soroban contract addresses
 * (smart wallets) authenticate via __check_auth, not raw Ed25519, and are
 * rejected before any RPC call (fail-closed).
 */
import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Address,
  nativeToScVal,
  scValToNative,
  StrKey,
  Keypair,
  type xdr,
} from '@stellar/stellar-sdk';
import {
  STELLAR_IDENTITY_REGISTRY,
  STELLAR_NETWORK_PASSPHRASE,
  resolveStellarRpcUrl,
} from './stellar-config';
import { loadStellarKeypair } from './erc8004-stellar-publish';
import { isStellarAddress } from '@/lib/stellar-verify';

const AK_BASE_URL = 'https://agentkarma.io';

/** The agent's public AgentKarma profile, used as the 8004 agentURI. */
export function buildAgentUri(agentWalletAddress: string): string {
  return `${AK_BASE_URL}/agent/${agentWalletAddress}`;
}

/**
 * register_with_uri(operator: Address, agentURI: String) → agentId u32.
 * Operator is the agent's own G… wallet; agentURI is its AK profile.
 */
export function buildRegisterArgs(agentWalletAddress: string): xdr.ScVal[] {
  return [
    Address.fromString(agentWalletAddress).toScVal(),
    nativeToScVal(buildAgentUri(agentWalletAddress), { type: 'string' }),
  ];
}

export interface MintResult {
  dryRun: boolean;
  agentId: number | null;
  txHash?: string;
}

export interface MintOpts {
  /**
   * 'simulate' (default — no write, fail-closed) is the ONLY supported mode.
   * 'execute' is hard-guarded to throw: an AK-signed register_with_uri would
   * silent-fail (agent auth missing) or bind agentWallet to AK (spec §3). The
   * real mint is the agent-signed client-side flow (see module docblock).
   */
  mode?: 'simulate' | 'execute';
  /** Injected Soroban RPC server (tests mock this; prod resolves the mainnet RPC). */
  server?: rpc.Server;
  /** Injected source signer for the SIMULATE source account only (no signing). */
  keypair?: Keypair;
}

/**
 * PREVIEW the agent's stellar-8004 identity registration (simulate only).
 *
 * Rejects C… / non-G… addresses before touching the network, then simulates
 * register_with_uri and decodes the agentId the call WOULD return. It NEVER
 * signs or sends — there is no AK-signed execute path (see module docblock for
 * why; `mode: 'execute'` throws). Raises on any simulate error — no silent
 * fallback (AK core rule).
 *
 * The returned agentId is a preview of what an agent-signed register would mint;
 * it is NOT persisted and NOT a confirmation that any identity exists on-chain.
 */
export async function mintStellarAgentIdentity(
  agentWalletAddress: string,
  opts: MintOpts = {},
): Promise<MintResult> {
  if (StrKey.isValidContract(agentWalletAddress) || !isStellarAddress(agentWalletAddress)) {
    throw new Error(
      'Only G… Ed25519 addresses are supported in v1 (smart wallets excluded).',
    );
  }
  if (!STELLAR_IDENTITY_REGISTRY) throw new Error('Missing STELLAR_IDENTITY_REGISTRY');

  const mode = opts.mode ?? 'simulate';
  if (mode === 'execute') {
    // Hard guard: never run an AK-signed register_with_uri. It would silent-fail
    // (the agent's require_auth is unsatisfied) or, with caller=AK, bind
    // agentWallet to AK and break spec §3. The correct mint is agent-signed and
    // client-side — TODO(U4-onchain) in the module docblock. Fail loudly rather
    // than write garbage to mainnet.
    throw new Error(
      'AK-signed register_with_uri is not allowed: register_with_uri requires the ' +
        "AGENT to sign (caller == owner == agentWallet). Use the agent-signed " +
        'client-side flow (TODO U4-onchain). Only mode:"simulate" is supported here.',
    );
  }

  const server = opts.server ?? new rpc.Server(resolveStellarRpcUrl(), { allowHttp: false });
  // Source account for the simulate only — no key ever signs in this path.
  const sourcePubkey = (opts.keypair ?? loadStellarKeypair()).publicKey();

  const source = await server.getAccount(sourcePubkey);
  const registry = new Contract(STELLAR_IDENTITY_REGISTRY);

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
  })
    .addOperation(registry.call('register_with_uri', ...buildRegisterArgs(agentWalletAddress)))
    .setTimeout(180)
    .build();

  const sim = (await server.simulateTransaction(tx)) as
    & { error?: string }
    & Partial<rpc.Api.SimulateTransactionSuccessResponse>;
  if (sim.error) {
    throw new Error(`register_with_uri simulation failed: ${sim.error}`);
  }

  const retval = sim.result?.retval;
  const agentId = retval != null ? Number(scValToNative(retval)) : null;
  return { dryRun: true, agentId };
}
