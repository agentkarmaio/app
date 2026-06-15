'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, HeartPulse } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SUCCESSION_INTERVAL_PRESETS, formatInterval } from '@/lib/succession-format';

/**
 * Raw succession plan the claim form posts to /api/agent/claim under the
 * optional `succession` body field. The claim route is Solana-authenticated, so
 * heirs declared here are keyed to Solana — the chain is fixed, not auto-detected
 * from the address (never auto-detect EVM chain).
 */
export interface SuccessionFormPlan {
  intervalSeconds: number;
  heirs: { address: string; chain: 'solana' }[];
}

/**
 * "Set up succession" disclosure for the claim form (human rail). Operators
 * declare a single heir + a plain-language heartbeat interval. AK OBSERVES the
 * lifecycle — declaring a plan moves no funds and does not raise the score;
 * staying alive does. The badge stays put on a fresh declaration.
 *
 * Controlled by the parent: it owns the values + reports the assembled plan (or
 * null) up via onChange, so the parent stays the single source for submission.
 */
export function SuccessionDeclaration({
  intervalSeconds,
  heirAddress,
  onChange,
}: {
  intervalSeconds: number;
  heirAddress: string;
  onChange: (next: { intervalSeconds: number; heirAddress: string }) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border border-[rgb(255_255_255/0.06)] bg-[rgb(255_255_255/0.015)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left"
      >
        <span className="flex items-center gap-2">
          <HeartPulse className="size-3.5 text-[#828fff]" />
          <span className="text-[12px] font-[510] text-[#d0d6e0]">Set up succession (optional)</span>
        </span>
        {expanded ? (
          <ChevronDown className="size-3.5 text-[#62666d]" />
        ) : (
          <ChevronRight className="size-3.5 text-[#62666d]" />
        )}
      </button>

      {expanded && (
        <div className="space-y-2.5 border-t border-[rgb(255_255_255/0.06)] px-2.5 py-2.5">
          <p className="text-[11px] leading-relaxed text-[#62666d]">
            Declare an heir + heartbeat interval. AK witnesses the plan and derives the heartbeat
            from on-chain liveness — it never holds a key or executes the will. Declaring a plan
            doesn’t raise your score; staying alive does.
          </p>

          <div>
            <span className="mb-1 block text-[10px] font-[510] uppercase tracking-[0.08em] text-[#62666d]">
              Check-in interval
            </span>
            <div className="flex flex-wrap gap-1">
              {SUCCESSION_INTERVAL_PRESETS.map((p) => {
                const active = p.seconds === intervalSeconds;
                return (
                  <button
                    key={p.seconds}
                    type="button"
                    onClick={() => onChange({ intervalSeconds: p.seconds, heirAddress })}
                    className={
                      active
                        ? 'rounded-[5px] bg-[rgb(94_106_210/0.16)] px-2 py-0.5 text-[11px] font-[510] text-[#a8b0ff]'
                        : 'rounded-[5px] px-2 py-0.5 text-[11px] font-[510] text-[#8a8f98] transition-colors hover:text-[#f7f8f8]'
                    }
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] text-[#62666d]">
              Derived heartbeat: <span className="font-mono text-[#8a8f98]">{formatInterval(intervalSeconds)}</span>
            </p>
          </div>

          <div>
            <span className="mb-1 block text-[10px] font-[510] uppercase tracking-[0.08em] text-[#62666d]">
              Heir wallet (Solana)
            </span>
            <Input
              placeholder="Heir Solana address"
              value={heirAddress}
              onChange={(e) => onChange({ intervalSeconds, heirAddress: e.target.value })}
              className="bg-[rgb(255_255_255/0.03)] border-[rgb(255_255_255/0.08)] text-[13px] h-8 font-mono"
            />
            <p className="mt-1 text-[10px] text-[#62666d]">
              The heir acts, not AgentKarma. We index the succession; we never move funds.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Assemble the post body field from the controlled values, or null when the
 * operator left succession blank. Returns null (omit the field) unless an heir
 * address was entered — an interval with no heir is not a valid plan.
 */
export function buildSuccessionPlan(
  intervalSeconds: number,
  heirAddress: string,
): SuccessionFormPlan | null {
  const trimmed = heirAddress.trim();
  if (!trimmed) return null;
  return { intervalSeconds, heirs: [{ address: trimmed, chain: 'solana' }] };
}
