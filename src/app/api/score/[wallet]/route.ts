import { NextRequest, NextResponse } from 'next/server';
import { getWallet, getTransactions } from '@/db/client';
import { calculateScore } from '@/scoring/index';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ wallet: string }> }
) {
  const { wallet } = await params;

  if (!wallet || wallet.length < 32) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }

  const [walletRow, transactions] = await Promise.all([
    getWallet(wallet),
    getTransactions(wallet, 1000),
  ]);

  if (!walletRow && transactions.length === 0) {
    return NextResponse.json({ error: 'Wallet not found' }, { status: 404 });
  }

  if (transactions.length === 0) {
    return NextResponse.json({
      address: wallet,
      score: walletRow?.score ?? 0,
      trustTier: walletRow?.trust_tier ?? 'Unrated',
      metrics: { successRate: 0, diversity: 0, volume: 0, age: 0 },
      txCount: 0,
      lastActive: walletRow?.last_seen ?? null,
    });
  }

  const score = calculateScore(transactions);
  return NextResponse.json(score);
}
