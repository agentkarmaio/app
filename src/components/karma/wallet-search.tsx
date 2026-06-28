'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ArrowRight, Loader2 } from 'lucide-react';
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

export function WalletSearch() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const typedAddress = classifyTyped(query);

  const search = useCallback(async (q: string) => {
    if (q.length < 3) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setResults(data.results ?? []);
    } catch {
      setResults([]);
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
    if (selectedIdx >= 0 && results[selectedIdx]) {
      navigateResult(results[selectedIdx]);
    } else if (typedAddress) {
      navigateAddress(typedAddress.address);
    }
  }, [selectedIdx, results, typedAddress, navigateResult, navigateAddress]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const totalItems = results.length + (typedAddress ? 1 : 0);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((prev) => (prev + 1) % totalItems);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((prev) => (prev - 1 + totalItems) % totalItems);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
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

  const showDropdown = open && (query.length >= 3 || !!typedAddress);

  return (
    <div ref={containerRef} className="relative w-full max-w-xl">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-[#62666d]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => query.length >= 3 && setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search by name or address…"
          className="h-9 w-full rounded-full border border-[rgb(255_255_255/0.05)] bg-[rgb(255_255_255/0.02)] pl-9 pr-4 text-[13px] font-[510] text-[#f7f8f8] placeholder-[#62666d] outline-none transition-colors focus:border-[rgb(113_112_255/0.35)] focus:bg-[rgb(255_255_255/0.03)]"
          spellCheck={false}
          autoComplete="off"
        />
        {loading && (
          <Loader2 className="absolute right-3.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-[#62666d]" />
        )}
      </div>

      {showDropdown && (
        <div className="absolute top-full z-50 mt-1.5 w-full overflow-hidden rounded-xl border border-[rgb(255_255_255/0.06)] bg-[rgb(20_21_22/0.95)] backdrop-blur-xl shadow-[0_8px_24px_-12px_rgb(0_0_0/0.6)]">
          {typedAddress && (
            <button
              type="button"
              className={`flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors ${
                selectedIdx === 0
                  ? 'bg-[rgb(255_255_255/0.05)]'
                  : 'hover:bg-[rgb(255_255_255/0.03)]'
              }`}
              onClick={() => navigateAddress(typedAddress.address)}
              onMouseEnter={() => setSelectedIdx(0)}
            >
              <div className="min-w-0">
                <p className="text-[13px] font-[510] text-[#d0d6e0]">
                  Look up wallet
                </p>
                <p className="mt-0.5 truncate font-mono text-[12px] text-[#62666d]">
                  {typedAddress.address}
                </p>
              </div>
              <ArrowRight className="size-3.5 shrink-0 text-[#62666d]" />
            </button>
          )}

          {results.length > 0 && (
            <>
              {typedAddress && (
                <div className="border-t border-[rgb(255_255_255/0.05)]" />
              )}
              <div className="px-2 py-1.5">
                <p className="px-1 text-[10px] font-[510] uppercase tracking-wide text-[#62666d]">
                  Known agents
                </p>
              </div>
              {results.map((r, i) => {
                const idx = typedAddress ? i + 1 : i;
                return (
                  <button
                    key={`${r.chain}:${r.address}`}
                    type="button"
                    className={`flex w-full items-center justify-between px-3 py-2 text-left transition-colors ${
                      selectedIdx === idx
                        ? 'bg-[rgb(255_255_255/0.05)]'
                        : 'hover:bg-[rgb(255_255_255/0.03)]'
                    }`}
                    onClick={() => navigateResult(r)}
                    onMouseEnter={() => setSelectedIdx(idx)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <ChainBadge chain={r.chain} />
                      <span className="truncate text-[13px] text-[#d0d6e0]">
                        {r.displayName ?? shortAddr(r.address)}
                      </span>
                      {r.agentId != null && (
                        <span className="shrink-0 font-mono text-[11px] text-[#62666d]">
                          #{r.agentId}
                        </span>
                      )}
                      <TierBadge tier={r.trustTier} size="sm" />
                    </div>
                    <span className="shrink-0 text-[13px] font-[510] tabular-nums text-[#8a8f98]">
                      {r.score.toFixed(1)}
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {!loading && results.length === 0 && !typedAddress && query.length >= 3 && (
            <div className="px-3 py-4 text-center text-[13px] text-[#62666d]">
              No agents found matching &ldquo;{query}&rdquo;
            </div>
          )}
        </div>
      )}
    </div>
  );
}
