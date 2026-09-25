/**
 * ERC-8004 Arc (chain 5042) — read surface.
 *
 * Folds over the parameterized erc8004-evm factory; canonical registries are
 * deployed at the same vanity-prefixed addresses as Celo's. arcMainnet's viem
 * chain object declares no rpcUrls, so the factory always needs an explicit
 * endpoint: ARC_MAINNET_RPC_URL env → the launch-verified official public RPC.
 *
 *   IdentityRegistry:   0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 *   ReputationRegistry: 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
 */

import { arcMainnet } from '@/config/arc-chain';
import { makeEvm8004Reads } from './erc8004-evm';

export const IDENTITY_REGISTRY_ARC_MAINNET = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;
export const REPUTATION_REGISTRY_ARC_MAINNET = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const;

const reads = makeEvm8004Reads({
  chain: arcMainnet,
  identityRegistry: IDENTITY_REGISTRY_ARC_MAINNET,
  reputationRegistry: REPUTATION_REGISTRY_ARC_MAINNET,
  rpcEnv: 'ARC_MAINNET_RPC_URL',
  defaultRpcUrl: 'https://rpc.mainnet.arc.io',
  gasToken: 'USDC',
});

export const readAgent = reads.readAgent;
export const readFeedbackSummary = reads.readFeedbackSummary;
export const aggregateFeedback = reads.aggregateFeedback;
export const readAllFeedback = reads.readAllFeedback;