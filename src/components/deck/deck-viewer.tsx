"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const PDF_FILE = "/api/deck/file";

const documentOptions = {
  cMapUrl: "https://unpkg.com/pdfjs-dist@5.4.296/cmaps/",
  cMapPacked: true,
};

export function DeckViewer() {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [width, setWidth] = useState<number>(900);
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

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  }, []);

  const goPrev = useCallback(() => setPageNumber((p) => Math.max(1, p - 1)), []);
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

  const options = useMemo(() => documentOptions, []);

  return (
    <div className="flex flex-col gap-4">
      <div
        ref={containerRef}
        className="aspect-[16/9] w-full overflow-hidden rounded-lg border border-border bg-card"
      >
        <Document
          file={PDF_FILE}
          onLoadSuccess={onDocumentLoadSuccess}
          options={options}
          loading={<DeckSkeleton />}
          error={<DeckError />}
          className="flex justify-center"
        >
          <Page
            pageNumber={pageNumber}
            width={width}
            renderTextLayer
            renderAnnotationLayer
            loading={<DeckSkeleton />}
          />
        </Document>
      </div>

      <div className="flex items-center gap-3 self-center text-sm text-muted-foreground">
        <Button
          variant="outline"
          size="sm"
          onClick={goPrev}
          disabled={pageNumber <= 1}
        >
          ← Prev
        </Button>
        <span className={cn("font-mono tabular-nums", numPages === 0 && "opacity-40")}>
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
        <span className="ml-4 text-xs text-muted-foreground/70">
          Use ← → to navigate
        </span>
      </div>

    </div>
  );
}

function DeckSkeleton() {
  // Silent placeholder. Aspect-locked to the deck (16:9) so the height
  // matches what react-pdf will render — no layout jump on chunk swap.
  return <div className="aspect-[16/9] w-full" />;
}

function DeckError() {
  return (
    <div className="flex h-[60vh] w-full items-center justify-center text-xs text-destructive">
      Failed to load deck. Try refreshing.
    </div>
  );
}
