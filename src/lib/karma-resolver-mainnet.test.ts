import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as db from '@/db/client';
import * as enrichment from '@/db/enrichment-queries';
import { resolveKarma } from './karma-resolver';
import { resolveAgentCardFields } from './agent-card-fields';
import { ARC_MAINNET_TRANSFER_EMITTER } from '@/config/arc-mainnet';
import type { SignalEvent, Wallet } from '@/db/schema';

const owner = `0x${'1'.repeat(40)}`;
const effective = `0x${'2'.repeat(40)}`;
const other = `0x${'3'.repeat(40)}`;
const zero = `0x${'0'.repeat(40)}`;
const agent = { chain: 'arc-mainnet', agent_id: 0, owner, agent_wallet: effective,
  registration: { name: 'Mainnet Zero', description: 'Independent agent' }, metadata_score: 99 };
let wallet: ReturnType<typeof spyOn<typeof db, 'getWallet'>>;
let registry: ReturnType<typeof spyOn<typeof db, 'getErc8004Agent'>>;
let byAddress: ReturnType<typeof spyOn<typeof enrichment, 'getRegistryAgentsForAddress'>>;
let receipts: ReturnType<typeof spyOn<typeof db, 'getArcMainnetReceiptEvents'>>;
beforeEach(() => {
  wallet = spyOn(db, 'getWallet').mockResolvedValue(null);
  registry = spyOn(db, 'getErc8004Agent').mockResolvedValue(agent);
  byAddress = spyOn(enrichment, 'getRegistryAgentsForAddress').mockResolvedValue({ rows: [], total: 0 });
  receipts = spyOn(db, 'getArcMainnetReceiptEvents').mockResolvedValue({ events: [], saturated: false });
});
afterEach(() => { wallet.mockRestore(); registry.mockRestore(); byAddress.mockRestore(); receipts.mockRestore(); });

describe('Arc mainnet registry identity and receipt binding', () => {
  test('ID zero resolves a registry-only identity with no manufactured Karma', async () => {
    const result = await resolveKarma(owner, 'arc-mainnet', { agentId: 0 });
    expect(registry).toHaveBeenCalledWith('arc-mainnet', 0);
    expect(result).toMatchObject({ address: effective, agentId: 0, identity: {
      claimed: false, displayName: 'Mainnet Zero', description: 'Independent agent',
    }, txCount: 0, provider: { score: 0, hasSignal: false }, consumer: { score: 0, hasSignal: false } });
    expect(receipts).toHaveBeenCalledWith(effective, 10000);
  });
  test('rejects an agentId belonging to another address without computing its scores', async () => {
    expect(await resolveKarma(other, 'arc-mainnet', { agentId: 0 })).toBeNull();
    expect(receipts).not.toHaveBeenCalled();
  });
  test('rejects a cross-network record or mismatched ID from the identity read', async () => {
    registry.mockResolvedValue({ ...agent, chain: 'arc' });
    expect(await resolveKarma(owner, 'arc-mainnet', { agentId: 0 })).toBeNull();
    registry.mockResolvedValue({ ...agent, agent_id: 1 });
    expect(await resolveKarma(owner, 'arc-mainnet', { agentId: 0 })).toBeNull();
  });
  test('zero agentWallet falls back to owner; exact identity wins over shared wallet display name', async () => {
    registry.mockResolvedValue({ ...agent, agent_wallet: zero });
    wallet.mockResolvedValue({ chain: 'arc-mainnet', address: owner, display_name: 'Different shared identity', claimed: false } as Wallet);
    const result = await resolveKarma(owner, 'arc-mainnet', { agentId: 0 });
    expect(result?.address).toBe(owner);
    expect(result?.identity.displayName).toBe('Mainnet Zero');
    expect(receipts).toHaveBeenCalledWith(owner, 10000);
  });
  test('an unnamed identity never inherits another agent name from their shared wallet', async () => {
    registry.mockResolvedValue({ ...agent, registration: {} });
    wallet.mockResolvedValue({ chain: 'arc-mainnet', address: effective, display_name: 'Different agent', description: 'Different identity' } as Wallet);
    expect(await resolveKarma(owner, 'arc-mainnet', { agentId: 0 })).toMatchObject({
      identity: { displayName: 'Agent #0', description: null },
    });
  });
  test('an address-only owner lookup never attributes its receipts to another effective wallet', async () => {
    byAddress.mockResolvedValue({ rows: [agent] as never, total: 1 });
    expect(await resolveKarma(owner, 'arc-mainnet')).toBeNull();
    expect(receipts).toHaveBeenCalledWith(owner, 10000);
  });
  test('an address-only effective wallet has a deterministic registry identity without a wallets row', async () => {
    byAddress.mockResolvedValue({ rows: [agent] as never, total: 1 });
    expect(await resolveKarma(effective, 'arc-mainnet')).toMatchObject({ agentId: 0, identity: { displayName: 'Mainnet Zero' } });
    expect(byAddress).toHaveBeenCalledWith('arc-mainnet', effective);
  });
  test('pinned unfurl preserves exact registry name and uses receipts at the effective wallet', async () => {
    const hash = `0x${'a'.repeat(64)}`;
    const event = { id: 'receipt-1', created_at: new Date().toISOString(), chain: 'arc-mainnet', agent_wallet: effective, kind: 'usdc_transfer_settled', tier: 2,
      face: 'provider', weight: 0.6, value: 1, tx_ref: `${hash}:0`, signed_by: null,
      observed_at: new Date().toISOString(), payload: { source: 'arc_native_usdc_transfer', rawTxHash: hash,
        logIndex: 0, rawAmount: '1000000000000000000', amountDecimal: '1', amount: 1, decimals: 18,
        emitter: ARC_MAINNET_TRANSFER_EMITTER, counterparty: other } } as SignalEvent;
    receipts.mockResolvedValue({ events: [event], saturated: false });
    expect(await resolveAgentCardFields(owner, { chain: 'arc-mainnet', agentId: 0 })).toMatchObject({
      name: 'Mainnet Zero', chain: 'arc-mainnet', isRegistry: true, badge: 'behavior-inferred', txCount: 1,
      profileUrl: `/agent/${effective}?chain=arc-mainnet&agentId=0`,
    });
    expect(receipts).toHaveBeenCalledWith(effective, 10000);
  });
});
