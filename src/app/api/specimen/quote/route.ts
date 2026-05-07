/**
 * GET /api/specimen/quote — payment-gated rotating-quote endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';

import { handleGated } from '@/lib/specimen/gated-handler';
import { quotePayload } from '@/lib/specimen/payloads';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const result = await handleGated(request.headers, 'quote', quotePayload);
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.extraHeaders,
  });
}
