/**
 * Tx-signature replay guard.
 *
 * In-memory by default — fine for single-instance deploys with a 120s
 * payment window (replays are bounded). Upgrade to KV when scaling out.
 *
 * Standalone server can opt into a file-backed store via
 * `useFileBackedStore(path)` for crash-restart durability.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface ReplayStore {
  has(sig: string): boolean;
  add(sig: string): void;
}

class MemoryStore implements ReplayStore {
  private set = new Set<string>();
  has(sig: string): boolean { return this.set.has(sig); }
  add(sig: string): void { this.set.add(sig); }
}

class FileStore implements ReplayStore {
  private cache = new Set<string>();
  constructor(private path: string) {
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf8')) as { redeemed?: Record<string, number> };
        for (const k of Object.keys(data.redeemed ?? {})) this.cache.add(k);
      } catch {
        // start fresh
      }
    }
  }
  has(sig: string): boolean { return this.cache.has(sig); }
  add(sig: string): void {
    this.cache.add(sig);
    mkdirSync(dirname(this.path), { recursive: true });
    const out: Record<string, number> = {};
    for (const k of this.cache) out[k] = Math.floor(Date.now() / 1000);
    writeFileSync(this.path, JSON.stringify({ redeemed: out }), { mode: 0o600 });
  }
}

let _store: ReplayStore = new MemoryStore();

export function useFileBackedStore(path: string): void {
  _store = new FileStore(path);
}

export function isRedeemed(signature: string): boolean {
  return _store.has(signature);
}

export function markRedeemed(signature: string): void {
  _store.add(signature);
}
