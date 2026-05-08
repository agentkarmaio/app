"use client";

import dynamic from "next/dynamic";
import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setOpenReplayMetadata, setOpenReplayUserID } from "@/lib/openreplay";

const DeckViewer = dynamic(
  () => import("./deck-viewer").then((m) => m.DeckViewer),
  { ssr: false, loading: () => <ViewerLoading /> },
);

const STORAGE_KEY = "ak:deck:viewer-email";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type GateState = "gated" | "open";

type DeckGateProps = {
  viewerCount?: number;
  initialAuthed?: boolean;
  initialEmail?: string | null;
};

export function DeckGate({
  viewerCount = 0,
  initialAuthed = false,
  initialEmail = null,
}: DeckGateProps) {
  // Start in the right state synchronously based on the server-verified
  // ak_deck cookie. No "checking" flash on returning visitors.
  const [state, setState] = useState<GateState>(initialAuthed ? "open" : "gated");
  const [email, setEmail] = useState("");
  const [identified, setIdentified] = useState<string | null>(initialEmail);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // If the server already verified our cookie, just push identity into
    // OpenReplay — no localStorage round-trip, no extra POST. The session is
    // already authed for /api/deck/file.
    if (initialAuthed && initialEmail) {
      identify(initialEmail);
      try {
        localStorage.setItem(STORAGE_KEY, initialEmail);
      } catch {
        // ignore
      }
      return;
    }
    // Cookie missing/expired but localStorage may still have an email from a
    // previous session — auto-identify and re-issue the cookie quietly.
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // localStorage unavailable — stay gated.
    }
    if (stored && EMAIL_RE.test(stored)) {
      identify(stored);
      void recordView(stored, true).then(() => {
        setIdentified(stored);
        setState("open");
      });
    }
  }, [initialAuthed, initialEmail]);

  function identify(value: string) {
    setOpenReplayUserID(value);
    setOpenReplayMetadata("source", "deck");
    setOpenReplayMetadata("identified_at", new Date().toISOString());
  }

  async function recordView(value: string, isReturning: boolean) {
    try {
      await fetch("/api/deck/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, isReturning }),
      });
    } catch {
      // Network blip — viewer will surface the auth failure if the cookie
      // didn't get set; the user can re-submit the gate to retry.
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      setError("Please enter a valid email.");
      return;
    }
    setSubmitting(true);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // ignore — we still identify in-memory for this session
    }
    identify(value);
    await recordView(value, false);
    setIdentified(value);
    setError(null);
    setSubmitting(false);
    setState("open");
  }

  function handleSwitch() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setEmail(identified ?? "");
    setIdentified(null);
    setError(null);
    setState("gated");
  }

  if (state === "gated") {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-6 py-12">
        <div className="space-y-3">
          <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            AgentKarma · Pitch deck
          </p>
          <h1 className="text-2xl font-medium leading-tight">
            Reputation layer for autonomous on-chain agents.
          </h1>
          <p className="text-sm text-muted-foreground">
            Drop your email to view the deck. We use it only to follow up if
            you have questions — no list, no spam.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            aria-invalid={error ? true : undefined}
            className="h-10"
          />
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : null}
          <Button type="submit" size="lg" className="h-10" disabled={submitting}>
            {submitting ? "Loading…" : "View deck →"}
          </Button>
        </form>
        {viewerCount > 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
            <Eye className="size-3" aria-hidden />
            <span className="font-mono tabular-nums">
              {viewerCount.toLocaleString()}
            </span>
            <span>{viewerCount === 1 ? "viewer" : "viewers"}</span>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <DeckViewer />
      {identified ? (
        <p className="text-center text-xs text-muted-foreground/70">
          Viewing as <span className="font-mono">{identified}</span>
          <button
            type="button"
            onClick={handleSwitch}
            className="ml-2 underline-offset-4 hover:text-foreground hover:underline"
          >
            switch
          </button>
        </p>
      ) : null}
    </div>
  );
}

function ViewerLoading() {
  // Silent placeholder. Aspect-locked to the deck (16:9) so the height
  // matches what react-pdf will render — no layout jump on chunk swap.
  // Note: avoid `items-center` on the outer flex — it triggers a browser
  // circular-sizing bug with aspect-ratio + w-full children, collapsing the
  // card to 0×0. Default stretch keeps the cross-axis determined.
  return (
    <div className="flex flex-col gap-4">
      <div className="aspect-[16/9] w-full rounded-lg border border-border bg-card" />
    </div>
  );
}
