"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
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
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.min(1280, Math.floor(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
      if (e.key === "ArrowRight" || e.key === " ") goNext();
      else if (e.key === "ArrowLeft") goPrev();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext]);

  // Touch swipe navigation for mobile.
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

  return (
    <div className="flex flex-col gap-4">
      <div
        ref={containerRef}
        className="aspect-[16/9] w-full select-none overflow-hidden rounded-lg border border-border bg-card touch-pan-y"
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
        <span className="sm:hidden">Swipe or tap prev/next</span>
        <span className="hidden sm:inline">Use ← → to navigate</span>
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
