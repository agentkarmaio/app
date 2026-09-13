import { expect, test } from 'bun:test';
import { assertLegacyGapWriteAllowed } from './legacy-gap-guard';

test('legacy recovery refuses writes while managed Solana polling is enabled', async () => {
  await expect(assertLegacyGapWriteAllowed(async () => ({
    data: { enabled: true, owner: null, lease_until: null }, error: null,
  }))).rejects.toThrow('intentionally paused');
});
test('paused managed polling allows legacy recovery only after active work releases ownership', async () => {
  await expect(assertLegacyGapWriteAllowed(async () => ({
    data: { enabled: false, owner: 'private-owner', lease_until: '2099-01-01T00:00:00Z' }, error: null,
  }))).rejects.toThrow('active lease');
  await assertLegacyGapWriteAllowed(async () => ({ data: { enabled: false, owner: null, lease_until: null }, error: null }));
});
test('absent pre-migration state preserves the legacy recovery entrypoint', async () => {
  for (const code of ['42P01', 'PGRST205']) await assertLegacyGapWriteAllowed(async () => ({ data: null, error: { code } }));
  await assertLegacyGapWriteAllowed(async () => ({ data: null, error: null }));
});
test('unknown database errors fail closed without printing private payloads', async () => {
  await expect(assertLegacyGapWriteAllowed(async () => ({ data: null, error: { code: '57014' } }))).rejects.toThrow('state could not be verified');
});
