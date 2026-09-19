import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as db from '@/db/client';
import { GET } from './route';
import type { SignalEvent, Wallet } from '@/db/schema';
import { ARC_MAINNET_TRANSFER_EMITTER } from '@/config/arc-mainnet';

const address = `0x${'1'.repeat(40)}`;
let projected: ReturnType<typeof spyOn<typeof db, 'getWalletByAgentId'>>;
let wallet: ReturnType<typeof spyOn<typeof db, 'getWallet'>>;
let registry: ReturnType<typeof spyOn<typeof db, 'getErc8004Agent'>>;
let receipts: ReturnType<typeof spyOn<typeof db, 'getArcMainnetReceiptEvents'>>;
beforeEach(() => {
  projected = spyOn(db, 'getWalletByAgentId').mockResolvedValue({ chain: 'arc-mainnet', address,
    display_name: 'Projected name', score: 99, provider_score: 99, consumer_score: 99,
    confidence_badge: 'declared', trust_tier: 'Excellent' } as Wallet);
  wallet = spyOn(db, 'getWallet').mockResolvedValue(null);
  registry = spyOn(db, 'getErc8004Agent').mockImplementation(async (chain, id) => ({
    chain, agent_id: id, owner: address, agent_wallet: address, registration: { name: 'Exact mainnet identity' }, metadata_score: 99,
  }));
  receipts = spyOn(db, 'getArcMainnetReceiptEvents').mockResolvedValue({ events: [], saturated: false });
});
afterEach(() => { projected.mockRestore(); wallet.mockRestore(); registry.mockRestore(); receipts.mockRestore(); });
const get = (id: string, chain = 'arc-mainnet') => GET(new Request(`http://x/api/v2/agent/${chain}/${id}`) as never,
  { params: Promise.resolve({ chain, id }) });

describe('mainnet agent ID API', () => {
  test('ID zero resolves exact identity with absent faces null, never projected metadata scores', async () => {
    const response = await get('0');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ chain: 'arc-mainnet', agentId: 0, address,
      displayName: 'Exact mainnet identity', score: null, providerScore: null, consumerScore: null,
      trustTier: 'Unrated', confidenceBadge: 'declared', profileUrl: `/agent/${address}?chain=arc-mainnet&agentId=0` });
    expect(projected).toHaveBeenCalledWith('arc-mainnet', 0);
  });
  test('live provider receipts override stale persisted scores while absent consumer stays null', async () => {
    const hash = `0x${'a'.repeat(64)}`;
    receipts.mockResolvedValue({ saturated: false, events: [{ id: 'receipt-1', created_at: new Date().toISOString(), chain: 'arc-mainnet', agent_wallet: address,
      kind: 'usdc_transfer_settled', tier: 2, face: 'provider', weight: 0.6, value: 1, signed_by: null,
      tx_ref: `${hash}:0`, observed_at: new Date().toISOString(), payload: { source: 'arc_native_usdc_transfer',
        rawTxHash: hash, logIndex: 0, rawAmount: '1000000000000000000', amountDecimal: '1', amount: 1,
        decimals: 18, emitter: ARC_MAINNET_TRANSFER_EMITTER, counterparty: `0x${'2'.repeat(40)}` } } as SignalEvent] });
    const response = await get('1');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.providerScore).toBeGreaterThan(0);
    expect(body.providerScore).toBeLessThan(99);
    expect(body.consumerScore).toBeNull();
    expect(body.confidenceBadge).toBe('behavior-inferred');
  });
  test('malformed IDs are rejected before lookup; only mainnet newly permits zero', async () => {
    for (const id of ['-1', '1.2', '1e2', '0x10', '2147483648']) expect((await get(id)).status).toBe(400);
    expect((await get('0', 'arc')).status).toBe(400);
    expect(projected).not.toHaveBeenCalled();
  });
  test('registry identity missing or mismatched returns 404 without projected-score fallback', async () => {
    registry.mockResolvedValue(null);
    expect((await get('42')).status).toBe(404);
  });
  test('other chains retain their existing persisted-score response', async () => {
    const response = await get('42', 'celo');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ chain: 'celo', score: 99, providerScore: 99, consumerScore: 99 });
    expect(registry).not.toHaveBeenCalled();
    expect(receipts).not.toHaveBeenCalled();
  });
});
