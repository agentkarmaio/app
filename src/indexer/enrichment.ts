/**
 * Wallet Enrichment Module
 *
 * Uses Helius Wallet API to resolve wallet identities, funding sources,
 * and flag potential sybil clusters.
 */

import { getHeliusApiKey, withConcurrency } from './helius';
import { supabase } from '../db/client';
import type { Wallet } from '../db/schema';

const HELIUS_BASE = 'https://api.helius.xyz';
const IDENTITY_BATCH_SIZE = 100;
const FUNDED_BY_CONCURRENCY = 5;
const SYBIL_THRESHOLD = 3;

// --- Types -------------------------------------------------------------------

interface WalletIdentity {
  address: string;
  name: string | null;
  category: string | null;
}

interface FundingSource {
  funder: string;
  funderName: string | null;
  amount: number;
}

// --- Helpers -----------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// --- Helius API Calls --------------------------------------------------------

export async function batchWalletIdentity(
  addresses: string[],
): Promise<Map<string, WalletIdentity>> {
  const apiKey = getHeliusApiKey();
  const url = `${HELIUS_BASE}/v1/wallet/batch-identity?api-key=${apiKey}`;
  const batches = chunk(addresses, IDENTITY_BATCH_SIZE);
  const result = new Map<string, WalletIdentity>();

  for (const batch of batches) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: batch }),
      });

      if (res.status === 404) continue;

      if (!res.ok) {
        console.error(
          `[enrichment] batch-identity failed: ${res.status} ${res.statusText} (batch of ${batch.length})`,
        );
        continue;
      }

      const data = (await res.json()) as WalletIdentity[];
      for (const identity of data) {
        result.set(identity.address, identity);
      }
    } catch (err) {
      console.error(`[enrichment] batch-identity network error (batch of ${batch.length}):`, err);
    }
  }

  return result;
}

export async function getWalletFundedBy(
  address: string,
): Promise<FundingSource | null> {
  const apiKey = getHeliusApiKey();
  const url = `${HELIUS_BASE}/v1/wallet/${address}/funded-by?api-key=${apiKey}`;

  try {
    const res = await fetch(url);

    if (res.status === 404) return null;

    if (!res.ok) {
      console.error(
        `[enrichment] funded-by failed for ${address}: ${res.status} ${res.statusText}`,
      );
      return null;
    }

    const data = (await res.json()) as { funder: string; funderName?: string | null; amount: number };
    return {
      funder: data.funder,
      funderName: data.funderName ?? null,
      amount: data.amount,
    };
  } catch (err) {
    console.error(`[enrichment] funded-by network error for ${address}:`, err);
    return null;
  }
}

// --- Main Enrichment ---------------------------------------------------------

export async function enrichWallets(): Promise<{ enriched: number; sybilFlagged: number }> {
  // 1. Fetch un-enriched wallets
  const { data: wallets, error } = await supabase
    .from('wallets')
    .select('*')
    .is('enriched_at', null);

  if (error) throw error;
  if (!wallets || wallets.length === 0) {
    console.log('[enrichment] No un-enriched wallets found');
    return { enriched: 0, sybilFlagged: 0 };
  }

  const walletList = wallets as Wallet[];
  const addresses = walletList.map((w) => w.address);
  console.log(`[enrichment] Processing ${addresses.length} wallets`);

  // 2. Batch identity lookup
  const identities = await batchWalletIdentity(addresses);
  console.log(`[enrichment] Resolved ${identities.size} identities`);

  // 3. For wallets without identity, look up funding source
  const unidentified = addresses.filter((addr) => !identities.has(addr));
  console.log(`[enrichment] Looking up funding for ${unidentified.length} unidentified wallets`);

  const fundingResults = await withConcurrency(
    unidentified,
    FUNDED_BY_CONCURRENCY,
    async (addr) => ({ address: addr, funding: await getWalletFundedBy(addr) }),
  );

  const fundingMap = new Map<string, FundingSource>();
  for (const result of fundingResults) {
    if (result.funding) {
      fundingMap.set(result.address, result.funding);
    }
  }

  // 4. Sybil heuristic: group by unknown funder, flag if 3+ share same funder
  const funderCounts = new Map<string, string[]>();
  for (const [addr, funding] of fundingMap) {
    // Only consider unknown funders (no identity)
    if (!identities.has(funding.funder)) {
      const existing = funderCounts.get(funding.funder) ?? [];
      existing.push(addr);
      funderCounts.set(funding.funder, existing);
    }
  }

  const sybilAddresses = new Set<string>();
  for (const [, walletAddrs] of funderCounts) {
    if (walletAddrs.length >= SYBIL_THRESHOLD) {
      for (const addr of walletAddrs) {
        sybilAddresses.add(addr);
      }
    }
  }

  // 5. Update wallet records
  const now = new Date().toISOString();
  let enriched = 0;

  for (const addr of addresses) {
    const identity = identities.get(addr);
    const funding = fundingMap.get(addr);

    const updatePayload: Record<string, unknown> = {
      enriched_at: now,
      entity_name: identity?.name ?? null,
      entity_category: identity?.category ?? null,
      funded_by: funding?.funder ?? null,
      funded_by_name: funding?.funderName ?? null,
      sybil_risk: sybilAddresses.has(addr),
    };

    const { error: updateError } = await supabase
      .from('wallets')
      .update(updatePayload)
      .eq('address', addr);

    if (updateError) {
      console.error(`[enrichment] Failed to update ${addr}:`, updateError);
      continue;
    }

    enriched++;
  }

  console.log(`[enrichment] Sybil flagged: ${sybilAddresses.size}`);

  return { enriched, sybilFlagged: sybilAddresses.size };
}
