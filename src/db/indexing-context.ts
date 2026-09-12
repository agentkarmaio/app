import { AsyncLocalStorage } from 'node:async_hooks';
import type { Chain } from './schema';

export type IndexingPath = 'payments' | 'escrow' | 'transfers' | 'registry';
export interface IndexingContext {
  chain: Chain;
  path: IndexingPath;
  owner: string;
  signal?: AbortSignal;
}
const context = new AsyncLocalStorage<IndexingContext & { lost?: boolean }>();

export function runWithIndexingContext<T>(value: IndexingContext, fn: () => T): T {
  return context.run({ ...value }, fn);
}

/** Cancels upcoming requests in this asynchronous run, including its children. */
export function markIndexingLeaseLost(): void {
  const current = context.getStore();
  if (current) current.lost = true;
}

export function assertIndexingLease(): void {
  const current = context.getStore();
  if (current?.lost || current?.signal?.aborted) throw new Error('indexing_lease_lost');
}

/** Called at request time by the shared Supabase fetch, never at client init. */
export function getIndexingHeaders(): Record<string, string> {
  assertIndexingLease();
  const current = context.getStore();
  return current ? {
    'x-indexing-chain': current.chain,
    'x-indexing-path': current.path,
    'x-indexing-owner': current.owner,
  } : {};
}
