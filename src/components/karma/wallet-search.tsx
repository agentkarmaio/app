'use client';

import { Suspense, use, useState, useCallback, useRef, useEffect, useId } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ArrowRight, Loader2, RotateCw } from 'lucide-react';
import { TierBadge } from '@/components/karma/tier-badge';
import { ChainBadge } from '@/components/karma/chain-badge';
import { agentHref } from '@/lib/agent-href';
import type { Chain, TrustTier } from '@/db/schema';

interface SearchResult {
  address: string;
  chain: Chain;
  displayName: string | null;
  score: number;
  trustTier: TrustTier;
  txCount: number;
  agentId: number | null;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

// Direct-lookup affordance: a full address typed in. Solana base58 (32-44),
// EVM 0x40hex (42), or Stellar G-strkey (56). For EVM the chain is ambiguous
// (Celo vs Arc) so we don't pin one — the /agent route resolves it.
function classifyTyped(q: string): { kind: 'solana' | 'evm' | 'stellar'; address: string } | null {
  const t = q.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return { kind: 'solana', address: t };
  if (/^0x[a-fA-F0-9]{40}$/.test(t)) return { kind: 'evm', address: t };
  if (/^G[A-Z2-7]{55}$/.test(t)) return { kind: 'stellar', address: t };
  return null;
}

export interface SearchExample {
  /** Chip text: a name, or a shortened address. */
  label: string;
  /** What the chip types into the search: the full name or address. */
  query: string;
}

/**
 * One-click example queries. The promise resolves to real indexed agents
 * streamed from the server; an empty list renders nothing (never a made-up name).
 */
function ExampleQueries({ examples, onPick }: { examples: Promise<SearchExample[]>; onPick: (q: string) => void }) {
  const items = use(examples);
  if (items.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2">
      <span className="text-[13px] text-[#8a8f98]">Try</span>
      {items.map((item) => (
        <button
          key={item.query}
          type="button"
          aria-label={`Search for ${item.label}`}
          onClick={() => onPick(item.query)}
          className="inline-flex min-h-8 max-w-[14rem] items-center rounded-full border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] px-3 text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:border-[rgb(255_255_255/0.16)] hover:bg-[rgb(255_255_255/0.05)] hover:text-[#f7f8f8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7170ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a] motion-reduce:transition-none"
        >
          <span className={`truncate ${item.label === item.query ? '' : 'font-mono text-[12px]'}`}>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export function WalletSearch({ examples }: { examples?: Promise<SearchExample[]> }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (idx: number) => `${baseId}-option-${idx}`;

  const typedAddress = classifyTyped(query);

  const search = useCallback(async (q: string) => {
    if (q.length < 3) {
      setResults([]);
      setFailed(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      // A rate limit or server error is not "no matches": say so honestly.
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      setResults(data.results ?? []);
      setFailed(false);
    } catch {
      setResults([]);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = useCallback((value: string) => {
    setQuery(value);
    setSelectedIdx(-1);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(value.trim()), 250);
  }, [search]);

  const pickExample = useCallback((value: string) => {
    handleChange(value);
    inputRef.current?.focus();
  }, [handleChange]);

  // Chain-aware navigation. A search result carries its chain, so EVM (Celo vs
  // Arc) links go to the right profile via agentHref. A raw typed address has
  // no chain (EVM ambiguous), so we link bare and let /agent resolve it.
  const navigateResult = useCallback((r: SearchResult) => {
    setOpen(false);
    setQuery('');
    router.push(agentHref(r));
  }, [router]);

  const navigateAddress = useCallback((address: string) => {
    setOpen(false);
    setQuery('');
    router.push(`/agent/${address}`);
  }, [router]);

  const handleSubmit = useCallback(() => {
    const offset = typedAddress ? 1 : 0;
    if (typedAddress && selectedIdx <= 0) {
      navigateAddress(typedAddress.address);
    } else if (selectedIdx >= offset && results[selectedIdx - offset]) {
      navigateResult(results[selectedIdx - offset]);
    } else if (results.length > 0) {
      // Enter or "Look up" with nothing highlighted opens the best match.
      navigateResult(results[0]);
    } else {
      inputRef.current?.focus();
      setOpen(true);
    }
  }, [selectedIdx, results, typedAddress, navigateResult, navigateAddress]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const totalItems = results.length + (typedAddress ? 1 : 0);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (totalItems === 0) return;
      setSelectedIdx((prev) =>
        e.key === 'ArrowDown' ? (prev + 1) % totalItems : (prev - 1 + totalItems) % totalItems,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      setOpen(false);
      setSelectedIdx(-1);
    }
  }, [results.length, typedAddress, handleSubmit]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const showDropdown = open && (query.trim().length >= 3 || !!typedAddress);
  const hasOptions = !!typedAddress || results.length > 0;
  const noMatches = !loading && !failed && results.length === 0 && !typedAddress && query.trim().length >= 3;

  // Spoken summary for screen readers; visible copy lives in the popup.
  const liveMessage = !showDropdown
    ? ''
    : loading
      ? 'Searching'
      : failed
        ? 'Search is unavailable right now.'
        : noMatches
          ? `No agents found matching ${query.trim()}`
          : `${results.length + (typedAddress ? 1 : 0)} results available. Use up and down arrows to review.`;

  return (
    <div ref={containerRef} className="relative w-full max-w-xl">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        className="relative flex h-11 items-center rounded-lg border border-[rgb(255_255_255/0.12)] bg-[rgb(255_255_255/0.04)] shadow-[0_1px_2px_rgb(0_0_0/0.4)] transition-colors focus-within:border-[rgb(113_112_255/0.6)] focus-within:bg-[rgb(255_255_255/0.05)] focus-within:ring-2 focus-within:ring-[rgb(113_112_255/0.35)] motion-reduce:transition-none"
      >
        <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#8a8f98]" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search agents by name, wallet address or agent ID"
          aria-autocomplete="list"
          aria-expanded={showDropdown}
          aria-controls={listboxId}
          aria-activedescendant={showDropdown && selectedIdx >= 0 ? optionId(selectedIdx) : undefined}
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => query.trim().length >= 3 && setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search by name or address…"
          className="h-full min-w-0 flex-1 bg-transparent pl-10 pr-2 text-[15px] text-[#f7f8f8] placeholder-[#8a8f98] outline-none"
          spellCheck={false}
          autoComplete="off"
        />
        {loading && (
          <Loader2 aria-hidden className="mr-2 size-4 shrink-0 animate-spin text-[#8a8f98] motion-reduce:animate-none" />
        )}
        <button
          type="submit"
          aria-label="Look up agent"
          className="mr-1 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[13px] font-[510] text-white transition-colors hover:bg-[#6873dc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7f8f8] focus-visible:ring-offset-1 focus-visible:ring-offset-[#08090a] motion-reduce:transition-none"
        >
          <span aria-hidden className="hidden sm:inline">Look up</span>
          <ArrowRight aria-hidden className="size-4" />
        </button>
      </form>

      <p role="status" aria-live="polite" className="sr-only">{liveMessage}</p>

      {examples && (
        <Suspense fallback={null}>
          <ExampleQueries examples={examples} onPick={pickExample} />
        </Suspense>
      )}

      {showDropdown && (
        <div className="absolute top-12 z-50 w-full overflow-hidden rounded-lg border border-[rgb(255_255_255/0.08)] bg-[rgb(20_21_22/0.97)] shadow-[0_8px_24px_-12px_rgb(0_0_0/0.6)] backdrop-blur-xl">
          <ul id={listboxId} role="listbox" aria-label="Matching agents" className={hasOptions ? 'py-1' : 'hidden'}>
            {typedAddress && (
              <li
                id={optionId(0)}
                role="option"
                aria-selected={selectedIdx === 0}
                className={`flex cursor-pointer items-center justify-between px-3 py-2.5 text-left transition-colors motion-reduce:transition-none ${
                  selectedIdx === 0 ? 'bg-[rgb(255_255_255/0.06)]' : 'hover:bg-[rgb(255_255_255/0.03)]'
                }`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => navigateAddress(typedAddress.address)}
                onMouseEnter={() => setSelectedIdx(0)}
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-[510] text-[#d0d6e0]">Look up wallet</p>
                  <p className="mt-0.5 truncate font-mono text-[12px] text-[#8a8f98]">{typedAddress.address}</p>
                </div>
                <ArrowRight aria-hidden className="size-3.5 shrink-0 text-[#8a8f98]" />
              </li>
            )}

            {results.length > 0 && (
              <li
                role="presentation"
                className={`px-3 pb-1 pt-2 text-[11px] font-[510] uppercase tracking-[0.06em] text-[#8a8f98] ${
                  typedAddress ? 'mt-1 border-t border-[rgb(255_255_255/0.05)]' : ''
                }`}
              >
                Known agents
              </li>
            )}
            {results.map((r, i) => {
              const idx = typedAddress ? i + 1 : i;
              return (
                <li
                  key={`${r.chain}:${r.address}`}
                  id={optionId(idx)}
                  role="option"
                  aria-selected={selectedIdx === idx}
                  className={`flex cursor-pointer items-center justify-between px-3 py-2 text-left transition-colors motion-reduce:transition-none ${
                    selectedIdx === idx ? 'bg-[rgb(255_255_255/0.06)]' : 'hover:bg-[rgb(255_255_255/0.03)]'
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => navigateResult(r)}
                  onMouseEnter={() => setSelectedIdx(idx)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <ChainBadge chain={r.chain} />
                    <span className="truncate text-[13px] text-[#d0d6e0]">
                      {r.displayName ?? shortAddr(r.address)}
                    </span>
                    {r.agentId != null && (
                      <span className="shrink-0 font-mono text-[11px] text-[#8a8f98]">#{r.agentId}</span>
                    )}
                    <TierBadge tier={r.trustTier} size="sm" />
                  </div>
                  <span className="shrink-0 text-[13px] font-[510] tabular-nums text-[#8a8f98]">
                    {r.score.toFixed(1)}
                  </span>
                </li>
              );
            })}
          </ul>

          {failed && !typedAddress && (
            <div className="flex items-center justify-between gap-3 px-3 py-3 text-[13px]">
              <span className="text-[#d0d6e0]">Search is unavailable right now. Try again in a moment.</span>
              <button
                type="button"
                onClick={() => search(query.trim())}
                className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-[510] text-[#d0d6e0] transition-colors hover:bg-[rgb(255_255_255/0.05)] hover:text-[#f7f8f8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7170ff] motion-reduce:transition-none"
              >
                <RotateCw aria-hidden className="size-3.5" />
                Try again
              </button>
            </div>
          )}

          {noMatches && (
            <div className="px-3 py-4 text-center text-[13px] text-[#8a8f98]">
              No agents found matching &ldquo;{query.trim()}&rdquo;
            </div>
          )}

          {loading && !hasOptions && !failed && (
            <div className="px-3 py-4 text-center text-[13px] text-[#8a8f98]">Searching…</div>
          )}
        </div>
      )}
    </div>
  );
}
