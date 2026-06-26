/**
 * Metadata-bound claim/edit challenge (SECURITY-CRITICAL, isomorphic).
 *
 * The claim/prove/edit challenge proves key control, but on its own it does NOT
 * commit to the metadata being written — so a signature scraped from the public
 * claim receipt (or intercepted) could be replayed within the 5-min window to
 * overwrite a profile with ATTACKER-CHOSEN fields. We close that by binding a
 * hash of the submitted metadata into the signed message:
 *
 *   AgentKarma: Claim wallet {addr} at {ts} | sha256:{hex}
 *
 * The server recomputes the hash from the request body and rejects any message
 * that doesn't bind exactly those fields — a replayed signature is locked to its
 * original metadata. The receipt stays self-describing and re-verifiable (anyone
 * can recompute the hash from the displayed profile).
 *
 * Pure + isomorphic: no React, no next/*, no node-only deps. `crypto.subtle`
 * exists in browsers AND Node 20+/Bun, so the SAME function hashes identically on
 * the client signer and the server route. MUST stay byte-identical across both.
 *
 * Prove (/api/agent/prove) is intentionally NOT bound — it mutates no metadata,
 * so its challenge stays the bare "…wallet {addr} at {ts}".
 */

export interface BoundMetadata {
  displayName?: string | null;
  description?: string | null;
  website?: string | null;
  category?: string | null;
  imageUrl?: string | null;
  tempoAddress?: string | null;
  /**
   * Optional Dead Man's Switch plan (Solana claim only). Bound so a replayed
   * claim signature can't smuggle an attacker-chosen heir past the identity
   * binding. Null / absent on every other route → same hash both sides.
   */
  succession?: unknown;
}

/**
 * Deterministic canonical form of a succession plan ({ intervalSeconds, heirs }).
 * Heirs sorted by (chain, address) so heir-array ordering can't change the hash.
 * Returns null for absent/malformed input. Pure — never throws.
 */
function canonicalSuccession(plan: unknown): unknown {
  if (plan == null || typeof plan !== 'object') return null;
  const p = plan as { intervalSeconds?: unknown; heirs?: unknown };
  const heirs = Array.isArray(p.heirs)
    ? p.heirs
        .map((h) => {
          const o = (h ?? {}) as { address?: unknown; chain?: unknown };
          return { address: o.address ?? null, chain: o.chain ?? null };
        })
        .sort((a, b) => `${a.chain}|${a.address}`.localeCompare(`${b.chain}|${b.address}`))
    : [];
  return { intervalSeconds: typeof p.intervalSeconds === 'number' ? p.intervalSeconds : null, heirs };
}

/**
 * Deterministic canonical form of the bound metadata. Fixed key order, every
 * field present, empty/absent normalized to null. MUST produce byte-identical
 * output on client and server (both feed the same already-trimmed values that go
 * into the request body).
 */
export function canonicalAgentMetadata(m: BoundMetadata): string {
  return JSON.stringify({
    displayName: m.displayName ?? null,
    description: m.description ?? null,
    website: m.website ?? null,
    category: m.category ?? null,
    imageUrl: m.imageUrl ?? null,
    tempoAddress: m.tempoAddress ?? null,
    succession: canonicalSuccession(m.succession),
  });
}

/** SHA-256 (hex) of the canonical metadata. Async — crypto.subtle is async. */
export async function metadataHash(m: BoundMetadata): Promise<string> {
  const utf8 = new TextEncoder().encode(canonicalAgentMetadata(m));
  // Copy into a plain ArrayBuffer so the digest input is unambiguously a
  // BufferSource — TextEncoder's Uint8Array<ArrayBufferLike> trips the strict
  // DOM lib (SharedArrayBuffer vs ArrayBuffer) under TS 5.9.
  const buf = new ArrayBuffer(utf8.byteLength);
  new Uint8Array(buf).set(utf8);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Separator between the base challenge and the metadata binding. */
export const CHALLENGE_HASH_SEP = ' | sha256:';

/** Client: append the metadata binding to a base challenge ("…at {ts}"). */
export function bindMetadata(baseMessage: string, hash: string): string {
  return `${baseMessage}${CHALLENGE_HASH_SEP}${hash}`;
}

/**
 * Server: does `message` bind EXACTLY this metadata? Never throws. A message
 * lacking the binding, or binding different fields, returns false → 401.
 */
export async function messageBindsMetadata(message: string, m: BoundMetadata): Promise<boolean> {
  const hash = await metadataHash(m);
  return message.endsWith(`${CHALLENGE_HASH_SEP}${hash}`);
}
