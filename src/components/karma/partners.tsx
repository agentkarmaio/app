'use client';

import { useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, ArrowRight, Check } from 'lucide-react';
import Image from 'next/image';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';

// Add confirmed partnerships here; the row wraps as the list grows.
const PARTNERS = [{ name: 'Celina', href: 'https://www.usecelina.xyz/', logo: '/logos/celina.png' }];
const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export function Partners() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError('');
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch('/api/v2/collaboration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        setError(response.status === 429 ? 'Too many attempts. Please try again in 10 minutes.' : result.error || 'Could not send your application. Please try again.');
        return;
      }
      setSent(true);
    } catch {
      setError('Connection interrupted. We could not confirm delivery. Please try again shortly.');
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-label="Partners" className="flex flex-wrap items-center gap-x-8 gap-y-2 border-y border-border py-3">
      <h2 className="text-xs text-muted-foreground">Working with</h2>
      <ul className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-2">
        {PARTNERS.map((partner) => (
          <li key={partner.name}>
            <a href={partner.href} target="_blank" rel="noopener noreferrer" className={`group inline-flex min-h-10 items-center gap-2 rounded-sm text-sm font-medium text-secondary-foreground hover:text-foreground ${focus}`}>
              <Image src={partner.logo} alt="" width={28} height={28} className="size-7 shrink-0 object-contain grayscale motion-safe:transition-[filter] group-hover:grayscale-0" />
              {partner.name}
              <ArrowUpRight className="size-3 text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">, AgentKarma partner (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
      <Sheet>
        <SheetTrigger className={`inline-flex min-h-10 items-center gap-2 rounded-sm text-xs text-muted-foreground hover:text-foreground ${focus}`}>
          Collaborate <ArrowRight className="size-3" aria-hidden="true" />
        </SheetTrigger>
        <SheetContent className="w-full overflow-y-auto p-6 sm:max-w-md motion-reduce:transition-none">
          <SheetHeader className="px-0 pt-8 pb-4">
            <SheetTitle className="text-xl">Let’s work together.</SheetTitle>
            <SheetDescription className="mt-2 leading-relaxed">Tell us what you’re building and where AgentKarma fits.</SheetDescription>
          </SheetHeader>
          {sent ? (
            <div role="status" className="space-y-4 py-6">
              <Check className="size-6 text-foreground" aria-hidden="true" />
              <h3 className="text-lg font-medium">Application received.</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">Thanks for reaching out. We’ll review your idea and get back to you by email.</p>
              <SheetClose className={`min-h-10 rounded-sm text-sm underline underline-offset-4 ${focus}`}>Done</SheetClose>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              <fieldset disabled={pending} className="space-y-5 disabled:opacity-60">
                <div className="space-y-2">
                  <label htmlFor="collab-name" className="text-sm">Your name</label>
                  <Input id="collab-name" name="name" autoComplete="name" required minLength={2} maxLength={100} className="h-11" />
                </div>
                <div className="space-y-2">
                  <label htmlFor="collab-email" className="text-sm">Work email</label>
                  <Input id="collab-email" name="email" type="email" autoComplete="email" required maxLength={254} className="h-11" />
                </div>
                <div className="space-y-2">
                  <label htmlFor="collab-telegram" className="text-sm">Telegram username</label>
                  <div className="relative">
                    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 z-10 flex items-center text-sm text-muted-foreground">@</span>
                    <Input id="collab-telegram" name="telegram" placeholder="username" autoComplete="off" autoCapitalize="none" spellCheck={false} required minLength={5} pattern="[A-Za-z0-9_]{5,32}" maxLength={32} className="h-11 pl-8" />
                  </div>
                </div>
                <div className="space-y-2">
                  <label htmlFor="collab-project" className="text-sm">Project name or website</label>
                  <Input id="collab-project" name="project" autoComplete="organization" required minLength={2} maxLength={200} className="h-11" />
                </div>
                <div className="space-y-2">
                  <label htmlFor="collab-message" className="text-sm">How could we collaborate?</label>
                  <textarea id="collab-message" name="message" required minLength={20} maxLength={2000} rows={5} className={`w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-base md:text-sm ${focus}`} />
                </div>
                <div hidden aria-hidden="true"><input name="website" tabIndex={-1} autoComplete="off" /></div>
                <p className="text-xs leading-relaxed text-muted-foreground">Your details go to the AgentKarma team so we can follow up on your application.</p>
                <button type="submit" disabled={pending} className={`inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-background disabled:cursor-wait ${focus}`}>
                  {pending ? 'Sending…' : 'Send application'}
                  {!pending && <ArrowRight className="size-4" aria-hidden="true" />}
                </button>
              </fieldset>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </form>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}
