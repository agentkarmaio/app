/**
 * Seed database with realistic demo data — 200+ agents across all tiers,
 * with valid-looking Solana base58 signatures and addresses.
 *
 * Usage: bun run src/scripts/seed.ts
 */

import { supabase } from '../db/client';
import { calculateScore } from '../scoring';
import { ALL_FACILITATOR_ADDRESSES } from '../config/facilitators';

// Base58 alphabet (Solana standard)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function randomBase58(len: number): string {
  return Array.from({ length: len }, () => B58[Math.floor(Math.random() * B58.length)]).join('');
}

function fakeWalletAddress(): string {
  return randomBase58(44);
}

function fakeTxSignature(): string {
  return randomBase58(88);
}

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// Tier profiles — how many agents per tier and their parameter ranges
const TIER_PROFILES = [
  // Very Good (76-90): 15 agents
  ...Array.from({ length: 15 }, () => ({
    txRange: [250, 480] as [number, number],
    facRange: [6, 10] as [number, number],
    ageRange: [120, 178] as [number, number],
    successRange: [0.95, 1.0] as [number, number],
  })),
  // Good (61-75): 30 agents
  ...Array.from({ length: 30 }, () => ({
    txRange: [100, 250] as [number, number],
    facRange: [4, 8] as [number, number],
    ageRange: [70, 140] as [number, number],
    successRange: [0.90, 0.98] as [number, number],
  })),
  // Fair (41-60): 60 agents
  ...Array.from({ length: 60 }, () => ({
    txRange: [30, 120] as [number, number],
    facRange: [2, 5] as [number, number],
    ageRange: [30, 90] as [number, number],
    successRange: [0.80, 0.95] as [number, number],
  })),
  // Poor (21-40): 50 agents
  ...Array.from({ length: 50 }, () => ({
    txRange: [5, 40] as [number, number],
    facRange: [1, 3] as [number, number],
    ageRange: [5, 40] as [number, number],
    successRange: [0.65, 0.85] as [number, number],
  })),
  // Unrated (0-20): 20 agents
  ...Array.from({ length: 20 }, () => ({
    txRange: [1, 8] as [number, number],
    facRange: [1, 1] as [number, number],
    ageRange: [1, 10] as [number, number],
    successRange: [0.40, 0.70] as [number, number],
  })),
];

async function seed() {
  const total = TIER_PROFILES.length;
  console.log(`[seed] Seeding ${total} agents with realistic Solana-style data...\n`);

  const tierCounts: Record<string, number> = {};
  let totalTxs = 0;

  for (let idx = 0; idx < TIER_PROFILES.length; idx++) {
    const profile = TIER_PROFILES[idx];
    const wallet = fakeWalletAddress();
    const txCount = Math.floor(rand(...profile.txRange));
    const numFac = Math.floor(rand(...profile.facRange));
    const ageDays = Math.floor(rand(...profile.ageRange));
    const successRate = rand(...profile.successRange);

    const walletFacilitators = pickN(ALL_FACILITATOR_ADDRESSES, numFac);

    const { error: walletErr } = await supabase.from('wallets').upsert({
      address: wallet,
      first_seen: daysAgo(ageDays),
      last_seen: daysAgo(Math.floor(rand(0, 3))),
      tx_count: txCount,
      score: 0,
      trust_tier: 'Unrated',
    }, { onConflict: 'address' });

    if (walletErr) {
      console.error(`[seed] wallet error:`, walletErr.message);
      continue;
    }

    const txRows = Array.from({ length: txCount }, (_, i) => ({
      wallet_address: wallet,
      facilitator: walletFacilitators[i % walletFacilitators.length],
      amount: parseFloat(rand(0.01, 75).toFixed(6)),
      timestamp: daysAgo(rand(0, ageDays)),
      success: Math.random() < successRate,
      tx_signature: fakeTxSignature(),
    }));

    // Insert in batches of 200 (Supabase row limit per request)
    for (let i = 0; i < txRows.length; i += 200) {
      const batch = txRows.slice(i, i + 200);
      const { error: txErr } = await supabase
        .from('transactions')
        .upsert(batch, { onConflict: 'tx_signature', ignoreDuplicates: true });
      if (txErr) {
        console.error(`[seed] tx error for agent ${idx}:`, txErr.message);
        break;
      }
    }

    const score = calculateScore(txRows.map((tx) => ({ ...tx, id: '' })));

    await supabase.from('wallets').update({
      score: score.score,
      trust_tier: score.trustTier,
      tx_count: txCount,
    }).eq('address', wallet);

    await supabase.from('scores').insert({
      wallet_address: wallet,
      score: score.score,
      success_rate: score.metrics.successRate,
      diversity: score.metrics.diversity,
      volume: score.metrics.volume,
      age: Math.round(score.metrics.age * 180),
    });

    tierCounts[score.trustTier] = (tierCounts[score.trustTier] ?? 0) + 1;
    totalTxs += txCount;

    if ((idx + 1) % 25 === 0 || idx === TIER_PROFILES.length - 1) {
      console.log(`  [${idx + 1}/${total}] ${wallet.slice(0, 6)}... → ${score.score.toFixed(1)} (${score.trustTier})`);
    }
  }

  console.log(`\n[seed] Done.`);
  console.log(`[seed] Agents: ${total} | Transactions: ${totalTxs}`);
  console.log(`[seed] Tiers: ${Object.entries(tierCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
}

seed().catch((err) => {
  console.error('[seed] Fatal:', err);
  process.exit(1);
});
