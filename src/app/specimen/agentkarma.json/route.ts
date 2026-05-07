/**
 * Tier 3 declared-identity manifest for the AgentKarma specimen agent.
 *
 * Served as a demonstrative URL — judges and humans can inspect the agent's
 * declared identity / pricing / endpoints. Tier 3 auto-resolution against
 * .well-known is deferred until the specimen has its own subdomain.
 */

import { NextResponse } from 'next/server';

import { buildManifest } from '@/lib/specimen/manifest';
import { SPECIMEN_PROVIDER_ADDRESS } from '@/config/specimen';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';

export const dynamic = 'force-static';
export const revalidate = 3600;

export async function GET() {
  const baseUrl = `${APP_URL}/api/specimen`;
  const manifest = buildManifest(baseUrl);

  return NextResponse.json(
    {
      schema: 'agentkarma.v1',
      ...manifest,
      wallet: SPECIMEN_PROVIDER_ADDRESS,
    },
    { headers: { 'cache-control': 'public, max-age=300, s-maxage=3600' } },
  );
}
