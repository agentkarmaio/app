/**
 * ERC-8004 Arc Mainnet write path — AgentKarma as a 8004 validator.
 *
 * Folds over the parameterized erc8004-evm factory. AK's mainnet wallet
 * (agentId 228, 0x246D…9e5a) signs giveFeedback records on the ReputationRegistry.
 * The contract blocks self-feedback, so AK MUST target a different agentId
 * than 228.
 *
 * Gas is USDC itself (18-decimal native view) — one attestation measured at
 * cents-scale (register() cost ~0.004 USDC at block 22,731,056).
 */

import { arcMainnet } from '@/config/arc-chain';
import {
  makeEvm8004Publish,
  evmFeeCeilingWei,
  readEvmFeeAccount,
  feedbackHashFromJson,
} from './erc8004-evm';
import type { EvmFeeAccount } from './erc8004-evm';
import { AK_ARC_MAINNET } from '@/config/ak-validator';
import {
  IDENTITY_REGISTRY_ARC_MAINNET,
  REPUTATION_REGISTRY_ARC_MAINNET,
} from './erc8004-arc-mainnet';

const config = {
  chain: arcMainnet,
  identityRegistry: IDENTITY_REGISTRY_ARC_MAINNET,
  reputationRegistry: REPUTATION_REGISTRY_ARC_MAINNET,
  rpcEnv: 'ARC_MAINNET_RPC_URL',
  defaultRpcUrl: 'https://rpc.mainnet.arc.io',
  gasToken: 'USDC',
  validatorKeyfile: AK_ARC_MAINNET.keyfile,
  privateKeyEnv: 'ARC_MAINNET_VALIDATOR_PRIVATE_KEY',
  disclosedSigner: AK_ARC_MAINNET.validator,
} as const;

const publish = makeEvm8004Publish(config);

export const publishFeedback = publish.publishFeedback;
export const activeSignerAddress = publish.activeSignerAddress;
export { feedbackHashFromJson };

/**
 * Runway floor: refuse to start a drip below 0.5 USDC (~100 writes at the
 * measured cents-scale fee), so a dry wallet pages before it empties rather
 * than failing mid-run.
 */
export const MIN_ARC_MAINNET_BALANCE = 0.5;

/**
 * Hard ceiling on what a single attestation may cost, in USDC. Registration
 * measured ~0.004; 0.1 is room for a genuine gas spike while refusing
 * anything an order of magnitude out of band.
 */
export const MAX_FEE_USDC = 0.1;

export function arcMainnetFeeCeilingWei(balanceWei: bigint, maxFeeUsdc = MAX_FEE_USDC): bigint {
  return evmFeeCeilingWei(balanceWei, maxFeeUsdc);
}

export async function readArcMainnetFeeAccount(
  address: `0x${string}`,
  opts: { rpcUrl?: string; minUsdc?: number; getBalance?: (a: `0x${string}`) => Promise<bigint> } = {},
): Promise<EvmFeeAccount> {
  return readEvmFeeAccount(config, address, {
    rpcUrl: opts.rpcUrl,
    minBalance: opts.minUsdc ?? MIN_ARC_MAINNET_BALANCE,
    getBalance: opts.getBalance,
  });
}