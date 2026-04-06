import Link from 'next/link';
import Image from 'next/image';

export function Navbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-lg">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/brand/agent-karma-symbol.svg"
            alt="Karma"
            width={26}
            height={26}
            className="dark:hidden"
          />
          <Image
            src="/brand/agent-karma-symbol-inverse.svg"
            alt="Karma"
            width={26}
            height={26}
            className="hidden dark:block"
          />
          <span className="text-lg font-bold tracking-tight">Karma</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">
            Leaderboard
          </Link>
          <a
            href="https://github.com/8004-protocol/8004-solana"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            8004 Docs
          </a>
        </nav>
      </div>
    </header>
  );
}
