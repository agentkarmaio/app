"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { Maximize2, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

// withCredentials forces pdf.js to send our auth cookie even from webviews
// that strip credentials on same-origin fetch (some Telegram/X in-app builds).
const PDF_FILE = { url: "/api/deck/file", withCredentials: true } as const;
const PDF_DOWNLOAD_URL = "/api/deck/file";

// Empty options — deck is Latin-only, so no cMap CDN dependency. Removing
// the unpkg.com fetch eliminates a flaky load path on mobile in-app browsers.
const documentOptions = {} as const;

export function DeckViewer() {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [width, setWidth] = useState<number>(900);
  const [loadError, setLoadError] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Track container width; works for both inline and fullscreen since the
  // ref points at the same DOM node across mode changes (single mounted tree).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.min(1920, Math.floor(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fullscreen]);

  // Lock body scroll while fullscreen so iOS doesn't bounce the page behind.
  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [fullscreen]);

  const onDocumentLoadSuccess = useCallback(
    ({ numPages }: { numPages: number }) => {
      setNumPages(numPages);
      setLoadError(false);
    },
    [],
  );

  const onDocumentLoadError = useCallback(() => {
    setLoadError(true);
  }, []);

  const goPrev = useCallback(
    () => setPageNumber((p) => Math.max(1, p - 1)),
    [],
  );
  const goNext = useCallback(
    () => setPageNumber((p) => (numPages ? Math.min(numPages, p + 1) : p)),
    [numPages],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && fullscreen) {
        setFullscreen(false);
        return;
      }
      if (e.key === "ArrowRight" || e.key === " ") goNext();
      else if (e.key === "ArrowLeft") goPrev();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext, fullscreen]);

  // Touch swipe navigation — same ref node in both modes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    function onStart(e: TouchEvent) {
      const t = e.touches[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
    }
    function onEnd(e: TouchEvent) {
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) goNext();
        else goPrev();
      }
    }
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchend", onEnd);
    };
  }, [goPrev, goNext]);

  const options = useMemo(() => documentOptions, []);

  if (loadError) return <DeckFallback />;

  const deck = (
    <div
      ref={containerRef}
      className={cn(
        "select-none overflow-hidden touch-pan-y",
        fullscreen
          ? "flex aspect-[16/9] max-h-full max-w-full items-center justify-center"
          : "aspect-[16/9] w-full rounded-lg border border-border bg-card",
      )}
    >
      <Document
        file={PDF_FILE}
        onLoadSuccess={onDocumentLoadSuccess}
        onLoadError={onDocumentLoadError}
        options={options}
        loading={<DeckSkeleton />}
        error={<DeckFallback />}
        className="flex justify-center"
      >
        <Page
          pageNumber={pageNumber}
          width={width}
          renderTextLayer={false}
          renderAnnotationLayer={false}
          loading={<DeckSkeleton />}
        />
      </Document>
    </div>
  );

  if (fullscreen) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pitch deck — fullscreen"
        className="fixed inset-0 z-50 flex flex-col bg-black"
      >
        <div className="flex flex-1 items-center justify-center overflow-hidden p-2">
          {deck}
        </div>

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-3">
          <span className="pointer-events-auto rounded-md bg-black/60 px-2 py-1 font-mono text-xs tabular-nums text-white/90 backdrop-blur">
            {numPages === 0 ? "—" : `${pageNumber} / ${numPages}`}
          </span>
          <button
            type="button"
            onClick={() => setFullscreen(false)}
            aria-label="Exit fullscreen"
            className="pointer-events-auto inline-flex h-9 w-9 items-center justify-center rounded-md bg-black/60 text-white/90 backdrop-blur transition hover:bg-black/80"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center gap-3">
          <button
            type="button"
            onClick={goPrev}
            disabled={pageNumber <= 1}
            className="pointer-events-auto inline-flex h-9 items-center rounded-md bg-black/60 px-3 text-sm text-white/90 backdrop-blur transition hover:bg-black/80 disabled:opacity-40"
          >
            ← Prev
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={!numPages || pageNumber >= numPages}
            className="pointer-events-auto inline-flex h-9 items-center rounded-md bg-black/60 px-3 text-sm text-white/90 backdrop-blur transition hover:bg-black/80 disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        {deck}
        <button
          type="button"
          onClick={() => setFullscreen(true)}
          aria-label="Enter fullscreen"
          className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md bg-background/70 text-muted-foreground backdrop-blur transition hover:bg-background hover:text-foreground"
        >
          <Maximize2 className="size-4" />
        </button>
      </div>

      <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
        <Button
          variant="outline"
          size="sm"
          onClick={goPrev}
          disabled={pageNumber <= 1}
        >
          ← Prev
        </Button>
        <span
          className={cn(
            "font-mono tabular-nums",
            numPages === 0 && "opacity-40",
          )}
        >
          {numPages === 0 ? "—" : `${pageNumber} / ${numPages}`}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={goNext}
          disabled={!numPages || pageNumber >= numPages}
        >
          Next →
        </Button>
      </div>
      <p className="text-center text-xs text-muted-foreground/60">
        <span className="sm:hidden">
          Swipe or tap prev/next · tap ⤢ for fullscreen
        </span>
        <span className="hidden sm:inline">
          Use ← → to navigate · click ⤢ for fullscreen
        </span>
      </p>
    </div>
  );
}

function DeckSkeleton() {
  return <div className="aspect-[16/9] w-full" />;
}

function DeckFallback() {
  return (
    <div className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card p-6 text-center">
      <p className="text-xs text-destructive">
        Embedded viewer didn&apos;t load.
      </p>
      <a
        href={PDF_DOWNLOAD_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonVariants({ size: "sm", variant: "outline" })}
      >
        Open PDF directly →
      </a>
    </div>
  );
}
