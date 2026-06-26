/**
 * Agent logo proxy.
 *
 * Agent registration JSON (ERC-8004 / Soroban) carries an attacker-controlled
 * `image` URL. Rather than let every visitor's browser hit that third-party host
 * directly, we re-serve the bytes from our own origin: hides the visitor's IP,
 * lets the CDN cache, and enforces an SSRF guard + size cap + content-type
 * allow-list the client can't. On any failure we answer non-200 and the
 * <AgentAvatar> client falls back to a monogram, so the UI stays silent.
 *
 * Runs on the Node runtime — the SSRF guard uses node:dns / node:net.
 */
import { safeFetchImage, SsrfError } from '@/lib/ssrf-guard';

export const runtime = 'nodejs';

const MAX_BYTES = 2 * 1024 * 1024;

// Raster types are inert in any context. SVG can carry script, but only executes
// when rendered as a document — never via <img>, and the response CSP sandboxes
// direct navigation, so it is safe to pass through.
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
]);

export async function GET(req: Request): Promise<Response> {
  const target = new URL(req.url).searchParams.get('url');
  if (!target) return new Response(null, { status: 400 });

  try {
    const { contentType, bytes } = await safeFetchImage(target, {
      maxBytes: MAX_BYTES,
      timeoutMs: 6000,
    });
    const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(type)) return new Response(null, { status: 415 });

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    });
  } catch (err) {
    // Bad/blocked URL → 400; upstream failure (down, oversize, non-2xx) → 502.
    return new Response(null, { status: err instanceof SsrfError ? 400 : 502 });
  }
}
