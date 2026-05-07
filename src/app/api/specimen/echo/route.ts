/**
 * GET /api/specimen/echo — payment-gated echo endpoint.
 *
 * No payment headers → 402 + PaymentRequirements.
 * Valid X-Payment-* headers → 200 + payload.
 */

import { NextRequest, NextResponse } from 'next/server';

import { handleGated } from '@/lib/specimen/gated-handler';
import { echoPayload } from '@/lib/specimen/payloads';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const result = await handleGated(request.headers, 'echo', echoPayload);
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.extraHeaders,
  });
}
