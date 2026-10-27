"use client";

import { createContext, use, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { drawingKey, drawingLabel, type PartDrawing } from "@/lib/diagnose-parts";
import type { DrawnSystem } from "@/lib/diagnose-zones";
import { areaParam } from "@/lib/manual-figures";

import { BookIcon, ChevronIcon, CrossIcon, ZoomInIcon } from "./icons";
import { usePagePicture, usePageView } from "./manual-pictures";

// The part picked in the examine view, drawn as its manual draws it, on the
// 3D unit itself: a bubble beside the part with a leader to it (placed by
// the examine view, src/lib/unit-3d/bubble.ts), showing the part's
// drawings cropped out of its manual pages (an exploded view first; one
// with nothing to crop, lines only or a scan, as its page), the part's
// name and the page ("Starter motor · p.9"), "From the manual" and what
// it is (an exploded view, a drawing), and with several, arrows, a count
// and a swipe between them. A tap on the drawing, or Enlarge under it,
// opens its page full screen zoomed to it (the address's
// ?manual-page=…:box-…); × puts it away until another part is picked (or
// its chip is tapped again). A quiet frame once the part's pages are
// known and while their drawings are found; nothing before that, and no
// bubble when it has no drawing. While another part's sheet comes, the
// last one stays, dimmed. On a narrow stage it's a strip across the top.
// The sheet beside the stage finds the drawings (part-sheet.tsx) and says
// which they are here (StageDrawingsContext); the line drawing's sheet,
// with no 3D unit, has no stage to say it to.

// The picked part's drawings for the stage: being found (the part's pages
// known, the drawings on them not yet), found, or none to show; sure when
// a drawing is sure to come (an exploded view among its pages); stale
// while another part's sheet comes (these are the last part's).
export type StageDrawings = { system: DrawnSystem; part: string | null; state: "loading" | "found" | "none"; drawings: PartDrawing[]; sure?: boolean; stale?: boolean };
type Report = (system: DrawnSystem, drawings: StageDrawings | null) => void;

// What the sheet tells the stage: its part's drawings as they change, and
// that the part picked already was picked again (its bubble comes back).
export const StageDrawingsContext = createContext<{ report: Report; reopen: (system: DrawnSystem) => void } | null>(null);

// Which part a bubble is for (× puts it away until this changes).
export const stageDrawingsKey = (drawings: StageDrawings) => `${drawings.system}|${(drawings.part ?? "").toLowerCase()}`;
const contentKey = (drawings: StageDrawings) =>
  `${stageDrawingsKey(drawings)}|${drawings.state}|${drawings.sure ? "sure" : ""}|${drawings.stale ? "stale" : ""}|${drawings.drawings.map(drawingKey).join(",")}`;
export const sameStageDrawings = (a: StageDrawings, b: StageDrawings) => contentKey(a) === contentKey(b);

// The sheet's side: says what its part's drawings are as they change, and
// that there are none when it goes.
export function useStageDrawings(drawings: StageDrawings) {
  const stage = use(StageDrawingsContext);
  const report = stage?.report;
  const key = contentKey(drawings);
  const { system } = drawings;
  useEffect(() => {
    report?.(drawings.system, drawings);
    // key stands for drawings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, key]);
  useEffect(() => () => report?.(system, null), [report, system]);
}

// A drawing very wide or tall gets a box within these shapes (it fits
// inside); the bubble keeps its first drawing's shape for all of them, so
// it stays put while they're swiped through.
const shapeOf = (aspect: number) => Math.min(1.7, Math.max(0.8, aspect || 1));
// A swipe: this far across, more across than down.
const SWIPE = 36;

const ink = "text-[#1f2328]";
const muted = "text-[#4b5158]";
const focusRing = "focus-visible:ring-2 focus-visible:ring-[#085c52] focus-visible:outline-none";
const cardClass = `rounded-xl bg-white ${ink} shadow-[0_6px_24px_rgba(15,20,25,0.18)] ring-1 ring-[#085c52]/35`;
const iconButton = `inline-flex size-11 shrink-0 items-center justify-center rounded-lg transition hover:bg-black/5 aria-disabled:opacity-35 aria-disabled:hover:bg-transparent ${focusRing}`;
// Floating, as wide as a third of the stage within these (a tablet's or a
// laptop's about 300px, a large monitor's up to 440).
const FLOATING = "w-[clamp(220px,36cqw,440px)] p-2 pt-0";
const DOCKED = "flex h-full gap-2 p-1.5";

// The part's name, as its chip has it.
const named = (part: string | null) => part ?? "The part";

export function DrawingBubble({ shown, docked, onClose }: { shown: StageDrawings; docked: boolean; onClose: () => void }) {
  const body =
    shown.state !== "found" || shown.drawings.length === 0 ? (
      <Waiting part={shown.part} docked={docked} onClose={onClose} />
    ) : (
      <Drawings key={stageDrawingsKey(shown)} part={shown.part} drawings={shown.drawings} docked={docked} onClose={onClose} />
    );
  // The last part's, while the next one's sheet comes.
  return (
    <div data-bubble-stale={shown.stale || undefined} aria-busy={shown.stale || undefined} className={`h-full transition-opacity ${shown.stale ? "opacity-60" : ""}`}>
      {body}
    </div>
  );
}

const closeButton = (onClose: () => void) => (
  <button type="button" data-bubble-close aria-label="Close the drawing" title="Close" onClick={onClose} className={iconButton}>
    <CrossIcon />
  </button>
);

// While the part's drawings are found: the bubble's frame, still (nothing
// moves on the stage), with its name and × already.
function Waiting({ part, docked, onClose }: { part: string | null; docked: boolean; onClose: () => void }) {
  return (
    <div data-bubble-state="loading" aria-busy="true" className={`${docked ? DOCKED : FLOATING} ${cardClass}`}>
      <p role="status" className="sr-only">
        Finding the {part ? part.toLowerCase() : "part"}&apos;s drawings in the manual.
      </p>
      {docked ? (
        <>
          <span aria-hidden className="h-full w-28 shrink-0 rounded-lg bg-black/[0.05]" />
          <span aria-hidden className={`flex min-w-0 flex-1 items-start gap-1.5 pt-1 text-[12.5px] font-semibold ${muted}`}>
            <BookIcon className="mt-px size-3.5 shrink-0" />
            <span className="truncate">{named(part)} · from the manual</span>
          </span>
          {closeButton(onClose)}
        </>
      ) : (
        <>
          <div className="flex items-center gap-1.5 pl-1">
            <BookIcon className={`size-3.5 shrink-0 ${muted}`} />
            <p aria-hidden className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] leading-4 font-semibold">{named(part)}</span>
              <span className={`block truncate text-[11.5px] leading-4 ${muted}`}>From the manual</span>
            </p>
            <span className="-mr-1.5">{closeButton(onClose)}</span>
          </div>
          <span aria-hidden className="block aspect-[4/3] max-h-[46cqh] w-full rounded-lg bg-black/[0.05]" />
        </>
      )}
    </div>
  );
}

function Drawings({ part, drawings, docked, onClose }: { part: string | null; drawings: PartDrawing[]; docked: boolean; onClose: () => void }) {
  const openPage = usePageView();
  const [index, setIndex] = useState(0);
  const at = Math.min(index, drawings.length - 1);
  const drawing = drawings[at];
  const several = drawings.length > 1;
  const from = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const go = (step: number) => setIndex((old) => Math.min(drawings.length - 1, Math.max(0, Math.min(old, drawings.length - 1) + step)));

  function onPointerDown(event: ReactPointerEvent) {
    from.current = { x: event.clientX, y: event.clientY };
    swiped.current = false;
  }
  function onPointerUp(event: ReactPointerEvent) {
    const start = from.current;
    from.current = null;
    if (!start || !several) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // Its click (a mouse's) doesn't open the page.
    swiped.current = true;
    go(dx < 0 ? 1 : -1);
  }
  function onKeyDown(event: KeyboardEvent) {
    if (!several || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    go(event.key === "ArrowRight" ? 1 : -1);
  }
  function enlarge() {
    if (swiped.current) {
      swiped.current = false;
      return;
    }
    openPage?.({ manualId: drawing.manualId, page: drawing.page, title: drawing.title, ...(drawing.area ? { focus: drawing.area } : {}) });
  }

  const label = drawingLabel(drawing);
  const name = named(part);
  // Docked, the kind goes on the caption's line (the pager has the other).
  const caption = (
    <span data-bubble-caption className="block truncate text-[12.5px] leading-4 font-semibold">
      {docked ? `${name} · ${label} · p.${drawing.page}` : `${name} · p.${drawing.page}`}
    </span>
  );
  const close = closeButton(onClose);
  // Off the picture (an exploded view's callout numbers reach its corners).
  const enlargeButton = (
    <button
      type="button"
      data-bubble-enlarge
      aria-label={`Enlarge the ${label.toLowerCase()} from page ${drawing.page}`}
      onClick={() => openPage?.({ manualId: drawing.manualId, page: drawing.page, title: drawing.title, ...(drawing.area ? { focus: drawing.area } : {}) })}
      className={`inline-flex h-11 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[12.5px] font-medium text-[#085c52] transition hover:bg-black/5 ${focusRing}`}
    >
      <ZoomInIcon className="size-3.5" />
      Enlarge
    </button>
  );
  // At either end its arrow says it can't go on (aria-disabled, so a
  // focused arrow keeps the focus, and with it the arrow keys).
  const pager = several && (
    <div role="group" aria-label="Drawings" data-bubble-pager className="flex shrink-0 items-center">
      <button type="button" data-bubble-step="back" aria-label="Previous drawing" aria-disabled={at === 0} onClick={() => go(-1)} className={iconButton}>
        <ChevronIcon className="size-4 rotate-90" />
      </button>
      <span data-bubble-count aria-live="polite" className={`min-w-10 text-center text-xs font-medium tabular-nums ${muted}`}>
        {at + 1} / {drawings.length}
      </span>
      <button type="button" data-bubble-step="next" aria-label="Next drawing" aria-disabled={at === drawings.length - 1} onClick={() => go(1)} className={iconButton}>
        <ChevronIcon className="size-4 -rotate-90" />
      </button>
    </div>
  );
  const picture = (
    <Picture
      key={drawingKey(drawing)}
      drawing={drawing}
      label={label}
      onOpen={enlarge}
      className={docked ? "h-full w-28 shrink-0" : "max-h-[46cqh] w-full"}
      shape={docked ? null : shapeOf(drawings[0].aspect)}
    />
  );

  return (
    <div
      role="group"
      aria-roledescription="drawings"
      aria-label={`From the manual: ${part ? `the ${part.toLowerCase()}, ` : ""}${label.toLowerCase()}, page ${drawing.page}${several ? `, ${at + 1} of ${drawings.length}` : ""}`}
      data-bubble-state="found"
      data-drawing-index={at}
      data-drawing-count={drawings.length}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        from.current = null;
      }}
      onKeyDown={onKeyDown}
      className={`touch-none select-none ${docked ? DOCKED : FLOATING} ${cardClass}`}
    >
      {docked ? (
        <>
          {picture}
          <div className="flex min-w-0 flex-1 flex-col justify-between pt-1">
            {caption}
            {/* With several, the pager (the picture itself enlarges); one, Enlarge. */}
            {pager || <span className="-ml-2">{enlargeButton}</span>}
          </div>
          {close}
        </>
      ) : (
        <>
          <div className="flex items-center gap-1.5 pl-1">
            <BookIcon className={`size-3.5 shrink-0 ${muted}`} />
            <p className="min-w-0 flex-1">
              {caption}
              <span data-bubble-kind className={`block truncate text-[11.5px] leading-4 ${muted}`}>
                From the manual · {label}
              </span>
            </p>
            <span className="-mr-1.5">{close}</span>
          </div>
          {picture}
          <div className={`-mx-1.5 -mb-1 flex items-center pt-0.5 ${several ? "justify-between" : "justify-end"}`}>
            {pager}
            {enlargeButton}
          </div>
        </>
      )}
    </div>
  );
}

// The drawing itself, cropped out of its page at the size it's shown; a
// tap opens the page zoomed to it. Nothing is drawn over it.
function Picture({ drawing, label, onOpen, className, shape }: { drawing: PartDrawing; label: string; onOpen: () => void; className: string; shape: number | null }) {
  const { element, url, failed, retry } = usePagePicture(drawing.manualId, drawing.page, "fit", drawing.area);
  return (
    <button
      ref={element}
      type="button"
      data-bubble-drawing={`${drawing.manualId}:${drawing.page}`}
      data-drawing-area={drawing.area ? areaParam(drawing.area) : "page"}
      data-drawing-kind={drawing.kind}
      data-ready={url ? "true" : "false"}
      aria-label={failed ? `The drawing from page ${drawing.page} couldn't be drawn. Try again.` : `${label} from page ${drawing.page} of ${drawing.title}. Open it full screen, zoomed in.`}
      onClick={() => (failed ? retry() : onOpen())}
      style={shape ? { aspectRatio: String(shape) } : undefined}
      className={`relative block overflow-hidden rounded-lg bg-white ring-1 ring-black/10 transition hover:ring-black/25 ${focusRing} ${className}`}
    >
      {url ? (
        // A drawing cropped here from the shop's own manual (no image file to optimise).
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" draggable={false} className="size-full object-contain" />
      ) : failed ? (
        <span className="absolute inset-0 grid place-items-center p-2 text-center text-xs text-[#9a3412]">Couldn&apos;t draw it. Tap to try again.</span>
      ) : (
        <span aria-hidden className="absolute inset-0 bg-black/[0.05]" />
      )}
    </button>
  );
}
