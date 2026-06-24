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
import { arcTestnet } from '@/config/arc-chain';
import type { Chain } from '@/db/schema';
import { IDENTITY_REGISTRY_CELO, REPUTATION_REGISTRY_CELO } from '@/integrations/erc8004-celo';
import { IDENTITY_REGISTRY_ARC, REPUTATION_REGISTRY_ARC } from '@/integrations/erc8004-arc';

export interface Erc8004RegistryConfig {
  /** AK chain key (matches the `chain` column + the `wallets` PK dimension). */
  chain: Extract<Chain, 'celo' | 'arc'>;
  /** viem chain definition the scanner builds its public client from. */
  viemChain: ViemChain;
  identityRegistry: `0x${string}`;
  reputationRegistry: `0x${string}`;
  /** Env var name holding an RPC override (falls back to the viem default). */
  rpcEnvVar: string;
}

export const ERC8004_REGISTRIES: Record<'celo' | 'arc', Erc8004RegistryConfig> = {
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
};

export function getRegistryConfig(chain: string): Erc8004RegistryConfig | undefined {
  return (ERC8004_REGISTRIES as Record<string, Erc8004RegistryConfig>)[chain];
}
