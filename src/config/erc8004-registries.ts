/**
 * ERC-8004 registry configs — one entry per EVM chain whose IdentityRegistry +
 * ReputationRegistry AgentKarma mirrors into the `erc8004_agents` /
 * `erc8004_feedback` tables. Celo + Arc share the exact contract shape (the
 * canonical 0x8004… vanity-prefixed reference deployment), so the scanner in
 * `src/indexer/erc8004-registry.ts` is generic and reads from here.
 *
 * Addresses are re-exported from the per-chain integration modules so there is
 * a single source of truth (never duplicate a registry address).
 */

import type { Chain as ViemChain } from 'viem';
import { celo } from 'viem/chains';
import { arcMainnet, arcTestnet } from '@/config/arc-chain';
import type { Chain } from '@/db/schema';
import { IDENTITY_REGISTRY_CELO, REPUTATION_REGISTRY_CELO } from '@/integrations/erc8004-celo';
import { IDENTITY_REGISTRY_ARC, REPUTATION_REGISTRY_ARC } from '@/integrations/erc8004-arc';

export interface Erc8004RegistryConfig {
  /** AK chain key (matches the `chain` column + the `wallets` PK dimension). */
  chain: Extract<Chain, 'celo' | 'arc' | 'arc-mainnet'>;
  /** viem chain definition the scanner builds its public client from. */
  viemChain: ViemChain;
  identityRegistry: `0x${string}`;
  reputationRegistry: `0x${string}`;
  /** Env var name holding an RPC override (falls back to the viem default). */
  rpcEnvVar: string;
  /** First minted token ID; older Celo/Arc testnet registries start at 1. */
  firstAgentId?: 0 | 1;
}

export const ERC8004_REGISTRIES: Record<'celo' | 'arc' | 'arc-mainnet', Erc8004RegistryConfig> = {
  celo: {
    chain: 'celo',
    viemChain: celo,
    identityRegistry: IDENTITY_REGISTRY_CELO,
    reputationRegistry: REPUTATION_REGISTRY_CELO,
    rpcEnvVar: 'CELO_RPC_URL',
  },
  arc: {
    chain: 'arc',
    viemChain: arcTestnet,
    identityRegistry: IDENTITY_REGISTRY_ARC,
    reputationRegistry: REPUTATION_REGISTRY_ARC,
    rpcEnvVar: 'ARC_RPC_URL',
  },
  'arc-mainnet': {
    chain: 'arc-mainnet',
    viemChain: arcMainnet,
    // Independently verified on chain 5042; never inherit the testnet pair.
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    rpcEnvVar: 'ARC_MAINNET_RPC_URL',
    firstAgentId: 0,
  },
};

export function getRegistryConfig(chain: string): Erc8004RegistryConfig | undefined {
  return (ERC8004_REGISTRIES as Record<string, Erc8004RegistryConfig>)[chain];
}
