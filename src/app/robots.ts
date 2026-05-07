import type { MetadataRoute } from 'next';

const SITE_URL = 'https://agentkarma.io';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/_or/', '/_next/'],
      },
      // AI/LLM crawlers — explicit allow. AgentKarma is a public reputation
      // primitive; we want answer engines to surface it.
      { userAgent: 'GPTBot', allow: '/' },
      { userAgent: 'OAI-SearchBot', allow: '/' },
      { userAgent: 'ChatGPT-User', allow: '/' },
      { userAgent: 'ClaudeBot', allow: '/' },
      { userAgent: 'Claude-Web', allow: '/' },
      { userAgent: 'PerplexityBot', allow: '/' },
      { userAgent: 'Perplexity-User', allow: '/' },
      { userAgent: 'Google-Extended', allow: '/' },
      { userAgent: 'Applebot-Extended', allow: '/' },
      { userAgent: 'CCBot', allow: '/' },
      { userAgent: 'Bytespider', allow: '/' },
      { userAgent: 'Amazonbot', allow: '/' },
      { userAgent: 'Meta-ExternalAgent', allow: '/' },
      { userAgent: 'cohere-ai', allow: '/' },
      { userAgent: 'DuckAssistBot', allow: '/' },
      { userAgent: 'YouBot', allow: '/' },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
