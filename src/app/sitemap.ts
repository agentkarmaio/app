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

export const revalidate = 3600;

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

  // Top-N agents by score. Sitemap is regenerated hourly so churn is fine.
  let agentEntries: MetadataRoute.Sitemap = [];
  try {
    const { wallets } = await getLeaderboard(MAX_AGENTS_IN_SITEMAP, 0);
    agentEntries = wallets.map((w) => ({
      url: `${SITE}/agent/${w.address}`,
      lastModified: w.last_seen ? new Date(w.last_seen) : (w.updated_at ? new Date(w.updated_at) : now),
      changeFrequency: 'daily',
      priority: w.claimed ? 0.7 : 0.4,
    }));
  } catch {
    // DB unreachable — emit static portion only. Better than 500.
  }

  let orgEntries: MetadataRoute.Sitemap = [];
  try {
    const orgs = await listOrganizations();
    orgEntries = orgs.map((o) => ({
      url: `${SITE}/org/${o.slug}`,
      lastModified: o.created_at ? new Date(o.created_at) : now,
      changeFrequency: 'weekly',
      priority: 0.7,
    }));
  } catch {
    // see above
  }

  return [...staticEntries, ...payshEntries, ...orgEntries, ...agentEntries];
}
