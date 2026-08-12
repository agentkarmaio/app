'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Menu } from 'lucide-react';
import { WalletConnectButton } from '@/components/wallet/wallet-connect-button';
import { EvmWalletButton } from '@/components/wallet/evm-wallet-button';
import { ChainSwitcher } from '@/components/layout/chain-switcher';
import { ChainSelectionProvider, useChainSelection } from '@/components/layout/chain-selection';
import { isEvmChain } from '@/lib/chain-meta';

/** Chain-aware connect: injected EVM wallet on Celo/Arc, Solana adapter elsewhere.
 *  Reads the active chain from context so an in-place switch on an agent page
 *  swaps the wallet without navigating. */
function ConnectButton() {
  const { active } = useChainSelection();
  return isEvmChain(active) ? <EvmWalletButton /> : <WalletConnectButton />;
}

const PRIMARY_ITEMS = [
  { href: '/', label: 'Home' },
  { href: '/agent-enact', label: 'AgentEnact' },
  { href: '/explore', label: 'Explore' },
  { href: '/protocol', label: 'Protocol' },
];

const MORE_ITEMS = [
  { href: '/succession', label: 'Succession' },
  { href: '/bonding', label: 'Bonding' },
  { href: '/estates', label: 'Estates' },
  { href: '/sureties', label: 'Sureties' },
  { href: '/widget', label: 'Widget' },
  { href: '/paysh', label: 'pay.sh' },
  { href: '/docs/mcp', label: 'MCP' },
  { href: '/enterprise', label: 'Enterprise' },
];

const ALL_ITEMS = [...PRIMARY_ITEMS, ...MORE_ITEMS];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function Navbar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  const moreActive = MORE_ITEMS.some((item) => isActive(pathname, item.href));

  useEffect(() => {
    if (!open && !moreOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setMoreOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, moreOpen]);

  return (
    <ChainSelectionProvider>
    <header className="sticky top-0 z-50 px-4 pt-4">
      <div className="mx-auto flex h-11 max-w-5xl items-center justify-between rounded-full border border-[rgb(255_255_255/0.06)] bg-transparent pl-4 pr-2 backdrop-blur-xl backdrop-saturate-150 shadow-[0_1px_0_0_rgb(255_255_255/0.04)_inset,0_8px_24px_-12px_rgb(0_0_0/0.6)]">
        <Link href="/" className="karma-logo-group flex items-center gap-2">
          <span className="karma-logo-wrap relative inline-flex size-9 items-center justify-center">
            <Image
              src="/brand/agentkarma-dark-X-transparent.png"
              alt="Karma"
              width={96}
              height={96}
              priority
              className="karma-logo relative z-10 size-9"
            />
          </span>
          <span className="text-[14px] font-[590] tracking-[-0.154px] text-[#f7f8f8]">
            Karma
          </span>
        </Link>

        <div className="flex items-center gap-2">
          <nav className="hidden items-center gap-0.5 text-[12.5px] font-[510] md:flex">
            {PRIMARY_ITEMS.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    active
                      ? 'rounded-full bg-[rgb(255_255_255/0.06)] px-3 py-1.5 text-[#f7f8f8]'
                      : 'rounded-full px-3 py-1.5 text-[#8a8f98] transition-colors hover:text-[#f7f8f8]'
                  }
                >
                  {item.label}
                </Link>
              );
            })}

            <div ref={moreRef} className="relative">
              <button
                type="button"
                onClick={() => setMoreOpen((o) => !o)}
                aria-expanded={moreOpen}
                aria-haspopup="menu"
                className={
                  moreActive || moreOpen
                    ? 'inline-flex items-center gap-0.5 rounded-full bg-[rgb(255_255_255/0.06)] px-3 py-1.5 text-[#f7f8f8]'
                    : 'inline-flex items-center gap-0.5 rounded-full px-3 py-1.5 text-[#8a8f98] transition-colors hover:text-[#f7f8f8]'
                }
              >
                More
                <ChevronDown
                  className={
                    moreOpen
                      ? 'size-3 rotate-180 transition-transform'
                      : 'size-3 transition-transform'
                  }
                />
              </button>

              {moreOpen && (
                <div
                  role="menu"
                  className="karma-menu-pop absolute right-0 top-[calc(100%+10px)] z-50 w-[176px] rounded-2xl border border-[rgb(255_255_255/0.06)] bg-[#0f1011]/85 p-1 shadow-[0_8px_24px_-12px_rgb(0_0_0/0.6),0_1px_0_0_rgb(255_255_255/0.04)_inset] backdrop-blur-xl backdrop-saturate-150"
                >
                  <nav className="flex flex-col gap-[1px]">
                    {MORE_ITEMS.map((item) => {
                      const active = isActive(pathname, item.href);
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          role="menuitem"
                          onClick={() => setMoreOpen(false)}
                          className={
                            active
                              ? 'rounded-lg bg-[rgb(255_255_255/0.06)] px-2.5 py-1.5 text-[13px] font-[510] text-[#f7f8f8]'
                              : 'rounded-lg px-2.5 py-1.5 text-[13px] font-[510] text-[#8a8f98] transition-colors hover:bg-[rgb(255_255_255/0.04)] hover:text-[#f7f8f8]'
                          }
                        >
                          {item.label}
                        </Link>
                      );
                    })}
                  </nav>
                </div>
              )}
            </div>
          </nav>

          <div className="hidden md:block">
            <ChainSwitcher />
          </div>

          <a
            href="https://x.com/agentkarmaio"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="AgentKarma on X"
            className="inline-flex size-8 items-center justify-center rounded-full text-[#8a8f98] transition-colors hover:bg-[rgb(255_255_255/0.06)] hover:text-[#f7f8f8]"
          >
            <XIcon className="size-[13px]" />
          </a>

          <div
            data-tour="connect"
            className="ml-1 hidden border-l border-[rgb(255_255_255/0.06)] pl-2 md:block"
          >
            <ConnectButton />
          </div>

          <div ref={menuRef} className="relative md:hidden">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-label={open ? 'Close menu' : 'Open menu'}
              aria-expanded={open}
              aria-haspopup="menu"
              data-tour="connect"
              className="inline-flex size-8 items-center justify-center rounded-full text-[#8a8f98] transition-colors hover:bg-[rgb(255_255_255/0.06)] hover:text-[#f7f8f8] data-[open=true]:bg-[rgb(255_255_255/0.06)] data-[open=true]:text-[#f7f8f8]"
              data-open={open}
            >
              <Menu className="size-4" />
            </button>

            {open && (
              <div
                role="menu"
                className="karma-menu-pop absolute right-0 top-[calc(100%+10px)] z-50 w-[176px] rounded-2xl border border-[rgb(255_255_255/0.06)] bg-[#0f1011]/85 p-1 shadow-[0_8px_24px_-12px_rgb(0_0_0/0.6),0_1px_0_0_rgb(255_255_255/0.04)_inset] backdrop-blur-xl backdrop-saturate-150"
              >
                <nav className="flex flex-col gap-[1px]">
                  {ALL_ITEMS.map((item) => {
                    const active = isActive(pathname, item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        role="menuitem"
                        onClick={() => setOpen(false)}
                        className={
                          active
                            ? 'rounded-lg bg-[rgb(255_255_255/0.06)] px-2.5 py-1.5 text-[13px] font-[510] text-[#f7f8f8]'
                            : 'rounded-lg px-2.5 py-1.5 text-[13px] font-[510] text-[#8a8f98] transition-colors hover:bg-[rgb(255_255_255/0.04)] hover:text-[#f7f8f8]'
                        }
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                </nav>

                <div className="mx-1 my-1 h-px bg-[rgb(255_255_255/0.06)]" />

                <div className="px-1 pb-1">
                  <ConnectButton />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
    </ChainSelectionProvider>
  );
}
