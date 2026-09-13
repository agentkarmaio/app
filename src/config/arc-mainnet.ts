/** Arc mainnet receipt configuration. Never inherits testnet RPCs or membership.
 * Event provenance: https://docs.arc.io/arc/references/usdc-system-events.md
 */
export const ARC_MAINNET_CHAIN_ID = 5042;
export const ARC_MAINNET_USDC_CONTRACT = '0x3600000000000000000000000000000000000000' as const;
export const ARC_MAINNET_TRANSFER_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe' as const;
export const ARC_MAINNET_TRANSFER_DECIMALS = 18;
export const ARC_MAINNET_TRANSFER_EXCLUSIONS: ReadonlySet<string> = new Set([
  '0x0000000000000000000000000000000000000000',
  ARC_MAINNET_USDC_CONTRACT,
  ARC_MAINNET_TRANSFER_EMITTER,
]);
/** Only independently verified mainnet operators belong here. Empty by default. */
export const ARC_MAINNET_SEED_EXTRA: readonly string[] = [];
export const ARC_MAINNET_MAX_SEED_SIZE = 10_000;

/** Explicit operator-approved mainnet membership; never read testnet settings. */
export function parseArcMainnetSeedAddresses(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const addresses = raw.split(',').map(address => address.trim().toLowerCase());
  if (addresses.length > ARC_MAINNET_MAX_SEED_SIZE || addresses.some(address => !/^0x[0-9a-f]{40}$/.test(address))) {
    throw new Error('arc_mainnet_seed_invalid');
  }
  return [...new Set(addresses)];
}

export function parseArcMainnetRpcUrl(raw: string | undefined): string {
  if (!raw?.trim()) throw new Error('arc_mainnet_rpc_missing');
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    // Provider URLs may contain secrets: never include the supplied value.
    throw new Error('arc_mainnet_rpc_invalid');
  }
}

export function parseArcMainnetStartBlock(raw: string | undefined): number {
  if (!raw) return 0;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('arc_mainnet_start_invalid');
  return Number(raw);
}
