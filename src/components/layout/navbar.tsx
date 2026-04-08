import Link from 'next/link';
import Image from 'next/image';

export function Navbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-[rgb(255_255_255/0.05)] bg-[#0f1011]/80 backdrop-blur-xl">
      <div className="mx-auto flex h-12 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2">
          <Image
            src="/brand/agent-karma-symbol.svg"
            alt="Karma"
            width={22}
            height={22}
            className="dark:hidden"
          />
          <Image
            src="/brand/agent-karma-symbol-inverse.svg"
            alt="Karma"
            width={22}
            height={22}
            className="hidden dark:block"
          />
          <span className="text-[15px] font-[590] tracking-[-0.165px] text-[#f7f8f8]">
            Karma
          </span>
        </Link>
        <nav className="flex items-center gap-5 text-[13px] font-[510] text-[#8a8f98]">
          <Link href="/" className="transition-colors hover:text-[#f7f8f8]">
            Leaderboard
          </Link>
          <Link href="/explore" className="transition-colors hover:text-[#f7f8f8]">
            Explore
          </Link>
          <Link href="/protocol" className="transition-colors hover:text-[#f7f8f8]">
            Protocol
          </Link>
          <Link href="/widget" className="transition-colors hover:text-[#f7f8f8]">
            Widget
          </Link>
        </nav>
      </div>
    </header>
  );
}
