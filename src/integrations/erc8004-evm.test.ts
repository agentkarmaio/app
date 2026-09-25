/// <reference types="bun-types" />
/**
 * Parameterized EVM-8004 factory — pure gates and signer resolution.
 *
 * The read/write network paths are exercised against live RPC only by the
 * unarmed daily workflow (simulate mode), like Celo's. Here: the RPC
 * resolution, fee ceiling, the hash helper, and signer resolution precedence.
 *
 * Run: bun test src/integrations/erc8004-evm.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  resolveEvmRpcUrl,
  evmFeeCeilingWei,
  feedbackHashFromJson,
  makeEvm8004Publish,
} from './erc8004-evm';
import type { Evm8004PublishConfig } from './erc8004-evm';
import { arcMainnet } from '@/config/arc-chain';
import { AK_ARC_MAINNET } from '@/config/ak-validator';

// One bun process runs every test file, so env leaks across files unless it is
// restored here (see memory: bun-test-env-leak).
const ENV_KEYS = ['ARC_MAINNET_RPC_URL', 'ARC_MAINNET_VALIDATOR_PRIVATE_KEY'] as const;
const saved = ENV_KEYS.map((k) => process.env[k]);

afterEach(() => {
  ENV_KEYS.forEach((_k, i) => {
    if (saved[i] === undefined) delete process.env[ENV_KEYS[i]];
    else process.env[ENV_KEYS[i]] = saved[i];
  });
});

const CONFIG: Evm8004PublishConfig = {
  chain: arcMainnet,
  identityRegistry: AK_ARC_MAINNET.identityRegistry,
  reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  rpcEnv: 'ARC_MAINNET_RPC_URL',
  defaultRpcUrl: 'https://rpc.mainnet.arc.io',
  gasToken: 'USDC',
  validatorKeyfile: '/nonexistent/ci-runner/has/no/keyfile.json',
  privateKeyEnv: 'ARC_MAINNET_VALIDATOR_PRIVATE_KEY',
  disclosedSigner: AK_ARC_MAINNET.validator,
};

describe('resolveEvmRpcUrl', () => {
  test('env override wins over the default', () => {
    process.env.ARC_MAINNET_RPC_URL = 'https://rpc.example.com/v2';
    expect(resolveEvmRpcUrl(CONFIG)).toBe('https://rpc.example.com/v2');
  });

  test('bare-hostname env value is scheme-normalized', () => {
    process.env.ARC_MAINNET_RPC_URL = 'rpc.example.com/v2';
    expect(resolveEvmRpcUrl(CONFIG)).toBe('https://rpc.example.com/v2');
  });

  test('falls back to the default endpoint when the env var is unset', () => {
    delete process.env.ARC_MAINNET_RPC_URL;
    expect(resolveEvmRpcUrl(CONFIG)).toBe('https://rpc.mainnet.arc.io');
  });
});

describe('evmFeeCeilingWei', () => {
  test('balance below cap → ceiling is the balance (exact bigint)', () => {
    expect(evmFeeCeilingWei(123n, 0.1)).toBe(123n);
  });
  test('balance above cap → ceiling is the cap, no float residue', () => {
    expect(evmFeeCeilingWei(10n ** 19n, 0.1)).toBe(10n ** 17n);
  });
});

describe('feedbackHashFromJson', () => {
  test('same payload → same hash', () => {
    const payload = { rater: 'AgentKarma', target: '1', score: 88 };
    expect(feedbackHashFromJson(payload)).toBe(feedbackHashFromJson({ rater: 'AgentKarma', target: '1', score: 88 }));
  });
  test('different payload → different hash', () => {
    expect(feedbackHashFromJson({ score: 88 })).not.toBe(feedbackHashFromJson({ score: 89 }));
  });
});

describe('activeSignerAddress', () => {
  const publish = makeEvm8004Publish(CONFIG);

  test('falls back to the disclosed validator constant with no key and no keyfile', () => {
    delete process.env.ARC_MAINNET_VALIDATOR_PRIVATE_KEY;
    expect(publish.activeSignerAddress()).toBe(AK_ARC_MAINNET.validator as `0x${string}`);
  });

  test('an unset secret arrives as empty string and still resolves', () => {
    // GitHub injects an absent secret as "", which is falsy but present.
    process.env.ARC_MAINNET_VALIDATOR_PRIVATE_KEY = '';
    expect(publish.activeSignerAddress()).toBe(AK_ARC_MAINNET.validator as `0x${string}`);
  });

  test('a configured signing key wins over the fallback', () => {
    // Well-known test vector; private key 0x01 → a fixed, public address.
    process.env.ARC_MAINNET_VALIDATOR_PRIVATE_KEY =
      '0x0000000000000000000000000000000000000000000000000000000000000001';
    expect(publish.activeSignerAddress()).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  });
});