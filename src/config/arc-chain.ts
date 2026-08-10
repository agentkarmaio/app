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
