"use client";

import Link from "next/link";
import { createContext, use, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent } from "react";
import { createPortal } from "react-dom";

import { drawingsOf, type DrawingPage, type PartDrawing } from "@/lib/diagnose-parts";
import type { SourceView } from "@/lib/diagnose-rules";
import { areaParam, fitArea, parseAreaParam, type PageArea, type PageFigures } from "@/lib/manual-figures";

import { BackIcon, BookIcon, ZoomInIcon, ZoomOutIcon } from "./icons";
import { drawPage, figurePicture, headingArea, holdManuals, pageFigures, pagePicture } from "./manual-pages";
import { holdPage, overlayRoot, useMounted } from "./overlays";
import { useHistoryParam } from "./use-history-param";

// The real Polaris manual pages Claude cites, as pictures: small ones on
// each cause and check (drawn only once they're on screen), and a tap
// opens the page full screen to zoom into, with a way into the manual
// viewer at that page. The full-screen page is in the address
// (?manual-page=<manual>:<page>, with ":torque" when it's opened to read
// its torque specs, zoomed toward its TORQUE boxes, or ":box-…" when it's
// opened from one of a part's drawings, zoomed to that drawing), so Back
// closes it.

export type ManualSource = Extract<SourceView, { type: "manual" }>;

// focus: "torque" opens it zoomed toward its TORQUE boxes (the part sheet's
// card points to them there, never copying a torque); an area, zoomed to
// that drawing on it (a part's drawing, enlarged).
type PageRef = { manualId: string; page: number; title: string; focus?: "torque" | PageArea };

const focusParam = (focus: PageRef["focus"]) => (focus === "torque" ? ":torque" : focus ? `:${areaParam(focus)}` : "");

const PageViewContext = createContext<((page: PageRef) => void) | null>(null);

// Opens a page full screen (the part sheet's large page).
export function usePageView() {
  return use(PageViewContext);
}

// The manual pages among some sources, once each.
export function manualPages(sources: SourceView[]): ManualSource[] {
  const seen = new Set<string>();
  const pages: ManualSource[] = [];
  for (const source of sources) {
    if (source.type !== "manual") continue;
    const key = `${source.manualId}:${source.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push(source);
  }
  return pages;
}

// Around the Diagnose screen: keeps the manuals open while it's shown, and
// shows the full-screen page when the address names one (in the browser
// only: the server, rendering a refreshed address, has no document to put
// it in, and the page view opens once the page has hydrated).
export function ManualPictures({ children, titles }: { children: ReactNode; titles: Map<string, string> }) {
  const [value, open, close] = useHistoryParam("manual-page");
  const mounted = useMounted();
  // The titles of manuals opened from outside the reply's (a part's page
  // found by search), for the page view's header.
  const [opened, setOpened] = useState<Map<string, string>>(() => new Map());
  useEffect(() => holdManuals(), []);
  const match = value ? /^([0-9a-f-]{36}):(\d{1,5})(?::(torque|box-[\d-]+))?$/i.exec(value) : null;
  const focus = match?.[3] === "torque" ? ("torque" as const) : match?.[3] ? parseAreaParam(match[3]) : null;
  const page: PageRef | null = match
    ? { manualId: match[1], page: Number(match[2]), title: titles.get(match[1]) ?? opened.get(match[1]) ?? "Manual", ...(focus ? { focus } : {}) }
    : null;
  return (
    <PageViewContext
      value={(ref) => {
        if (!titles.has(ref.manualId) && opened.get(ref.manualId) !== ref.title) setOpened((old) => new Map(old).set(ref.manualId, ref.title));
        open(`${ref.manualId}:${ref.page}${focusParam(ref.focus)}`);
      }}
    >
      {children}
      {page && mounted && createPortal(<PageView key={value} page={page} onClose={close} />, overlayRoot())}
    </PageViewContext>
  );
}

// A row of small page pictures: "inline" ones sit in a cause's row of
// buttons (a cause stays short; a tap opens the page), "large" ones in the
// gallery and the full-screen sheet.
export type ThumbSize = "inline" | "small" | "large";
export function PageThumbs({ sources, size = "small", className = "" }: { sources: SourceView[]; size?: ThumbSize; className?: string }) {
  const pages = manualPages(sources);
  if (pages.length === 0) return null;
  return (
    <ul aria-label="Manual pictures" className={`flex flex-wrap gap-2 ${className}`}>
      {pages.map((source) => (
        <li key={`${source.manualId}:${source.page}`}>
          <PageThumb source={source} size={size} />
        </li>
      ))}
    </ul>
  );
}

const SIZES = { inline: { width: 36, css: "w-9" }, small: { width: 60, css: "w-[60px]" }, large: { width: 104, css: "w-[104px]" } } as const;

// Widths a picture that fills its box is drawn at: the box's width rounded
// up to one of these steps, so a few sizes cover every screen.
const FIT_STEP = 160;
const FIT_MOST = 960;

// A page's picture at a width, drawn once its element is near the screen;
// retry draws a failed one again. With an area, that drawing cropped out of
// the page (src/lib/manual-figures.ts) instead of the whole page. "fit"
// draws it as wide as its element is (in steps, once it's been measured).
export function usePagePicture(manualId: string, page: number, width: number | "fit", area: PageArea | null = null) {
  const element = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [tries, setTries] = useState(0);
  const [measured, setMeasured] = useState(0);
  const [state, setState] = useState<{ url: string; key: string } | { failed: string } | null>(null);
  const drawnWidth = width === "fit" ? measured : width;
  const crop = area ? areaParam(area) : "page";
  const key = `${manualId}:${page}:${crop}:${drawnWidth}:${tries}`;

  useEffect(() => {
    const el = element.current;
    if (!el || visible) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    const el = element.current;
    if (!el || width !== "fit") return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect.width;
      if (box > 0) setMeasured((old) => Math.max(old, Math.min(FIT_MOST, Math.ceil(box / FIT_STEP) * FIT_STEP)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);

  useEffect(() => {
    if (!visible || drawnWidth <= 0) return;
    // Gone (scrolled away, another part picked, measured wider) before it's
    // drawn: it's taken out of the queue.
    const stop = new AbortController();
    // The area as written in its key (to a thousandth of the page), so one
    // drawing is one picture however its area object came.
    const cropped = crop === "page" ? null : parseAreaParam(crop);
    (cropped ? figurePicture(manualId, page, cropped, drawnWidth, stop.signal) : pagePicture(manualId, page, drawnWidth, stop.signal)).then(
      (url) => !stop.signal.aborted && setState({ url, key }),
      (error) => {
        if (stop.signal.aborted) return;
        console.error("Couldn't draw a manual page", error);
        setState({ failed: key });
      },
    );
    return () => stop.abort();
  }, [visible, manualId, page, drawnWidth, crop, key]);

  const url = state && "url" in state && state.key === key ? state.url : null;
  const failed = !!state && "failed" in state && state.failed === key;
  return { element, url, failed, retry: () => setTries((n) => n + 1) };
}

// A part's drawings (see drawingsOf): found on its drawing pages, in their
// order, once the pages are known, and shown as they're found (each page's
// once those before it are done, so they never change places); "finding"
// until every page is looked at, "none" with no drawing page at all. A
// page that can't be looked at (its manual couldn't be opened) is left
// out. Pass the same array for the same pages (the sheet's own): a new one
// looks again (from what's kept). Pages another part asked for, not looked
// at yet when it's left, aren't looked at.
const NO_DRAWINGS: PartDrawing[] = [];
type Looked = { page: DrawingPage; figures: PageFigures | null };
export function usePartDrawings(pages: DrawingPage[]): { state: "none" | "finding" | "found"; drawings: PartDrawing[] } {
  const key = pages.map((page) => `${page.manualId}:${page.page}:${page.kind}`).join("|");
  const [found, setFound] = useState<{ key: string; looked: (Looked | undefined)[] } | null>(null);
  useEffect(() => {
    if (pages.length === 0) return;
    const stop = new AbortController();
    const looked: (Looked | undefined)[] = pages.map(() => undefined);
    pages.forEach((page, index) => {
      pageFigures(page.manualId, page.page, stop.signal)
        .then(
          (figures) => ({ page, figures }),
          (error) => {
            if (!stop.signal.aborted) console.error("Couldn't find a manual page's drawings", error);
            return { page, figures: null };
          },
        )
        .then((result) => {
          if (stop.signal.aborted) return;
          looked[index] = result;
          setFound({ key, looked: [...looked] });
        });
    });
    return () => stop.abort();
  }, [pages, key]);
  const looked = found?.key === key ? found.looked : null;
  const drawings = useMemo(() => {
    if (!looked) return NO_DRAWINGS;
    const done = looked.findIndex((result) => result === undefined);
    return drawingsOf((done === -1 ? looked : looked.slice(0, done)) as Looked[]);
  }, [looked]);
  if (pages.length === 0) return { state: "none", drawings: NO_DRAWINGS };
  return { state: looked && looked.every((result) => result !== undefined) ? "found" : "finding", drawings };
}

function PageThumb({ source, size }: { source: ManualSource; size: ThumbSize }) {
  const openPage = use(PageViewContext);
  const { width, css } = SIZES[size];
  const { element, url, failed, retry } = usePagePicture(source.manualId, source.page, width);
  const inline = size === "inline";
  return (
    <figure className={`${css} ${inline ? "relative" : "space-y-1"}`}>
      <button
        ref={element}
        type="button"
        data-page-thumb={`${source.manualId}:${source.page}`}
        data-ready={url ? "true" : "false"}
        aria-label={`Picture of manual page ${source.page}: ${source.title}. Open it.`}
        title={`${source.title}, page ${source.page}`}
        onClick={() => (failed ? retry() : openPage?.({ manualId: source.manualId, page: source.page, title: source.title }))}
        className="relative block aspect-[17/22] w-full overflow-hidden rounded-md border border-white/15 bg-white/[0.06] transition hover:border-white/40 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        {url ? (
          // A picture drawn here from the shop's own manual (no image file to optimise).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="size-full bg-white object-cover object-top" />
        ) : failed ? (
          <span className="absolute inset-0 grid place-items-center p-1 text-center text-[10px] leading-tight text-trail">{inline ? "Retry" : "Tap to retry"}</span>
        ) : (
          // A still placeholder: lines of a page, while it's drawn.
          <span aria-hidden className="absolute inset-x-2 top-2.5 space-y-1.5">
            {[90, 70, 80, 55].map((w) => (
              <span key={w} className="block h-1 rounded-full bg-white/10" style={{ width: `${w}%` }} />
            ))}
          </span>
        )}
      </button>
      {inline ? (
        // The page number on the picture's foot.
        <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-md bg-charcoal-900/80 text-center text-[10px] leading-4 text-ink tabular-nums">p.{source.page}</figcaption>
      ) : (
        <figcaption className="flex items-center justify-center gap-1 text-[11px] text-ink-muted tabular-nums">
          <BookIcon className="size-3" />
          p.{source.page}
        </figcaption>
      )}
    </figure>
  );
}

// --- The page full screen ----------------------------------------------------------

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
// Opened to read its torque specs: zoomed toward its TORQUE boxes (each
// heading and the lines under it), at most this much, so the rest of the
// page is still in reach.
const TORQUE_HEADING = /^TORQUE(?:\s|$)/;
const TORQUE_LINES = 8;
const FOCUS_ZOOM = 3;
// Opened from a drawing: zoomed so it fills the stage, at most this much.
const FIGURE_ZOOM = 4;

function PageView({ page, onClose }: { page: PageRef; onClose: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [fitWidth, setFitWidth] = useState(0);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  // The zoom the canvas was last drawn at (it's redrawn sharp a moment
  // after zooming stops).
  const [drawnZoom, setDrawnZoom] = useState(1);
  const [status, setStatus] = useState<"loading" | "shown" | "failed">("loading");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [tries, setTries] = useState(0);
  const [focused, setFocused] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ distance: number; zoom: number; mid: { x: number; y: number }; view: typeof view } | null>(null);

  useEffect(() => holdPage(closeButton.current), []);

  // The page fits the stage's width (or height, if that's tighter).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setFitWidth(Math.floor(Math.min(width - 16, (height - 16) * (17 / 22))));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Sharp at the zoom it's shown at, once zooming has stopped.
  useEffect(() => {
    const timer = setTimeout(() => setDrawnZoom(view.zoom), 180);
    return () => clearTimeout(timer);
  }, [view.zoom]);

  useEffect(() => {
    const target = canvas.current;
    if (!target || fitWidth <= 0) return;
    const controller = new AbortController();
    drawPage(page.manualId, page.page, target, fitWidth * drawnZoom, controller.signal).then(
      (drawn) => {
        if (controller.signal.aborted) return;
        setSize({ width: drawn.width / drawnZoom, height: drawn.height / drawnZoom });
        setStatus("shown");
      },
      (error) => {
        if (controller.signal.aborted || (error as { name?: string })?.name === "RenderingCancelledException") return;
        console.error("Couldn't show a manual page", error);
        setStatus("failed");
      },
    );
    return () => controller.abort();
  }, [page.manualId, page.page, fitWidth, drawnZoom, tries]);

  // Zoom about a point of the stage, keeping that point where it is.
  function zoomAt(next: number, at: { x: number; y: number }, from = view) {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    const k = zoom / from.zoom;
    setView(clamp({ zoom, x: at.x - (at.x - from.x) * k, y: at.y - (at.y - from.y) * k }));
  }

  // Keep the page on the stage.
  function clamp(next: typeof view) {
    const el = stage.current;
    if (!el || size.width === 0) return next;
    const w = size.width * next.zoom;
    const h = size.height * next.zoom;
    const sw = el.clientWidth;
    const sh = el.clientHeight;
    const x = w <= sw ? (sw - w) / 2 : Math.min(0, Math.max(sw - w, next.x));
    const y = h <= sh ? Math.max(8, (sh - h) / 2) : Math.min(0, Math.max(sh - h, next.y));
    return { zoom: next.zoom, x, y };
  }

  // Centred once its size is known. Opened to read its torque specs, then
  // zoomed toward its TORQUE boxes where the PDF's text says they are,
  // unless the tech has zoomed it already (a scanned page has no text to
  // say where: it stays as it is). Opened from a drawing, zoomed to it.
  const placed = useRef(false);
  useEffect(() => {
    if (status !== "shown" || placed.current || size.width === 0) return;
    placed.current = true;
    setView((old) => clamp(old));
    const el = stage.current;
    const focus = page.focus;
    if (focus && focus !== "torque") {
      if (!el) return;
      const fit = fitArea(focus, size, { width: el.clientWidth, height: el.clientHeight }, { margin: 24, most: FIGURE_ZOOM });
      setView((old) => (old.zoom === 1 ? clamp(fit) : old));
      setFocused(true);
      return;
    }
    if (focus !== "torque") return;
    headingArea(page.manualId, page.page, TORQUE_HEADING, TORQUE_LINES).then(
      (area) => {
        const el = stage.current;
        if (!area || !el) return;
        const width = (area.right - area.left) * size.width;
        const height = (area.bottom - area.top) * size.height;
        const zoom = Math.min(FOCUS_ZOOM, Math.max(MIN_ZOOM, Math.min((el.clientWidth - 48) / width, (el.clientHeight - 48) / height)));
        const x = el.clientWidth / 2 - ((area.left + area.right) / 2) * size.width * zoom;
        const y = el.clientHeight / 2 - ((area.top + area.bottom) / 2) * size.height * zoom;
        setView((old) => (old.zoom === 1 ? clamp({ zoom, x, y }) : old));
        setFocused(true);
      },
      (error) => console.error("Couldn't find the page's torque specs", error),
    );
    // clamp reads the latest size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, size.width]);

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  function onWheel(event: WheelEvent) {
    const at = local(event);
    zoomAt(view.zoom * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025)), at);
  }

  function onPointerDown(event: ReactPointerEvent) {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, local(event));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view };
    }
  }

  function onPointerMove(event: ReactPointerEvent) {
    const last = pointers.current.get(event.pointerId);
    if (!last) return;
    const now = local(event);
    pointers.current.set(event.pointerId, now);
    if (pointers.current.size >= 2 && gesture.current) {
      // Pinch: zoom about the fingers' middle, and follow it.
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const g = gesture.current;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, g.zoom * (distance / Math.max(1, g.distance))));
      const k = zoom / g.view.zoom;
      setView(clamp({ zoom, x: mid.x - (g.mid.x - g.view.x) * k, y: mid.y - (g.mid.y - g.view.y) * k }));
      return;
    }
    // Drag: move the page.
    setView((old) => clamp({ ...old, x: old.x + now.x - last.x, y: old.y + now.y - last.y }));
  }

  function onPointerUp(event: ReactPointerEvent) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
  }

  const centre = () => ({ x: (stage.current?.clientWidth ?? 0) / 2, y: (stage.current?.clientHeight ?? 0) / 2 });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${page.title}, page ${page.page}`}
      data-page-view={`${page.manualId}:${page.page}`}
      data-focus={focused ? (page.focus === "torque" ? "torque" : "area") : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "+" || event.key === "=") zoomAt(view.zoom * 1.25, centre());
        else if (event.key === "-") zoomAt(view.zoom / 1.25, centre());
      }}
      className="fixed inset-0 z-[36] flex flex-col bg-charcoal-900 text-ink"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-charcoal-900/90 px-3 py-2">
        <button ref={closeButton} type="button" onClick={onClose} data-page-close className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-sm font-medium hover:border-glow/40 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none">
          <BackIcon />
          Back
        </button>
        <p className="min-w-0 flex-1 truncate text-sm">
          <span className="font-semibold">Page {page.page}</span> <span className="text-ink-muted">· {page.title}</span>
        </p>
        <button type="button" aria-label="Zoom out" data-page-zoom="out" onClick={() => zoomAt(view.zoom / 1.4, centre())} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-white/15 hover:border-glow/40">
          <ZoomOutIcon />
        </button>
        <button type="button" data-page-zoom="fit" onClick={() => setView(clamp({ zoom: 1, x: 0, y: 0 }))} className="inline-flex min-h-11 items-center rounded-lg border border-white/15 px-3 font-mono text-sm tabular-nums hover:border-glow/40">
          {Math.round(view.zoom * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" data-page-zoom="in" onClick={() => zoomAt(view.zoom * 1.4, centre())} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-white/15 hover:border-glow/40">
          <ZoomInIcon />
        </button>
        <Link
          href={`/library/${page.manualId}?page=${page.page}`}
          data-open-in-manual
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-glow/40 bg-glow/10 px-3 text-sm font-medium text-glow hover:bg-glow/15"
        >
          <BookIcon />
          Open in manual
        </Link>
      </header>
      <div
        ref={stage}
        className="relative min-h-0 flex-1 touch-none overflow-hidden select-none"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => zoomAt(view.zoom > 1.5 ? 1 : 2.5, local(event))}
      >
        <canvas
          ref={canvas}
          role="img"
          aria-label={`Page ${page.page} of ${page.title}`}
          data-zoom={drawnZoom}
          className={`absolute top-0 left-0 origin-top-left bg-white shadow-2xl ${status === "shown" ? "" : "opacity-0"}`}
          style={{ width: size.width * view.zoom || undefined, height: size.height * view.zoom || undefined, transform: `translate(${view.x}px, ${view.y}px)` }}
        />
        {status === "loading" && <p className="absolute inset-x-0 top-8 text-center text-sm text-ink-muted">Loading page {page.page}…</p>}
        {status === "failed" && (
          <div className="absolute inset-x-4 top-8 space-y-3 text-center">
            <p className="text-sm text-trail">This page couldn&apos;t be shown. Check the connection and try again.</p>
            <button type="button" onClick={() => setTries((n) => n + 1)} className="inline-flex min-h-11 items-center rounded-lg border border-glow/40 px-4 text-sm text-glow">
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
