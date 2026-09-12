import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import * as db from '@/db/client';
import { resolveAgentCardFields } from './agent-card-fields';
import type { Wallet } from '@/db/schema';

const address = '0x1111111111111111111111111111111111111111';
let signals: ReturnType<typeof spyOn<typeof db, 'getArcMainnetReceiptEvents'>>;
beforeEach(() => { signals = spyOn(db, 'getArcMainnetReceiptEvents').mockResolvedValue({ events: [], saturated: false }); });
afterEach(() => signals.mockRestore());
describe('network-pinned unfurl fields', () => {
  test('an unpinned address shared with mainnet returns neutral metadata without registry fallback', async () => {
    const anyChain = spyOn(db, 'getWalletsByAddressAnyChain').mockResolvedValue([
      {chain:'arc',address,provider_score:99,tx_count:100,display_name:'Testnet only'} as Wallet,
      {chain:'arc-mainnet',address,provider_score:0,tx_count:1,display_name:'Mainnet agent'} as Wallet,
    ]);
    const wallet = spyOn(db,'getWallet').mockResolvedValue(null);
    const registry = spyOn(db,'getErc8004AgentByAddress').mockResolvedValue({chain:'arc',row:{metadata_score:99,registration:{name:'Testnet only'}}});
    try {
      const fields=await resolveAgentCardFields(address);
      expect(fields).toMatchObject({score:0,tier:'Unrated',txCount:0,chain:'multiple networks',isRegistry:false});
      expect(fields.name).not.toBe('Testnet only');
      expect(registry).not.toHaveBeenCalled();
    } finally { anyChain.mockRestore();wallet.mockRestore();registry.mockRestore(); }
  });
  test('a sole mainnet wallet resolves its own network on address-only OG requests', async () => {
    const anyChain = spyOn(db,'getWalletsByAddressAnyChain').mockResolvedValue([{chain:'arc-mainnet',address,provider_score:0,tx_count:2,display_name:'Mainnet agent'} as Wallet]);
    const wallet = spyOn(db,'getWallet').mockResolvedValue(null);
    const registry = spyOn(db,'getErc8004AgentByAddress').mockResolvedValue({chain:'arc',row:{metadata_score:99,registration:{name:'Testnet only'}}});
    try {
      expect(await resolveAgentCardFields(address)).toMatchObject({name:'Mainnet agent',score:0,txCount:0,chain:'arc-mainnet',isRegistry:false});
      expect(registry).not.toHaveBeenCalled();
    } finally { anyChain.mockRestore();wallet.mockRestore();registry.mockRestore(); }
  });
  test('an absent mainnet wallet cannot reuse matching testnet registry metadata', async () => {
    const wallet = spyOn(db, 'getWallet').mockResolvedValue(null);
    const registry = spyOn(db, 'getErc8004Agent').mockResolvedValue({ owner: address, metadata_score: 99, registration: { name: 'Testnet only' } });
    const byAddress = spyOn(db, 'getErc8004AgentByAddress').mockResolvedValue({ chain: 'arc', row: { owner: address, metadata_score: 99, registration: { name: 'Testnet only' } } });
    try {
      const fields = await resolveAgentCardFields(address, { chain: 'arc-mainnet', agentId: 42 });
      expect(fields.chain).toBe('arc-mainnet');
      expect(fields.isRegistry).toBe(false);
      expect(fields.name).not.toBe('Testnet only');
      expect(wallet).toHaveBeenCalledWith(address, 'arc-mainnet');
      expect(registry).not.toHaveBeenCalled();
      expect(byAddress).not.toHaveBeenCalled();
    } finally { wallet.mockRestore(); registry.mockRestore(); byAddress.mockRestore(); }
  });
  test('a mainnet receipt wallet keeps its own display fields and network', async () => {
    const read = spyOn(db, 'getWallet').mockImplementation(async (_address, chain) => chain === 'arc-mainnet'
      ? { chain, address, display_name: 'Mainnet agent', tx_count: 1, provider_score: 0, claimed: false } as Wallet
      : { chain: 'arc', address, display_name: 'Testnet agent', tx_count: 10, provider_score: 90 } as Wallet);
    try {
      expect(await resolveAgentCardFields(address, { chain: 'arc-mainnet' })).toMatchObject({ chain: 'arc-mainnet', name: 'Mainnet agent', score: 0, txCount: 0 });
      expect(signals).toHaveBeenCalledWith(address, 10000);
    } finally { read.mockRestore(); }
  });
});
