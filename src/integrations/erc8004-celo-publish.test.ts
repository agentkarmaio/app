/// <reference types="bun-types" />
/**
 * Celo attestation publisher — signer resolution.
 *
 * Run: bun test src/integrations/erc8004-celo-publish.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { activeSignerAddress } from './erc8004-celo-publish';
import { AK_VALIDATOR } from '@/config/ak-validator';

// One bun process runs every test file, so env leaks across files unless it is
// restored here (see memory: bun-test-env-leak).
const ENV_KEYS = ['CELO_VALIDATOR_PRIVATE_KEY', 'CELO_VALIDATOR_KEYFILE'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/**
 * 2026-09-13: every scheduled celo-attest run failed with a raw ENOENT on
 * `.keys/agentkarma-celo.json`. CI has no keyfile, and the arming secret was
 * never set — but the unarmed run only simulates, which needs an address, not
 * a key. Reading the address must never depend on holding the private key.
 */
describe('activeSignerAddress', () => {
  test('falls back to the disclosed validator constant with no key and no keyfile', () => {
    delete process.env.CELO_VALIDATOR_PRIVATE_KEY;
    process.env.CELO_VALIDATOR_KEYFILE = '/nonexistent/ci-runner/has/no/keyfile.json';
    expect(activeSignerAddress()).toBe(AK_VALIDATOR.validator as `0x${string}`);
  });

  test('an unset secret arrives as empty string and still resolves', () => {
    // GitHub injects an absent secret as "", which is falsy but present.
    process.env.CELO_VALIDATOR_PRIVATE_KEY = '';
    process.env.CELO_VALIDATOR_KEYFILE = '/nonexistent/ci-runner/has/no/keyfile.json';
    expect(activeSignerAddress()).toBe(AK_VALIDATOR.validator as `0x${string}`);
  });

  test('a configured signing key wins over the fallback', () => {
    // Well-known test vector; private key 0x01 → a fixed, public address.
    process.env.CELO_VALIDATOR_PRIVATE_KEY =
      '0x0000000000000000000000000000000000000000000000000000000000000001';
    process.env.CELO_VALIDATOR_KEYFILE = '/nonexistent/ci-runner/has/no/keyfile.json';
    expect(activeSignerAddress()).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  });
});
