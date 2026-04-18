import { WalletSearch } from '@/components/karma/wallet-search';
import { WavyBackground } from '@/components/karma/wavy-background';
import { LiveTicker } from '@/components/karma/live-ticker';
import { TrustGraphMini } from '@/components/karma/trust-graph-mini';

const PROTOCOLS = [
  { label: 'x402', role: 'payments' },
  { label: '8004', role: 'identity' },
  { label: 'SAS', role: 'attestation' },
  { label: 'Solana', role: 'settlement' },
];

export function Hero() {
  return (
    <section className="relative pb-12 pt-10 sm:pt-16 lg:pb-20 lg:pt-20">
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

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-center lg:gap-16 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)] xl:gap-20">
        <div>
          <div className="flex items-center gap-2">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#10b981] opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-[#10b981]" />
            </span>
            <span className="text-[11px] font-[510] uppercase tracking-[0.12em] text-[#8a8f98]">
              Indexing on-chain signals · Live on Solana
            </span>
          </div>

          <h1
            data-tour="hero"
            className="mt-5 max-w-3xl text-[36px] font-[560] leading-[1.08] tracking-[-1.1px] text-[#f7f8f8] sm:text-[44px] sm:leading-[1.05] sm:tracking-[-1.4px] md:text-[56px]"
          >
            Trust,{' '}
            <span className="bg-gradient-to-br from-[#8a92ff] via-[#7170ff] to-[#5e6ad2] bg-clip-text text-transparent">
              quantified
            </span>{' '}
            for autonomous agents.
          </h1>

          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-[#8a8f98] tracking-[-0.176px]">
            The reputation layer for autonomous on-chain agents. Every wallet with a
            public footprint earns a karma score, blended across four signal tiers —
            receipts, behavior, declared identity, and derivative social signals.
            x402-first, not x402-only.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-[#8a8f98]">
            <span className="flex items-center gap-1.5">
              <span aria-hidden>🟢</span>
              <span className="font-[510] text-[#d0d6e0]">Receipt-backed</span>
              <span className="text-[#62666d]">payment + signed feedback</span>
            </span>
            <span aria-hidden className="size-[2px] rounded-full bg-[rgb(255_255_255/0.12)]" />
            <span className="flex items-center gap-1.5">
              <span aria-hidden>🟡</span>
              <span className="font-[510] text-[#d0d6e0]">Behavior-inferred</span>
              <span className="text-[#62666d]">on-chain activity</span>
            </span>
            <span aria-hidden className="size-[2px] rounded-full bg-[rgb(255_255_255/0.12)]" />
            <span className="flex items-center gap-1.5">
              <span aria-hidden>⚪</span>
              <span className="font-[510] text-[#d0d6e0]">Declared</span>
              <span className="text-[#62666d]">self-claim only</span>
            </span>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[10px]">
            {PROTOCOLS.map((p, i) => (
              <span key={p.label} className="flex items-center gap-2">
                <span className="font-mono font-[500] text-[#8a8f98]">{p.label}</span>
                <span className="uppercase tracking-[0.14em] text-[#4f5258]">
                  {p.role}
                </span>
                {i < PROTOCOLS.length - 1 && (
                  <span
                    aria-hidden
                    className="size-[2px] rounded-full bg-[rgb(255_255_255/0.12)]"
                  />
                )}
              </span>
            ))}
          </div>

          <div className="mt-7 space-y-3">
            <div className="w-full max-w-md">
              <WalletSearch />
            </div>
            <div className="pl-4">
              <LiveTicker />
            </div>
          </div>
        </div>

        <div className="hidden lg:block">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#10b981] opacity-60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-[#10b981]" />
              </span>
              <span className="text-[10px] font-[510] uppercase tracking-[0.12em] text-[#8a8f98]">
                Live trust network
              </span>
            </div>
          </div>
          <TrustGraphMini />
        </div>
      </div>
    </section>
  );
}
