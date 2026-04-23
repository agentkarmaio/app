/**
 * One-shot: recompute + persist a single wallet's score. Used to verify the
 * tier-gating fix before running the fleet-wide backfill. Delete after use.
 */
import {
  getTransactions, upsertWallet, getFeedbackSummary, getLatestSignalValues,
} from '../db/client';
import { calculateScore } from '../scoring';
import { computeCadence } from '../scoring/cadence';
import { readAttestation } from '../integrations/attestation';

const WALLET = process.argv[2] ?? 'TeStKWyNre9PW8XbLfvuBm9f6EnTBYqS5GXTzciCnHw';

const txs = await getTransactions(WALLET, 10000);
console.log(`[refresh-one] ${WALLET} — loaded ${txs.length} txs`);

if (txs.length === 0) {
  console.log('[refresh-one] no transactions, nothing to do');
  process.exit(0);
}

const [attestation, feedback, manifestMap] = await Promise.all([
  readAttestation(WALLET).catch(() => 0),
  getFeedbackSummary(WALLET),
  getLatestSignalValues([WALLET], 'manifest').catch(() => new Map<string, number>()),
]);

const cadence = computeCadence(txs.map((tx) => new Date(tx.timestamp)));
const score = calculateScore(
  txs, attestation,
  feedback.deliveryRate, feedback.total,
  cadence?.automationScore ?? null,
  manifestMap.get(WALLET) ?? null,
);

console.log(`[refresh-one] computed → score=${score.score.toFixed(2)} tier=${score.trustTier} badge=${score.confidenceBadge} provider=${score.providerScore.toFixed(2)} consumer=${score.consumerScore?.toFixed(2) ?? '—'}`);

await upsertWallet(WALLET, score.score, score.trustTier, score.txCount, {
  providerScore: score.providerScore,
  consumerScore: score.consumerScore,
  confidenceBadge: score.confidenceBadge,
});

console.log('[refresh-one] upserted');
