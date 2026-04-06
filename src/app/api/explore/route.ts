import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/db/client';
import type { Transaction } from '@/db/schema';

export async function GET(request: NextRequest) {
  const facilitator = request.nextUrl.searchParams.get('facilitator')?.trim();
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') ?? '30', 10), 100);

  let query = supabase
    .from('transactions')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (facilitator) {
    query = query.eq('facilitator', facilitator);
  }

  const { data, error } = await query;
  if (error) throw error;

  const uniqueWallets = new Set((data ?? []).map((tx: Transaction) => tx.wallet_address));

  return NextResponse.json({
    transactions: (data ?? []) as Transaction[],
    uniqueAgents: uniqueWallets.size,
    facilitatorFilter: facilitator ?? null,
  });
}
