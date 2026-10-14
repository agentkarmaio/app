/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { Address, Networks, nativeToScVal, type rpc, type Transaction, type xdr } from '@stellar/stellar-sdk';
import { makeStellarRegistryReader } from './stellar-registry';
import { identityTarget } from '@/integrations/erc8004-stellar';
import { STELLAR_IDENTITY_REGISTRY, STELLAR_TESTNET_IDENTITY_REGISTRY } from '@/integrations/stellar-config';

/** Fake Soroban server: records every simulated tx, answers total_agents = 7. */
function recordingServer() {
  const seen: Transaction[] = [];
  const server = {
    async simulateTransaction(tx: Transaction) {
      seen.push(tx);
      return { result: { retval: nativeToScVal(7, { type: 'u64' }) } };
    },
  } as unknown as rpc.Server;
  return { server, seen };
}

/** The contract a recorded simulate call invoked. */
function contractOf(tx: Transaction): string {
  const fn = (tx.operations[0] as unknown as { func: xdr.HostFunction }).func;
  return Address.fromScAddress(fn.invokeContract().contractAddress()).toString();
}

describe('makeStellarRegistryReader network targeting', () => {
  test('default reader targets the mainnet registry with the PUBLIC passphrase', async () => {
    const { server, seen } = recordingServer();
    expect(await makeStellarRegistryReader(server).totalAgents()).toBe(7);
    expect(seen[0].networkPassphrase).toBe(Networks.PUBLIC);
    expect(contractOf(seen[0])).toBe(STELLAR_IDENTITY_REGISTRY);
  });

  test('testnet reader targets the testnet registry with the TESTNET passphrase', async () => {
    const { server, seen } = recordingServer();
    await makeStellarRegistryReader(server, identityTarget('testnet')).totalAgents();
    expect(seen[0].networkPassphrase).toBe(Networks.TESTNET);
    expect(contractOf(seen[0])).toBe(STELLAR_TESTNET_IDENTITY_REGISTRY);
  });
});

describe('agent_uri UriNotSet', () => {
  const failing = (error: string) => ({
    async simulateTransaction() { return { error }; },
  }) as unknown as rpc.Server;

  test('an agent registered without a URI reads as an empty URI, not a scan error', async () => {
    const { readStellarAgentUri } = await import('@/integrations/erc8004-stellar');
    // identity-registry errors.rs: IdentityError::UriNotSet = 2
    expect(await readStellarAgentUri(failing('HostError: Error(Contract, #2)\n\nEvent log ...'), 14)).toBe('');
  });

  test('every other revert still throws (AgentNotFound, transport errors)', async () => {
    const { readStellarAgentUri } = await import('@/integrations/erc8004-stellar');
    await expect(readStellarAgentUri(failing('HostError: Error(Contract, #3)'), 14)).rejects.toThrow('#3');
    await expect(readStellarAgentUri(failing('HostError: Error(Contract, #22)'), 14)).rejects.toThrow('#22');
  });
});
