import { NextResponse } from 'next/server';
import { SOLANA_FACILITATORS, ALL_FACILITATOR_ADDRESSES } from '@/config/facilitators';

/**
 * GET /api/facilitators
 *
 * Returns the canonical facilitator registry.
 * Referenced in the Karma Protocol RFC as a public endpoint.
 */
export async function GET() {
  const facilitators = Object.entries(SOLANA_FACILITATORS).map(([name, addresses]) => ({
    name,
    addresses,
    count: addresses.length,
  }));

  return NextResponse.json({
    version: '0.1.0',
    chain: 'solana-mainnet',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    totalAddresses: ALL_FACILITATOR_ADDRESSES.length,
    facilitators,
  }, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
