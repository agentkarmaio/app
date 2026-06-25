'use client';

/**
 * AgentAvatar — an agent's logo, or a quiet initials monogram when there isn't
 * one. The image (from on-chain registration JSON) is loaded through the
 * same-origin /api/agent-image proxy, which SSRF-guards, size-caps, and caches
 * it. On a missing/invalid URL or a load error we render the monogram, so a
 * broken or absent logo never leaves a hole.
 *
 * Decorative by design: the agent name sits adjacent as a heading / cell, so the
 * image is `alt=""` and the monogram is aria-hidden to avoid double announcing.
 */
import { useState } from 'react';
import { cn } from '@/lib/utils';

/** http(s) only — mirrors the registration fetcher, which defers ipfs:// / ar://.
 *  Anything else falls through to the monogram. */
function proxiedSrc(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!/^https?:\/\//i.test(v)) return null;
  return `/api/agent-image?url=${encodeURIComponent(v)}`;
}

/** Up to two letters: word initials when there are two, else leading alphanumerics. */
function monogram(name: string): string {
  const cleaned = name.replace(/^agent\s+/i, '').trim();
  if (!cleaned) return '?';
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const alnum = cleaned.replace(/[^a-z0-9]/gi, '');
  return (alnum.slice(0, 2) || cleaned.slice(0, 2)).toUpperCase();
}

export function AgentAvatar({
  src,
  name,
  size = 56,
  className,
}: {
  src?: string | null;
  name: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = proxiedSrc(src);

  return (
    <div
      style={{ width: size, height: size }}
      className={cn(
        'relative flex shrink-0 select-none items-center justify-center overflow-hidden rounded-xl border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.03)]',
        className,
      )}
    >
      {url && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary remote
        // host, proxied same-origin; next/image cannot whitelist unknown domains.
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          aria-hidden
          className="font-[590] leading-none tracking-[-0.02em] text-[#8a8f98]"
          style={{ fontSize: Math.round(size * 0.36) }}
        >
          {monogram(name)}
        </span>
      )}
    </div>
  );
}
