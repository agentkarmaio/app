import { describe, expect, test } from 'bun:test';
import { assertIndexingLease, getIndexingHeaders, markIndexingLeaseLost, runWithIndexingContext } from './indexing-context';

describe('indexing request context', () => {
  test('parallel chain jobs keep their own headers across asynchronous calls', async () => {
    expect(getIndexingHeaders()).toEqual({});
    const [arc, stellar] = await Promise.all([
      runWithIndexingContext({ chain: 'arc', path: 'transfers', owner: 'arc-owner' }, async () => {
        await Bun.sleep(10);
        return getIndexingHeaders();
      }),
      runWithIndexingContext({ chain: 'stellar', path: 'registry', owner: 'stellar-owner' }, async () => {
        await Bun.sleep(1);
        return getIndexingHeaders();
      }),
    ]);
    expect(arc).toEqual({ 'x-indexing-chain': 'arc', 'x-indexing-path': 'transfers', 'x-indexing-owner': 'arc-owner' });
    expect(stellar).toEqual({ 'x-indexing-chain': 'stellar', 'x-indexing-path': 'registry', 'x-indexing-owner': 'stellar-owner' });
    expect(getIndexingHeaders()).toEqual({});
  });

  test('renewal failure marks the shared run lost for child callbacks', async () => {
    await runWithIndexingContext({ chain: 'arc', path: 'escrow', owner: 'owner' }, async () => {
      const pending = (async () => {
        await Bun.sleep(10);
        expect(() => getIndexingHeaders()).toThrow('indexing_lease_lost');
      })();
      markIndexingLeaseLost();
      expect(() => assertIndexingLease()).toThrow('indexing_lease_lost');
      await pending;
    });
    expect(() => assertIndexingLease()).not.toThrow();
  });

  test('abort blocks subsequent requests without poisoning the next run', () => {
    const controller = new AbortController();
    runWithIndexingContext({ chain: 'celo', path: 'payments', owner: 'owner', signal: controller.signal }, () => {
      expect(getIndexingHeaders()['x-indexing-chain']).toBe('celo');
      controller.abort();
      expect(() => getIndexingHeaders()).toThrow('indexing_lease_lost');
    });
    runWithIndexingContext({ chain: 'celo', path: 'payments', owner: 'next-owner' }, () => {
      expect(getIndexingHeaders()['x-indexing-owner']).toBe('next-owner');
    });
  });
});
