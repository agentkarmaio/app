/**
 * stellar-8004 Identity mint — the on-chain half of the Stellar claim flow (U4).
 *
 * On a successful claim (POST /api/agent/claim/stellar), AK mints the agent's
 * 8004 identity on the trionlabs/stellar-8004 Identity Registry so U3's
 * publishAttestation has a registered agentId to target — `give_feedback`
 * reverts without one (spec §2 gating, mirrors the Celo IdentityRegistry
 * precondition in erc8004-celo-publish.ts).
 *
 * DI for testability (AK rule: no live network in unit tests). The Soroban RPC
 * server and the AK validator keypair are INJECTED via `opts.server` /
 * `opts.keypair`, defaulting to the real mainnet RPC + the loaded validator key
 * in production. Tests inject a mocked rpc.Server and assert the
 * simulate-only path decodes the agentId — they never sign or send.
 *
 * v1 supports only G… Ed25519 wallets. C… Soroban contract addresses
 * (smart wallets) authenticate via __check_auth, not raw Ed25519, and are
 * rejected before any RPC call (fail-closed).
 *
 * ABI caveat (STOP-and-confirm before mainnet, plan Task 47): the exact
 * `register_with_uri` method name/arg order and whether the agent-signed
 * `setAgentWallet(agentId, agentWallet)` binding is a separate op are pinned to
 * the documented [operator, agentURI] shape (spec §"agentId is a registered
 * u32"). The 'simulate' default makes a wrong ABI fail closed in tests.
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
  /** 'simulate' (default — no write, fail-closed) | 'execute'. */
  mode?: 'simulate' | 'execute';
  /** Injected Soroban RPC server (tests mock this; prod resolves the mainnet RPC). */
  server?: rpc.Server;
  /** Injected AK validator signer (tests pass a deterministic key; prod loads from env/.keys). */
  keypair?: Keypair;
}

/**
 * Mint (or, in simulate mode, resolve) the agent's stellar-8004 identity.
 *
 * Rejects C… / non-G… addresses before touching the network. In 'simulate'
 * mode decodes the agentId from the simulation retval and never signs/sends.
 * In 'execute' mode it assembles, signs with the injected keypair, sends, and
 * polls for the result. Raises on any simulate/send/tx error — no silent
 * fallback (AK core rule).
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
  const server = opts.server ?? new rpc.Server(resolveStellarRpcUrl(), { allowHttp: false });
  const validator = opts.keypair ?? loadStellarKeypair();

  const source = await server.getAccount(validator.publicKey());
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

  if (mode === 'simulate') {
    const retval = sim.result?.retval;
    const agentId = retval != null ? Number(scValToNative(retval)) : null;
    return { dryRun: true, agentId };
  }

  const prepared = rpc
    .assembleTransaction(tx, sim as rpc.Api.SimulateTransactionSuccessResponse)
    .build();
  prepared.sign(validator);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(
      `register_with_uri send failed: ${JSON.stringify(sent.errorResult ?? sent)}`,
    );
  }

  let got = await server.getTransaction(sent.hash);
  while (got.status === 'NOT_FOUND') {
    await new Promise((r) => setTimeout(r, 1000));
    got = await server.getTransaction(sent.hash);
  }
  if (got.status !== 'SUCCESS') {
    throw new Error(`register_with_uri tx failed: ${got.status}`);
  }
  const agentId = got.returnValue != null ? Number(scValToNative(got.returnValue)) : null;
  return { dryRun: false, agentId, txHash: sent.hash };
}
