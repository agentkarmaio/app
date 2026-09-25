/**
 * Decode a `data:application/json[;enc=gzip[;level=N]][;base64],<body>` URI.
 *
 * Throws on anything malformed (missing comma, undecodable body, non-JSON) —
 * callers decide whether that is an invalid record or a hard error.
 *
 * Gzip goes through `fflate` (pure JS) — not `node:zlib`, not the platform
 * `DecompressionStream`: this decoder sits in the import graph of the Edge
 * instrumentation bundle (`instrumentation.ts` → `lib/indexing-jobs` → the
 * chain readers), where a Node builtin compiles to an unsupported-import stub
 * and `DecompressionStream` is flagged as an unsupported Edge API. fflate is
 * runtime-agnostic, so both runtimes share one warning-free path.
 */
import { gunzipSync } from 'fflate';

export function decodeDataUriJson(uri: string): unknown {
  const commaIdx = uri.indexOf(',');
  if (commaIdx < 0) throw new Error('data URI missing comma separator');
  const params = uri.slice(5, commaIdx).split(';'); // strip 'data:'
  const body = uri.slice(commaIdx + 1);

  const bytes = params.includes('base64')
    ? Buffer.from(body, 'base64')
    : Buffer.from(decodeURIComponent(body), 'utf-8');
  const raw = params.some((p) => p.startsWith('enc=gzip')) ? gunzipSync(bytes) : bytes;

  return JSON.parse(Buffer.from(raw).toString('utf-8'));
}
