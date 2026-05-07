import { createHmac, timingSafeEqual } from "node:crypto";

export const DECK_COOKIE_NAME = "ak_deck";
export const DECK_COOKIE_TTL_S = 60 * 60 * 24 * 30; // 30 days

function getSecret(): string {
  // Prefer a dedicated secret; fall back to the Supabase service role key so
  // we don't require an extra env var. Both are server-only and high entropy.
  const secret =
    process.env.DECK_COOKIE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error(
      "DECK_COOKIE_SECRET or SUPABASE_SERVICE_ROLE_KEY must be set",
    );
  }
  return secret;
}

function hmac(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export function makeDeckCookie(email: string): string {
  const exp = Date.now() + DECK_COOKIE_TTL_S * 1000;
  const payload = `${email}|${exp}`;
  const sig = hmac(payload);
  const b64 = Buffer.from(payload).toString("base64url");
  return `${b64}.${sig}`;
}

export function verifyDeckCookie(
  value: string | null | undefined,
): { email: string; exp: number } | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const b64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(b64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = hmac(payload);
  // timingSafeEqual throws if lengths differ — guard first.
  if (expected.length !== sig.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  const sep = payload.lastIndexOf("|");
  if (sep <= 0) return null;
  const email = payload.slice(0, sep);
  const exp = Number(payload.slice(sep + 1));
  if (!email || !Number.isFinite(exp) || Date.now() > exp) return null;
  return { email, exp };
}
