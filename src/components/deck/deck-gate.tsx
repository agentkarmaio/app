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

type GateState = "checking" | "gated" | "open";

export function DeckGate({ viewerCount = 0 }: { viewerCount?: number }) {
  const [state, setState] = useState<GateState>("checking");
  const [email, setEmail] = useState("");
  const [identified, setIdentified] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch {
        // localStorage unavailable — fall through to gated.
      }
      if (stored && EMAIL_RE.test(stored)) {
        identify(stored);
        // Awaited so the auth cookie is set before the viewer fetches the PDF.
        await recordView(stored, true);
        if (cancelled) return;
        setIdentified(stored);
        setState("open");
        return;
      }
      if (!cancelled) setState("gated");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  if (state === "checking") return <ViewerLoading />;

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
  return (
    <div className="flex min-h-[60vh] items-center justify-center text-xs text-muted-foreground">
      Loading…
    </div>
  );
}
