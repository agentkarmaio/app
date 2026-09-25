import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, Globe } from 'lucide-react';
import type { Chain } from '@/db/schema';
import { explorerAddressUrl } from '@/lib/explorer-urls';
import { safeHref } from '@/lib/safe-url';
import { categoryLabel } from '@/lib/agent-category';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { AgentAvatar } from './agent-avatar';
import { LivenessIndicator } from './liveness-indicator';
import { WalletAddress } from './wallet-address';

const BACK_LINK =
  'inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors';
const CATEGORY_CHIP =
  'bg-[rgb(255_255_255/0.04)] text-[#8a8f98] border-[rgb(255_255_255/0.08)] text-[11px] px-1.5 py-0';
const WEBSITE_LINK =
  'inline-flex items-center gap-1 text-[12px] text-[#8a8f98] hover:text-[#f7f8f8] transition-colors';

/**
 * The frame every agent profile shares: back link, identity header, separator,
 * then the body. It fetches nothing and holds no state — every piece that needs
 * an await (header chips, score visual, body sections) arrives as a node from
 * the caller, so each chain keeps ownership of its own Suspense boundaries and
 * the streaming order of the SSR shell stays where it is.
 *
 * `score` is a node rather than a number because the faces legitimately differ:
 * Solana shows one ring, Arc mainnet shows both faces side by side (invariant
 * #3 — two-faced karma is never collapsed into one number).
 */
export function AgentProfileShell({
  back,
  address,
  chain,
  avatarSrc,
  name,
  chips,
  actions,
  lastSeen,
  description,
  category,
  website,
  score,
  children,
}: {
  back: { href: string; label: string };
  address: string;
  chain: Chain;
  avatarSrc?: string | null;
  name?: string | null;
  /** Tier / confidence / autonomy / succession chips — streamed by the caller. */
  chips?: ReactNode;
  /** Header controls that act on the wallet, e.g. the embed badge button. */
  actions?: ReactNode;
  lastSeen?: string | Date | null;
  description?: string | null;
  category?: string | null;
  /** Raw declared URL: attacker-controlled, so it is sanitized here, once. */
  website?: string | null;
  score?: ReactNode;
  children: ReactNode;
}) {
  // walletRow.website is set through the wallet-signed claim flow, whose own
  // `new URL()` check accepts javascript:/data: — safeHref rejects both.
  const safeWebsite = safeHref(website);
  const label = categoryLabel(category);

  return (
    <div className="space-y-6">
      <Link href={back.href} className={BACK_LINK}>
        <ArrowLeft className="size-4" />
        {back.label}
      </Link>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <AgentAvatar src={avatarSrc} name={name ?? address} />
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[24px] font-[510] tracking-[-0.288px] text-[#f7f8f8]">
                {name ?? 'Agent Profile'}
              </h1>
              {chips}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <WalletAddress address={address} truncate={false} className="text-muted-foreground" />
              <a
                href={explorerAddressUrl(chain, address)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View account on block explorer"
                className="text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
              </a>
              {actions}
              <LivenessIndicator lastSeen={lastSeen} size="sm" showRelative />
            </div>

            {description && (
              <p className="text-[14px] text-[#8a8f98] leading-relaxed max-w-lg break-words">
                {description}
              </p>
            )}

            {(label || safeWebsite) && (
              <div className="flex flex-wrap items-center gap-3">
                {label && (
                  <Badge variant="outline" className={CATEGORY_CHIP}>
                    {label}
                  </Badge>
                )}
                {safeWebsite && (
                  <a href={safeWebsite} target="_blank" rel="noopener noreferrer" className={WEBSITE_LINK}>
                    <Globe className="size-3" />
                    {new URL(safeWebsite).hostname}
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
        {score}
      </div>

      <Separator />

      {children}
    </div>
  );
}
