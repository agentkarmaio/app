/**
 * IndexNow — instant search-engine notification (Bing, Yandex, Naver, Seznam,
 * Yep, and the shared api.indexnow.org endpoint that fans out to all of them).
 * Google does not consume IndexNow; it is covered by the sitemap + crawl.
 *
 * How verification works: the receiving engine fetches `keyLocation` and checks
 * that its body equals `key`. That file is served statically from
 * `web/public/${INDEXNOW_KEY}.txt` — its filename and contents are this same
 * constant, so THIS module is the single source of truth. If you rotate the
 * key, rename that public file to match.
 *
 * Etiquette (per indexnow.org): submit only URLs whose content actually
 * changed. Do not re-submit unchanged pages on a schedule — callers filter by
 * lastModified before calling here. Max 10,000 URLs per request.
 */

export const INDEXNOW_KEY = '6b5c68b0f61843f4b81d8f047c80134362f23094c53545e59a07b28eb7485fea';

const SITE = 'https://agentkarma.io';
const HOST = 'agentkarma.io';
const KEY_LOCATION = `${SITE}/${INDEXNOW_KEY}.txt`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_URLS_PER_REQUEST = 10_000;

export type IndexNowResult = {
  submitted: number;
  batches: { count: number; status: number; ok: boolean }[];
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Submit changed URLs to IndexNow. Only same-origin (agentkarma.io) URLs are
 * accepted — the protocol rejects cross-host lists and it guards against
 * accidentally pinging with dev/preview URLs. Network/HTTP errors are logged,
 * never thrown: this is a fire-and-forget notification, never on a critical
 * path. Returns a per-batch report so scripts can log/exit meaningfully.
 */
export async function submitUrls(urls: string[]): Promise<IndexNowResult> {
  const clean = [...new Set(urls)].filter((u) => {
    try {
      return new URL(u).host === HOST;
    } catch {
      return false;
    }
  });

  if (clean.length === 0) return { submitted: 0, batches: [] };

  const batches: IndexNowResult['batches'] = [];
  for (const urlList of chunk(clean, MAX_URLS_PER_REQUEST)) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: HOST, key: INDEXNOW_KEY, keyLocation: KEY_LOCATION, urlList }),
      });
      batches.push({ count: urlList.length, status: res.status, ok: res.ok });
      if (!res.ok) {
        console.error(`[indexnow] submit failed: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      batches.push({ count: urlList.length, status: 0, ok: false });
      console.error('[indexnow] submit threw:', err);
    }
  }

  return { submitted: clean.length, batches };
}
