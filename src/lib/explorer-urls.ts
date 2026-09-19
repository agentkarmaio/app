/**
 * Block-explorer URLs for every chain, in a module a client component can
 * import.
 *
 * The ChainAdapters own `explorerTxUrl` / `explorerAddressUrl` in the type
 * system, but they cannot be the source a browser bundle reads from: each
 * adapter pulls its indexer and RPC client in with it (`@/indexer/*`,
 * `@/db/client`, `@solana/web3.js`, `viem`), so importing the registry into a
 * `'use client'` component drags the server into the browser. The adapters
 * therefore DELEGATE here rather than each holding its own copy — one place
 * defines each URL shape, and `explorer-urls.test.ts` pins the exact strings
 * the adapter tests already assert.
 *
 * Paths differ per explorer family, which is the whole reason this is a table
 * and not string concatenation at the call site: Solscan uses /account, the
 * EVM scanners use /address, and stellar.expert nests under /explorer/public.
 */

import type { Chain } from '@/db/schema';

interface ExplorerPaths {
  /** Base for a transaction page, without the id. */
  tx: string;
  /** Base for an account/address page, without the address. */
  address: string;
}

const EXPLORERS: Record<Chain, ExplorerPaths> = {
  solana: {
    tx: 'https://solscan.io/tx/',
    address: 'https://solscan.io/account/',
  },
  celo: {
    tx: 'https://celoscan.io/tx/',
    address: 'https://celoscan.io/address/',
  },
  stellar: {
    tx: 'https://stellar.expert/explorer/public/tx/',
    address: 'https://stellar.expert/explorer/public/account/',
  },
  arc: {
    tx: 'https://testnet.arcscan.app/tx/',
    address: 'https://testnet.arcscan.app/address/',
  },
  'arc-mainnet': {
    tx: 'https://explorer.arc.io/tx/',
    address: 'https://explorer.arc.io/address/',
  },
};

/**
 * Link to one transaction. The id is passed through unencoded: every chain's
 * transaction id is already URL-safe (base58, 0x-hex, or Stellar's base16), and
 * encoding would corrupt nothing but would hide a malformed id behind a link
 * that looks fine.
 *
 * `arc-mainnet` receipt ids carry a `:logIndex` suffix that its adapter strips
 * before calling here — do not pass a raw receipt id to this function.
 */
export function explorerTxUrl(chain: Chain, txId: string): string {
  return `${EXPLORERS[chain].tx}${txId}`;
}

/** Link to one account / address page. */
export function explorerAddressUrl(chain: Chain, address: string): string {
  return `${EXPLORERS[chain].address}${address}`;
}
