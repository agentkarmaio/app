import { afterEach, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { POST as prove } from './prove/route';
import { POST as edit } from './edit/route';
import { POST as claim } from './claim/evm/route';
import { POST as manifest } from './manifest/refresh/route';
import { POST as refresh } from '../score/refresh/route';
import { POST as heartbeat } from '../cron/heartbeat/route';
import { POST as publish } from '../cron/publish/route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { __setSupabaseForTest } from '@/db/client';
import { declareSuccession } from '@/successions/declare';
import { GET as registration } from '@/app/well-known/agent.json/route';

const error = 'Arc testnet is retired. Historical profiles remain read-only.';
const env = { cron: process.env.CRON_SECRET, refresh: process.env.SCORE_REFRESH_TOKEN };
afterEach(() => {
  __setSupabaseForTest(null);
  __resetRateLimitForTests();
  for (const [key, value] of [['CRON_SECRET', env.cron], ['SCORE_REFRESH_TOKEN', env.refresh]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

for (const [path, handler] of [
  ['agent/prove', prove], ['agent/edit', edit], ['agent/claim/evm', claim],
  ['agent/manifest/refresh', manifest], ['score/refresh', refresh],
  ['cron/heartbeat', heartbeat], ['cron/publish', publish],
] as const) {
  test(`${path} retires Arc testnet before wallet or network access`, async () => {
    process.env.CRON_SECRET = 'retirement-test';
    process.env.SCORE_REFRESH_TOKEN = 'retirement-test';
    __setSupabaseForTest({ from() { throw new Error('Unexpected DB access'); } });
    const response = await handler(new NextRequest(`https://agentkarma.io/api/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer retirement-test' },
      body: JSON.stringify({ chain: 'arc' }),
    }));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error });
  });
}

test('an unpinned manifest refresh cannot mutate a resolved historical testnet wallet', async () => {
  // Only a stored row is supplied; all downstream writes fail loudly.
  __setSupabaseForTest({
    from() {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        single: async () => ({ data: null, error: null }),
        then: (resolve: (result: unknown) => void) => resolve({ data: [{ chain: 'arc', address: '0x' + '12'.repeat(20), website: null }], error: null }),
      };
      return query;
    },
  });
  const response = await manifest(new NextRequest('https://agentkarma.io/api/agent/manifest/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: '0x' + '12'.repeat(20) }),
  }));
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({ error });
});

test('testnet succession declaration stops before any DB write', async () => {
  __setSupabaseForTest({ from() { throw new Error('Unexpected DB access'); } });
  expect(await declareSuccession({ chain: 'arc', agentWallet: '0x' + '12'.repeat(20), sourceType: 'self_hosted', plan: {} }))
    .toEqual({ ok: false, error });
});

test('active registration metadata omits the retired testnet identity', async () => {
  const body = await registration().json();
  expect(body.identities.some((identity: { chain: string }) => identity.chain === 'arc')).toBe(false);
  expect(body.registrations.some((entry: { agentRegistry: string }) => entry.agentRegistry.startsWith('eip155:5042002:'))).toBe(false);
  expect(body.registrations.some((entry: { agentRegistry: string }) => entry.agentRegistry.startsWith('eip155:42220:'))).toBe(true);
});

test('testnet on-chain publishing rejects simulation and execution before loading a key', async () => {
  const { publishFeedback } = await import('@/integrations/erc8004-arc-publish');
  for (const mode of ['simulate', 'execute'] as const) {
    await expect(publishFeedback({ agentId: 1, value: 80, valueDecimals: 0, tag1: 'karma', tag2: 'test' }, mode))
      .rejects.toThrow('Arc testnet is retired');
  }
});

test('retired heartbeat records are untouched even through a direct evaluation or drain', async () => {
  const { evaluateOneHeartbeat, drainHeartbeatsOnce } = await import('@/successions/heartbeat-worker');
  __setSupabaseForTest({ from() { throw new Error('Unexpected DB access'); } });
  for (const status of ['declared', 'live', 'lapsed', 'executed', 'revoked'] as const) {
    expect(await evaluateOneHeartbeat({ chain: 'arc', status } as Parameters<typeof evaluateOneHeartbeat>[0])).toBe('skipped');
  }
  await expect(drainHeartbeatsOnce(10, 'arc')).resolves.toMatchObject({ claimed: 0, transitioned: 0, errors: [] });
});

for (const archiveExists of [false, true]) {
  test(`legacy score reads pinned archive without scan writes (exists=${archiveExists})`, async () => {
    const { GET } = await import('@/app/api/score/[wallet]/route');
    const filters: string[] = [];
    const wallet = '0x' + '12'.repeat(20);
    __setSupabaseForTest({ from(table: string) {
      let chain: string | undefined;
      const query = {
        select: () => query, order: () => query,
        eq: (column: string, value: string) => { filters.push(`${table}.${column}=${value}`); if (column === 'chain') chain = value; return query; },
        single: async () => ({ data: chain === 'arc' && archiveExists ? { chain, address: wallet, score: 45, provider_score: 45, metric_success_rate: 0.9, tx_count: 7, scan_state: 'pending' } : null, error: null }),
        range: async () => ({ data: [], error: null }),
      };
      return query;
    } });
    const response = await GET(new NextRequest(`https://agentkarma.io/api/score/${wallet}?chain=arc`), { params: Promise.resolve({ wallet }) });
    expect(response.status).toBe(archiveExists ? 200 : 404);
    expect(filters).toContain('wallets.chain=arc');
    expect(filters).not.toContain('wallets.chain=solana');
    const result = await response.json();
    expect(result.scanning).toBeUndefined();
    if (archiveExists) expect(result).toMatchObject({ providerScore: 45, metrics: { successRate: 0.9, loyalty: null }, txCount: 7, chain: 'arc', readOnly: true });
  });
}

for (const chain of ['celo', 'arc-mainnet']) {
  test(`explicit ${chain} manifest lookup cannot select the same address on testnet`, async () => {
    const reads: string[] = [];
    const wallet = '0x' + '12'.repeat(20);
    __setSupabaseForTest({ from() {
      let selectedChain: string | undefined;
      const query = {
        select: () => query, order: () => query,
        eq: (column: string, value: string) => { if (column === 'chain') { reads.push(value); selectedChain = value; } return query; },
        single: async () => ({ data: selectedChain === chain ? { chain, address: wallet, website: null } : null, error: null }),
        then: (resolve: (result: unknown) => void) => resolve({ data: [{ chain: 'arc', address: wallet }, { chain, address: wallet, website: null }], error: null }),
      };
      return query;
    } });
    const response = await manifest(new NextRequest('https://agentkarma.io/api/agent/manifest/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chain, wallet }),
    }));
    expect(response.status).toBe(200);
    expect(reads).toEqual([chain]);
    expect(await response.json()).toMatchObject({ resolved: false, reason: 'wallet has no declared website' });
  });
}

for (const chain of ['celo', 'arc-mainnet']) {
  test(`manifest persistence scopes ${chain} identity and conflict key`, async () => {
    const { upsertAgentManifest } = await import('@/db/client');
    const writes: unknown[] = [];
    __setSupabaseForTest({ from(table: string) { return { upsert: async (row: unknown, options: unknown) => {
      writes.push({ table, row, options }); return { error: null };
    } }; } });
    await upsertAgentManifest({ chain, agentWallet: '0x' + '12'.repeat(20), sourceType: 'self_hosted', url: null, raw: null, parsed: null, verified: false } as Parameters<typeof upsertAgentManifest>[0]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ table: 'agent_manifests', row: { chain }, options: { onConflict: 'chain,agent_wallet,source_type' } });
  });
}

for (const chain of ['arc', 'arc-mainnet', 'celo', 'solana'] as const) {
  test(`manifest reads isolate ${chain} from identical wallet addresses on other networks`, async () => {
    const { getAgentManifestsForWallet, getAgentManifestsForWallets } = await import('@/db/client');
    const rows = ['arc', 'arc-mainnet', 'celo', 'solana'].map(network => ({ chain: network, agent_wallet: 'shared', source_type: 'self_hosted', url: `https://${network}.example.com` }));
    __setSupabaseForTest({ from() {
      const filters: Record<string, string> = {};
      const query = {
        select: () => query, in: () => query, order: () => query,
        eq: (key: string, value: string) => { filters[key] = value; return query; },
        then: (resolve: (result: unknown) => void) => resolve({ data: rows.filter(row => Object.entries(filters).every(([key, value]) => row[key as keyof typeof row] === value)), error: null }),
      };
      return query;
    } });
    expect((await getAgentManifestsForWallet('shared', chain)).map(row => row.url)).toEqual([`https://${chain}.example.com`]);
    expect((await getAgentManifestsForWallets(['shared'], chain)).get('shared')?.map(row => row.url)).toEqual([`https://${chain}.example.com`]);
  });
}
