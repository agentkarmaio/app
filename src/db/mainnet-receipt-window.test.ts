import { afterEach, expect, test } from 'bun:test';
import { __setSupabaseForTest, getArcMainnetReceiptEvents } from './client';

afterEach(() => __setSupabaseForTest(null));
const wallet = `0x${'1'.repeat(40)}`;
function database(size: number, failPage = -1) {
  const rows = Array.from({ length: size }, (_, i) => ({ id: `00000000-0000-0000-0000-${(size-i).toString(16).padStart(12, '0')}`,
    observed_at: '2026-09-12T00:00:00.000Z', chain: 'arc-mainnet', agent_wallet: wallet, kind: 'usdc_transfer_settled' }));
  const pages: Array<{ orders: string[]; range?: [number, number]; cursor?: string; filters: Record<string, unknown> }> = [];
  __setSupabaseForTest({ from(table: string) {
    expect(table).toBe('signal_events');
    const page: typeof pages[number] = { orders: [], filters: {} }; pages.push(page);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (key: string, value: unknown) => { page.filters[key] = value; return b; };
    b.order = (key: string, opts: { ascending: boolean }) => { expect(opts.ascending).toBe(false); page.orders.push(key); return b; };
    b.or = (cursor: string) => { page.cursor = cursor; return b; };
    b.range = (from: number, to: number) => { page.range = [from, to]; return b; };
    b.then = (resolve: (r: unknown) => void) => {
      const lastId = page.cursor?.match(/id\.lt\.([0-9a-f-]+)/)?.[1];
      const eligible = rows.filter(row => !lastId || row.id < lastId);
      const data = eligible.slice(page.range?.[0] ?? 0, Math.min((page.range?.[1] ?? 999) + 1, 1000));
      resolve({ data, error: pages.length === failPage ? { message: 'page failed' } : null });
    };
    return b;
  } });
  return { rows, pages };
}

test('mainnet window reads beyond PostgREST1000 using stable time/id boundaries', async () => {
  const { rows, pages } = database(1500);
  for (const row of rows) row.observed_at = '2026-09-12T00:00:00.123456Z';
  const result = await getArcMainnetReceiptEvents(wallet);
  expect(result.events.map(row => row.id)).toEqual(rows.map(row => row.id));
  expect(result.saturated).toBe(false);
  expect(pages).toHaveLength(2);
  for (const page of pages) {
    expect(page.orders).toEqual(['observed_at', 'id']);
    expect(page.filters).toEqual({ chain: 'arc-mainnet', agent_wallet: wallet, kind: 'usdc_transfer_settled' });
    expect(page.range).toEqual([0, 999]);
  }
  expect(pages[1].cursor).toContain(`id.lt.${rows[999].id}`);
  expect(pages[1].cursor).toContain('observed_at.eq.2026-09-12T00:00:00.123456Z');
});
test('ten thousand actual rows plus one lookahead reports truncation without scoring lookahead', async () => {
  const { pages } = database(10002);
  const result = await getArcMainnetReceiptEvents(wallet);
  expect(result.events).toHaveLength(10000);
  expect(result.saturated).toBe(true);
  expect(pages).toHaveLength(11);
  expect(pages[10].range).toEqual([0, 0]);
});
test('exactly ten thousand rows without more does not report truncation', async () => {
  database(10000);
  expect((await getArcMainnetReceiptEvents(wallet)).saturated).toBe(false);
});
test('a late page error rejects the whole score window', async () => {
  database(1500, 2);
  await expect(getArcMainnetReceiptEvents(wallet)).rejects.toMatchObject({ message: 'page failed' });
});
