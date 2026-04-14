import { WalletSearch } from '@/components/karma/wallet-search';
import { WavyBackground } from '@/components/karma/wavy-background';
import { LiveTicker } from '@/components/karma/live-ticker';

const PROTOCOLS = [
  { label: 'x402', role: 'payments' },
  { label: '8004', role: 'identity' },
  { label: 'SAS', role: 'attestation' },
  { label: 'Solana', role: 'settlement' },
];

export function Hero() {
  return (
    <section className="relative pb-12 pt-10 sm:pt-16">
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 h-full overflow-hidden -z-10"
        style={{ left: 'calc(50% - 50vw)', width: '100vw' }}
      >
        <WavyBackground
          opacity={0.22}
          blur={28}
          waveWidth={60}
          className="absolute inset-0 size-full"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 60% 70% at 50% 0%, transparent 0%, rgba(8,9,10,0.4) 55%, rgba(8,9,10,0.95) 85%)',
          }}
        />
        <div
          className="absolute inset-x-0 top-0 h-[420px] opacity-[0.14]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage:
              'radial-gradient(ellipse 50% 70% at 50% 0%, black 30%, transparent 80%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 50% 70% at 50% 0%, black 30%, transparent 80%)',
          }}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#10b981] opacity-60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-[#10b981]" />
        </span>
        <span className="text-[11px] font-[510] uppercase tracking-[0.12em] text-[#8a8f98]">
          Indexing x402 payments · Live on Solana
        </span>
      </div>

      <h1 className="mt-5 max-w-3xl text-[44px] font-[560] leading-[1.05] tracking-[-1.4px] text-[#f7f8f8] sm:text-[56px]">
        Trust,{' '}
        <span className="bg-gradient-to-br from-[#8a92ff] via-[#7170ff] to-[#5e6ad2] bg-clip-text text-transparent">
          quantified
        </span>{' '}
        for AI agents.
      </h1>

      <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-[#8a8f98] tracking-[-0.176px]">
        The credit bureau for autonomous agents. On-chain karma scores derived
        from every x402 payment settled on Solana — so humans and machines can
        tell which agents to trust.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px] text-[#62666d]">
        {PROTOCOLS.map((p, i) => (
          <span key={p.label} className="flex items-center gap-2">
            {i > 0 && <span className="text-[rgb(255_255_255/0.1)]">·</span>}
            <span className="text-[#d0d6e0]">{p.label}</span>
            <span className="uppercase tracking-[0.08em] text-[#62666d]">
              {p.role}
            </span>
          </span>
        ))}
      </div>

      <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="max-w-xl flex-1">
          <WalletSearch />
        </div>
        <LiveTicker />
      </div>
    </section>
  );
}
