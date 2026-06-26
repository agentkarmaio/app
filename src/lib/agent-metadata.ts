/**
 * Shared agent-metadata validation — single source of truth for the field rules
 * that the claim routes (/api/agent/claim[/evm|/stellar]) and the edit route
 * (/api/agent/edit) both enforce. Before this, each route inlined identical
 * displayName/description/website/category checks; the 4th copy (edit) made the
 * duplication a pattern, so it lives here.
 *
 * Server-only: imports the SSRF guard (node:dns). Routes import it; client
 * banners keep their own presentational `CATEGORIES` {value,label} arrays.
 */
import { TEMPO_ADDRESS_REGEX } from '@/db/schema';
import { assertPublicHttpUrl, SsrfError } from '@/lib/ssrf-guard';

/** Canonical agent category set. The 3 claim routes + edit route import this. */
export const VALID_CATEGORIES = ['ai', 'data', 'defi', 'infra', 'social', 'utility', 'other'] as const;
export type AgentCategory = (typeof VALID_CATEGORIES)[number];

/** Upper bound on a stored logo URL — well clear of any real CDN URL. */
export const MAX_IMAGE_URL_LEN = 2048;

export interface AgentMetadataInput {
  /** Gated on `!== undefined` so the edit route can validate partial updates;
   *  claim routes enforce presence upstream (required-fields gate). */
  displayName?: string;
  description?: string | null;
  website?: string | null;
  category?: string | null;
  /** Solana-only declared signal; validated only when `opts.allowTempo`. */
  tempoAddress?: string | null;
}

/**
 * Synchronous field validation (cheap string/enum/URL-shape checks). The logo
 * URL is validated separately by `validateImageUrl` because it does an async
 * SSRF/DNS check — keeping this fn sync means the 400 path stays cheap.
 */
export function validateAgentMetadata(
  fields: AgentMetadataInput,
  opts: { allowTempo?: boolean } = {},
): { ok: true } | { ok: false; error: string } {
  const { displayName, description, website, category, tempoAddress } = fields;

  if (displayName !== undefined && (displayName.length < 1 || displayName.length > 50)) {
    return { ok: false, error: 'displayName must be 1-50 characters' };
  }
  if (description && description.length > 280) {
    return { ok: false, error: 'description must be 280 characters or less' };
  }
  if (category && !VALID_CATEGORIES.includes(category as AgentCategory)) {
    return { ok: false, error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` };
  }
  if (website) {
    try {
      new URL(website);
    } catch {
      return { ok: false, error: 'website must be a valid URL' };
    }
  }
  if (opts.allowTempo && tempoAddress && !TEMPO_ADDRESS_REGEX.test(tempoAddress)) {
    return { ok: false, error: 'tempoAddress must be a valid EVM-style 0x… 42-character address' };
  }

  return { ok: true };
}

/**
 * Validate a user-supplied agent logo URL before persisting it to
 * `wallets.image_url`. Empty / absent → `null` (the explicit "clear my logo"
 * path; NEVER returns `''`, which would defeat the `image_url ?? registry.image`
 * display fallback). Otherwise it MUST be a public http(s) URL — the same guard
 * /api/agent-image applies per fetch — so a stored value is guaranteed
 * renderable and we fail loud HERE rather than silently degrading to a monogram
 * at display time.
 *
 * Async (DNS-resolves named hosts to block private/metadata/rebind targets).
 * Throws `SsrfError` on reject; routes map that to HTTP 422.
 */
export async function validateImageUrl(raw: unknown): Promise<string | null> {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return null;
  if (typeof raw !== 'string') {
    throw new SsrfError('imageUrl must be a string');
  }
  const v = raw.trim();
  if (v.length > MAX_IMAGE_URL_LEN) {
    throw new SsrfError(`imageUrl exceeds ${MAX_IMAGE_URL_LEN} characters`);
  }
  // http(s)-only + private/loopback/metadata-range + DNS-rebind block.
  await assertPublicHttpUrl(v);
  return v;
}
