/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { supabaseServerUrl } from './client';

describe('supabaseServerUrl', () => {
  test('prefers the in-cluster URL so server queries skip the public edge', () => {
    expect(supabaseServerUrl({
      SUPABASE_INTERNAL_URL: 'http://kong:8000',
      NEXT_PUBLIC_SUPABASE_URL: 'https://agentkarma-db.srvl.app',
    })).toBe('http://kong:8000');
  });

  test('falls back to the public URL off-cluster (laptop, CI, indexer hosts)', () => {
    expect(supabaseServerUrl({ NEXT_PUBLIC_SUPABASE_URL: 'https://agentkarma-db.srvl.app' }))
      .toBe('https://agentkarma-db.srvl.app');
  });

  test('treats an empty internal URL as unset (unset secrets arrive as "")', () => {
    expect(supabaseServerUrl({ SUPABASE_INTERNAL_URL: '', NEXT_PUBLIC_SUPABASE_URL: 'https://x.test' }))
      .toBe('https://x.test');
  });

  test('undefined when neither is set', () => {
    expect(supabaseServerUrl({})).toBeUndefined();
  });
});
