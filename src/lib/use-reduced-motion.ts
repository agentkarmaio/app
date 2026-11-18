'use client';

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/**
 * Live `prefers-reduced-motion: reduce`. CSS media queries cannot stop JS
 * animation (rAF loops, SMIL `<animate>`, timers), so those read this instead.
 * The server snapshot is `true`: render the still version first and only start
 * motion once the client confirms the user has not asked to reduce it.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
