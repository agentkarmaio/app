/// <reference types="bun-types" />
/**
 * parseAgentKarmaManifest — `succession` block carry-through. The manifest
 * resolver only shape-checks the block; the full bounds/heir/self-heir
 * validation runs later in the succession write-path. These tests pin that the
 * block is surfaced (or dropped) correctly so the refresh route can declare it.
 *
 * Run: bun test src/integrations/manifest-succession.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { parseAgentKarmaManifest } from './manifest';

function manifest(succession: unknown) {
  return { schema: 'agentkarma.v1', name: 'Bot', succession };
}

describe('parseAgentKarmaManifest succession carry-through', () => {
  test('surfaces a well-formed succession block', () => {
    const p = parseAgentKarmaManifest(manifest({
      intervalSeconds: 604800,
      heirs: [{ address: 'HEIR', chain: 'solana', share: 2, label: 'primary' }],
    }));
    expect(p?.succession).toBeDefined();
    expect(p?.succession?.intervalSeconds).toBe(604800);
    expect(p?.succession?.heirs).toHaveLength(1);
    expect(p?.succession?.heirs[0].chain).toBe('solana');
    expect(p?.succession?.heirs[0].share).toBe(2);
  });

  test('accepts snake_case interval_seconds', () => {
    const p = parseAgentKarmaManifest(manifest({
      interval_seconds: 86400,
      heirs: [{ address: 'HEIR', chain: 'celo' }],
    }));
    expect(p?.succession?.intervalSeconds).toBe(86400);
  });

  test('drops a block with no usable heirs (bad chain filtered out)', () => {
    const p = parseAgentKarmaManifest(manifest({
      intervalSeconds: 604800,
      heirs: [{ address: 'HEIR', chain: 'bitcoin' }],
    }));
    expect(p?.succession).toBeUndefined();
  });

  test('drops a block with a non-numeric interval', () => {
    const p = parseAgentKarmaManifest(manifest({
      intervalSeconds: 'soon',
      heirs: [{ address: 'HEIR', chain: 'solana' }],
    }));
    expect(p?.succession).toBeUndefined();
  });

  test('manifest with no succession block parses fine, succession undefined', () => {
    const p = parseAgentKarmaManifest({ schema: 'agentkarma.v1', name: 'Bot' });
    expect(p).not.toBeNull();
    expect(p?.succession).toBeUndefined();
  });
});
