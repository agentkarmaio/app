/**
 * The highest block a getLogs scan should ask for.
 *
 * Forno balances requests across backends that disagree on the tip, so a block
 * number read from one can be past the backend serving the next call. That call
 * answers `-32019 block is out of range`, measured on 11 of 60 head-then-getLogs
 * pairs, and failed celo/payments 5 times in 60 recovery runs (2026-11). One block
 * of margin cleared it in the same measurement. Sixteen leaves room for a slower
 * backend and costs nothing: a cursor-based scan picks those blocks up next run.
 */
export const INDEXABLE_HEAD_MARGIN_BLOCKS = BigInt(16);

export async function readIndexableHead(client: { getBlockNumber: () => Promise<bigint> }): Promise<bigint> {
  const tip = await client.getBlockNumber();
  return tip > INDEXABLE_HEAD_MARGIN_BLOCKS ? tip - INDEXABLE_HEAD_MARGIN_BLOCKS : BigInt(0);
}
