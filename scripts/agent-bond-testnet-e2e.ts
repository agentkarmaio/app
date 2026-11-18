/**
 * Agent Bond live end-to-end test against Stellar TESTNET.
 *
 * Gated: does nothing unless STELLAR_TESTNET_LIVE=1. Uses the 60-second
 * unbonding E2E instance (STELLAR_TESTNET_AGENT_BOND.e2e), never the
 * production instance, so it never touches real scores.
 *
 * Flow, each step asserted against get_bond and the emitted events:
 *   fresh agent: friendbot XLM -> USDC trustline -> DEX path payment to USDC
 *   -> register in stellar-8004 (agentWallet = the agent)
 *   deposit -> request_unbond -> withdraw before unlock (expect EarlyWithdraw)
 *   -> slash (Assay evidence, by the slasher) -> wait for unlock -> withdraw
 *   then one indexer pass over the real RPC events, projected in memory.
 *
 * Slasher secret: AGENT_BOND_SLASHER_SECRET, else the local stellar-cli key
 * `ak-bond-slasher`. Secrets are never printed.
 *
 *   STELLAR_TESTNET_LIVE=1 bun run scripts/agent-bond-testnet-e2e.ts
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  Asset, BASE_FEE, Contract, Horizon, Keypair, Networks, Operation, TransactionBuilder,
  nativeToScVal, rpc, scValToNative, xdr,
} from '@stellar/stellar-sdk';

import { STELLAR_TESTNET_AGENT_BOND, STELLAR_TESTNET_IDENTITY_REGISTRY } from '../src/integrations/stellar-config';
import { USDC_ISSUER } from '../src/config/stellar-x402';
import {
  runAgentBondIndexer, type AgentBondRow, type AgentBondEventRow,
} from '../src/indexer/stellar-agent-bond';

if (process.env.STELLAR_TESTNET_LIVE !== '1') {
  console.log('skipped: set STELLAR_TESTNET_LIVE=1 to run the Agent Bond testnet E2E');
  process.exit(0);
}

const PASS = Networks.TESTNET;
const server = new rpc.Server(process.env.STELLAR_TESTNET_RPC_URL || 'https://soroban-testnet.stellar.org');
const horizon = new Horizon.Server(process.env.STELLAR_TESTNET_HORIZON_URL || 'https://horizon-testnet.stellar.org');
const BOND = STELLAR_TESTNET_AGENT_BOND.e2e.contractId;
const USDC = new Asset('USDC', USDC_ISSUER.testnet);
const U = 10_000_000n;

function slasherKeypair(): Keypair {
  const secret = process.env.AGENT_BOND_SLASHER_SECRET
    ?? execFileSync('stellar', ['keys', 'show', 'ak-bond-slasher'], { encoding: 'utf8' }).trim();
  return Keypair.fromSecret(secret);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`E2E FAIL: ${msg}`);
  console.log(`  ok  ${msg}`);
}

async function classic(kp: Keypair, ops: xdr.Operation[]) {
  const acct = await horizon.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(acct, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: PASS });
  for (const op of ops) b.addOperation(op);
  const tx = b.setTimeout(60).build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
}

/** Simulate, then (unless simulateOnly) sign, send and poll. Returns the native result. */
async function invoke(kp: Keypair, contractId: string, method: string, args: xdr.ScVal[], simulateOnly = false): Promise<unknown> {
  const acct = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`);
  if (simulateOnly) return sim.result ? scValToNative(sim.result.retval) : undefined;
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`${method}: send failed`);
  for (let i = 0; i < 30; i++) {
    const r = await server.getTransaction(sent.hash);
    if (r.status === rpc.Api.GetTransactionStatus.SUCCESS) return r.returnValue ? scValToNative(r.returnValue) : undefined;
    if (r.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`${method}: tx failed`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`${method}: not confirmed in 60s`);
}

const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });

type Bond = { owner: string; bonded: bigint; unbonding: bigint; unlock_at: bigint; slashed_total: bigint };
async function getBond(kp: Keypair, agentId: number): Promise<Bond> {
  return (await invoke(kp, BOND, 'get_bond', [u32(agentId)], true)) as Bond;
}

async function main() {
  const startLedger = (await server.getLatestLedger()).sequence;
  const agent = Keypair.random();
  const slasher = slasherKeypair();
  console.log(`agent ${agent.publicKey()} on E2E contract ${BOND}`);

  // 1. Fund: friendbot XLM, USDC trustline, DEX swap 100 XLM -> USDC.
  const fb = await fetch(`https://friendbot.stellar.org?addr=${agent.publicKey()}`);
  assert(fb.ok, 'friendbot funded the agent');
  await classic(agent, [
    Operation.changeTrust({ asset: USDC }),
    Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: '100', destination: agent.publicKey(), destAsset: USDC, destMin: '20' }),
  ]);
  const usdcBal = (await horizon.loadAccount(agent.publicKey())).balances.find((b) => 'asset_code' in b && b.asset_code === 'USDC');
  assert(usdcBal && Number(usdcBal.balance) >= 20, `agent holds testnet USDC (${usdcBal?.balance})`);

  // 2. Register in stellar-8004 (agentWallet defaults to the caller).
  const agentId = Number(await invoke(agent, STELLAR_TESTNET_IDENTITY_REGISTRY, 'register', [nativeToScVal(agent.publicKey(), { type: 'address' })]));
  const wallet = await invoke(agent, STELLAR_TESTNET_IDENTITY_REGISTRY, 'get_agent_wallet', [u32(agentId)], true);
  assert(wallet === agent.publicKey(), `registered agentId ${agentId} with agentWallet = agent`);

  // 3. deposit 10, request_unbond 4.
  await invoke(agent, BOND, 'deposit', [u32(agentId), i128(10n * U)]);
  let b = await getBond(agent, agentId);
  assert(b.owner === agent.publicKey() && b.bonded === 10n * U, 'deposit bound the owner and bonded 10 USDC');
  await invoke(agent, BOND, 'request_unbond', [u32(agentId), i128(4n * U)]);
  b = await getBond(agent, agentId);
  assert(b.bonded === 6n * U && b.unbonding === 4n * U, 'unbond moved 4 USDC to unbonding');

  // 4. Early withdraw is rejected (Error #5 EarlyWithdraw).
  const early = await invoke(agent, BOND, 'withdraw', [u32(agentId)], true).then(() => 'ok', (e: Error) => e.message);
  assert(early.includes('#5'), 'withdraw before unlock rejected with EarlyWithdraw');

  // 5. Slash 3 USDC during unbonding with Assay evidence: drawn from unbonding first.
  const evidence = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('AssayVerdict'), xdr.ScVal.scvBytes(randomBytes(32)), xdr.ScVal.scvBytes(randomBytes(32))]);
  await invoke(slasher, BOND, 'slash', [u32(agentId), i128(3n * U), evidence]);
  b = await getBond(agent, agentId);
  assert(b.unbonding === 1n * U && b.bonded === 6n * U && b.slashed_total === 3n * U, 'slash took 3 USDC from unbonding');
  const replay = await invoke(slasher, BOND, 'slash', [u32(agentId), i128(U), evidence], true).then(() => 'ok', (e: Error) => e.message);
  assert(replay.includes('#7'), 'reusing the same evidence is rejected (EvidenceReused)');

  // 6. Wait for unlock, withdraw the remaining 1 USDC.
  const waitMs = Math.max(0, Number(b.unlock_at) * 1000 - Date.now()) + 10_000;
  console.log(`  ..  waiting ${Math.round(waitMs / 1000)}s for unlock`);
  await new Promise((res) => setTimeout(res, waitMs));
  const paid = await invoke(agent, BOND, 'withdraw', [u32(agentId)]);
  b = await getBond(agent, agentId);
  assert(paid === 1n * U && b.unbonding === 0n && b.bonded === 6n * U, 'withdraw paid the remaining 1 USDC');

  // 7. One indexer pass over the real events, projected in memory.
  const events: AgentBondEventRow[] = [];
  let bonds: AgentBondRow[] = [];
  await runAgentBondIndexer({
    contractId: BOND,
    deployLedger: startLedger,
    getOldestLedger: async () => (await server.getHealth()).oldestLedger,
    getEvents: async (req, limit) => {
      const filters = [{ type: 'contract' as const, contractIds: [BOND] }];
      const r = 'cursor' in req ? await server.getEvents({ filters, cursor: req.cursor, limit }) : await server.getEvents({ filters, startLedger: req.startLedger, limit });
      return {
        cursor: r.cursor, oldestLedger: r.oldestLedger, latestLedger: r.latestLedger,
        events: r.events.map((e) => ({ id: e.id, ledger: e.ledger, ledgerClosedAt: e.ledgerClosedAt,
          contractId: e.contractId ? e.contractId.address().toString() : '', txHash: e.txHash,
          topic: e.topic, value: e.value, inSuccessfulContractCall: e.inSuccessfulContractCall ?? true })),
      };
    },
    loadCursor: async () => null,
    reconcile: async () => [],
    saveCursor: async () => {},
    loadPrior: async () => new Map(),
    ensureWallets: async () => {},
    insertEvents: async (rows) => { events.push(...rows); return rows.length; },
    upsertBonds: async (rows) => { bonds = rows; },
    markDirty: async () => {},
    seasoningOwners: async () => [],
  });
  const mine = events.filter((e) => e.agent_id === agentId);
  assert(mine.map((e) => e.kind).join(',') === 'deposited,unbond_requested,slashed,withdrawn', `indexer saw all four events (${mine.map((e) => e.kind).join(',')})`);
  const slashRow = mine.find((e) => e.kind === 'slashed')!;
  assert(slashRow.evidence?.kind === 'assay' && slashRow.amount === '3.0000000', 'indexer decoded the Assay slash');
  assert(slashRow.slasher === slasher.publicKey(), 'slash event names the slasher');
  const row = bonds.find((r) => r.agent_id === agentId);
  assert(row?.bonded === '6.0000000' && row.unbonding === '0.0000000' && row.slashed_total === '3.0000000', 'indexer state matches get_bond');

  console.log('E2E PASS');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
