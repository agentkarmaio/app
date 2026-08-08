import { describe, expect, test } from 'bun:test';
import { findMissingEnv, optionalEnv, requireEnv } from './require-env';

// Regression guard for the 2026-06-23 floor outage: the keep-fresh /
// heartbeat-drain GitHub Actions ran with their secrets UNSET, which GitHub
// injects as empty strings (not undefined). The job crashed ~8 frames deep in
// the indexer with a cryptic supabase error, and — worse — nothing alerted, so
// the out-of-process ingest floor rotted silently for weeks while ingestion
// stalled. This preflight detects the missing/empty secrets at line 1 with an
// actionable message naming the floor, so the failure is instantly diagnosable.
describe('findMissingEnv', () => {
  const REQUIRED = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

  test('treats empty-string env as missing (the exact GitHub Actions bug)', () => {
    // This is what the failing runs actually received — present keys, empty values.
    const env = { NEXT_PUBLIC_SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' };
    expect(findMissingEnv(env, REQUIRED)).toEqual([
      'NEXT_PUBLIC_SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]);
  });

  test('treats whitespace-only env as missing', () => {
    const env = { NEXT_PUBLIC_SUPABASE_URL: '   ', SUPABASE_SERVICE_ROLE_KEY: '\t' };
    expect(findMissingEnv(env, REQUIRED)).toEqual([
      'NEXT_PUBLIC_SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]);
  });

  test('treats undefined env as missing', () => {
    expect(findMissingEnv({}, REQUIRED)).toEqual([
      'NEXT_PUBLIC_SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]);
  });

  test('reports only the keys that are actually missing', () => {
    const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.co', SUPABASE_SERVICE_ROLE_KEY: '' };
    expect(findMissingEnv(env, REQUIRED)).toEqual(['SUPABASE_SERVICE_ROLE_KEY']);
  });

  test('returns empty when every required key is present', () => {
    const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };
    expect(findMissingEnv(env, REQUIRED)).toEqual([]);
  });
});

describe('requireEnv', () => {
  const REQUIRED = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

  test('throws a single error listing ALL missing keys, naming the floor', () => {
    let err: Error | undefined;
    try {
      requireEnv(REQUIRED, { NEXT_PUBLIC_SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    // Both names in one message — fix all at once, no whack-a-mole.
    expect(err!.message).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(err!.message).toContain('SUPABASE_SERVICE_ROLE_KEY');
    // Actionable: points at the cause (CI secrets) so diagnosis is instant.
    expect(err!.message.toLowerCase()).toContain('secret');
  });

  test('does not throw when all required env is present', () => {
    expect(() =>
      requireEnv(REQUIRED, {
        NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.co',
        SUPABASE_SERVICE_ROLE_KEY: 'k',
      }),
    ).not.toThrow();
  });
});

// ─── optionalEnv ─────────────────────────────────────────────────────────────
//
// Regression family (2026-08-08). The SAME defect shipped three times in one
// day: `opts.x ?? process.env.X ?? DEFAULT` treats an unset GitHub Actions
// secret — which expands to '' — as a real value, producing empty base URLs and
// "fetch() URL is invalid". Fixed in stellar-activity.ts, then stellar-x402.ts,
// then stellar-facilitator-probe.ts, which failed IN CI because the local test
// only ever exercised the var-set path.

describe('optionalEnv', () => {
  test('returns the fallback for an unset key', () => {
    expect(optionalEnv('STELLAR_RPC_URL', 'https://default.example', {})).toBe('https://default.example');
  });

  test('returns the fallback for an EMPTY key (the unset-CI-secret shape)', () => {
    expect(optionalEnv('STELLAR_RPC_URL', 'https://default.example', { STELLAR_RPC_URL: '' }))
      .toBe('https://default.example');
  });

  test('returns the fallback for a whitespace-only key', () => {
    expect(optionalEnv('STELLAR_RPC_URL', 'https://default.example', { STELLAR_RPC_URL: '   ' }))
      .toBe('https://default.example');
  });

  test('returns a real override, trimmed', () => {
    expect(optionalEnv('STELLAR_RPC_URL', 'https://default.example', { STELLAR_RPC_URL: ' https://rpc.example ' }))
      .toBe('https://rpc.example');
  });
});
