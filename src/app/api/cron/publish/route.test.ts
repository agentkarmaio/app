/// <reference types="bun-types" />
import { describe, expect, test, beforeEach } from 'bun:test';
import { __setPublishDepsForTest } from '@/integrations/publish';
import { POST } from './route';

describe('POST /api/cron/publish chain routing', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'secret';
    __setPublishDepsForTest({
      getLeaderboard: async () => ({ wallets: [{ address: 'GW' }], total: 1 }),
      getTransactions: async () => [{ tx_signature: 'x' }],
      calculateScore: () => ({ score: 80, trustTier: 'Good' }),
      getAdapter: (chain: string) => ({
        chain, async readAttestation() { return 0; },
        async publishAttestation(address: string) { return { address, dryRun: false, skipped: false, txId: `${chain}_tx` }; },
      }),
    });
  });

  test('passes body.chain to publishTopScores', async () => {
    const req = new Request('http://x/api/cron/publish', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'stellar', limit: 1 }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any);
    const json = await res.json();
    expect(json.details[0].signature).toBe('stellar_tx');
  });

  test('rejects an invalid chain with 400', async () => {
    const req = new Request('http://x/api/cron/publish', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'bitcoin' }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any);
    expect(res.status).toBe(400);
  });
});
