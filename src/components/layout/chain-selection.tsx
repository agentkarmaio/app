'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { isChain, type Chain } from '@/db/schema';
import { activeChainFromPath, agentChainFromPath, isAgentPath } from '@/lib/chain-meta';

/**
 * Active-chain context for the header. Two modes, keyed off the route:
 *
 * - Browse/landing pages: `active` is derived from the path and `navigate` is
 *   true, so the switcher links to each chain's context page (unchanged).
 * - Agent detail pages (`/agent/[wallet]`): `navigate` is false and `select`
 *   updates local state in place. Picking a network MUST NOT push the user off
 *   the agent they're viewing — it only swaps the active-chain context (which
 *   wallet the Connect button offers). The initial value is seeded from the
 *   agent address class, then refined from a `?chain=` query param (Celo vs Arc
 *   share the 0x format). `?chain=` is read via window.location in an effect to
 *   avoid forcing the layout-level navbar into a useSearchParams Suspense boundary.
 */
interface ChainSelection {
  active: Chain;
  /** True when picking a chain should navigate (browse pages); false on agent pages. */
  navigate: boolean;
  select: (chain: Chain) => void;
}

const ChainSelectionContext = createContext<ChainSelection | null>(null);

export function ChainSelectionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const onAgentPage = isAgentPath(pathname);
  const pathChain = activeChainFromPath(pathname);
  const [picked, setPicked] = useState<Chain>(() =>
    isAgentPath(pathname) ? agentChainFromPath(pathname) : activeChainFromPath(pathname),
  );

  // Re-seed when the route changes: on a new agent page, prefer an explicit
  // `?chain=` pin (resolves the Celo/Arc ambiguity) over the address-class
  // guess; off agent pages, the path is authoritative. Resetting here also
  // ensures the in-place selection never leaks across navigations.
  useEffect(() => {
    if (!isAgentPath(pathname)) {
      setPicked(activeChainFromPath(pathname));
      return;
    }
    let seed = agentChainFromPath(pathname);
    const q = new URLSearchParams(window.location.search).get('chain');
    if (isChain(q)) seed = q;
    setPicked(seed);
  }, [pathname]);

  const active = onAgentPage ? picked : pathChain;

  return (
    <ChainSelectionContext.Provider value={{ active, navigate: !onAgentPage, select: setPicked }}>
      {children}
    </ChainSelectionContext.Provider>
  );
}

export function useChainSelection(): ChainSelection {
  const ctx = useContext(ChainSelectionContext);
  if (!ctx) throw new Error('useChainSelection must be used within a ChainSelectionProvider');
  return ctx;
}
