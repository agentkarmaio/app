/**
 * Validates that a URL string is safe to render as an `href` on a user-facing
 * link. The input typically comes from agent-published data (registration JSON,
 * claimed wallet manifests, etc.) which is fully attacker-controlled.
 *
 * Anything that doesn't parse as http(s) is rejected — closes off
 * `javascript:`, `data:`, `vbscript:`, `file:`, etc. that browsers will happily
 * execute inside an anchor.
 */
export function safeHref(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch {
    /* not a parseable URL */
  }
  return null;
}

// Agent endpoint URLs (from declared manifests) legitimately use non-http
// schemes — gRPC, WebSocket. Allow those alongside http(s) but still block the
// executable schemes (javascript:, data:, vbscript:, file:, etc.).
const ENDPOINT_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'grpc:', 'grpcs:']);

export function safeEndpointHref(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    if (ENDPOINT_SCHEMES.has(u.protocol)) return u.toString();
  } catch {
    /* not a parseable URL */
  }
  return null;
}
