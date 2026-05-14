import type { NextRequest } from 'next/server';

/**
 * Shared-secret bearer auth helpers for AgentKarma's non-public trigger/write
 * endpoints.
 *
 * Scope: we're not running per-consumer API keys yet. All we need is a
 * "only the operator can trigger this" gate.
 */

type BearerCheck =
  | { ok: true }
  | { ok: false; response: Response };

function unauthorized(msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function misconfigured(envVar: string): Response {
  // 500 — fail closed rather than allow, so a missing secret can never silently
  // open a write endpoint in prod.
  return new Response(
    JSON.stringify({
      error: `Server not configured: ${envVar} is not set`,
    }),
    {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

/**
 * Require `Authorization: Bearer <value of envVar>`.
 *
 * Fails closed: if the env var is unset, returns 500 (not 401). This prevents
 * a deploy misconfiguration from leaving a write endpoint publicly callable.
 */
export function requireBearerSecret(
  request: NextRequest | Request,
  envVar: string,
): BearerCheck {
  const expected = process.env[envVar];
  if (!expected || expected.length === 0) {
    return { ok: false, response: misconfigured(envVar) };
  }
  const header = request.headers.get('authorization');
  if (!header) return { ok: false, response: unauthorized('Missing Authorization header') };

  // Constant-time-ish comparison. JS doesn't expose a real timingSafeEqual in
  // the edge runtime, but matching lengths first + full-string scan is fine for
  // a shared-secret gate at this traffic level.
  const expectedHeader = `Bearer ${expected}`;
  if (!safeEqual(header, expectedHeader)) {
    return { ok: false, response: unauthorized('Invalid bearer token') };
  }
  return { ok: true };
}

/**
 * Verify a Helius webhook call. Helius supports a fixed "Authentication Header"
 * you configure when creating the webhook (see mgr.helius.dev). Whatever
 * string you set there is sent verbatim as the `Authorization` header on every
 * webhook POST. We store the expected value in HELIUS_WEBHOOK_SECRET (legacy
 * name) or HELIUS_WEBHOOK_AUTH_HEADER (preferred); either works.
 *
 * If neither is set, we allow the request through and log a warning — this
 * keeps local dev / ngrok replay workflows simple but MUST not happen in prod.
 * Set one of the two env vars in your deployment.
 */
let heliusOpenWarned = false;
export function verifyHeliusWebhook(request: NextRequest | Request): BearerCheck {
  const expected =
    process.env.HELIUS_WEBHOOK_AUTH_HEADER ?? process.env.HELIUS_WEBHOOK_SECRET;
  if (!expected || expected.length === 0) {
    if (!heliusOpenWarned) {
      console.warn(
        '[webhook/helius] No HELIUS_WEBHOOK_AUTH_HEADER / HELIUS_WEBHOOK_SECRET set — ' +
          'accepting all webhook calls. Configure the auth header in prod.',
      );
      heliusOpenWarned = true;
    }
    return { ok: true };
  }
  const header = request.headers.get('authorization');
  if (!header) return { ok: false, response: unauthorized('Missing Authorization header') };

  // Helius sends the configured string verbatim. Accept both raw and "Bearer X"
  // forms since operators sometimes configure the prefix into the header.
  if (safeEqual(header, expected) || safeEqual(header, `Bearer ${expected}`)) {
    return { ok: true };
  }
  return { ok: false, response: unauthorized('Invalid webhook signature') };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
