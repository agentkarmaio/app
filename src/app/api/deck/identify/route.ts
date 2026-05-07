import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { insertDeckView } from '@/db/client';
import {
  DECK_COOKIE_NAME,
  DECK_COOKIE_TTL_S,
  makeDeckCookie,
} from '@/lib/deck-cookie';
import { enforceRateLimit, getClientIp } from '@/lib/rate-limit';

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  isReturning: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const gate = await enforceRateLimit('deck-identify', request);
  if (!gate.ok) return gate.response;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  }

  try {
    await insertDeckView({
      email: parsed.data.email,
      isReturning: parsed.data.isReturning ?? false,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referrer: request.headers.get('referer'),
    });
  } catch (err) {
    console.error('[deck-identify] DB error:', err);
    return NextResponse.json({ error: 'persist_failed' }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true }, { headers: gate.headers });
  res.cookies.set({
    name: DECK_COOKIE_NAME,
    value: makeDeckCookie(parsed.data.email),
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: DECK_COOKIE_TTL_S,
  });
  return res;
}
