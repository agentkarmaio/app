/** Wallet-owned Stellar reviews. This module never reads validator keys or private RPC configuration. */
import {
  Address, BASE_FEE, Contract, Keypair, Networks, StrKey, Transaction,
  TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr,
} from '@stellar/stellar-sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { AK_REVIEW_TAG1 } from '@/config/ak-validator';
import { STELLAR_REPUTATION_REGISTRY } from '@/integrations/stellar-config';
import {
  buildFeedbackCommentBytes, decodeFeedbackCommentDataUri,
  encodeFeedbackCommentDataUri, parseFeedbackComment,
} from './feedback-comment';

export interface StellarFeedbackRecord {
  client: string;
  feedbackIndex: string;
  rawValue: string;
  valueDecimals: number;
  value: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
  comment?: string;
  commentVerified?: boolean;
  txHash?: string;
}
export interface StellarFeedbackInput {
  agentId: number;
  stars: number;
  comment?: string;
  address: string;
  ownerAddress?: string;
}
export interface StellarFeedbackDeps {
  server?: Pick<rpc.Server, 'getAccount' | 'simulateTransaction' | 'sendTransaction' | 'getTransaction'>;
  signTransaction?: (xdr: string, options: { networkPassphrase: string; address: string }) => Promise<{
    signedTxXdr: string; signerAddress: string; error?: { message: string };
  }>;
  getNetworkDetails?: () => Promise<{ networkPassphrase: string; error?: { message: string } }>;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
  confirmFee?: (feeStroops: string) => Promise<boolean>;
  now?: () => number;
  signal?: AbortSignal;
}
export interface StellarFeedbackResult {
  state: 'confirmed' | 'pending';
  txHash: string;
  record?: StellarFeedbackRecord;
}
const REVIEW_VERSION = 'v0.1';
const PUBLIC_RPC = 'https://mainnet.sorobanrpc.com';

function validAgentId(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id <= 0xffffffff;
}
function commentFields(input: StellarFeedbackInput) {
  const text = input.comment?.trim();
  if (!text) return { uri: '', hash: new Uint8Array(32) };
  const bytes = buildFeedbackCommentBytes({ value: input.stars * 20, stars: input.stars, comment: text });
  return { uri: encodeFeedbackCommentDataUri(bytes), hash: sha256(bytes) };
}

export function buildStellarFeedbackArgs(input: StellarFeedbackInput): xdr.ScVal[] {
  if (!validAgentId(input.agentId)) throw new Error('Invalid Stellar agent ID');
  if (!StrKey.isValidEd25519PublicKey(input.address)) throw new Error('Connect a Stellar G-address wallet');
  if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) throw new Error('Choose 1–5 stars');
  if (input.ownerAddress === input.address) throw new Error("You can't review your own agent");
  const { uri, hash } = commentFields(input);
  return [
    new Address(input.address).toScVal(), nativeToScVal(input.agentId, { type: 'u32' }),
    nativeToScVal(BigInt(input.stars * 20), { type: 'i128' }), nativeToScVal(0, { type: 'u32' }),
    nativeToScVal(AK_REVIEW_TAG1, { type: 'string' }), nativeToScVal(REVIEW_VERSION, { type: 'string' }),
    nativeToScVal('', { type: 'string' }), nativeToScVal(uri, { type: 'string' }), nativeToScVal(hash, { type: 'bytes' }),
  ];
}

/** Strict contract record decoder; preserve u64/i128 as strings across React's boundary. */
export function decodeStellarFeedbackRecord(client: string, index: bigint, raw: unknown): StellarFeedbackRecord {
  if ((!StrKey.isValidEd25519PublicKey(client) && !StrKey.isValidContract(client)) || index < 1n || index > 0xffffffffffffffffn) {
    throw new Error('Invalid Stellar feedback identity');
  }
  if (!raw || typeof raw !== 'object') throw new Error('Invalid Stellar feedback');
  const r = raw as Record<string, unknown>;
  if (typeof r.value !== 'bigint' || r.value < -(1n << 127n) || r.value >= (1n << 127n)
    || typeof r.value_decimals !== 'number' || !Number.isInteger(r.value_decimals)
    || r.value_decimals < 0 || r.value_decimals > 18 || typeof r.is_revoked !== 'boolean'
    || typeof r.tag1 !== 'string' || typeof r.tag2 !== 'string') throw new Error('Invalid Stellar feedback fields');
  return {
    client, feedbackIndex: index.toString(), rawValue: r.value.toString(), valueDecimals: r.value_decimals,
    value: Number(r.value) / 10 ** r.value_decimals, tag1: r.tag1, tag2: r.tag2, revoked: r.is_revoked,
  };
}

/** Decode only this registry's successful contract events, never diagnostic/foreign events. */
export function parseStellarFeedbackEvent(event: xdr.ContractEvent, txHash?: string): (StellarFeedbackRecord & { agentId: number }) | null {
  try {
    const contract = event.contractId();
    if (event.type().name !== 'contract' || !contract || StrKey.encodeContract(contract as unknown as Buffer) !== STELLAR_REPUTATION_REGISTRY) return null;
    const body = event.body().v0();
    const topics = body.topics().map(scValToNative);
    if (topics.length !== 4 || topics[0] !== 'new_feedback' || !validAgentId(topics[1])
      || typeof topics[2] !== 'string' || typeof topics[3] !== 'string') return null;
    const data = scValToNative(body.data()) as Record<string, unknown>;
    if (!data || typeof data.feedback_index !== 'bigint') return null;
    const record = decodeStellarFeedbackRecord(topics[2], data.feedback_index, {
      ...data, tag1: topics[3], is_revoked: false,
    });
    if (typeof data.feedback_uri !== 'string' || data.feedback_uri.length > 16_384
      || !(data.feedback_hash instanceof Uint8Array) || data.feedback_hash.length !== 32) return null;
    if (data.feedback_uri) {
      const bytes = decodeFeedbackCommentDataUri(data.feedback_uri);
      const comment = bytes && parseFeedbackComment(bytes);
      if (!bytes || !comment || comment.value !== record.value
        || !sha256(bytes).every((v, i) => v === (data.feedback_hash as Uint8Array)[i])) return null;
      record.comment = comment.comment;
      record.commentVerified = true;
    } else if (data.feedback_hash.some((v) => v !== 0)) return null;
    return { ...record, agentId: topics[1], ...(txHash ? { txHash } : {}) };
  } catch { return null; }
}

export function matchStellarFeedbackEvent(events: xdr.ContractEvent[][], input: StellarFeedbackInput, txHash: string): StellarFeedbackRecord | null {
  for (const event of events.flat()) {
    const record = parseStellarFeedbackEvent(event, txHash);
    if (record && record.agentId === input.agentId && record.client === input.address
      && record.rawValue === String(input.stars * 20) && record.valueDecimals === 0
      && record.tag1 === AK_REVIEW_TAG1 && record.tag2 === REVIEW_VERSION
      && (record.comment ?? '') === (input.comment?.trim() ?? '')) return record;
  }
  return null;
}

export async function submitStellarFeedback(input: StellarFeedbackInput, deps: StellarFeedbackDeps = {}): Promise<StellarFeedbackResult> {
  deps.signal?.throwIfAborted();
  const args = buildStellarFeedbackArgs(input);
  const wallet = !deps.signTransaction || !deps.getNetworkDetails ? await import('@stellar/freighter-api') : null;
  const sign = deps.signTransaction ?? wallet!.signTransaction;
  const network = deps.getNetworkDetails ?? wallet!.getNetworkDetails;
  async function checkNetwork() {
    const details = await network();
    if (details.error) throw new Error(details.error.message);
    if (details.networkPassphrase !== Networks.PUBLIC) throw new Error('Switch Freighter to Stellar mainnet');
  }
  await checkNetwork();
  const server = deps.server ?? new rpc.Server(PUBLIC_RPC, { timeout: 15_000 });
  const source = await server.getAccount(input.address);
  const unsigned = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract(STELLAR_REPUTATION_REGISTRY).call('give_feedback', ...args)).setTimeout(180).build();
  const sim = await server.simulateTransaction(unsigned);
  if (rpc.Api.isSimulationRestore(sim)) throw new Error('Feedback requires archived contract data to be restored. No transaction was signed or sent');
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error('error' in sim ? String(sim.error) : 'Feedback simulation failed');
  const prepared = rpc.assembleTransaction(unsigned, sim).build();
  deps.signal?.throwIfAborted();
  if (!/^[0-9]+$/.test(prepared.fee) || BigInt(prepared.fee) <= 0n) throw new Error('Invalid feedback transaction fee');
  if (deps.confirmFee && !await deps.confirmFee(prepared.fee)) throw new Error('Feedback publication cancelled');
  function checkExpiry() {
    const expires = Number(prepared.timeBounds?.maxTime);
    if (!Number.isFinite(expires) || expires <= Math.floor((deps.now ?? Date.now)() / 1_000)) {
      throw new Error('Feedback fee quote expired. Start again for a fresh quote');
    }
  }
  checkExpiry();
  deps.signal?.throwIfAborted();
  const result = await sign(prepared.toXDR(), { networkPassphrase: Networks.PUBLIC, address: input.address });
  if (result.error) throw new Error(result.error.message);
  if (result.signerAddress !== input.address) throw new Error('The signing wallet changed. Reconnect and try again');
  const signed = TransactionBuilder.fromXDR(result.signedTxXdr, Networks.PUBLIC);
  if (!(signed instanceof Transaction) || signed.source !== input.address || !signed.hash().equals(prepared.hash())) {
    throw new Error('Wallet returned a modified feedback transaction');
  }
  const publicKey = Keypair.fromPublicKey(input.address);
  if (!signed.signatures.some((signature) => {
    try { return publicKey.verify(signed.hash(), signature.signature()); } catch { return false; }
  })) throw new Error('Feedback transaction is not signed by the connected wallet');
  await checkNetwork();
  checkExpiry();
  deps.signal?.throwIfAborted();
  const txHash = signed.hash().toString('hex');
  // A transport error may happen after acceptance. Never re-submit or report failure from that alone.
  let sent: Awaited<ReturnType<typeof server.sendTransaction>> | undefined;
  try { sent = await server.sendTransaction(signed); } catch { /* confirm the known hash */ }
  if (deps.signal?.aborted) return { state: 'pending', txHash };
  if (sent?.status === 'ERROR') throw new Error(`Stellar rejected feedback transaction ${txHash}`);
  const polls = Math.min(30, Math.max(1, Math.floor(deps.maxPolls ?? 20)));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < polls; i++) {
    if (deps.signal?.aborted) return { state: 'pending', txHash };
    let found: rpc.Api.GetTransactionResponse;
    try { found = await server.getTransaction(txHash); } catch {
      if (i + 1 < polls) await sleep(1_500);
      continue;
    }
    if (found.status !== 'NOT_FOUND' && found.txHash !== txHash) return { state: 'pending', txHash };
    if (found.status === 'FAILED') throw new Error(`Feedback transaction failed: ${txHash}`);
    if (found.status === 'SUCCESS') {
      const record = matchStellarFeedbackEvent(found.events?.contractEventsXdr ?? [], input, txHash);
      if (!record) return { state: 'pending', txHash };
      return { state: 'confirmed', txHash, record };
    }
    if (i + 1 < polls) await sleep(1_500);
  }
  return { state: 'pending', txHash };
}
