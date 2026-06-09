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
 * RPC:        https://rpc.testnet.arc.network  (override: ARC_RPC_URL)
 * Explorer:   https://testnet.arcscan.app
 */

import { defineChain } from 'viem';

export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' } },
  testnet: true,
});
