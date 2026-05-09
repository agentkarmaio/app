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
const ANON_PREFIX = "anon-";

type GateState = "gated" | "open";

type DeckGateProps = {
  viewCount?: number;
  initialAuthed?: boolean;
  initialEmail?: string | null;
};

function isAnonEmail(value: string | null): boolean {
  return Boolean(value && value.startsWith(ANON_PREFIX));
}

export function DeckGate({
  viewCount = 0,
  initialAuthed = false,
  initialEmail = null,
}: DeckGateProps) {
  // Start in the right state synchronously based on the server-verified
  // ak_deck cookie. No "checking" flash on returning visitors.
  const [state, setState] = useState<GateState>(initialAuthed ? "open" : "gated");
  const [email, setEmail] = useState("");
  const [identified, setIdentified] = useState<string | null>(initialEmail);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"none" | "email" | "skip">("none");

  useEffect(() => {
    if (initialAuthed && initialEmail) {
      identify(initialEmail);
      try {
        localStorage.setItem(STORAGE_KEY, initialEmail);
      } catch {
        // ignore
      }
      return;
    }
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // localStorage unavailable — stay gated.
    }
    if (stored && (EMAIL_RE.test(stored) || isAnonEmail(stored))) {
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

  async function recordView(
    value: string | null,
    isReturning: boolean,
  ): Promise<{ email: string; anonymous: boolean } | null> {
    try {
      const res = await fetch("/api/deck/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value ?? "", isReturning }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { email?: string; anonymous?: boolean };
      if (typeof data.email !== "string") return null;
      return { email: data.email, anonymous: Boolean(data.anonymous) };
    } catch {
      return null;
    }
  }

  async function submitWithEmail(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!value) {
      // Empty input is treated as "skip" — view anonymously.
      await viewAnonymously();
      return;
    }
    if (!EMAIL_RE.test(value)) {
      setError("Please enter a valid email or skip.");
      return;
    }
    setSubmitting("email");
    setError(null);
    const result = await recordView(value, false);
    if (!result) {
      setSubmitting("none");
      setError("Couldn't save — try again or skip.");
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, result.email);
    } catch {
      // ignore
    }
    identify(result.email);
    setIdentified(result.email);
    setSubmitting("none");
    setState("open");
  }

  async function viewAnonymously() {
    setSubmitting("skip");
    setError(null);
    const result = await recordView(null, false);
    if (!result) {
      setSubmitting("none");
      setError("Couldn't open the deck — try again.");
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, result.email);
    } catch {
      // ignore
    }
    identify(result.email);
    setIdentified(result.email);
    setSubmitting("none");
    setState("open");
  }

  function handleSwitch() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setEmail(isAnonEmail(identified) ? "" : identified ?? "");
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
            Email is optional — drop it if you want a follow-up, or skip and
            view anonymously. No list, no spam.
          </p>
        </div>
        <form onSubmit={submitWithEmail} className="flex flex-col gap-3">
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@company.com (optional)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error ? true : undefined}
            className="h-10"
          />
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            className="h-10"
            disabled={submitting !== "none"}
          >
            {submitting === "email" ? "Loading…" : "View deck →"}
          </Button>
          <button
            type="button"
            onClick={viewAnonymously}
            disabled={submitting !== "none"}
            className="text-center text-xs text-muted-foreground/70 underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
          >
            {submitting === "skip" ? "Loading…" : "Skip — view anonymously"}
          </button>
        </form>
        {viewCount > 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
            <Eye className="size-3" aria-hidden />
            <span className="font-mono tabular-nums">
              {viewCount.toLocaleString()}
            </span>
            <span>{viewCount === 1 ? "view" : "views"}</span>
          </p>
        ) : null}
      </div>
    );
  }

  const anon = isAnonEmail(identified);
  return (
    <div className="flex flex-col gap-3">
      <DeckViewer />
      {identified ? (
        <p className="text-center text-xs text-muted-foreground/70">
          {anon ? (
            <>Viewing anonymously</>
          ) : (
            <>
              Viewing as <span className="font-mono">{identified}</span>
            </>
          )}
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
  return (
    <div className="flex flex-col gap-4">
      <div className="aspect-[16/9] w-full rounded-lg border border-border bg-card" />
    </div>
  );
}
