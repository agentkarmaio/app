import type { MetadataRoute } from 'next';
import { getLeaderboard, listOrganizations } from '@/db/client';
import { PAYSH_OPERATORS } from '@/config/paysh-operators';

const SITE = 'https://agentkarma.io';

// Sitemap protocol caps a single file at 50,000 URLs. We stay well under that
// per file and add a static-route head so crawlers always get a complete map
// even when the DB is unreachable (which is the only failure mode in dev).
const MAX_AGENTS_IN_SITEMAP = 5000;

const STATIC_ROUTES: { path: string; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']; priority: number }[] = [
  { path: '/',           changeFrequency: 'hourly',  priority: 1.0 },
  { path: '/explore',    changeFrequency: 'hourly',  priority: 0.9 },
  { path: '/paysh',      changeFrequency: 'hourly',  priority: 0.9 },
  { path: '/protocol',   changeFrequency: 'weekly',  priority: 0.8 },
  { path: '/widget',     changeFrequency: 'monthly', priority: 0.7 },
  { path: '/enterprise', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/docs/mcp',   changeFrequency: 'weekly',  priority: 0.7 },
  { path: '/specimen',   changeFrequency: 'monthly', priority: 0.6 },
  { path: '/glossary',   changeFrequency: 'monthly', priority: 0.7 },
  { path: '/faq',        changeFrequency: 'monthly', priority: 0.7 },
];

// Render at runtime, not build time. The build container may not have
// Supabase reachable; the deployed runtime always does. Cloudflare can
// still edge-cache via the response's Cache-Control if we add it later.
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((r) => ({
    url: `${SITE}${r.path}`,
    lastModified: now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));

  // pay.sh operator anchor pages — we don't have detail routes per operator
  // yet, but the directory deep-links by operator id via #anchor.
  const payshEntries: MetadataRoute.Sitemap = Object.keys(PAYSH_OPERATORS).map((id) => ({
    url: `${SITE}/paysh#${id}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.5,
  }));

  // Top-N agents by score. Let DB errors propagate — caching an empty
  // sitemap as success would pin the staleness for the full revalidate
  // window. Throwing means Next.js retries on the next request.
  const { wallets } = await getLeaderboard(MAX_AGENTS_IN_SITEMAP, 0);
  const agentEntries: MetadataRoute.Sitemap = wallets.map((w) => ({
    url: `${SITE}/agent/${w.address}`,
    lastModified: w.last_seen ? new Date(w.last_seen) : (w.updated_at ? new Date(w.updated_at) : now),
    changeFrequency: 'daily',
    priority: w.claimed ? 0.7 : 0.4,
  }));

  const orgs = await listOrganizations();
  const orgEntries: MetadataRoute.Sitemap = orgs.map((o) => ({
    url: `${SITE}/org/${o.slug}`,
    lastModified: o.created_at ? new Date(o.created_at) : now,
    changeFrequency: 'weekly',
    priority: 0.7,
  }));

  return [...staticEntries, ...payshEntries, ...orgEntries, ...agentEntries];
}
