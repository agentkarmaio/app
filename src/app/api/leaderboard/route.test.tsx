import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import * as db from '@/db/client';
import * as limits from '@/lib/rate-limit';
import type { Wallet } from '@/db/schema';
import { LeaderboardTable, type LeaderboardEntry } from '@/components/karma/leaderboard-table';
import { GET } from './route';

const address = `0x${'1'.repeat(40)}`;
const restores: Array<() => void> = [];
function track<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }
afterEach(() => restores.splice(0).reverse().forEach(restore => restore()));
beforeEach(() => track(spyOn(limits, 'enforceRateLimit').mockResolvedValue({ ok: true, headers: {} } as never)));
function setup(rows: Partial<Wallet>[]) {
  track(spyOn(db, 'getLeaderboard').mockResolvedValue({ wallets: rows as Wallet[], total: rows.length }));
  const delivery = track(spyOn(db, 'getFeedbackSummariesForWallets').mockResolvedValue(new Map([[address, { total: 2, delivered: 2, failed: 0, deliveryRate: 1 }]])));
  const history = track(spyOn(db, 'getScoreHistoriesForWallets').mockResolvedValue(new Map([[address, [{ score: 99, calculated_at: '2026-09-19T00:00:00Z' }]]])));
  return { delivery, history };
}
const mainnet = (id: number): Partial<Wallet> => ({ chain: 'arc-mainnet', address, arc_agent_id: id,
  score: 0, provider_score: null as unknown as number, consumer_score: 14, tx_count: 1,
  trust_tier: 'Unrated', confidence_badge: 'declared', last_seen: null });
const get = () => GET(new NextRequest('http://localhost/api/leaderboard?chain=arc-mainnet'));

test('mainnet absent provider stays null and registry zero is preserved without legacy enrichment', async () => {
  const state = setup([mainnet(0), mainnet(1)]);
  const body = await (await get()).json();
  expect(body.wallets.map((w: {agentId:number}) => w.agentId)).toEqual([0, 1]);
  expect(body.wallets[0]).toMatchObject({ score: null, providerScore: null, consumerScore: 14, delivery: null, trend: [] });
  expect(state.delivery).not.toHaveBeenCalled();
  expect(state.history).not.toHaveBeenCalled();
});

test('mixed-chain results exclude mainnet from lookups and shared-address enrichment', async () => {
  const state = setup([mainnet(0), { chain: 'solana', address, score: 33, provider_score: 33 }]);
  const body = await (await get()).json();
  expect(state.delivery).toHaveBeenCalledWith([address]);
  expect(state.history).toHaveBeenCalledWith([address]);
  expect(body.wallets[0]).toMatchObject({ delivery: null, trend: [], score: null });
  expect(body.wallets[1]).toMatchObject({ score: 33, providerScore: 33, delivery: { total: 2, deliveryRate: 1 }, trend: [99] });
});

test('an observed mainnet provider score of zero remains an assessed zero', async () => {
  setup([{ ...mainnet(2), provider_score: 0, confidence_badge: 'behavior-inferred' }]);
  expect((await (await get()).json()).wallets[0]).toMatchObject({ score: 0, providerScore: 0 });
});

test('mainnet table renders an absent score and distinct links for a shared wallet', () => {
  const entries = [0, 1].map(agentId => ({ rank: agentId + 1, chain: 'arc-mainnet', address,
    agentId, score: null, trustTier: 'Unrated', txCount: 0, lastSeen: null })) as LeaderboardEntry[];
  const table = LeaderboardTable({ entries });
  const rows = table.props.children[1].props.children;
  expect(new Set(rows.map((row: {key:string}) => row.key)).size).toBe(2);
  const html = renderToStaticMarkup(table);
  expect(html).toContain('chain=arc-mainnet&amp;agentId=0');
  expect(html).toContain('chain=arc-mainnet&amp;agentId=1');
  expect(html).not.toContain('>0.0<');
});
