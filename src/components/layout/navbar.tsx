'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Menu } from 'lucide-react';
import { WalletConnectButton } from '@/components/wallet/wallet-connect-button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

const NAV_ITEMS = [
  { href: '/', label: 'Leaderboard' },
  { href: '/explore', label: 'Explore' },
  { href: '/protocol', label: 'Protocol' },
  { href: '/widget', label: 'Widget' },
];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function Navbar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 px-4 pt-4">
      <div className="mx-auto flex h-11 max-w-5xl items-center justify-between rounded-full border border-[rgb(255_255_255/0.06)] bg-transparent pl-4 pr-2 backdrop-blur-xl backdrop-saturate-150 shadow-[0_1px_0_0_rgb(255_255_255/0.04)_inset,0_8px_24px_-12px_rgb(0_0_0/0.6)]">
        <Link href="/" className="flex items-center gap-2">
          <Image
            src="/brand/agent-karma-symbol.svg"
            alt="Karma"
            width={20}
            height={20}
            className="dark:hidden"
          />
          <Image
            src="/brand/agent-karma-symbol-inverse.svg"
            alt="Karma"
            width={20}
            height={20}
            className="hidden dark:block"
          />
          <span className="text-[14px] font-[590] tracking-[-0.154px] text-[#f7f8f8]">
            Karma
          </span>
        </Link>

        <div className="flex items-center gap-2">
          <nav className="hidden items-center gap-0.5 text-[12.5px] font-[510] md:flex">
            {NAV_ITEMS.map((item) => {
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
          </nav>

          <div
            data-tour="connect"
            className="ml-1 hidden border-l border-[rgb(255_255_255/0.06)] pl-2 md:block"
          >
            <WalletConnectButton />
          </div>

          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger
              aria-label="Open menu"
              data-tour="connect"
              className="inline-flex size-8 items-center justify-center rounded-full text-[#8a8f98] transition-colors hover:bg-[rgb(255_255_255/0.06)] hover:text-[#f7f8f8] md:hidden"
            >
              <Menu className="size-4" />
            </SheetTrigger>
            <SheetContent
              side="right"
              className="w-[280px] border-l-[rgb(255_255_255/0.06)] bg-[#0f1011] text-[#f7f8f8]"
            >
              <SheetHeader>
                <SheetTitle className="text-left text-[14px] font-[590] text-[#f7f8f8]">
                  Karma
                </SheetTitle>
              </SheetHeader>

              <nav className="mt-2 flex flex-col gap-1 px-4">
                {NAV_ITEMS.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={
                        active
                          ? 'rounded-md bg-[rgb(255_255_255/0.06)] px-3 py-2 text-[14px] font-[510] text-[#f7f8f8]'
                          : 'rounded-md px-3 py-2 text-[14px] font-[510] text-[#8a8f98] transition-colors hover:bg-[rgb(255_255_255/0.04)] hover:text-[#f7f8f8]'
                      }
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>

              <div className="mt-6 border-t border-[rgb(255_255_255/0.06)] px-4 pt-4">
                <WalletConnectButton />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
