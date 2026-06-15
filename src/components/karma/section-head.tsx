/* Shared explainer macrostructure primitives, extracted from /integrate so
 * /succession and /bonding render the exact same Stat-Led spine.
 * Roman-numeral marker, divider seam, StatusPill. No "01/FEATURES" eyebrows.
 *
 * Accents:
 *   live          — shipped, real production data
 *   live-partial  — shipped on all chains, secondary surface (e.g. SDK) pending
 *   planned       — not shipped, queued
 *   contingent    — built but gated behind founder sign-off (Bonding)
 */

export type SectionAccent = 'live' | 'live-partial' | 'planned' | 'contingent';

export function SectionHead({
  marker,
  title,
  sub,
  accent,
}: {
  marker: string;
  title: string;
  sub: string;
  accent: SectionAccent;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] tracking-[0.04em] text-[#4f5258]">
          {marker}
        </span>
        <span aria-hidden className="h-px flex-1 bg-[rgb(255_255_255/0.06)]" />
        <StatusPill accent={accent} />
      </div>
      <h2 className="max-w-2xl text-[22px] font-[590] leading-[1.2] tracking-[-0.4px] text-[#f7f8f8] sm:text-[24px]">
        {title}
      </h2>
      <p className="max-w-2xl text-[13px] leading-relaxed text-[#8a8f98]">{sub}</p>
    </div>
  );
}

export function StatusPill({ accent }: { accent: SectionAccent }) {
  if (accent === 'live') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(16_185_129/0.20)] bg-[rgb(16_185_129/0.08)] px-2 py-0.5 text-[10px] font-[510] uppercase tracking-[0.12em] text-[#a3d6bd]">
        <span aria-hidden className="size-1 rounded-full bg-[#10b981]" />
        Live
      </span>
    );
  }
  if (accent === 'live-partial') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(234_179_8/0.20)] bg-[rgb(234_179_8/0.06)] px-2 py-0.5 text-[10px] font-[510] uppercase tracking-[0.12em] text-[#e0c879]">
        <span aria-hidden className="size-1 rounded-full bg-[#eab308]" />
        Live · all chains
      </span>
    );
  }
  if (accent === 'contingent') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(234_179_8/0.20)] bg-[rgb(234_179_8/0.06)] px-2 py-0.5 text-[10px] font-[510] uppercase tracking-[0.12em] text-[#e0c879]">
        <span aria-hidden className="size-1 rounded-full bg-[#eab308]" />
        Planned · contingent
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(255_255_255/0.08)] bg-[rgb(255_255_255/0.02)] px-2 py-0.5 text-[10px] font-[510] uppercase tracking-[0.12em] text-[#8a8f98]">
      <span aria-hidden className="size-1 rounded-full bg-[#62666d]" />
      Planned
    </span>
  );
}

export function Stat({
  value,
  label,
  sub,
}: {
  value: string;
  label: string;
  sub: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[24px] font-[560] tabular-nums tracking-[-0.4px] text-[#f7f8f8] sm:text-[26px]">
        {value}
      </p>
      <p className="text-[10.5px] font-[510] uppercase tracking-[0.14em] text-[#8a8f98]">
        {label}
      </p>
      <p className="text-[10.5px] text-[#62666d]">{sub}</p>
    </div>
  );
}

export function LiveFact({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[13px] font-[590] text-[#f7f8f8]">{title}</p>
      <p className="text-[12.5px] leading-relaxed text-[#8a8f98]">{children}</p>
    </div>
  );
}
