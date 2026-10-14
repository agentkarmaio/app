/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { Asset, Networks } from '@stellar/stellar-sdk';
import {
  STELLAR_IDENTITY_REGISTRY,
  STELLAR_NETWORK_PASSPHRASE,
  resolveStellarRpcUrl,
  stellarNetwork,
} from './stellar-config';
import { USDC_ISSUER, USDC_SAC } from '@/config/stellar-x402';

describe('stellarNetwork', () => {
  test('pubnet is the pinned mainnet config, unchanged', () => {
    const n = stellarNetwork('pubnet', {});
    expect(n.chain).toBe('stellar');
    expect(n.identityRegistry).toBe(STELLAR_IDENTITY_REGISTRY);
    expect(n.passphrase).toBe(STELLAR_NETWORK_PASSPHRASE);
    expect(n.passphrase).toBe(Networks.PUBLIC);
    expect(n.rpcUrl).toBe(resolveStellarRpcUrl({}));
    expect(n.horizonUrl).toBe('https://horizon.stellar.org');
    expect(n.usdc).toEqual({ code: 'USDC', issuer: USDC_ISSUER.pubnet, sac: USDC_SAC.pubnet, decimals: 7 });
  });

  test('pubnet honours the existing env overrides', () => {
    const n = stellarNetwork('pubnet', { STELLAR_RPC_URL: 'https://rpc.example', STELLAR_HORIZON_URL: 'https://hz.example' });
    expect(n.rpcUrl).toBe('https://rpc.example');
    expect(n.horizonUrl).toBe('https://hz.example');
  });

  test('testnet is its own chain key with testnet endpoints and contracts', () => {
    const n = stellarNetwork('testnet', {});
    expect(n.chain).toBe('stellar-testnet');
    expect(n.identityRegistry).toBe('CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH');
    expect(n.passphrase).toBe(Networks.TESTNET);
    expect(n.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(n.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    expect(n.usdc.issuer).toBe(USDC_ISSUER.testnet);
    expect(n.usdc.sac).toBe(USDC_SAC.testnet);
  });

  test('testnet never reads the mainnet env overrides (a mainnet RPC must not serve testnet reads)', () => {
    const env = { STELLAR_RPC_URL: 'https://mainnet.example', STELLAR_HORIZON_URL: 'https://mainnet-hz.example' };
    const n = stellarNetwork('testnet', env);
    expect(n.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(n.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    const o = stellarNetwork('testnet', { STELLAR_TESTNET_RPC_URL: 'https://t.example', STELLAR_TESTNET_HORIZON_URL: ' ' });
    expect(o.rpcUrl).toBe('https://t.example');
    expect(o.horizonUrl).toBe('https://horizon-testnet.stellar.org'); // blank secret = unset
  });

  test('USDC SAC is derived from the pinned issuer on each network', () => {
    for (const net of ['pubnet', 'testnet'] as const) {
      const n = stellarNetwork(net, {});
      expect(new Asset('USDC', n.usdc.issuer).contractId(n.passphrase)).toBe(n.usdc.sac);
    }
  });
});
