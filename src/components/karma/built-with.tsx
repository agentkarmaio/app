import Image from 'next/image';

type Tech = {
  name: string;
  href: string;
  logo: string;
  width: number;
  height: number;
  heightClass: string;
};

const STACK: Tech[] = [
  {
    name: 'Solana',
    href: 'https://solana.com',
    logo: '/logos/solana-wordmark.svg',
    width: 262,
    height: 40,
    heightClass: 'h-[14px] sm:h-[15px]',
  },
  {
    name: 'Helius',
    href: 'https://www.helius.dev',
    logo: '/logos/helius.svg',
    width: 190,
    height: 40,
    heightClass: 'h-[16px] sm:h-[18px]',
  },
  {
    name: 'x402',
    href: 'https://www.x402.org',
    logo: '/logos/x402.svg',
    width: 1512,
    height: 558,
    heightClass: 'h-[14px] sm:h-[16px]',
  },
  {
    name: '8004',
    href: 'https://eips.ethereum.org/EIPS/eip-8004',
    logo: '/logos/8004.svg',
    width: 76,
    height: 20,
    heightClass: 'h-[14px] sm:h-[16px]',
  },
  {
    name: 'Colosseum',
    href: 'https://www.colosseum.org',
    logo: '/logos/colosseum.svg',
    width: 1777,
    height: 230,
    heightClass: 'h-[12px] sm:h-[14px]',
  },
];

export function BuiltWith() {
  return (
    <div className="flex flex-col items-center gap-4 py-2">
      <span className="text-[9px] font-[510] uppercase tracking-[0.22em] text-[#4f5258]">
        Built on
      </span>
      <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-4 sm:gap-x-16">
        {STACK.map((tech) => (
          <a
            key={tech.name}
            href={tech.href}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={tech.name}
            className="group inline-flex h-5 items-center"
          >
            <Image
              src={tech.logo}
              alt={tech.name}
              width={tech.width}
              height={tech.height}
              className={`${tech.heightClass} w-auto opacity-25 grayscale transition-[opacity,filter] duration-200 group-hover:opacity-70 group-hover:grayscale-0`}
              unoptimized
            />
          </a>
        ))}
      </div>
    </div>
  );
}
