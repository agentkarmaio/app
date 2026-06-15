import { ExternalLink, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { AgentManifest, ParsedManifest } from '@/db/schema';
import { safeHref, safeEndpointHref } from '@/lib/safe-url';

const ENDPOINT_LABEL: Record<string, string> = {
  x402: 'x402 endpoint',
  mcp:  'MCP descriptor',
  http: 'HTTP endpoint',
  ws:   'WebSocket endpoint',
  grpc: 'gRPC endpoint',
};

const SOURCE_LABEL: Record<string, string> = {
  self_hosted:    'Self-hosted /.well-known',
  x402_accepts:   'x402 accepts response',
  mcp_descriptor: 'MCP server descriptor',
  claim_form:     'Claim form',
};

export function ManifestCard({ manifest }: { manifest: AgentManifest }) {
  const parsed = (manifest.parsed ?? {}) as ParsedManifest;
  const endpoints = parsed.endpoints ?? [];
  const capabilities = parsed.capabilities ?? [];
  // manifest.url is where AK fetched the manifest from (agent-declared for
  // self-hosted sources). Sanitize before linking — http(s) only.
  const sourceUrl = safeHref(manifest.url);

  return (
    <Card className="border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            Declared Manifest
          </CardTitle>
          {manifest.verified ? (
            <Badge
              variant="outline"
              className="gap-1 bg-[rgb(16_185_129/0.10)] text-[#10b981] border-[rgb(16_185_129/0.25)] text-[10px] px-1.5 py-0 font-[510]"
              title="The manifest declares this wallet — owner-verified."
            >
              <ShieldCheck className="size-3" />
              Owner-verified
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="gap-1 bg-[rgb(255_255_255/0.04)] text-[#8a8f98] border-[rgb(255_255_255/0.08)] text-[10px] px-1.5 py-0 font-[510]"
              title="Manifest exists but does not declare a wallet — unverified."
            >
              <ShieldAlert className="size-3" />
              Unverified
            </Badge>
          )}
        </div>
        <p className="mt-1 text-[11px] text-[#62666d]">
          {SOURCE_LABEL[manifest.source_type] ?? manifest.source_type}
          {sourceUrl && (
            <>
              {' · '}
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[#d0d6e0] transition-colors inline-flex items-center gap-1"
              >
                {new URL(sourceUrl).hostname}
                <ExternalLink className="size-3" />
              </a>
            </>
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {parsed.description && (
          <p className="text-[13px] leading-relaxed text-[#b4bcd0]">{parsed.description}</p>
        )}

        {capabilities.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-[510] uppercase tracking-[0.12em] text-[#62666d]">
              Capabilities
            </p>
            <div className="flex flex-wrap gap-1.5">
              {capabilities.map((cap) => (
                <span
                  key={cap}
                  className="rounded-md border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.04)] px-1.5 py-0.5 text-[11px] font-mono text-[#d0d6e0]"
                >
                  {cap}
                </span>
              ))}
            </div>
          </div>
        )}

        {endpoints.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] font-[510] uppercase tracking-[0.12em] text-[#62666d]">
              Endpoints
            </p>
            <div className="space-y-1.5">
              {endpoints.map((ep) => {
                // ep.url is attacker-controlled (declared in the agent manifest).
                // Allow http/ws/grpc but block executable schemes; when unsafe,
                // render the URL as inert text instead of a clickable link.
                const safe = safeEndpointHref(ep.url);
                const inner = (
                  <>
                    <span className="font-[510] text-[#d0d6e0]">
                      {ENDPOINT_LABEL[ep.kind] ?? ep.kind}
                    </span>
                    <span className="flex items-center gap-1 truncate font-mono text-[11px] text-[#62666d]">
                      <span className="truncate max-w-[240px]">{ep.url}</span>
                      {safe && <ExternalLink className="size-3 shrink-0" />}
                    </span>
                  </>
                );
                const cls =
                  'flex items-center justify-between gap-3 rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)] px-2.5 py-1.5 text-[12px] transition-colors hover:border-[rgb(255_255_255/0.12)] hover:bg-[rgb(255_255_255/0.04)]';
                return safe ? (
                  <a key={ep.kind + ep.url} href={safe} target="_blank" rel="noopener noreferrer" className={cls}>
                    {inner}
                  </a>
                ) : (
                  <div key={ep.kind + ep.url} className={cls}>
                    {inner}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {(() => {
          // Manifest URLs are attacker-controlled — agents publish their own
          // ParsedManifest. Reject anything that isn't http(s) so a malicious
          // manifest can't ship `javascript:` URIs into the rendered links.
          const githubHref = safeHref(parsed.github);
          const websiteHref = safeHref(parsed.website);
          if (!githubHref && !websiteHref) return null;
          return (
            <div className="flex flex-wrap gap-3 pt-1 text-[11px]">
              {githubHref && (
                <a
                  href={githubHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
                >
                  GitHub
                  <ExternalLink className="size-3" />
                </a>
              )}
              {websiteHref && (
                <a
                  href={websiteHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[#8a8f98] transition-colors hover:text-[#d0d6e0]"
                >
                  Website
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          );
        })()}
      </CardContent>
    </Card>
  );
}
