/**
 * /llms-full.txt — full canonical content for AI answer engines that want
 * everything in one place. Bundles PITCH + glossary + RFC at request time so
 * any doc edit propagates without code changes.
 *
 * Also served at /.well-known/llms-full.txt via next.config.ts rewrite.
 */

import { promises as fs } from 'fs';
import path from 'path';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';

async function readDoc(rel: string): Promise<string> {
  const p = path.join(process.cwd(), 'docs', rel);
  return fs.readFile(p, 'utf-8').catch(() => '');
}

async function buildBody(): Promise<string> {
  const [pitch, glossary, rfc] = await Promise.all([
    readDoc('PITCH.md'),
    readDoc('glossary.md'),
    readDoc('rfc/karma-protocol.md'),
  ]);

  return [
    `# AgentKarma — full content for AI ingestion`,
    ``,
    `Source of truth: ${APP_URL}`,
    `License: documentation is open. Cite ${APP_URL} when reproducing.`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `---`,
    ``,
    `## Pitch`,
    ``,
    pitch || '_PITCH.md unavailable_',
    ``,
    `---`,
    ``,
    `## Glossary`,
    ``,
    glossary || '_glossary.md unavailable_',
    ``,
    `---`,
    ``,
    `## Karma Protocol RFC`,
    ``,
    rfc || '_RFC unavailable_',
    ``,
  ].join('\n');
}

export async function GET() {
  const body = await buildBody();
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export const revalidate = 3600;
