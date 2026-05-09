'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * Polls /api/score/[wallet] while a regressive scan is in flight. When the
 * route flips from 202 (`{ scanning: true }`) to a 200 with a full score,
 * triggers a server-component refresh so the parent page can re-render with
 * the freshly indexed data. Stops after 3 minutes; encourages manual refresh.
 *
 * The initial scan-state hydration is done by the parent server component,
 * so we never need a client-side initial fetch — `useEffect` here is only
 * for setting up + tearing down the poll loop.
 */
const MAX_POLLS = 36;        // 3 minutes @ 5s base interval
const BASE_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

export function ScanPoller({ wallet }: { wallet: string }) {
  const router = useRouter();
  const [exhausted, setExhausted] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polls = 0;
    let consecutiveErrors = 0;

    const tick = async () => {
      if (cancelledRef.current) return;
      polls += 1;
      if (polls > MAX_POLLS) {
        setExhausted(true);
        return;
      }

      try {
        const res = await fetch(`/api/score/${wallet}`, { cache: 'no-store' });
        if (res.status === 200) {
          const body = (await res.json().catch(() => null)) as { scanning?: boolean } | null;
          // Full score response — `scanning` flag absent or falsy.
          if (!body?.scanning) {
            if (!cancelledRef.current) router.refresh();
            return;
          }
        }
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors += 1;
      }

      const backoff = consecutiveErrors > 0
        ? Math.min(MAX_BACKOFF_MS, BASE_INTERVAL_MS * 2 ** consecutiveErrors)
        : BASE_INTERVAL_MS;
      timer = setTimeout(tick, backoff);
    };

    timer = setTimeout(tick, BASE_INTERVAL_MS);

    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [wallet, router]);

  if (exhausted) {
    return (
      <p className="text-[12px] text-[#8a8f98]">
        Scan taking longer than expected. Refresh the page to check status.
      </p>
    );
  }

  return (
    <div className="inline-flex items-center gap-2 text-[12px] text-[#8a8f98]">
      <Loader2 className="size-3 animate-spin text-[#828fff]" aria-hidden />
      <span>Polling for results…</span>
    </div>
  );
}
