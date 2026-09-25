/** Presentation helpers only. Scoring and receipt validation stay in their canonical modules. */
import type { KarmaFaceBlock } from './karma-resolver';
import type { TrustTier } from '@/db/schema';
import type { ArcMainnetReceiptObservation } from '@/scoring/arc-mainnet-receipts';
import { safeEndpointHref, safeHref } from './safe-url';

export const PROFILE_RECEIPT_LIMIT = 500;
export const PROFILE_FEEDBACK_LIMIT = 50;
export const PROFILE_SERVICE_LIMIT = 10;

export function hasDisplayScore(face: KarmaFaceBlock): boolean {
  return face.hasSignal && Number.isFinite(face.score) && face.score >= 0 && face.score <= 100;
}

export function displayTier(face: KarmaFaceBlock): TrustTier {
  const tiers: readonly string[] = ['Unrated', 'Poor', 'Fair', 'Good', 'Very Good', 'Excellent'];
  return hasDisplayScore(face) && tiers.includes(face.trustTier) ? face.trustTier as TrustTier : 'Unrated';
}

export function unitInterval(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

/** No floating-point conversion: preserves one-wei USDC and large registry values. */
export function formatRawUnits(value: string | number, decimals: number): string | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const raw = String(value);
  if (!/^-?\d{1,78}$/.test(raw)) return null;
  const integer = BigInt(raw);
  const negative = integer < 0n;
  const digits = (negative ? -integer : integer).toString().padStart(decimals + 1, '0');
  const whole = (decimals ? digits.slice(0, -decimals) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function metadataText(value: unknown, limit = 200): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
}

/** The second registry read must still refer to the resolved payment wallet, not a fleet owner. */
export function matchesProfileRegistry(row: Record<string, unknown>, address: string, agentId: number): boolean {
  const zero = '0x0000000000000000000000000000000000000000';
  const agentWallet = String(row.agent_wallet ?? '').toLowerCase();
  const effective = agentWallet && agentWallet !== zero ? agentWallet : String(row.owner ?? '').toLowerCase();
  return row.chain === 'arc-mainnet' && Number(row.agent_id) === agentId && effective === address.toLowerCase();
}

export function readProfileRegistration(value: unknown) {
  const reg = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const source = Array.isArray(reg.services) ? reg.services : [];
  const services: Array<{ name: string; endpoint: string | null }> = [];
  // Bound work as well as output; registry metadata is untrusted.
  for (const entry of source.slice(0, PROFILE_SERVICE_LIMIT)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const service = entry as Record<string, unknown>;
    services.push({
      name: metadataText(service.name, 80) ?? 'Service',
      endpoint: safeEndpointHref(metadataText(service.endpoint, 2048)),
    });
  }
  return {
    image: safeHref(metadataText(reg.image, 2048)),
    active: typeof reg.active === 'boolean' ? reg.active : null,
    x402Support: typeof reg.x402Support === 'boolean' ? reg.x402Support : null,
    services,
    servicesTruncated: source.length > PROFILE_SERVICE_LIMIT,
  };
}

export interface ProfileRelationship {
  address: string;
  receivedRaw: string;
  sentRaw: string;
  transfers: number;
  transactions: number;
  lastActive: string;
}

/** Accept ONLY collectArcMainnetReceipts().observations, never raw signal events. */
export function buildProfileActivity(observations: readonly ArcMainnetReceiptObservation[]) {
  const receipts = [...observations].sort((a, b) => b.timestamp.localeCompare(a.timestamp)
    || b.rawTxHash.localeCompare(a.rawTxHash) || b.logIndex - a.logIndex);
  const byAddress = new Map<string, {
    received: bigint; sent: bigint; transfers: number; hashes: Set<string>; lastActive: string;
  }>();
  let received = 0n;
  let sent = 0n;
  for (const receipt of receipts) {
    const entry = byAddress.get(receipt.counterparty) ?? {
      received: 0n, sent: 0n, transfers: 0, hashes: new Set<string>(), lastActive: receipt.timestamp,
    };
    const amount = BigInt(receipt.rawAmount);
    if (receipt.face === 'provider') { entry.received += amount; received += amount; }
    else { entry.sent += amount; sent += amount; }
    entry.transfers++;
    entry.hashes.add(receipt.rawTxHash);
    byAddress.set(receipt.counterparty, entry);
  }
  const relationships: ProfileRelationship[] = [...byAddress].map(([address, row]) => ({
    address, receivedRaw: row.received.toString(), sentRaw: row.sent.toString(),
    transfers: row.transfers, transactions: row.hashes.size, lastActive: row.lastActive,
  })).sort((a, b) => b.transactions - a.transactions || b.lastActive.localeCompare(a.lastActive)
    || a.address.localeCompare(b.address));
  return {
    receipts, relationships, receivedRaw: received.toString(), sentRaw: sent.toString(),
    transactions: new Set(receipts.map(row => row.rawTxHash)).size,
  };
}

export type ProfileActivity = ReturnType<typeof buildProfileActivity>;

/** Stored history is never backfilled with synthetic zeroes for missing values. */
export function profileScoreHistory(rows: readonly { score: unknown; calculated_at: unknown }[]) {
  return rows.flatMap(row => {
    if ((typeof row.score !== 'number' && typeof row.score !== 'string')
      || String(row.score).trim() === '' || typeof row.calculated_at !== 'string') return [];
    const score = Number(row.score);
    const time = Date.parse(row.calculated_at);
    return Number.isFinite(score) && score >= 0 && score <= 100 && Number.isFinite(time)
      ? [{ score, calculated_at: new Date(time).toISOString() }] : [];
  }).sort((a, b) => a.calculated_at.localeCompare(b.calculated_at));
}
