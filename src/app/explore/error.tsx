'use client';

/**
 * Route-scoped error boundary for /explore.
 *
 * Without this, any uncaught throw while server-rendering the Explore route
 * (e.g. an RSC stream severed by a container restart mid-render) bubbles to
 * the global handler and white-screens the whole app. Scoped here, the app
 * shell + nav survive and the user gets a one-tap retry that re-renders only
 * this segment.
 */

import { useEffect } from 'react';

export default function ExploreError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[explore] render error:', error);
  }, [error]);

  return (
    <div className="relative overflow-hidden rounded-lg border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.02)] p-10 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgb(245_166_35/0.08),transparent_55%)]"
      />
      <div className="relative">
        <p className="text-[15px] font-[510] text-[#f7f8f8]">
          Couldn&apos;t load Explore
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-[#8a8f98]">
          A transient server error interrupted this view. Retry — it usually
          clears on the next request.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-5 inline-flex items-center rounded-md bg-[#5e6ad2] px-3 py-1.5 text-[13px] font-[510] text-white transition-colors hover:bg-[#5e6ad2]/90"
        >
          Retry
        </button>
        {error.digest && (
          <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.1em] text-[#4b4e54]">
            error {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
