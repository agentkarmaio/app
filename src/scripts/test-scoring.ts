/**
 * Test Script — Scoring Engine with Mock Data
 *
 * Generates 50 fake x402 transactions across multiple wallets and
 * runs them through the Karma scoring engine to verify output.
 *
 * Usage: bun run src/scripts/test-scoring.ts
 */

import { calculateScores, getTrustTier } from '../scoring/index';
import { ALL_FACILITATOR_ADDRESSES } from '../config/facilitators';
import type { Transaction } from '../db/schema';

// ─── Mock Data Generation ─────────────────────────────────────────────────────

const FAKE_WALLETS = [
  'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1',
  'Wa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2',
  'Wa11etCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3',
  'Wa11etDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD4',
  'Wa11etEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE5',
];

// Use real facilitator addresses from config
const facilitators = ALL_FACILITATOR_ADDRESSES.slice(0, 8);

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randomInt(min: number, max: number): number {
  return Math.floor(randomBetween(min, max + 1));
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Generate a pseudo-random base-58-like signature */
function fakeSignature(index: number): string {
  return `FakeSig${String(index).padStart(5, '0')}${'x'.repeat(50)}`.slice(0, 88);
}

/**
 * Build 50 mock transactions with varying wallet distributions,
 * success rates, and facilitator diversity.
 */
function generateMockTransactions(): Transaction[] {
  const transactions: Transaction[] = [];
  const now = Date.now();

  // Wallet profiles: [wallet index, tx count, success rate, # of unique facilitators to use]
  const profiles: [number, number, number, number][] = [
    [0, 12, 0.95, 5],  // Power user — high success, diverse
    [1, 8,  0.80, 3],  // Mid-tier — decent success
    [2, 15, 0.60, 6],  // High volume but mixed success
    [3, 3,  1.00, 2],  // New user — perfect but few txs
    [4, 12, 0.30, 1],  // Low-quality — mostly failures, single facilitator
  ];

  let sigIndex = 0;

  for (const [walletIdx, count, successRate, divCount] of profiles) {
    const wallet = FAKE_WALLETS[walletIdx];
    const walletFacilitators = facilitators.slice(0, divCount);

    for (let i = 0; i < count; i++) {
      // Spread timestamps over the past 90 days
      const daysAgo = randomBetween(0, 90);
      const timestamp = new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();

      transactions.push({
        id: `mock-${sigIndex}`,
        wallet_address: wallet,
        facilitator: randomChoice(walletFacilitators),
        amount: parseFloat(randomBetween(0.1, 50).toFixed(6)),
        timestamp,
        success: Math.random() < successRate,
        tx_signature: fakeSignature(sigIndex++),
      });
    }
  }

  // Shuffle to simulate mixed ordering
  return transactions.sort(() => Math.random() - 0.5);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Karma Scoring Engine — Mock Data Test');
  console.log('═══════════════════════════════════════════════════════\n');

  const transactions = generateMockTransactions();
  console.log(`Generated ${transactions.length} mock transactions across ${FAKE_WALLETS.length} wallets.\n`);

  const scores = calculateScores(transactions);

  // Sort by score descending for display
  const sorted = [...scores.values()].sort((a, b) => b.score - a.score);

  console.log('┌─────────────────────────────────────────────────────────────────────────────┐');
  console.log('│  WALLET SCORES                                                               │');
  console.log('├─────────────────────────────────────────────────────────────────────────────┤');

  for (const ws of sorted) {
    const shortAddr = `${ws.address.slice(0, 8)}…${ws.address.slice(-6)}`;
    console.log(`│ ${shortAddr.padEnd(18)}  Score: ${String(ws.score.toFixed(2)).padStart(6)}  Tier: ${ws.trustTier.padEnd(9)}  Txs: ${String(ws.txCount).padStart(3)} │`);
    console.log(`│   Metrics → successRate: ${(ws.metrics.successRate * 100).toFixed(1).padStart(5)}%  diversity: ${ws.metrics.diversity.toFixed(3)}  volume: ${ws.metrics.volume.toFixed(3)}  age: ${ws.metrics.age.toFixed(3)} │`);
    console.log(`│   Last active: ${ws.lastActive.toISOString().slice(0, 10)}${' '.repeat(56)}│`);
    console.log('├─────────────────────────────────────────────────────────────────────────────┤');
  }

  console.log('└─────────────────────────────────────────────────────────────────────────────┘\n');

  console.log('TrustTier reference:');
  for (const [range, tier] of [
    ['0–20',   'Unrated'],
    ['21–50',  'Bronze'],
    ['51–75',  'Silver'],
    ['76–90',  'Gold'],
    ['91–100', 'Platinum'],
  ]) {
    console.log(`  ${range.padEnd(7)} → ${tier}`);
  }

  console.log('\nDone ✓');
}

main();
