"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

import {
  cardSettled,
  cardOf,
  drawingKey,
  drawingLabel,
  largePage,
  otherPages,
  panelDrawings,
  partLibraryHref,
  type DrawingPage,
  type PartCard,
  type PartDrawing,
  type PartPage,
  type PartSheet,
} from "@/lib/diagnose-parts";
import { SYSTEM_LABELS, type DrawnSystem } from "@/lib/diagnose-zones";
import type { FactsState, PageFacts, PageRef } from "@/lib/manual-facts-rules";
import { areaParam } from "@/lib/manual-figures";

import { StageDrawingsContext, useStageDrawings } from "./drawing-bubble";
import { BookIcon, SearchIcon, WrenchIcon, ZoomInIcon } from "./icons";
import { usePagePicture, usePageView, usePartDrawings } from "./manual-pictures";

// From the manual, at the top of a system's sheet: the system's parts to
// pick from (those its causes name first), the picked part's drawings
// cropped out of its manual pages and shown large (an exploded view first:
// the first across the sheet, the others in a strip under it; a tap opens
// the page full screen zoomed to the drawing; in the examine view they're
// on the 3D unit too, in a bubble by the part: drawing-bubble.tsx), the
// part's best manual page drawn whole (a tap opens it full screen to zoom
// into; Open in manual goes to the viewer at it), a few other pages that
// show it, and beside the page (under it on a phone) what it says: the
// procedure's title, its special tools as the page prints them, and which
// page that is. Its
// steps, torque specs and cautions are never put on it: when the page has
// them, a line in the manual's teal says so and opens the page full screen
// to read them there, zoomed toward its TORQUE boxes when it has torque
// specs (src/lib/manual-facts-rules.ts says why). The server finds the pages and reads each page once, the first
// time anyone in the shop opens it (src/app/api/diagnose/part-sheet/
// route.ts): the page shows while it's read, and on its own when it can't
// be. A part no page is about (another part's procedure only names it on
// the way) gets the pages that name it, said so, without a card.

type SheetAsk = { conversationId: string; system: DrawnSystem; part?: string };
type CardAsk = { conversationId: string; page: PageRef };
type Answer = PartSheet | { error: string };

const NOT_THROUGH = "That didn't go through. Check the connection and try again.";
const UNREADABLE: FactsState = { status: "unavailable", reason: "error" };
// Another device is reading the page: ask again after this long, for up to
// two minutes (a reading takes a few seconds; the server gives up on one
// after a few minutes).
const READ_AGAIN_MS = 2000;
// Looking for a part's drawings longer than this: the bubble's still frame
// shows (sooner, when a drawing is sure to come).
const FRAME_AFTER_MS = 400;
const MAX_WAITS = 60;
// The large page's picture, in CSS pixels (drawn sharp for the screen).
const LARGE_WIDTH = 480;
const SMALL_WIDTH = 60;
// A drawing in the strip: this tall, as wide as its shape (within these).
const STRIP_HEIGHT = 72;
const STRIP_WIDTHS = [56, 144] as const;
const NO_PAGES: DrawingPage[] = [];

async function ask<T>(input: SheetAsk | CardAsk): Promise<T | { error: string }> {
  try {
    const response = await fetch("/api/diagnose/part-sheet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as (T & { error?: string; redirectTo?: string }) | null;
    if (data?.redirectTo) window.location.assign(data.redirectTo);
    if (!response.ok || !data || typeof data.error === "string") return { error: data?.error ?? NOT_THROUGH };
    return data;
  } catch {
    // Offline, or the server went away.
    return { error: NOT_THROUGH };
  }
}

// Asked already on this visit: each part's sheet for the reply and unit on
// screen, and each page's card once it's settled, so going back to a part
// or a page asks nothing again, and a page that couldn't be read isn't
// asked about again until the page is loaded again.
const sheets = new Map<string, PartSheet>();
const cards = new Map<string, FactsState>();
const KEPT = 60;
function keep<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);
  map.set(key, value);
  while (map.size > KEPT) map.delete(map.keys().next().value!);
}
const cardKey = (page: PageRef) => `${page.manualId.toLowerCase()}:${page.page}`;

async function loadSheet(input: SheetAsk, version: string): Promise<Answer> {
  const key = (part: string) => `${input.conversationId}|${version}|${input.system}|${part.toLowerCase()}`;
  const known = sheets.get(key(input.part ?? ""));
  if (known) return known;
  const answer = await ask<PartSheet>(input);
  if (!("error" in answer)) {
    keep(sheets, key(input.part ?? ""), answer);
    // The first part's sheet is also that part's when it's picked.
    if (!input.part) keep(sheets, key(answer.part), answer);
  }
  return answer;
}

// A page's card: read now if no one has (a few seconds, once).
async function loadCard(input: CardAsk): Promise<FactsState> {
  const known = cards.get(cardKey(input.page));
  if (known) return known;
  const answer = await ask<PartCard>(input);
  const state = "error" in answer ? null : answer.state;
  if (!state) return UNREADABLE;
  if (cardSettled(state)) keep(cards, cardKey(input.page), state);
  return state;
}

const chipClass =
  "relative inline-flex h-9 max-w-full items-center rounded-full border px-3 text-[13px] font-medium transition before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

// Whether `key` has stood (not null, unchanged) for `ms`.
function useAfter(key: string | null, ms: number) {
  const [stood, setStood] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => setStood(key), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return key !== null && stood === key;
}

// version: what the sheets on screen depend on besides the system and part
// (the reply, the unit and its manuals); a new one asks again.
export function PartSheetSection({
  conversationId,
  system,
  version,
  causes = 0,
}: {
  conversationId: string;
  system: DrawnSystem;
  version: string;
  // How many causes follow the section in the sheet (a way down to them).
  causes?: number;
}) {
  const openPage = usePageView();
  // The part picked (null: the first, as the server orders them), and a
  // page picked among its others (null: its best).
  const [picked, setPicked] = useState<string | null>(null);
  const [chosen, setChosen] = useState<PageRef | null>(null);
  const [tries, setTries] = useState(0);

  const sheetKey = `${version}|${picked ?? ""}|${tries}`;
  const [loaded, setLoaded] = useState<{ key: string; answer: Answer } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadSheet({ conversationId, system, ...(picked ? { part: picked } : {}) }, version).then((answer) => {
      if (!cancelled) setLoaded({ key: sheetKey, answer });
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, system, picked, version, sheetKey]);

  // While another part's sheet comes, the last one stays (dimmed), so the
  // sheet doesn't fold up and open again on every pick.
  const answer = loaded?.answer ?? null;
  const stale = loaded !== null && loaded.key !== sheetKey;
  const sheet = answer && !("error" in answer) ? answer : null;
  const parts = sheet?.parts ?? [];
  const part = picked ?? sheet?.part ?? null;
  const large = sheet ? largePage(sheet, chosen) : null;
  // A part no page is about: its pages are shown, said so, and the best one
  // without a card (it's another part's page); one the tech picks has its card.
  const mentionsOnly = sheet !== null && sheet.pages.length > 0 && !sheet.pages[0].about;
  const carded = large !== null && (large.about || (chosen !== null && large !== sheet?.pages[0]));
  const given = sheet && large && carded ? cardOf(sheet, large) : null;
  // The part's drawings, found on its drawing pages (the cropped ones, and
  // an exploded view with nothing to crop unless it's the large page).
  const found = usePartDrawings(sheet?.drawings ?? NO_PAGES);
  const drawings = panelDrawings(found.drawings, large);
  // And the examine view's bubble on the 3D unit (drawing-bubble.tsx): the
  // part's drawings with no page under them, an exploded view whole too.
  // None while the first sheet comes (a part with no drawing never shows a
  // frame); while another part's sheet comes, the last part's, dimmed, as
  // the sheet is; a still frame only once the part has pages to look on
  // and none of their drawings is found yet, and then only when one is
  // sure to come (an exploded view among them, shown whole if there's
  // nothing to crop) or the looking takes a moment: a part whose pages
  // turn out to have nothing to crop doesn't flash a frame (on a phone, a
  // strip the callouts would drop under and come back from).
  const onStage = panelDrawings(found.drawings, null);
  const sure = sheet?.drawings.some((page) => page.kind === "exploded") ?? false;
  const finding = sheet !== null && onStage.length === 0 && found.state === "finding";
  const slow = useAfter(finding ? `${sheetKey}|${(sheet?.drawings ?? []).map((page) => `${page.manualId}:${page.page}`).join(",")}` : null, FRAME_AFTER_MS);
  const stage = use(StageDrawingsContext);
  useStageDrawings({
    system,
    part: stale ? (sheet?.part ?? part) : part,
    state: !sheet ? "none" : onStage.length > 0 ? "found" : finding && (sure || slow) ? "loading" : "none",
    drawings: onStage,
    sure,
    stale,
  });

  // The large page's card: as the sheet brought it when that's settled,
  // else asked for (and read, the first time anyone opens the page).
  const largeKey = large && loaded ? `${loaded.key}|${cardKey(large)}` : "";
  const [card, setCard] = useState<{ key: string; state: FactsState } | null>(null);
  useEffect(() => {
    if (!sheet || !large || !carded || stale) return;
    const page = { manualId: large.manualId, page: large.page };
    if (given && cardSettled(given) && !cards.has(cardKey(page))) {
      keep(cards, cardKey(page), given);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waits = 0;
    const run = () =>
      void loadCard({ conversationId, page }).then((state) => {
        if (cancelled) return;
        if (state.status !== "reading") {
          setCard({ key: largeKey, state });
          return;
        }
        // Being read on another device: it's there in a moment.
        if (waits++ < MAX_WAITS) timer = setTimeout(run, READ_AGAIN_MS);
        else setCard({ key: largeKey, state: UNREADABLE });
      });
    if (given?.status === "reading" && !cards.has(cardKey(page))) timer = setTimeout(run, READ_AGAIN_MS);
    else run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [conversationId, sheet, large, carded, stale, given, largeKey]);
  const state = card?.key === largeKey ? card.state : given && cardSettled(given) ? given : null;

  function pick(name: string) {
    // The part picked already: its drawing on the unit comes back if it was put away.
    if (part !== null && name.toLowerCase() === part.toLowerCase()) {
      stage?.reopen(system);
      return;
    }
    setPicked(name);
    setChosen(null);
  }

  // Down to the causes, past the page and its card (a phone's sheet is short).
  function toCauses(from: HTMLElement) {
    const target = from.closest("[data-sheet]")?.querySelector<HTMLElement>("[data-sheet-causes]");
    if (!target) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    target.focus({ preventScroll: true });
  }

  const label = SYSTEM_LABELS[system];
  return (
    <section
      aria-label="From the manual"
      aria-busy={stale || undefined}
      data-part-sheet={system}
      data-part={part ?? undefined}
      data-drawings={found.state}
      data-drawings-shown={drawings.length}
      className="@container space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-ink-muted uppercase">
          <BookIcon className="size-3.5" />
          From the manual
        </h3>
        {causes > 0 && (
          <button
            type="button"
            data-to-causes
            onClick={(event) => toCauses(event.currentTarget)}
            className="-my-2 inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-sm font-medium text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
          >
            Causes · {causes}
          </button>
        )}
      </div>
      {parts.length > 0 && (
        <div role="group" aria-label={`${label} parts`} className="flex flex-wrap gap-2">
          {parts.map((name) => {
            const on = part !== null && name.toLowerCase() === part.toLowerCase();
            return (
              <button
                key={name}
                type="button"
                data-part-chip={name}
                aria-pressed={on}
                onClick={() => pick(name)}
                className={`${chipClass} ${on ? "border-glow/50 bg-glow/15 text-glow" : "border-white/15 text-ink hover:border-white/30"}`}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
      {answer === null ? (
        <p role="status" data-part-loading className="text-sm text-ink-muted">
          {part ? `Finding the ${part.toLowerCase()} in the manuals…` : `Finding the ${label.toLowerCase()} parts…`}
        </p>
      ) : "error" in answer ? (
        <div role="status" className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${stale ? "opacity-60" : ""}`}>
          <p className="text-sm text-trail">{answer.error}</p>
          <button
            type="button"
            onClick={() => setTries((n) => n + 1)}
            className="inline-flex min-h-11 items-center rounded-lg border border-glow/40 px-3 text-sm font-medium text-glow hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
          >
            Try again
          </button>
        </div>
      ) : !large ? (
        <div className={stale ? "opacity-60" : ""}>
          <NoPage part={answer.part} noManual={answer.noManual} />
        </div>
      ) : (
        <div data-part-stale={stale || undefined} className={`space-y-3 transition-opacity ${stale ? "opacity-60" : ""}`}>
          {mentionsOnly && <MentionsOnly part={answer.part} />}
          {drawings.length > 0 && (
            <Drawings
              key={answer.part}
              drawings={drawings}
              // In the examine view the bubble on the unit shows the drawing
              // too: lower, so the page and its card are in the first screen.
              height={stage ? EXAMINE_DRAWING_HEIGHT : DRAWING_HEIGHT}
              onOpen={(drawing) => openPage?.({ manualId: drawing.manualId, page: drawing.page, title: drawing.title, ...(drawing.area ? { focus: drawing.area } : {}) })}
            />
          )}
          {/* The page and what it says side by side where the sheet has
              room (a wide screen, a portrait tablet), the page half of it,
              the other pages under the page; on a phone the page, the
              other pages (so a tap on one changes what's in view), then
              what it says. */}
          <div className="grid gap-3 @[34rem]:grid-cols-2 @[34rem]:grid-rows-[auto_1fr] @[34rem]:items-start @[34rem]:gap-x-4">
            <LargePage key={cardKey(large)} page={large} onOpen={() => openPage?.({ manualId: large.manualId, page: large.page, title: large.title })} />
            <OtherPages pages={otherPages(answer, large)} onPick={(page) => setChosen({ manualId: page.manualId, page: page.page })} />
            {carded && (
              <PageCard
                state={state}
                page={large}
                onRead={(torque) => openPage?.({ manualId: large.manualId, page: large.page, title: large.title, ...(torque ? { focus: "torque" as const } : {}) })}
                className="@[34rem]:col-start-2 @[34rem]:row-span-2 @[34rem]:row-start-1"
              />
            )}
          </div>
          {answer.noManual && <p className="text-xs text-ink-muted">This unit&apos;s manuals aren&apos;t in the library: these are pages its causes cite.</p>}
        </div>
      )}
    </section>
  );
}

// No page is about the part: the pages that name it, said so, and the
// Library's search for it.
function MentionsOnly({ part }: { part: string }) {
  return (
    <div data-part-mentions className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="min-w-0 flex-1 text-sm leading-6 text-ink">
        Nothing in this unit&apos;s manuals is about the {part.toLowerCase()}. These pages name it:
      </p>
      <Link
        href={partLibraryHref(part)}
        data-part-library
        className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        <SearchIcon />
        <span className="truncate">Search the Library</span>
      </Link>
    </div>
  );
}

// No page to show: no manual for the unit, or none that shows the part.
// The Library can still be searched for it.
function NoPage({ part, noManual }: { part: string; noManual: boolean }) {
  return (
    <div data-part-no-page className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <p className="text-sm leading-6 text-ink">
        {noManual ? `No manual for this unit is in the library, so there's no page for the ${part.toLowerCase()}.` : `Nothing in this unit's manuals shows the ${part.toLowerCase()}.`}
      </p>
      <Link
        href={partLibraryHref(part)}
        data-part-library
        className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg border border-glow/40 bg-glow/10 px-3 text-sm font-medium text-glow hover:bg-glow/15 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        <SearchIcon />
        <span className="truncate">Search the Library for {part.toLowerCase()}</span>
      </Link>
    </div>
  );
}

// The part's page, large: a tap opens it full screen to zoom into. A page
// wider than it's tall (a wiring diagram turned on its side) gets a box its
// own shape once it's drawn, not a strip at the top of a tall one.
function LargePage({ page, onOpen }: { page: PartPage; onOpen: () => void }) {
  const { element, url, failed, retry } = usePagePicture(page.manualId, page.page, LARGE_WIDTH);
  const [wide, setWide] = useState<string | null>(null);
  return (
    <figure className="mx-auto w-full max-w-[20rem] space-y-1 @[34rem]:max-w-none">
      <button
        ref={element}
        type="button"
        data-part-page={`${page.manualId}:${page.page}`}
        data-ready={url ? "true" : "false"}
        aria-label={failed ? `Page ${page.page} couldn't be drawn. Try again.` : `Page ${page.page} of ${page.title}. Open it full screen to zoom in.`}
        onClick={() => (failed ? retry() : onOpen())}
        style={wide ? { aspectRatio: wide } : undefined}
        className="relative block aspect-[17/22] w-full overflow-hidden rounded-lg border border-white/15 bg-white/[0.06] transition hover:border-white/40 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        {url ? (
          // A picture drawn here from the shop's own manual (no image file to optimise).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt=""
            onLoad={(event) => {
              const { naturalWidth: w, naturalHeight: h } = event.currentTarget;
              if (w > h) setWide(`${w} / ${h}`);
            }}
            className="size-full bg-white object-contain object-top"
          />
        ) : failed ? (
          <span className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-trail">This page couldn&apos;t be drawn. Tap to try again.</span>
        ) : (
          // A still placeholder: lines of a page, while it's drawn.
          <span aria-hidden className="absolute inset-x-5 top-6 space-y-3">
            {[90, 70, 80, 55, 75, 60].map((w) => (
              <span key={w} className="block h-1.5 rounded-full bg-white/10" style={{ width: `${w}%` }} />
            ))}
          </span>
        )}
        {url && (
          <span aria-hidden className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-md bg-charcoal-900/85 px-2 py-1 text-xs font-medium text-ink">
            <ZoomInIcon className="size-3.5" />
            Zoom
          </span>
        )}
      </button>
      <figcaption className="flex items-center justify-between gap-3">
        <span className="text-xs text-ink-muted tabular-nums">p.{page.page}</span>
        <Link
          href={`/library/${page.manualId}?page=${page.page}`}
          data-part-open-in-manual
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
        >
          <BookIcon />
          Open in manual
        </Link>
      </figcaption>
    </figure>
  );
}

// Very wide or tall drawings get a box within these shapes (the drawing
// fits inside it), so none is a sliver; the large one is as wide as the
// sheet unless that would make it taller than this, then centred.
const shapeOf = (aspect: number) => Math.min(2.4, Math.max(0.6, aspect || 1));
const DRAWING_HEIGHT = "min(34rem, 62vh)";
const EXAMINE_DRAWING_HEIGHT = "min(28rem, 44vh)";

// The part's drawings: one large, across the sheet (a tap opens its page
// full screen, zoomed to it), the others in a strip under it (a tap shows
// that one large). More found while they're shown join the strip.
function Drawings({ drawings, height, onOpen }: { drawings: PartDrawing[]; height: string; onOpen: (drawing: PartDrawing) => void }) {
  const [shown, setShown] = useState<string | null>(null);
  const index = Math.max(0, drawings.findIndex((drawing) => drawingKey(drawing) === shown));
  const large = drawings[index];
  // As wide as the sheet, or as the large one is at its tallest (centred,
  // with its strip under it).
  return (
    <div data-part-drawings className="mx-auto space-y-2" style={{ maxWidth: `min(100%, calc(${height} * ${shapeOf(large.aspect)}))` }}>
      <LargeDrawing key={drawingKey(large)} drawing={large} place={drawings.length > 1 ? `${index + 1} of ${drawings.length}` : null} onOpen={() => onOpen(large)} />
      {drawings.length > 1 && (
        <ul aria-label="Other drawings" className="flex gap-2 overflow-x-auto pb-1">
          {drawings.map((drawing, i) =>
            i === index ? null : (
              <li key={drawingKey(drawing)} className="shrink-0">
                <DrawingThumb drawing={drawing} onPick={() => setShown(drawingKey(drawing))} />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

// The large drawing, with Zoom under it rather than on it (an exploded
// view's callout numbers reach its corners).
function LargeDrawing({ drawing, place, onOpen }: { drawing: PartDrawing; place: string | null; onOpen: () => void }) {
  const { element, url, failed, retry } = usePagePicture(drawing.manualId, drawing.page, "fit", drawing.area);
  const label = drawingLabel(drawing);
  const shape = shapeOf(drawing.aspect);
  return (
    <figure className="space-y-1">
      <button
        ref={element}
        type="button"
        data-drawing={`${drawing.manualId}:${drawing.page}`}
        data-drawing-area={drawing.area ? areaParam(drawing.area) : "page"}
        data-drawing-kind={drawing.kind}
        data-ready={url ? "true" : "false"}
        aria-label={failed ? `The drawing from page ${drawing.page} couldn't be drawn. Try again.` : `${label} from page ${drawing.page} of ${drawing.title}. Open it full screen to zoom in.`}
        onClick={() => (failed ? retry() : onOpen())}
        style={{ aspectRatio: String(shape) }}
        className="relative block w-full overflow-hidden rounded-lg border border-white/15 bg-white/[0.06] transition hover:border-white/40 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        {url ? (
          // A drawing cropped here from the shop's own manual (no image file to optimise).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="size-full bg-white object-contain" />
        ) : failed ? (
          <span className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-trail">This drawing couldn&apos;t be drawn. Tap to try again.</span>
        ) : null}
      </button>
      <figcaption className="flex items-center gap-3 text-xs text-ink-muted">
        <span data-drawing-caption className="min-w-0 flex-1 truncate">
          {label} · p.{drawing.page}
        </span>
        {place && <span className="shrink-0 tabular-nums">{place}</span>}
        <button
          type="button"
          data-drawing-zoom
          aria-label={`Zoom into the ${label.toLowerCase()} from page ${drawing.page}`}
          onClick={onOpen}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
        >
          <ZoomInIcon className="size-4" />
          Zoom
        </button>
      </figcaption>
    </figure>
  );
}

function DrawingThumb({ drawing, onPick }: { drawing: PartDrawing; onPick: () => void }) {
  const width = Math.round(Math.min(STRIP_WIDTHS[1], Math.max(STRIP_WIDTHS[0], STRIP_HEIGHT * drawing.aspect)));
  const { element, url, failed, retry } = usePagePicture(drawing.manualId, drawing.page, width, drawing.area);
  return (
    <figure className="space-y-1" style={{ width }}>
      <button
        ref={element}
        type="button"
        data-drawing-thumb={`${drawing.manualId}:${drawing.page}`}
        data-drawing-area={drawing.area ? areaParam(drawing.area) : "page"}
        data-ready={url ? "true" : "false"}
        aria-label={`Show the ${drawingLabel(drawing).toLowerCase()} from page ${drawing.page} large`}
        title={`${drawing.title}, page ${drawing.page}`}
        onClick={() => (failed ? retry() : onPick())}
        style={{ height: STRIP_HEIGHT }}
        className="relative block w-full overflow-hidden rounded-md border border-white/15 bg-white/[0.06] transition hover:border-white/40 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="size-full bg-white object-contain" />
        ) : failed ? (
          <span className="absolute inset-0 grid place-items-center p-1 text-center text-[10px] leading-tight text-trail">Tap to retry</span>
        ) : null}
      </button>
      <figcaption className="text-center text-[11px] text-ink-muted tabular-nums">p.{drawing.page}</figcaption>
    </figure>
  );
}

// What the page says, as read once and checked against its text; while
// it's read, a line saying so (the page is already there to look at).
// onRead opens the page full screen, at its torque specs when it has them.
function PageCard({ state, page, onRead, className = "" }: { state: FactsState | null; page: PartPage; onRead: (torque: boolean) => void; className?: string }) {
  const status = state === null || state.status === "unread" ? "reading" : state.status;
  return (
    <section
      aria-label="What the page says"
      aria-busy={status === "reading"}
      data-page-facts={`${page.manualId}:${page.page}`}
      data-state={status}
      className={`min-w-0 space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-3 ${className}`}
    >
      {/* Said to a screen reader as it changes (the lines below come and go). */}
      <p role="status" className="sr-only">
        {status === "reading" ? `Reading page ${page.page}.` : status === "ready" ? `What page ${page.page} says is here.` : ""}
      </p>
      {state?.status === "ready" ? (
        <Facts facts={state.facts} onRead={() => onRead(state.facts.torqueOnPage)} />
      ) : status === "reading" ? (
        <p data-facts-loading className="text-sm text-ink-muted">
          Reading this page…
        </p>
      ) : status === "empty" ? (
        <p className="text-sm text-ink-muted">Nothing to list from this page: it&apos;s all in the page itself.</p>
      ) : (
        <p data-facts-unread className="text-sm text-ink-muted">
          Couldn&apos;t read this page&apos;s details.
        </p>
      )}
      <p data-facts-page className="flex items-start gap-1.5 text-xs leading-5 text-ink-muted">
        <BookIcon className="mt-0.5 size-3" />
        <span className="min-w-0 break-words">
          From page {page.page} of {page.title}
        </span>
      </p>
    </section>
  );
}

const sectionLabel = "text-xs font-semibold text-ink-muted";

// The title, the line saying the page has its steps, torque specs and
// cautions (in the teal of a MANUAL spec: read on the page itself, opened
// full screen, never put here in other words), and the special tools as
// the page prints them.
function Facts({ facts, onRead }: { facts: PageFacts; onRead: () => void }) {
  return (
    <>
      {facts.title && (
        <h4 data-facts-title className="text-sm leading-5 font-semibold break-words text-ink">
          {facts.title}
        </h4>
      )}
      {facts.readOnPage && (
        <div data-facts-on-page className="flex flex-wrap items-center justify-between gap-x-3 rounded-md border border-glow/45 bg-glow/10 py-0.5 pr-1 pl-3">
          <p className="py-2 text-sm leading-5 font-medium text-glow">Steps, torque specs and cautions are on this page</p>
          <button
            type="button"
            data-facts-on-page-open
            onClick={onRead}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
          >
            <ZoomInIcon className="size-4" />
            Read them on the page
          </button>
        </div>
      )}
      {facts.tools.length > 0 && (
        <div data-facts-tools className="space-y-1">
          <p className={sectionLabel}>Special tools</p>
          <ul className="space-y-1 text-sm leading-5 text-ink">
            {facts.tools.map((tool, index) => (
              <li key={index} className="flex gap-2">
                <WrenchIcon className="mt-0.5 size-4 text-ink-muted" />
                <span className="min-w-0 break-words">{tool}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// The part's other pages, small: a tap draws that one large instead.
function OtherPages({ pages, onPick }: { pages: PartPage[]; onPick: (page: PartPage) => void }) {
  if (pages.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className={sectionLabel}>Other pages</p>
      <ul aria-label="Other pages" className="flex flex-wrap gap-2">
        {pages.map((page) => (
          <li key={cardKey(page)}>
            <OtherPage page={page} onPick={onPick} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function OtherPage({ page, onPick }: { page: PartPage; onPick: (page: PartPage) => void }) {
  const { element, url, failed, retry } = usePagePicture(page.manualId, page.page, SMALL_WIDTH);
  return (
    <figure className="w-[60px] space-y-1">
      <button
        ref={element}
        type="button"
        data-other-page={`${page.manualId}:${page.page}`}
        data-ready={url ? "true" : "false"}
        aria-label={`Show page ${page.page} of ${page.title} large`}
        title={`${page.title}, page ${page.page}`}
        onClick={() => (failed ? retry() : onPick(page))}
        className="relative block aspect-[17/22] w-full overflow-hidden rounded-md border border-white/15 bg-white/[0.06] transition hover:border-white/40 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="size-full bg-white object-cover object-top" />
        ) : failed ? (
          <span className="absolute inset-0 grid place-items-center p-1 text-center text-[10px] leading-tight text-trail">Tap to retry</span>
        ) : (
          <span aria-hidden className="absolute inset-x-2 top-2.5 space-y-1.5">
            {[90, 70, 80, 55].map((w) => (
              <span key={w} className="block h-1 rounded-full bg-white/10" style={{ width: `${w}%` }} />
            ))}
          </span>
        )}
      </button>
      <figcaption className="text-center text-[11px] text-ink-muted tabular-nums">p.{page.page}</figcaption>
    </figure>
  );
}
