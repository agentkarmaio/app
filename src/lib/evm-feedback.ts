/**
 * EVM ReputationRegistry feedback — client-side write path.
 *
 * Lets any connected EVM wallet publish an ERC-8004 `giveFeedback` record about
 * a Celo / Arc agent, straight from the browser. The on-chain record IS the
 * storage: the agent profile reads it back via aggregateFeedback (no tag
 * filter), so an independent review increments the profile's on-chain count/avg
 * with no AK-side database row.
 *
 * Pure helpers (encode / starsToValue / feedbackChainConfig) are unit-tested;
 * the provider-taking helpers (ensureChain / submitFeedback) drive the wallet.
 */
import { encodeFunctionData, parseAbi, toHex, type Hex } from 'viem';
import { celo } from 'viem/chains';
import { arcTestnet } from '@/config/arc-chain';
import type { Eip1193Provider } from '@/components/wallet/evm-wallet-provider';

export type EvmFeedbackChain = 'celo' | 'arc';

/** AK's human-review scheme — distinct from the algorithmic 'agentkarma_metadata' tag. */
export const REVIEW_TAG1 = 'agentkarma_review';
export const REVIEW_SCHEME_VERSION = 'v0.1';

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export const GIVE_FEEDBACK_ABI = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);

/** 1-5 stars → 0-100 scale, commensurable with AK's metadata-quality score. */
export function starsToValue(stars: number): number {
  return Math.max(1, Math.min(5, Math.round(stars))) * 20;
}

export interface FeedbackArgs {
  agentId: number | bigint;
  /** 0-100, valueDecimals 0. */
  value: number;
  tag1?: string;
  tag2?: string;
}

export function encodeGiveFeedback(args: FeedbackArgs): Hex {
  return encodeFunctionData({
    abi: GIVE_FEEDBACK_ABI,
    functionName: 'giveFeedback',
    args: [
      BigInt(args.agentId),
      BigInt(args.value),
      0,
      args.tag1 ?? REVIEW_TAG1,
      args.tag2 ?? REVIEW_SCHEME_VERSION,
      '', // endpoint
      '', // feedbackURI — no off-chain content in v1
      ZERO_HASH,
    ],
  });
}

// Registry addresses mirror erc8004-celo.ts / erc8004-arc.ts. Immutable deploys;
// kept here so this client module doesn't pull the server-side reader modules
// (and their RPC clients) into the browser bundle.
const REGISTRY: Record<EvmFeedbackChain, `0x${string}`> = {
  celo: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  arc: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
};

const VIEM_CHAIN = { celo, arc: arcTestnet } as const;

export interface EvmFeedbackChainConfig {
  chainIdHex: `0x${string}`;
  registry: `0x${string}`;
  explorerTxUrl: (hash: string) => string;
  /** EIP-3085 wallet_addEthereumChain params, for wallets that don't know the chain. */
  addChainParams: Record<string, unknown>;
}

export function feedbackChainConfig(chain: EvmFeedbackChain): EvmFeedbackChainConfig {
  const vc = VIEM_CHAIN[chain];
  const explorer = vc.blockExplorers!.default.url;
  return {
    chainIdHex: toHex(vc.id),
    registry: REGISTRY[chain],
    explorerTxUrl: (hash) => `${explorer}/tx/${hash}`,
    addChainParams: {
      chainId: toHex(vc.id),
      chainName: vc.name,
      nativeCurrency: vc.nativeCurrency,
      rpcUrls: [vc.rpcUrls.default.http[0]],
      blockExplorerUrls: [explorer],
    },
  };
}

/** Switch the wallet to the target chain, adding it (EIP-3085) if unknown. */
export async function ensureChain(provider: Eip1193Provider, chain: EvmFeedbackChain): Promise<void> {
  const cfg = feedbackChainConfig(chain);
  const current = await provider.request<string>({ method: 'eth_chainId' });
  if (typeof current === 'string' && current.toLowerCase() === cfg.chainIdHex.toLowerCase()) return;
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: cfg.chainIdHex }],
    });
  } catch (err: unknown) {
    // 4902 = chain not added to the wallet → add it (which also selects it).
    if ((err as { code?: number })?.code === 4902) {
      await provider.request({ method: 'wallet_addEthereumChain', params: [cfg.addChainParams] });
    } else {
      throw err;
    }
  }
}

/**
 * Publish a feedback record. Ensures the wallet is on the target chain, then
 * sends giveFeedback. Returns the tx hash immediately (before mining) — the
 * caller links it to the explorer.
 */
export async function submitFeedback(
  provider: Eip1193Provider,
  from: `0x${string}`,
  chain: EvmFeedbackChain,
  args: FeedbackArgs,
): Promise<`0x${string}`> {
  await ensureChain(provider, chain);
  const cfg = feedbackChainConfig(chain);
  return provider.request<`0x${string}`>({
    method: 'eth_sendTransaction',
    params: [{ from, to: cfg.registry, data: encodeGiveFeedback(args) }],
  });
}
