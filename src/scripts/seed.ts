/**
 * Seed database using ONLY real on-chain transaction signatures.
 * Agent count and tx volumes are scaled to fit available signatures.
 *
 * Usage: bun run src/scripts/seed.ts
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { supabase } from '../db/client';
import { calculateScore } from '../scoring';
import { ALL_FACILITATOR_ADDRESSES, getFacilitatorName } from '../config/facilitators';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function randomBase58(len: number): string {
  return Array.from({ length: len }, () => B58[Math.floor(Math.random() * B58.length)]).join('');
}

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// ─── Fetch ALL real signatures ───────────────────────────────────────────────

async function fetchRealSignatures(): Promise<{ sig: string; facilitator: string; blockTime: number | null }[]> {
  const rpcUrl = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error('HELIUS_RPC_URL or SOLANA_RPC_URL required');

  const connection = new Connection(rpcUrl, 'confirmed');
  const all: { sig: string; facilitator: string; blockTime: number | null }[] = [];

  console.log(`[seed] Fetching real signatures from facilitators...`);

  for (const addr of ALL_FACILITATOR_ADDRESSES) {
    try {
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(addr),
        { limit: 200 },
      );
      for (const s of sigs) {
        all.push({ sig: s.signature, facilitator: addr, blockTime: s.blockTime });
      }
      const name = getFacilitatorName(addr) ?? addr.slice(0, 8);
      if (sigs.length > 0) console.log(`  ${name}: ${sigs.length}`);
    } catch { /* skip */ }
    await new Promise((r) => setTimeout(r, 120));
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = all.filter((s) => {
    if (seen.has(s.sig)) return false;
    seen.add(s.sig);
    return true;
  });

  console.log(`[seed] Total unique real signatures: ${unique.length}\n`);
  return unique;
}

// ─── Seed ────────────────────────────────────────────────────────────────────

async function seed() {
  const realSigs = await fetchRealSignatures();
  if (realSigs.length < 10) {
    console.error('[seed] Not enough real signatures. Check RPC connection.');
    process.exit(1);
  }

  // Shuffle so distribution is random across facilitators
  const shuffled = realSigs.sort(() => Math.random() - 0.5);
  let sigCursor = 0;

  function takeSigs(n: number): typeof realSigs {
    const batch = shuffled.slice(sigCursor, sigCursor + n);
    sigCursor += batch.length;
    return batch;
  }

  const totalSigs = shuffled.length;

  // Agent allocation — scale to fit available signatures
  // Reserve: 40% for top agents, 30% mid, 20% low, 10% minimal
  const agentSpecs = [
    // Very Good: few agents, many txs
    ...Array.from({ length: 8 }, () => ({
      txShare: 0.05,
      facRange: [5, 10] as [number, number],
      ageRange: [100, 178] as [number, number],
      srRange: [0.95, 1.0] as [number, number],
    })),
    // Good: moderate
    ...Array.from({ length: 20 }, () => ({
      txShare: 0.02,
      facRange: [3, 7] as [number, number],
      ageRange: [60, 130] as [number, number],
      srRange: [0.88, 0.97] as [number, number],
    })),
    // Fair: many agents, fewer txs
    ...Array.from({ length: 50 }, () => ({
      txShare: 0.006,
      facRange: [2, 4] as [number, number],
      ageRange: [20, 80] as [number, number],
      srRange: [0.78, 0.93] as [number, number],
    })),
    // Poor: lots of agents, minimal txs
    ...Array.from({ length: 40 }, () => ({
      txShare: 0.002,
      facRange: [1, 2] as [number, number],
      ageRange: [3, 30] as [number, number],
      srRange: [0.60, 0.82] as [number, number],
    })),
    // Unrated: very few txs
    ...Array.from({ length: 15 }, () => ({
      txShare: 0.0007,
      facRange: [1, 1] as [number, number],
      ageRange: [1, 8] as [number, number],
      srRange: [0.40, 0.65] as [number, number],
    })),
  ];

  console.log(`[seed] Seeding ${agentSpecs.length} agents from ${totalSigs} real signatures...\n`);

  const tierCounts: Record<string, number> = {};
  let totalTxs = 0;

  for (let idx = 0; idx < agentSpecs.length; idx++) {
    const spec = agentSpecs[idx];
    const txCount = Math.max(1, Math.round(totalSigs * spec.txShare));

    if (sigCursor >= shuffled.length) {
      console.log(`  [${idx + 1}/${agentSpecs.length}] out of real signatures, stopping.`);
      break;
    }

    const sigs = takeSigs(txCount);
    if (sigs.length === 0) break;

    const wallet = randomBase58(44);
    const numFac = Math.floor(rand(...spec.facRange));
    const ageDays = Math.floor(rand(...spec.ageRange));
    const successRate = rand(...spec.srRange);

    // Pick facilitators from the sigs we got
    const facAddrs = [...new Set(sigs.map((s) => s.facilitator))].slice(0, numFac);
    if (facAddrs.length === 0) facAddrs.push(sigs[0].facilitator);

    const { error: walletErr } = await supabase.from('wallets').upsert({
      address: wallet,
      first_seen: daysAgo(ageDays),
      last_seen: daysAgo(Math.floor(rand(0, 2))),
      tx_count: sigs.length,
      score: 0,
      trust_tier: 'Unrated',
    }, { onConflict: 'address' });

    if (walletErr) { console.error(`wallet err:`, walletErr.message); continue; }

    const txRows = sigs.map((s, i) => ({
      wallet_address: wallet,
      facilitator: facAddrs[i % facAddrs.length],
      amount: parseFloat(rand(0.05, 60).toFixed(6)),
      timestamp: s.blockTime
        ? new Date(s.blockTime * 1000).toISOString()
        : daysAgo(rand(0, ageDays)),
      success: Math.random() < successRate,
      tx_signature: s.sig,
    }));

    for (let i = 0; i < txRows.length; i += 200) {
      const batch = txRows.slice(i, i + 200);
      const { error: txErr } = await supabase
        .from('transactions')
        .upsert(batch, { onConflict: 'tx_signature', ignoreDuplicates: true });
      if (txErr) { console.error(`tx err:`, txErr.message); break; }
    }

    const score = calculateScore(txRows.map((tx) => ({ ...tx, id: '' })));

    await supabase.from('wallets').update({
      score: score.score,
      trust_tier: score.trustTier,
      tx_count: sigs.length,
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
    totalTxs += sigs.length;

    if ((idx + 1) % 25 === 0 || idx === agentSpecs.length - 1) {
      console.log(`  [${idx + 1}/${agentSpecs.length}] ${wallet.slice(0, 6)}... → ${score.score.toFixed(1)} (${score.trustTier}) | ${sigs.length} txs`);
    }
  }

  console.log(`\n[seed] Done.`);
  console.log(`[seed] Agents: ${Object.values(tierCounts).reduce((a, b) => a + b, 0)} | Transactions: ${totalTxs} (100% real sigs)`);
  console.log(`[seed] Tiers: ${Object.entries(tierCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
}

seed().catch((err) => { console.error('[seed] Fatal:', err); process.exit(1); });
