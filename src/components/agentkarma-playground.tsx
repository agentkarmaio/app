'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { buildAgentMessage, parseAgentReply } from '@/lib/agent-query';

type Reply = ReturnType<typeof parseAgentReply>;
type QueryResult = { reply: Reply; raw: unknown; elapsed: number; target: string };

const CONFIDENCE_LABELS = {
  'receipt-backed': 'Receipt-backed',
  'behavior-inferred': 'Behavior-inferred',
  declared: 'Declared',
} as const;

function Score({ label, value }: { label: string; value: unknown }) {
  const face = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const score = typeof face.score === 'number' && Number.isFinite(face.score)
    && face.score >= 0 && face.score <= 100 ? face.score : null;
  const badge = typeof face.confidenceBadge === 'string'
    && Object.hasOwn(CONFIDENCE_LABELS, face.confidenceBadge)
    ? CONFIDENCE_LABELS[face.confidenceBadge as keyof typeof CONFIDENCE_LABELS]
    : 'Confidence unavailable';

  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label} Karma</p>
      <p className="mt-1 font-mono text-xl tabular-nums">
        {score === null ? 'Unrated' : <>{score}<span className="text-sm text-muted-foreground"> / 100</span></>}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{badge}</p>
    </div>
  );
}

export function AgentKarmaPlayground({ examples }: {
  examples: { label: string; value: string }[];
}) {
  const [input, setInput] = useState(examples[0]?.value ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const target = input.trim();
    let message;
    let requestId;
    try {
      requestId = crypto.randomUUID();
      message = buildAgentMessage(target, requestId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Enter a wallet, chain-qualified agent ID, or AgentKarma profile URL.');
      setResult(null);
      inputRef.current?.focus();
      return;
    }

    inFlight.current = true;
    setPending(true);
    setError(null);
    setResult(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const started = performance.now();
    try {
      const response = await fetch('/a2a', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'message/send', params: { message } }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(response.status === 429
          ? 'Too many requests. Wait a moment, then try again.'
          : 'AgentKarma could not complete this lookup. Try again shortly.');
      }
      let raw: unknown;
      try { raw = await response.json(); } catch {
        throw new Error('AgentKarma returned an unreadable reply. Try again shortly.');
      }
      const reply = parseAgentReply(raw, requestId);
      setResult({ reply, raw, target, elapsed: Math.round(performance.now() - started) });
    } catch (cause) {
      setError(controller.signal.aborted
        ? 'This lookup took longer than 20 seconds. Try again.'
        : cause instanceof TypeError
          ? 'Could not reach AgentKarma. Check your connection and try again.'
          : cause instanceof Error ? cause.message : 'The lookup failed. Try again.');
    } finally {
      clearTimeout(timeout);
      inFlight.current = false;
      setPending(false);
    }
  }

  const resultName = result && typeof result.reply.data.name === 'string'
    ? result.reply.data.name.slice(0, 100) : null;
  const resultChain = result && typeof result.reply.data.chain === 'string'
    && ['celo', 'stellar', 'solana', 'arc'].includes(result.reply.data.chain)
    ? result.reply.data.chain === 'arc' ? 'Arc testnet' : result.reply.data.chain : null;

  return (
    <section id="try-it" aria-labelledby="playground-title" className="min-w-0 scroll-mt-24">
      <h2 id="playground-title" className="sr-only">Ask AgentKarma</h2>
      <form onSubmit={submit} aria-busy={pending}>
        <label htmlFor="agentkarma-target" className="mb-2 block text-sm font-medium">Wallet, agent ID, or profile URL</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            ref={inputRef}
            id="agentkarma-target"
            value={input}
            onChange={(event) => { setInput(event.target.value); setError(null); setResult(null); }}
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={2048}
            placeholder="agentId 9058 on celo"
            aria-describedby={error ? 'agentkarma-input-hint agentkarma-error' : 'agentkarma-input-hint'}
            aria-invalid={!!error}
            disabled={pending}
            className="h-12 min-h-12 flex-1 px-3 motion-reduce:transition-none"
          />
          <Button type="submit" disabled={pending || !input.trim()} className="h-12 px-5 motion-reduce:transition-none">
            {pending ? 'Checking…' : error ? 'Try again' : 'Check reputation'}
          </Button>
        </div>
        <p id="agentkarma-input-hint" className="sr-only">Include Celo or Arc with an agent ID. No wallet connection required.</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-1">
          <span className="mr-1 text-xs text-muted-foreground">Try</span>
          {examples.map((example) => (
            <Button key={example.value} type="button" variant="ghost" disabled={pending}
              className="min-h-11 px-2 text-xs font-normal text-muted-foreground motion-reduce:transition-none"
              onClick={() => { setInput(example.value); setError(null); setResult(null); inputRef.current?.focus(); }}>
              {example.label}
            </Button>
          ))}
        </div>
      </form>
      <div aria-live="polite" aria-atomic="true">
        {pending ? (
          <div className="mt-4 rounded-lg bg-card p-4 sm:p-5">
            <p className="text-xs text-muted-foreground">Reading reputation evidence…</p>
            <div aria-hidden className="mt-4 grid grid-cols-2 gap-8 motion-safe:animate-pulse">
              <div className="h-12 rounded bg-muted" /><div className="h-12 rounded bg-muted" />
            </div>
          </div>
        ) : error ? (
          <p id="agentkarma-error" role="alert" className="mt-3 text-sm leading-relaxed text-muted-foreground">{error}</p>
        ) : result ? (
          <div className="mt-4 rounded-lg bg-card px-4 pt-4 sm:px-5 sm:pt-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="min-w-0 break-words text-sm font-medium">
                {result.reply.found ? resultName || 'Reputation result' : 'No reputation available'}
                {resultChain && <span className="ml-2 text-xs font-normal capitalize text-muted-foreground">{resultChain}</span>}
              </p>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{result.elapsed.toLocaleString()} ms</span>
            </div>
            {result.reply.found ? (
              <div className="mt-5 grid grid-cols-2 gap-6">
                <Score label="Provider" value={result.reply.data.provider} />
                <Score label="Consumer" value={result.reply.data.consumer} />
              </div>
            ) : (
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {result.reply.data.reason === 'no_target' || result.reply.data.reason === 'invalid_address'
                  ? 'Check the address and chain, or choose an example above.'
                  : 'No reputation was returned for this query. Check the address and chain; missing data is not a negative rating.'}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-x-5">
              {result.reply.profilePath && (
                <Link href={result.reply.profilePath} className="inline-flex min-h-11 items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  View profile & evidence <ArrowUpRight aria-hidden className="size-3.5" />
                </Link>
              )}
            </div>
            <details className="group border-t border-border">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <ChevronDown aria-hidden className="size-3.5 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" />
                Raw response
              </summary>
              <pre className="mb-4 max-h-72 overflow-auto rounded bg-background p-3 font-mono text-xs leading-relaxed">{JSON.stringify(result.raw, null, 2)}</pre>
            </details>
          </div>
        ) : (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Provider & Consumer Karma, with confidence and evidence. No wallet connection needed.</p>
        )}
      </div>
    </section>
  );
}
