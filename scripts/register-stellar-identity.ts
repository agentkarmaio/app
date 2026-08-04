/**
 * Register AgentKarma ITSELF on the stellar-8004 Identity Registry (mainnet).
 *
 * Calls `register_with_uri(caller, agentURI)` with caller == AK's own Stellar
 * account (.keys/agentkarma-stellar.json) == tx source — so the tx signature
 * satisfies the contract's `caller.require_auth()`, and binding
 * owner == agentWallet == AK is CORRECT here (it is AK's own identity).
 *
 * This is the legitimate counterpart to the hard-guard in
 * src/integrations/stellar-identity-mint.ts: that guard forbids AK-signed
 * registration of OTHER agents' wallets (their require_auth would fail or
 * their agentWallet would bind to AK). Self-registration has no such problem
 * — mirrors scripts/register-celo-identity.ts (Celo agentId 9058).
 *
 * Modes:
 *   --simulate   estimate fee + preview the assigned agentId (default)
 *   --execute    send the tx; verifies the agentURI resolves first
 *
 * Never logs the secret key.
 */

import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Address,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import {
  STELLAR_IDENTITY_REGISTRY,
  STELLAR_NETWORK_PASSPHRASE,
  resolveStellarRpcUrl,
} from '../src/integrations/stellar-config';
import { loadStellarKeypair } from '../src/integrations/erc8004-stellar-publish';

const AGENT_URI = 'https://agentkarma.io/.well-known/agent.json';
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_TRIES = 30; // 60s ceiling — bounded, never spins forever

const mode = process.argv.includes('--execute') ? 'execute' : 'simulate';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── [1/4] Verify the agentURI resolves before writing it on-chain ────────────
if (mode === 'execute') {
  console.log(`[1/4] verifying ${AGENT_URI} resolves…`);
  const probe = await fetch(AGENT_URI);
  if (!probe.ok) {
    console.error(`✖ agent URI returns HTTP ${probe.status}. Deploy first.`);
    process.exit(1);
  }
  const body = (await probe.json()) as { type?: string };
  if (body?.type !== 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1') {
    console.error(`✖ unexpected JSON at ${AGENT_URI}:`, body);
    process.exit(1);
  }
  console.log(`    ✓ HTTP 200, type=${body.type}`);
} else {
  console.log(`[1/4] simulate mode: skipping URL probe (enforced on --execute)`);
}

// ── [2/4] Load keypair + on-ledger account ───────────────────────────────────
const keypair = loadStellarKeypair();
const caller = keypair.publicKey();
console.log(`[2/4] loaded keypair for ${caller}`);

const server = new rpc.Server(resolveStellarRpcUrl(), { allowHttp: false });

let account;
try {
  account = await server.getAccount(caller);
} catch {
  console.error(`✖ account ${caller} not found on-ledger.`);
  console.error('  Fund it with ~5 XLM first — the deposit itself creates the account.');
  process.exit(1);
}

// ── [3/4] Build + simulate ───────────────────────────────────────────────────
const tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
})
  .addOperation(
    new Contract(STELLAR_IDENTITY_REGISTRY).call(
      'register_with_uri',
      Address.fromString(caller).toScVal(),
      nativeToScVal(AGENT_URI, { type: 'string' }),
    ),
  )
  .setTimeout(60)
  .build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) {
  console.error(`✖ simulation failed: ${sim.error}`);
  process.exit(1);
}
const previewId = sim.result ? Number(scValToNative(sim.result.retval)) : null;
console.log(`[3/4] simulation succeeded`);
console.log(`    assigned agentId (preview): ${previewId}`);
console.log(`    min resource fee:           ${sim.minResourceFee} stroops`);

if (mode === 'simulate') {
  console.log(`[4/4] --simulate mode: nothing sent. Re-run with --execute to register.`);
  process.exit(0);
}

// ── [4/4] Execute ────────────────────────────────────────────────────────────
const prepared = rpc.assembleTransaction(tx, sim).build();
prepared.sign(keypair);
console.log(`[4/4] sending tx…`);
const sent = await server.sendTransaction(prepared);
if (sent.status === 'ERROR') {
  console.error(`✖ sendTransaction rejected:`, JSON.stringify(sent.errorResult));
  process.exit(1);
}
console.log(`    tx submitted: ${sent.hash}`);

let confirmed: rpc.Api.GetTransactionResponse | null = null;
for (let i = 0; i < POLL_MAX_TRIES; i++) {
  const resp = await server.getTransaction(sent.hash);
  if (resp.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    confirmed = resp;
    break;
  }
  if (resp.status === rpc.Api.GetTransactionStatus.FAILED) {
    console.error(`✖ tx FAILED on-chain: ${sent.hash}`);
    process.exit(1);
  }
  await sleep(POLL_INTERVAL_MS);
}
if (!confirmed || confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
  console.error(`✖ tx not confirmed after ${(POLL_INTERVAL_MS * POLL_MAX_TRIES) / 1000}s.`);
  console.error(`  Check https://stellar.expert/explorer/public/tx/${sent.hash} — it may still land.`);
  process.exit(1);
}

const agentId = confirmed.returnValue != null ? Number(scValToNative(confirmed.returnValue)) : previewId;

console.log('');
console.log(`✓ AgentKarma registered on Stellar`);
console.log(`  agentId:   ${agentId}`);
console.log(`  owner:     ${caller}`);
console.log(`  agentURI:  ${AGENT_URI}`);
console.log(`  tx:        ${sent.hash}`);
console.log(`  ledger:    ${confirmed.ledger}`);
console.log(`  explorer:  https://stellar.expert/explorer/public/tx/${sent.hash}`);
console.log(`  8004scan:  https://stellar8004.com/agents/${agentId}`);
console.log('');
console.log(`Next: set AK_STELLAR.agentId = ${agentId} in src/config/ak-validator.ts`);
