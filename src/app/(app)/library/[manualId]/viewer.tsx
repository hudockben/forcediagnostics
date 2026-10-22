"use client";

import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";

import { Notice } from "@/components/app/ui";
import { inputBaseClass } from "@/components/hud";
import { PDFJS_WASM_URL, loadPdfJs } from "@/lib/pdfjs";

import { getManualFileUrl } from "../actions";

// Shows one page of a manual at a time. pdf.js fetches only the parts of the
// PDF that page needs (HTTP range requests straight from storage), so a
// 100 MB manual opens on a tablet without downloading all of it.

// Bytes per range request: fewer, bigger requests suit slow shop Wi-Fi.
const RANGE_CHUNK_BYTES = 128 * 1024;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
// Tablets refuse canvases much bigger than this many pixels.
const MAX_CANVAS_PIXELS = 12_000_000;

const toolButtonClass =
  "flex h-12 min-w-12 items-center justify-center rounded-lg border border-white/10 px-3 text-sm font-medium text-ink transition hover:border-glow/40 hover:text-glow focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-ink";

const isCancelled = (error: unknown) =>
  (error as { name?: string } | null)?.name === "RenderingCancelledException";

type View = { kind: "loading" } | { kind: "shown" } | { kind: "failed"; message: string };

export function ManualViewer({
  manualId,
  pageCount,
  startPage,
  initialUrl,
}: {
  manualId: string;
  pageCount: number;
  startPage: number;
  initialUrl: string;
}) {
  const [pageNumber, setPageNumber] = useState(startPage);
  const [draft, setDraft] = useState(String(startPage));
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [tries, setTries] = useState(0);

  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileUrl = useRef(initialUrl);
  const pdf = useRef<PDFDocumentLoadingTask | null>(null);
  // The canvas takes one render at a time; each waits for the one before.
  const lastRender = useRef<Promise<unknown>>(Promise.resolve());

  // Fit to width: follow the frame's width (rotating a tablet, say).
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Closes the PDF when the page goes away.
  useEffect(
    () => () => {
      void pdf.current?.destroy();
      pdf.current = null;
    },
    [],
  );

  useEffect(() => {
    if (width === 0) return;
    let cancelled = false;
    let task: RenderTask | undefined;

    async function open(fresh: boolean) {
      if (fresh || !pdf.current) {
        await pdf.current?.destroy();
        pdf.current = null;
        if (fresh) {
          // Storage links expire after 15 minutes; ask for a new one.
          const result = await getManualFileUrl(manualId);
          if ("error" in result) throw new Error(result.error);
          fileUrl.current = result.url;
        }
        const pdfjs = await loadPdfJs();
        // The page or size changed while waiting: the newer run opens the
        // PDF, so there's only ever one (each has its own worker).
        if (cancelled) throw new Error("cancelled");
        pdf.current = pdfjs.getDocument({
          url: fileUrl.current,
          // Only fetch what the page on screen needs.
          disableAutoFetch: true,
          disableStream: true,
          rangeChunkSize: RANGE_CHUNK_BYTES,
          // Decoders for scanned-page images (CCITT, JBIG2, JPEG 2000).
          wasmUrl: PDFJS_WASM_URL,
          verbosity: pdfjs.VerbosityLevel.ERRORS,
        });
      }
      return pdf.current.promise;
    }

    async function draw(fresh: boolean) {
      const doc = await open(fresh);
      const page = await doc.getPage(pageNumber);
      await lastRender.current;
      const target = canvas.current;
      if (cancelled || !target) return;
      const fit = (width / page.getViewport({ scale: 1 }).width) * zoom;
      const cssViewport = page.getViewport({ scale: fit });
      const pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(MAX_CANVAS_PIXELS / (cssViewport.width * cssViewport.height)),
      );
      const viewport = page.getViewport({ scale: fit * pixelRatio });
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      target.style.width = `${Math.floor(cssViewport.width)}px`;
      target.style.height = `${Math.floor(cssViewport.height)}px`;
      task = page.render({ canvas: target, viewport });
      lastRender.current = task.promise.catch(() => {});
      await task.promise;
      if (!cancelled) setView({ kind: "shown" });
    }

    draw(false).catch((error) => {
      if (cancelled || isCancelled(error)) return;
      // Most likely the storage link ran out: try once more with a new one.
      draw(true).catch((again) => {
        if (cancelled || isCancelled(again)) return;
        console.error("Couldn't show a manual page", again);
        setView({ kind: "failed", message: "This page couldn't be shown. Check the connection and try again." });
      });
    });

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [manualId, pageNumber, width, zoom, tries]);

  function goTo(requested: number) {
    const next = Math.min(Math.max(Math.round(requested) || 1, 1), pageCount);
    setDraft(String(next));
    if (next === pageNumber) return;
    setPageNumber(next);
    setView({ kind: "loading" });
    // Keeps the address shareable without reloading the page.
    window.history.replaceState(null, "", `?page=${next}`);
  }

  // Arrow keys turn pages, unless someone is typing.
  const onArrowKey = useEffectEvent((step: number) => goTo(pageNumber + step));
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft") onArrowKey(-1);
      if (event.key === "ArrowRight") onArrowKey(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onPageSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    goTo(Number(draft));
  }

  function changeZoom(next: number) {
    if (next === zoom) return;
    setZoom(next);
    setView({ kind: "loading" });
  }

  const zoomIndex = ZOOMS.indexOf(zoom);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => goTo(pageNumber - 1)}
            disabled={pageNumber <= 1}
            aria-label="Previous page"
            className={toolButtonClass}
          >
            ‹ Prev
          </button>
          <form onSubmit={onPageSubmit} className="flex items-center gap-2 text-sm text-ink-muted">
            <label htmlFor="viewer-page" className="sr-only">
              Page number
            </label>
            <input
              id="viewer-page"
              type="number"
              inputMode="numeric"
              min={1}
              max={pageCount}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => goTo(Number(draft))}
              // w-20! wins over inputBaseClass's w-full.
              className={`${inputBaseClass} w-20! text-center`}
            />
            <span className="whitespace-nowrap">of {pageCount}</span>
          </form>
          <button
            type="button"
            onClick={() => goTo(pageNumber + 1)}
            disabled={pageNumber >= pageCount}
            aria-label="Next page"
            className={toolButtonClass}
          >
            Next ›
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => changeZoom(ZOOMS[zoomIndex - 1])}
            disabled={zoomIndex <= 0}
            aria-label="Zoom out"
            className={toolButtonClass}
          >
            −
          </button>
          <button type="button" onClick={() => changeZoom(1)} className={toolButtonClass}>
            {zoom === 1 ? "Fit width" : `${Math.round(zoom * 100)}%`}
          </button>
          <button
            type="button"
            onClick={() => changeZoom(ZOOMS[zoomIndex + 1])}
            disabled={zoomIndex >= ZOOMS.length - 1}
            aria-label="Zoom in"
            className={toolButtonClass}
          >
            +
          </button>
          <a
            href={`/library/${manualId}/file`}
            target="_blank"
            rel="noopener"
            className={`${toolButtonClass} whitespace-nowrap`}
          >
            Open full PDF
          </a>
        </div>
      </div>

      <div role="status" aria-live="polite" className="empty:hidden">
        {view.kind === "failed" && (
          <div className="space-y-3">
            <Notice tone="trail" live={false}>
              {view.message}
            </Notice>
            <button
              type="button"
              onClick={() => {
                setView({ kind: "loading" });
                setTries((count) => count + 1);
              }}
              className={toolButtonClass}
            >
              Try again
            </button>
          </div>
        )}
      </div>

      <div
        ref={frame}
        className="relative min-h-[60vh] overflow-auto rounded-xl border border-white/10 bg-white/[0.03]"
      >
        <canvas
          ref={canvas}
          aria-label={`Page ${pageNumber} of ${pageCount}`}
          role="img"
          className={`mx-auto block bg-white ${view.kind === "shown" ? "" : "opacity-60"}`}
        />
        {view.kind === "loading" && (
          <p className="absolute inset-x-0 top-6 text-center font-mono text-sm text-glow/80">Loading page {pageNumber}…</p>
        )}
      </div>
    </div>
  );
}
