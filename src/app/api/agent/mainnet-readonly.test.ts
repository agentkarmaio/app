import { expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { POST as prove } from './prove/route';
import { POST as edit } from './edit/route';
import { POST as claim } from './claim/evm/route';

for (const [name, handler] of [['prove', prove], ['edit', edit], ['claim/evm', claim]] as const) {
  test(`mainnet ${name} cannot accept a legacy network-unbound ownership challenge`, async () => {
    const response = await handler(new NextRequest(`https://agentkarma.io/api/agent/${name}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain: 'arc-mainnet', address: '0x558e7bfaf2cf1a494f44e50d92431afc060c9d12', walletAddress: '0x558e7bfaf2cf1a494f44e50d92431afc060c9d12', displayName: 'Agent', signature: 'legacy', message: 'legacy' }),
    }));
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: 'Arc mainnet ownership changes are not enabled' });
  });
}
