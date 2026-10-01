import { describe, expect, test } from 'bun:test';
import { Account, Address, Keypair, Networks, SorobanDataBuilder, StrKey, Transaction, TransactionBuilder, nativeToScVal, scValToNative, xdr, type rpc } from '@stellar/stellar-sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { submitStellarFeedback, buildStellarFeedbackArgs, decodeStellarFeedbackRecord, parseStellarFeedbackEvent, matchStellarFeedbackEvent } from './stellar-feedback';
import { STELLAR_NETWORK_PASSPHRASE, STELLAR_REPUTATION_REGISTRY } from '@/integrations/stellar-config';
import { decodeFeedbackCommentDataUri, buildFeedbackCommentBytes, encodeFeedbackCommentDataUri } from './feedback-comment';

const signer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 71));
const address = signer.publicKey();
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 72));
const input = { agentId: 7, stars: 4, address, comment: 'Useful response — teşekkürler' };

function event(overrides: { client?: string; agentId?: number; value?: bigint; decimals?: number; tag1?: string; hash?: Uint8Array; contract?: string; uri?: string } = {}) {
  const bytes = buildFeedbackCommentBytes({ value: 80, stars: 4, comment: input.comment });
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StrKey.decodeContract(overrides.contract ?? STELLAR_REPUTATION_REGISTRY) as unknown as ReturnType<xdr.ContractEvent['contractId']>,
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({
      topics: [nativeToScVal('new_feedback', { type: 'symbol' }), nativeToScVal(overrides.agentId ?? 7, { type: 'u32' }), new Address(overrides.client ?? address).toScVal(), nativeToScVal(overrides.tag1 ?? 'agentkarma_review', { type: 'string' })],
      data: nativeToScVal({ feedback_index: 3n, value: overrides.value ?? 80n, value_decimals: overrides.decimals ?? 0, tag2: 'v0.1', endpoint: '', feedback_uri: overrides.uri ?? encodeFeedbackCommentDataUri(bytes), feedback_hash: Buffer.from(overrides.hash ?? sha256(bytes)) }, { type: { feedback_index: ['symbol', 'u64'], value: ['symbol', 'i128'], value_decimals: ['symbol', 'u32'], tag2: ['symbol', 'string'], endpoint: ['symbol', 'string'], feedback_uri: ['symbol', 'string'], feedback_hash: ['symbol', 'bytes'] } }),
    })),
  });
}

function harness() {
  const calls = { sends: 0, signs: 0, polls: 0, network: 0 };
  let hash = '';
  const server = {
    getAccount: async () => new Account(address, '42'),
    simulateTransaction: async () => ({ transactionData: new SorobanDataBuilder().build().toXDR('base64'), minResourceFee: '100', results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR('base64') }], latestLedger: 1, events: [] }),
    sendTransaction: async (tx: Transaction) => { calls.sends++; hash = tx.hash().toString('hex'); return { status: 'PENDING', hash }; },
    getTransaction: async () => { calls.polls++; return { status: 'SUCCESS', txHash: hash, events: { contractEventsXdr: [[event()]], transactionEventsXdr: [] } }; },
  };
  const deps = {
    server: server as unknown as Pick<rpc.Server, 'getAccount' | 'simulateTransaction' | 'sendTransaction' | 'getTransaction'>,
    getNetworkDetails: async () => { calls.network++; return { networkPassphrase: STELLAR_NETWORK_PASSPHRASE }; },
    signTransaction: async (envelope: string, opts: { networkPassphrase: string; address: string }) => {
      calls.signs++;
      expect(opts).toEqual({ networkPassphrase: STELLAR_NETWORK_PASSPHRASE, address });
      const tx = TransactionBuilder.fromXDR(envelope, opts.networkPassphrase) as Transaction;
      tx.sign(signer);
      return { signedTxXdr: tx.toXDR(), signerAddress: address };
    },
    sleep: async () => {}, maxPolls: 2,
  };
  return { calls, server, deps };
}

describe('Stellar feedback input boundary', () => {
  test.each([0, 6, 1.5, NaN])('rejects invalid star value %s before wallet access', async (stars) => {
    await expect(submitStellarFeedback({ agentId: 7, stars, address })).rejects.toThrow();
  });

  test.each([-1, 1.5, 2 ** 32, NaN])('rejects invalid agent ID %s before wallet access', async (agentId) => {
    await expect(submitStellarFeedback({ agentId, stars: 4, address })).rejects.toThrow();
  });

  test('rejects a malformed caller before wallet access', async () => {
    await expect(submitStellarFeedback({ agentId: 7, stars: 4, address: 'GNOTANACCOUNT' })).rejects.toThrow();
  });

  test('blocks the known owner from reviewing their own registration', async () => {
    await expect(submitStellarFeedback({ agentId: 7, stars: 4, address, ownerAddress: address })).rejects.toThrow(/self|owner|own/i);
  });
});

describe('Stellar feedback transaction contract', () => {
  test('encodes all nine Soroban arguments and SHA-256 of exact inline comment bytes', () => {
    const args = buildStellarFeedbackArgs(input);
    expect(args).toHaveLength(9);
    expect(args.slice(0, 7).map(scValToNative)).toEqual([address, 7, 80n, 0, 'agentkarma_review', 'v0.1', '']);
    const bytes = decodeFeedbackCommentDataUri(scValToNative(args[7]));
    expect(bytes).not.toBeNull();
    expect(Buffer.from(scValToNative(args[8]))).toEqual(Buffer.from(sha256(bytes!)));
    expect(JSON.parse(new TextDecoder().decode(bytes!))).toMatchObject({ value: 80, stars: 4, comment: input.comment });
  });

  test('confirms only the matching event after one signed submission', async () => {
    const h = harness();
    const result = await submitStellarFeedback(input, h.deps);
    expect(result.state).toBe('confirmed');
    expect(result.txHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.record).toMatchObject({ client: address, feedbackIndex: '3', rawValue: '80', valueDecimals: 0, value: 80, comment: input.comment, commentVerified: true });
    expect(h.calls.sends).toBe(1);
  });

  test('wrong wallet network never signs or sends', async () => {
    const h = harness();
    h.deps.getNetworkDetails = async () => ({ networkPassphrase: Networks.TESTNET });
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow(/network|mainnet|public/i);
    expect(h.calls.signs).toBe(0); expect(h.calls.sends).toBe(0);
  });

  test('wallet rejection never sends', async () => {
    const h = harness();
    h.deps.signTransaction = async () => { throw new Error('User rejected'); };
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow(/reject/i);
    expect(h.calls.sends).toBe(0);
  });

  test('claimed signer address cannot substitute for a valid signature', async () => {
    const h = harness();
    h.deps.signTransaction = async (envelope) => {
      const tx = TransactionBuilder.fromXDR(envelope, STELLAR_NETWORK_PASSPHRASE) as Transaction;
      tx.sign(other);
      return { signedTxXdr: tx.toXDR(), signerAddress: address };
    };
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow();
    expect(h.calls.sends).toBe(0);
  });

  test('an unsigned envelope never sends', async () => {
    const h = harness();
    h.deps.signTransaction = async (envelope) => ({ signedTxXdr: envelope, signerAddress: address });
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow();
    expect(h.calls.sends).toBe(0);
  });

  test('a body changed by the wallet never sends despite a real caller signature', async () => {
    const h = harness();
    h.deps.signTransaction = async (envelope) => {
      const original = TransactionBuilder.fromXDR(envelope, STELLAR_NETWORK_PASSPHRASE) as Transaction;
      const tx = TransactionBuilder.cloneFrom(original, { fee: '123456' }).build();
      tx.sign(signer);
      return { signedTxXdr: tx.toXDR(), signerAddress: address };
    };
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow();
    expect(h.calls.sends).toBe(0);
  });

  test('simulation failures stop before signing', async () => {
    const h = harness();
    Object.assign(h.server, { simulateTransaction: async () => ({ error: 'HostError: SelfFeedback' }) });
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow(/SelfFeedback|self/i);
    expect(h.calls.signs).toBe(0); expect(h.calls.sends).toBe(0);
  });

  test.each(['NOT_FOUND', 'THROW'])('uncertain confirmation %s remains pending with one submission', async (status) => {
    const h = harness();
    Object.assign(h.server, { getTransaction: async () => { h.calls.polls++; if (status === 'THROW') throw new Error('timeout'); return { status }; } });
    const result = await submitStellarFeedback(input, h.deps);
    expect(result.state).toBe('pending'); expect(result.record).toBeUndefined();
    expect(result.txHash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.calls.sends).toBe(1); expect(h.calls.polls).toBeLessThanOrEqual(2);
  });

  test('failed transaction is not reported as confirmed', async () => {
    const h = harness();
    const get = h.server.getTransaction;
    Object.assign(h.server, { getTransaction: async () => ({ ...await get(), status: 'FAILED' }) });
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow(/failed/i);
    expect(h.calls.sends).toBe(1);
  });

  test('successful unrelated event cannot confirm the requested review', async () => {
    const h = harness();
    const get = h.server.getTransaction;
    Object.assign(h.server, { getTransaction: async () => ({ ...await get(), events: { contractEventsXdr: [[event({ agentId: 8 })]], transactionEventsXdr: [] } }) });
    const result = await submitStellarFeedback(input, h.deps);
    expect(result.state).toBe('pending'); expect(result.record).toBeUndefined();
    expect(h.calls.sends).toBe(1);
  });
});

describe('Stellar feedback submission uncertainty and consent', () => {
  test('abort while approving fees prevents signing and sending', async () => {
    const h = harness(); const controller = new AbortController();
    await expect(submitStellarFeedback(input, { ...h.deps, signal: controller.signal, confirmFee: async () => { controller.abort(); return true; } })).rejects.toThrow();
    expect(h.calls.signs).toBe(0); expect(h.calls.sends).toBe(0);
  });

  test('abort while wallet signs prevents sending', async () => {
    const h = harness(); const controller = new AbortController(); const sign = h.deps.signTransaction;
    h.deps.signTransaction = async (envelope, options) => { const result = await sign(envelope, options); controller.abort(); return result; };
    await expect(submitStellarFeedback(input, { ...h.deps, signal: controller.signal })).rejects.toThrow();
    expect(h.calls.signs).toBe(1); expect(h.calls.sends).toBe(0);
  });

  test('abort after submission retains pending transaction identity', async () => {
    const h = harness(); const controller = new AbortController(); const send = h.server.sendTransaction;
    Object.assign(h.server, { sendTransaction: async (tx: Transaction) => { const result = await send(tx); controller.abort(); return result; } });
    const result = await submitStellarFeedback(input, { ...h.deps, signal: controller.signal });
    expect(result.state).toBe('pending'); expect(result.txHash).toMatch(/^[a-f0-9]{64}$/); expect(h.calls.sends).toBe(1);
  });

  test('another transaction failure cannot make this submission retryable', async () => {
    const h = harness();
    Object.assign(h.server, { getTransaction: async () => ({ status: 'FAILED', txHash: '0'.repeat(64) }) });
    const result = await submitStellarFeedback(input, h.deps);
    expect(result.state).toBe('pending'); expect(h.calls.sends).toBe(1);
  });

  test('a successful simulation with restore preamble must stop before fees or signing', async () => {
    const h = harness(); const simulate = h.server.simulateTransaction; let feeRequested = false;
    Object.assign(h.server, { simulateTransaction: async () => ({ ...await simulate(), restorePreamble: { minResourceFee: '500', transactionData: new SorobanDataBuilder().build().toXDR('base64') } }) });
    await expect(submitStellarFeedback(input, { ...h.deps, confirmFee: async () => { feeRequested = true; return true; } })).rejects.toThrow(/restor/i);
    expect(feeRequested).toBe(false); expect(h.calls.signs).toBe(0); expect(h.calls.sends).toBe(0);
  });

  test('expired fee approval is rejected before signing', async () => {
    const h = harness();
    await expect(submitStellarFeedback(input, { ...h.deps, now: () => Date.now() + 181_000 })).rejects.toThrow(/expir/i);
    expect(h.calls.signs).toBe(0); expect(h.calls.sends).toBe(0);
  });

  test('expiration while wallet signs prevents broadcasting', async () => {
    const h = harness(); let elapsed = 0; const sign = h.deps.signTransaction;
    h.deps.signTransaction = async (envelope, options) => { const signed = await sign(envelope, options); elapsed = 181_000; return signed; };
    await expect(submitStellarFeedback(input, { ...h.deps, now: () => Date.now() + elapsed })).rejects.toThrow(/expir/i);
    expect(h.calls.signs).toBe(1); expect(h.calls.sends).toBe(0);
  });
  test('fee rejection happens before wallet signing', async () => {
    const h = harness(); let shownFee: string | undefined;
    await expect(submitStellarFeedback(input, { ...h.deps, confirmFee: async (fee: string) => { shownFee = fee; return false; } })).rejects.toThrow();
    expect(Number(shownFee)).toBeGreaterThan(0);
    expect(h.calls.signs).toBe(0); expect(h.calls.sends).toBe(0);
  });

  test('a network change during wallet approval prevents broadcasting', async () => {
    const h = harness(); let reads = 0;
    h.deps.getNetworkDetails = async () => ({ networkPassphrase: reads++ === 0 ? Networks.PUBLIC : Networks.TESTNET });
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow(/mainnet|network/i);
    expect(h.calls.signs).toBe(1); expect(h.calls.sends).toBe(0);
  });

  test('a changed signer address fails before broadcast', async () => {
    const h = harness(); const sign = h.deps.signTransaction;
    h.deps.signTransaction = async (envelope, opts) => ({ ...await sign(envelope, opts), signerAddress: other.publicKey() });
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow(/wallet|sign/i);
    expect(h.calls.sends).toBe(0);
  });

  test('wallet error payload prevents broadcast', async () => {
    const h = harness(); const sign = h.deps.signTransaction;
    h.deps.signTransaction = async (envelope, opts) => ({ ...await sign(envelope, opts), error: { message: 'Approval declined' } });
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow(/declined/);
    expect(h.calls.sends).toBe(0);
  });

  test('network API error prevents even simulation', async () => {
    const h = harness();
    h.deps.getNetworkDetails = async () => ({ networkPassphrase: Networks.PUBLIC, error: { message: 'Wallet disconnected' } });
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow(/disconnected/);
    expect(h.calls.signs).toBe(0); expect(h.calls.sends).toBe(0);
  });

  test('restore-required simulation never signs the unready invocation', async () => {
    const h = harness();
    Object.assign(h.server, { simulateTransaction: async () => ({ latestLedger: 1, restorePreamble: { minResourceFee: '500', transactionData: new SorobanDataBuilder().build().toXDR('base64') } }) });
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow();
    expect(h.calls.signs).toBe(0); expect(h.calls.sends).toBe(0);
  });

  test('send transport failure can still confirm its known signed transaction', async () => {
    const h = harness(); const send = h.server.sendTransaction;
    Object.assign(h.server, { sendTransaction: async (tx: Transaction) => { await send(tx); throw new Error('response dropped'); } });
    const result = await submitStellarFeedback(input, h.deps);
    expect(result.state).toBe('confirmed'); expect(h.calls.sends).toBe(1);
  });

  test.each(['DUPLICATE', 'TRY_AGAIN_LATER'])('%s is polled without a second send', async (status) => {
    const h = harness(); const send = h.server.sendTransaction;
    Object.assign(h.server, { sendTransaction: async (tx: Transaction) => ({ ...await send(tx), status }) });
    expect((await submitStellarFeedback(input, h.deps)).state).toBe('confirmed');
    expect(h.calls.sends).toBe(1);
  });

  test('explicit transaction rejection reports failure', async () => {
    const h = harness(); const send = h.server.sendTransaction;
    Object.assign(h.server, { sendTransaction: async (tx: Transaction) => ({ ...await send(tx), status: 'ERROR' }) });
    await expect(submitStellarFeedback(input, h.deps)).rejects.toThrow(/reject/i);
    expect(h.calls.sends).toBe(1); expect(h.calls.polls).toBe(0);
  });

  test('wrong RPC transaction hash remains unresolved and never reports another review as confirmed', async () => {
    const h = harness(); const get = h.server.getTransaction;
    Object.assign(h.server, { getTransaction: async () => ({ ...await get(), txHash: '0'.repeat(64) }) });
    const result = await submitStellarFeedback(input, h.deps);
    expect(result.state).toBe('pending'); expect(result.record).toBeUndefined(); expect(h.calls.sends).toBe(1);
  });
});

describe('Stellar feedback event integrity', () => {
  test('invalid client/index boundaries reject instead of coercing identities', () => {
    const raw = { value: 80n, value_decimals: 0, is_revoked: false, tag1: 'agentkarma_review', tag2: 'v0.1' };
    for (const [client, index] of [['invalid', 1n], [address, 0n], [address, 1n << 64n]] as const) {
      expect(() => decodeStellarFeedbackRecord(client, index, raw)).toThrow();
    }
  });

  test.each([null, {}, { value: 1 }, { value: 1n, value_decimals: 19, is_revoked: false, tag1: 'x', tag2: 'x' }, { value: 1n << 127n, value_decimals: 0, is_revoked: false, tag1: 'x', tag2: 'x' }])('malformed record is not coerced into a score', (raw) => {
    expect(() => decodeStellarFeedbackRecord(address, 1n, raw)).toThrow();
  });

  test('no-comment reviews keep empty URI and zero digest', () => {
    const args = buildStellarFeedbackArgs({ ...input, comment: '  ' });
    expect(scValToNative(args[7])).toBe(''); expect(Buffer.from(scValToNative(args[8]))).toEqual(Buffer.alloc(32));
    expect(parseStellarFeedbackEvent(event({ uri: '', hash: new Uint8Array(32) }))).toMatchObject({ value: 80 });
    expect(parseStellarFeedbackEvent(event({ uri: '', hash: new Uint8Array(32).fill(1) }))).toBeNull();
  });
  test('parses real XDR and verifies the inline comment hash', () => {
    expect(parseStellarFeedbackEvent(event(), 'tx')).toMatchObject({ agentId: 7, client: address, feedbackIndex: '3', comment: input.comment, commentVerified: true, txHash: 'tx' });
  });

  test('a matching event from a different contract is ignored', () => {
    expect(parseStellarFeedbackEvent(event({ contract: StrKey.encodeContract(Buffer.alloc(32, 44)) }))).toBeNull();
  });

  test.each([{ agentId: 8 }, { client: other.publicKey() }, { value: 60n }, { decimals: 1 }, { tag1: 'provider' }])('unrelated event does not confirm this review', (change) => {
    expect(matchStellarFeedbackEvent([[event(change)]], input, 'tx')).toBeNull();
  });

  test('tampered inline comment hash is not represented as verified', () => {
    const record = parseStellarFeedbackEvent(event({ hash: new Uint8Array(32) }));
    expect(record?.commentVerified).not.toBe(true);
    expect(matchStellarFeedbackEvent([[event({ hash: new Uint8Array(32) })]], input, 'tx')).toBeNull();
  });
});
