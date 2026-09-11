/**
 * Arc Testnet viem chain definition.
 *
 * Arc is a USDC-native EVM L1 — gas is paid in USDC with 18-decimal gas
 * accounting (native), while the USDC ERC-20 token uses 6-decimal units.
 * Integration modules construct their own clients and read
 * `process.env.ARC_RPC_URL` for an RPC override (mirrors how the Celo files
 * read `CELO_RPC_URL`); the http url below is the canonical default.
 *
 * Chain ID:   5042002
 * RPC:        https://rpc.drpc.testnet.arc.io  (override: ARC_RPC_URL)
 * Explorer:   https://testnet.arcscan.app
 *
 * On the RPC choice — Arc documents four keyless testnet endpoints, and they
 * are NOT interchangeable. Measured 2026-08-10 with 10k-block getLogs windows:
 *
 *   rpc.testnet.arc.network   1/25 windows   (the old default — hard quota)
 *   rpc.testnet.arc.io        1/25 windows   (Circle primary, same quota)
 *   rpc.quicknode.…           0/25           (rejects keyless calls)
 *   rpc.blockdaemon.…        25/25 recent, but getLogs FAILS on historical
 *                             ranges — fine for the head, useless for backfill
 *   rpc.drpc.…               60/60 sustained, and serves getLogs at a 4M-block
 *                             depth — the only one that can carry a catch-up
 *
 * The quota on the first two is what stalled Arc ingest for 25 days; it is a
 * budget, not a rate, so pacing and backoff cannot work around it. If this
 * endpoint ever degrades, re-run that comparison before assuming the indexer
 * is at fault. See project_arc_ingest_quota_stall.
 */

import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.drpc.testnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  // Canonical Multicall3 is deployed on Arc Testnet (verified on-chain). Declaring
  // it lets viem's client.multicall batch reads (the registry scanner relies on
  // it). blockCreated omitted — viem only uses it to bound a multicall's fromBlock.
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

/**
 * Arc Mainnet viem chain definition.
 *
 * Live and measured 2026-09-06 (Circle never announced it; the chain was
 * already at block ~19.5M). Same USDC-native gas model as testnet: 18-decimal
 * native gas accounting, 6-decimal USDC ERC-20 at the `0x3600…0000` predeploy.
 *
 * Chain ID:   5042
 * RPC:        ARC_MAINNET_RPC_URL — REQUIRED, no default (see below)
 * Explorer:   https://arc-scan.org
 *
 * On the missing default RPC — unlike testnet there is no Circle-published
 * keyless endpoint to fall back to. Every `*.arc.io` / `*.arc.network` mainnet
 * host fails DNS, and the two endpoints Arc's own wallet-add form offers
 * (arc-mainnet.infura.io, *.arc-mainnet.quiknode.pro) are per-account and
 * keyed. The one keyless endpoint found is `https://rpc.arc-scan.org`, a
 * third-party gateway (`arcscan-rpc-gateway/1`) — serviceable, but not
 * something to bake in as a silent default for a chain we score. So this
 * definition ships with an EMPTY default and callers raise when
 * ARC_MAINNET_RPC_URL is absent, matching arc-jobs.ts:496.
 *
 * Measured limits on rpc.arc-scan.org: full archive (genesis-era blocks read
 * fine), eth_getLogs capped at a 10,000-block range when filtering by address
 * AND at 20,000 results. A full backfill is ~1,950 calls; re-measure for quota
 * behaviour before relying on it (project_arc_ingest_quota_stall).
 *
 * NOTE — contract addresses do NOT carry over from testnet. Arc's ERC-8004
 * registries (0x8004A818…/0x8004B663…) and the ERC-8183 escrow have ZERO code
 * on mainnet. The canonical 8004 pair (0x8004A169…/0x8004BAa1…) IS pre-deployed
 * here, but as bare UUPS placeholders — both proxies share one stub
 * implementation and revert on every registry read — so the vanity addresses
 * are reserved, not yet live. Gate any mirror on a supportsInterface(0x80ac58cd)
 * liveness probe and treat a revert as "not live yet", never "zero agents".
 * See the design notes (kept out of this repo). USDC (6-decimal
 * ERC-20 at the 0x3600…0000 predeploy) and Multicall3 are the only confirmed
 * live contracts, which is why only multicall3 is declared here.
 */
export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [] } },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://arc-scan.org" },
  },
  // Canonical Multicall3, verified deployed on Arc mainnet 2026-09-06 (3,808
  // bytes at 0xcA11…CA11). blockCreated omitted — viem only uses it to bound a
  // multicall's fromBlock.
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: false,
});
