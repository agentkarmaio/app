/**
 * Bounded-concurrency map. Chain-agnostic — it lived in `indexer/helius.ts`
 * until the Arc transfer indexer needed it, and importing a Solana module from
 * an Arc path to get a generic pool is the kind of coupling that spreads.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order
 * in the returned array. Rejects on the first failure, like `Promise.all`.
 */
export async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
