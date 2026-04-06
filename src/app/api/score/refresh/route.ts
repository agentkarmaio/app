import { NextRequest, NextResponse } from 'next/server';
import { getAllTransactions, getTransactions, upsertWallet, insertScoreSnapshot } from '@/db/client';
import { calculateScore, calculateScores } from '@/scoring/index';
import { readAttestation, readAttestations } from '@/integrations/attestation';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const wallet = (body as { wallet?: string }).wallet;

  if (wallet) {
    const transactions = await getTransactions(wallet, 10000);
    if (transactions.length === 0) {
      return NextResponse.json({ error: 'No transactions found for wallet' }, { status: 404 });
    }

    const attestation = await readAttestation(wallet);
    const score = calculateScore(transactions, attestation);
    await upsertWallet(wallet, score.score, score.trustTier, score.txCount);
    await insertScoreSnapshot(
      wallet,
      score.score,
      score.metrics.successRate,
      score.metrics.diversity,
      score.metrics.volume,
      score.metrics.age,
    );

    return NextResponse.json({ refreshed: 1, wallet: score });
  }

  const allTx = await getAllTransactions();
  const walletAddresses = [...new Set(allTx.map((tx) => tx.wallet_address))];
  const attestations = await readAttestations(walletAddresses);
  const scores = calculateScores(allTx, attestations);

  let refreshed = 0;
  for (const [address, score] of scores) {
    await upsertWallet(address, score.score, score.trustTier, score.txCount);
    await insertScoreSnapshot(
      address,
      score.score,
      score.metrics.successRate,
      score.metrics.diversity,
      score.metrics.volume,
      score.metrics.age,
    );
    refreshed++;
  }

  return NextResponse.json({
    refreshed,
    attestationsFound: attestations.size,
    message: `Refreshed ${refreshed} wallet scores (${attestations.size} with 8004 attestation)`,
  });
}
