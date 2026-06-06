/// <reference types="bun-types" />
/**
 * Unit tests for the deterministic + DI surface of the stellar-8004 identity
 * mint (the on-chain half of the Stellar claim flow).
 *
 * NO live network: the RPC server and signer are INJECTED. We assert arg
 * encoding, the agentURI builder, C… rejection (smart wallets excluded v1),
 * and the simulate path's agentId decode against a mocked rpc.Server.
 * Fixtures are generated inline (Correction C5) — no placeholder StrKeys.
 */
import { describe, expect, test } from 'bun:test';
import { Keypair, StrKey, scValToNative, nativeToScVal } from '@stellar/stellar-sdk';
import {
  buildAgentUri,
  buildRegisterArgs,
  mintStellarAgentIdentity,
} from './stellar-identity-mint';

const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const G = kp.publicKey();
const C = StrKey.encodeContract(Buffer.alloc(32, 9));

describe('buildAgentUri', () => {
  test('points at the public agentkarma agent profile', () => {
    expect(buildAgentUri(G)).toBe(`https://agentkarma.io/agent/${G}`);
  });
});

describe('buildRegisterArgs', () => {
  test('encodes [operator address, agentURI string] as ScVals', () => {
    const args = buildRegisterArgs(G);
    expect(args).toHaveLength(2);
    expect(scValToNative(args[1])).toBe(`https://agentkarma.io/agent/${G}`);
  });
});

describe('mintStellarAgentIdentity guards', () => {
  test('rejects C… contract addresses (smart wallets excluded v1)', async () => {
    await expect(mintStellarAgentIdentity(C, { mode: 'simulate' })).rejects.toThrow(
      /Ed25519|G…|smart wallet/i,
    );
  });

  test('rejects malformed / junk addresses', async () => {
    await expect(mintStellarAgentIdentity('not-a-wallet', { mode: 'simulate' })).rejects.toThrow(
      /Ed25519|G…|smart wallet/i,
    );
  });
});

describe('mintStellarAgentIdentity simulate (injected rpc)', () => {
  // Minimal mock rpc.Server: getAccount returns a source account, simulate
  // returns a success with a u32 retval the mint must decode into agentId.
  function makeFakeServer(retvalAgentId: number) {
    return {
      async getAccount(pk: string) {
        return {
          accountId: () => pk,
          sequenceNumber: () => '1',
          incrementSequenceNumber: () => {},
        };
      },
      async simulateTransaction() {
        return { result: { retval: nativeToScVal(retvalAgentId, { type: 'u32' }) } };
      },
    };
  }

  test('decodes the agentId from a successful simulation, never signs/sends', async () => {
    const res = await mintStellarAgentIdentity(G, {
      mode: 'simulate',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server: makeFakeServer(4242) as any,
      keypair: kp,
    });
    expect(res.dryRun).toBe(true);
    expect(res.agentId).toBe(4242);
    expect(res.txHash).toBeUndefined();
  });

  test('raises (no silent fallback) when simulation returns an error', async () => {
    const errServer = {
      async getAccount() {
        return {
          accountId: () => G,
          sequenceNumber: () => '1',
          incrementSequenceNumber: () => {},
        };
      },
      async simulateTransaction() {
        return { error: 'HostError: register_with_uri reverted' };
      },
    };
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mintStellarAgentIdentity(G, { mode: 'simulate', server: errServer as any, keypair: kp }),
    ).rejects.toThrow(/simulat/i);
  });
});
