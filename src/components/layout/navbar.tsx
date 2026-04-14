'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/', label: 'Leaderboard' },
  { href: '/explore', label: 'Explore' },
  { href: '/protocol', label: 'Protocol' },
  { href: '/widget', label: 'Widget' },
];

export function Navbar() {
  const pathname = usePathname();

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
        <nav className="flex items-center gap-0.5 text-[12.5px] font-[510]">
          {NAV_ITEMS.map((item) => {
            const active =
              item.href === '/'
                ? pathname === '/'
                : pathname.startsWith(item.href);
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
      </div>
    </header>
  );
}
