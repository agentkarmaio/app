/**
 * AgentKarma Specimen — x402-compatible micro-API on Solana mainnet.
 *
 * Standalone Bun server. Same behaviour ships as Next.js Route Handlers under
 * /specimen/* and /api/specimen/* — the gating logic lives in
 * src/lib/specimen/gated-handler.ts and is shared.
 *
 * Routes:
 *   GET  /                    landing page
 *   GET  /agentkarma.json     Tier 3 declared-identity manifest
 *   GET  /echo                payment-gated echo endpoint
 *   GET  /quote               payment-gated rotating-quote endpoint
 *   GET  /healthz             liveness check
 *
 * Env:
 *   PORT                       default 3941
 *   HELIUS_RPC_URL             required for verification
 *   SPECIMEN_BASE_URL          public URL (used in 402 responses + manifest)
 *   SPECIMEN_REPLAY_PATH       optional file path for crash-durable replay set
 */

import {
  SPECIMEN_PROVIDER_ADDRESS,
  SPECIMEN_PRICE_USDC,
} from '../src/config/specimen';
import { handleGated } from '../src/lib/specimen/gated-handler';
import { buildManifest } from '../src/lib/specimen/manifest';
import { useFileBackedStore } from '../src/lib/specimen/replay';
import { echoPayload, quotePayload } from '../src/lib/specimen/payloads';

const PORT = Number(process.env.PORT ?? 3941);
const BASE_URL = process.env.SPECIMEN_BASE_URL ?? `http://localhost:${PORT}`;

if (process.env.SPECIMEN_REPLAY_PATH) {
  useFileBackedStore(process.env.SPECIMEN_REPLAY_PATH);
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function gated(req: Request, resource: string, payload: () => unknown): Promise<Response> {
  const result = await handleGated(req.headers, resource, payload);
  return jsonResponse(result.body, {
    status: result.status,
    headers: result.extraHeaders,
  });
}

const server = Bun.serve({
  port: PORT,
  development: false,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/healthz') return new Response('ok', { status: 200 });

    if (url.pathname === '/' || url.pathname === '') {
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>AgentKarma Specimen</title>
<style>body{font:14px/1.5 ui-monospace,monospace;max-width:42rem;margin:3rem auto;padding:0 1.5rem;color:#e6e6e6;background:#0b0b0d}h1{font-weight:600}code{background:#1a1a1d;padding:.1rem .35rem;border-radius:3px}a{color:#9ab8ff}</style>
</head><body>
<h1>AgentKarma Specimen</h1>
<p>x402-compatible USDC micro-API on Solana mainnet.</p>
<p>Provider wallet: <code>${SPECIMEN_PROVIDER_ADDRESS}</code></p>
<p>Endpoints:</p>
<ul>
  <li><a href="/agentkarma.json">/agentkarma.json</a> &mdash; Tier 3 declared-identity manifest</li>
  <li><code>GET /echo</code> &mdash; payment-gated, ${SPECIMEN_PRICE_USDC} USDC</li>
  <li><code>GET /quote</code> &mdash; payment-gated, ${SPECIMEN_PRICE_USDC} USDC</li>
</ul>
<p>Reputation profile: <a href="https://agentkarma.io/agent/${SPECIMEN_PROVIDER_ADDRESS}">agentkarma.io/agent/${SPECIMEN_PROVIDER_ADDRESS.slice(0, 8)}&hellip;</a></p>
</body></html>`;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/agentkarma.json') {
      return jsonResponse(buildManifest(BASE_URL));
    }

    if (url.pathname === '/echo' && req.method === 'GET') {
      return gated(req, 'echo', echoPayload);
    }

    if (url.pathname === '/quote' && req.method === 'GET') {
      return gated(req, 'quote', quotePayload);
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(`[specimen] listening on port ${server.port}`);
console.log(`[specimen] base url: ${BASE_URL}`);
console.log(`[specimen] provider: ${SPECIMEN_PROVIDER_ADDRESS}`);
