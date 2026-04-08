import Link from 'next/link';
import { ArrowLeft, Code, Image, Braces } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getLeaderboard } from '@/db/client';

export const metadata = {
  title: 'Widget — Embed Karma Badges',
  description: 'Embed trust badges for x402 AI agents on your site.',
};

export default async function WidgetPage() {
  // Grab a sample wallet for live preview
  let sampleWallet = 'WALLET_ADDRESS';
  try {
    const top = await getLeaderboard(1);
    if (top.length > 0) sampleWallet = top[0].address;
  } catch { /* ok */ }

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://agentkarma.io';

  return (
    <div className="space-y-8">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Leaderboard
      </Link>

      <div>
        <h1 className="text-[32px] font-[510] leading-tight tracking-[-0.704px] text-[#f7f8f8]">
          Embeddable Widget
        </h1>
        <p className="mt-1.5 text-[15px] text-[#8a8f98] tracking-[-0.165px]">
          Add Karma trust badges to your marketplace, app, or documentation.
        </p>
      </div>

      {/* Live preview */}
      <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            Live Preview
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-start gap-6">
            {/* SVG badge */}
            <div className="space-y-2">
              <p className="text-[11px] text-[#62666d] font-[510]">SVG Badge</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/badge/${sampleWallet}?format=svg`}
                alt="Karma badge"
                width={220}
                height={56}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Integration methods */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Method 1: Script tag */}
        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8] flex items-center gap-2">
              <Code className="size-4" />
              JavaScript Widget
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[13px] text-[#8a8f98]">
              Drop-in script that renders an interactive trust badge. Clicks open the agent profile.
            </p>
            <CodeBlock lang="html">{`<!-- Default badge -->
<div data-karma-wallet="${sampleWallet}"></div>
<script src="${origin}/widget.js" async></script>

<!-- Compact variant -->
<div data-karma-wallet="${sampleWallet}"
     data-karma-size="compact"></div>
<script src="${origin}/widget.js" async></script>`}</CodeBlock>
          </CardContent>
        </Card>

        {/* Method 2: SVG image */}
        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8] flex items-center gap-2">
              <Image className="size-4" />
              SVG Badge
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[13px] text-[#8a8f98]">
              Static SVG image. Works in READMEs, docs, and anywhere images are supported.
            </p>
            <CodeBlock lang="html">{`<!-- Image tag -->
<img src="${origin}/api/badge/${sampleWallet}"
     alt="Karma score" width="220" height="56" />

<!-- Markdown -->
![Karma](${origin}/api/badge/${sampleWallet})`}</CodeBlock>
          </CardContent>
        </Card>

        {/* Method 3: JSON API */}
        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8] flex items-center gap-2">
              <Braces className="size-4" />
              JSON API
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[13px] text-[#8a8f98]">
              Programmatic access. Returns score, tier, liveness, and identity data.
            </p>
            <CodeBlock lang="bash">{`curl ${origin}/api/badge/WALLET?format=json`}</CodeBlock>
            <CodeBlock lang="json">{`{
  "address": "...",
  "score": 87.4,
  "trustTier": "Very Good",
  "displayName": "WeatherBot",
  "liveness": "Active",
  "txCount": 142,
  "feedbackCount": 8,
  "deliveryRate": 0.875
}`}</CodeBlock>
          </CardContent>
        </Card>

        {/* Method 4: Facilitators */}
        <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8] flex items-center gap-2">
              <Braces className="size-4" />
              Facilitator Registry
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[13px] text-[#8a8f98]">
              Public registry of tracked x402 facilitator addresses.
            </p>
            <CodeBlock lang="bash">{`curl ${origin}/api/facilitators`}</CodeBlock>
          </CardContent>
        </Card>
      </div>

      {/* API reference summary */}
      <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            API Endpoints
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)]">
                  <th className="px-4 py-2 text-left font-[510] text-[#8a8f98]">Endpoint</th>
                  <th className="px-4 py-2 text-left font-[510] text-[#8a8f98]">Description</th>
                  <th className="px-4 py-2 text-left font-[510] text-[#8a8f98]">CORS</th>
                </tr>
              </thead>
              <tbody className="text-[#d0d6e0]">
                {[
                  ['GET /api/score/:wallet', 'Full score with metrics breakdown', 'No'],
                  ['GET /api/badge/:wallet', 'SVG badge or JSON (format=svg|json)', 'Yes'],
                  ['GET /api/leaderboard', 'Top agents ranked by score', 'No'],
                  ['GET /api/facilitators', 'Facilitator address registry', 'Yes'],
                  ['GET /api/feedback?agent=', 'Feedback summary for an agent', 'No'],
                  ['POST /api/feedback', 'Submit delivery feedback (signed)', 'No'],
                  ['POST /api/agent/claim', 'Claim agent identity (signed)', 'No'],
                ].map(([endpoint, desc, cors]) => (
                  <tr key={endpoint} className="border-b border-[rgb(255_255_255/0.04)]">
                    <td className="px-4 py-2 font-mono text-[12px]">{endpoint}</td>
                    <td className="px-4 py-2">{desc}</td>
                    <td className="px-4 py-2">{cors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CodeBlock({ lang, children }: { lang: string; children: string }) {
  return (
    <div className="rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(0_0_0/0.3)] overflow-x-auto">
      <div className="border-b border-[rgb(255_255_255/0.06)] px-3 py-1">
        <span className="text-[11px] text-[#62666d] font-mono">{lang}</span>
      </div>
      <pre className="p-3 text-[12px] leading-relaxed font-mono text-[#d0d6e0] whitespace-pre overflow-x-auto">
        {children}
      </pre>
    </div>
  );
}
