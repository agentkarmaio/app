import { NextRequest, NextResponse } from 'next/server';
import { getTransactions, getTransactionCount } from '@/db/client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ wallet: string }> }
) {
  const { wallet } = await params;

  if (!wallet || wallet.length < 32) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }

  const { searchParams } = request.nextUrl;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);
  const offset = parseInt(searchParams.get('offset') ?? '0', 10);

  const [transactions, total] = await Promise.all([
    getTransactions(wallet, limit, offset),
    getTransactionCount(wallet),
  ]);

  return NextResponse.json({
    address: wallet,
    total,
    limit,
    offset,
    transactions: transactions.map((tx) => ({
      id: tx.id,
      facilitator: tx.facilitator,
      amount: tx.amount,
      timestamp: tx.timestamp,
      success: tx.success,
      txSignature: tx.tx_signature,
    })),
  });
}
