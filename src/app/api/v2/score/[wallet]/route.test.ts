/// <reference types="bun-types" />
/**
 * GET /api/v2/score/{wallet} — chain pinning.
 *
 * An EVM address can hold rows on BOTH celo and arc (same key format). Without
 * a pin the route had to guess (detectChain → null → rows[0]), which returned a
 * well-formed snapshot for an arbitrary chain. `?chain=` pins the lookup; a pin
 * that mismatches the address format is a 400, never a silent downgrade.
 */
import { describe, expect, test } from 'bun:test';
import { GET, pickWalletRow } from './route';

const EVM = '0xcfc0a11c75519faf85b7872e27733cfaa4295b96';
const SOL = '4VRzfgGq8VkUH8PFiwzD3dDYkGNijvA1MCkP6Zwn8eYn';
const row = (chain: string) => ({ chain, address: EVM }) as never;

describe('pickWalletRow', () => {
  test('pinned chain wins over row order', () => {
    expect(pickWalletRow([row('celo'), row('arc')], EVM, 'arc')?.chain).toBe('arc');
  });
  test('pinned chain with no matching row → null (no fallback to another chain)', () => {
    expect(pickWalletRow([row('celo')], EVM, 'arc')).toBeNull();
  });
  test('unpinned single row is returned', () => {
    expect(pickWalletRow([row('celo')], EVM, null)?.chain).toBe('celo');
  });
  test('unpinned, format-detectable address prefers the detected chain', () => {
    const rows = [{ chain: 'celo', address: SOL }, { chain: 'solana', address: SOL }] as never[];
    expect(pickWalletRow(rows, SOL, null)?.chain).toBe('solana');
  });
});

describe('GET ?chain= validation', () => {
  const get = (url: string, wallet: string) =>
    GET(new Request(url) as never, { params: Promise.resolve({ wallet }) });

  test('unknown chain → 400', async () => {
    const res = await get(`http://x/api/v2/score/${EVM}?chain=polygon`, EVM);
    expect(res.status).toBe(400);
  });
  test('chain that mismatches the address format → 400', async () => {
    const res = await get(`http://x/api/v2/score/${SOL}?chain=celo`, SOL);
    expect(res.status).toBe(400);
  });
});
