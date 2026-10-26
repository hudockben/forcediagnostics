"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { specText } from "@/lib/diagnose-cause-steps";
import { cardOf, cardSettled, largePage, otherPages, partLibraryHref, type PartPage, type PartSheet } from "@/lib/diagnose-parts";
import { SYSTEM_LABELS, type DrawnSystem } from "@/lib/diagnose-zones";
import type { FactsState, PageFacts, PageRef } from "@/lib/manual-facts-rules";

import { BookIcon, SearchIcon, WarningIcon, WrenchIcon, ZoomInIcon } from "./icons";
import { usePagePicture, usePageView } from "./manual-pictures";

// From the manual, at the top of a system's sheet: the system's parts to
// pick from (those its causes name first), the picked part's best manual
// page drawn large (a tap opens it full screen to zoom into; Open in manual
// goes to the viewer at it), a few other pages that show it, and beside the
// page (under it on a phone) what it says: the procedure's steps, its
// torque specs (from the shop's own manual, so in the manual's teal), the
// special tools and cautions, and which page that is. The server finds the
// pages and reads each page once, the first time anyone in the shop opens
// it (src/app/api/diagnose/part-sheet/route.ts): the page shows while it's
// read, and on its own when it can't be.

type Asked = { conversationId: string; system: DrawnSystem; part?: string; page?: PageRef };
type Answer = PartSheet | { error: string };

const NOT_THROUGH = "That didn't go through. Check the connection and try again.";
const UNREADABLE: FactsState = { status: "unavailable", reason: "error" };
// Another device is reading the page: ask again after this long, this many
// times (a reading takes a few seconds).
const READ_AGAIN_MS = 1500;
const MAX_WAITS = 10;
// The large page's picture, in CSS pixels (drawn sharp for the screen).
const LARGE_WIDTH = 360;
const SMALL_WIDTH = 60;

async function ask(input: Asked): Promise<Answer> {
  try {
    const response = await fetch("/api/diagnose/part-sheet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as (PartSheet & { error?: string; redirectTo?: string }) | null;
    if (data?.redirectTo) window.location.assign(data.redirectTo);
    if (!response.ok || !data || typeof data.error === "string") return { error: data?.error ?? NOT_THROUGH };
    return data;
  } catch {
    // Offline, or the server went away.
    return { error: NOT_THROUGH };
  }
}

// Asked already on this visit: each part's sheet for the reply on screen,
// and each page's card once it's settled, so going back to a part or a
// page asks nothing again, and a page that couldn't be read isn't asked
// about again until the page is loaded again.
const sheets = new Map<string, PartSheet>();
const cards = new Map<string, FactsState>();
const KEPT = 60;
function keep<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);
  map.set(key, value);
  while (map.size > KEPT) map.delete(map.keys().next().value!);
}
const cardKey = (page: PageRef) => `${page.manualId.toLowerCase()}:${page.page}`;

async function loadSheet(input: Asked, version: string): Promise<Answer> {
  const key = (part: string) => `${input.conversationId}|${version}|${input.system}|${part.toLowerCase()}`;
  const known = sheets.get(key(input.part ?? ""));
  if (known) return known;
  const answer = await ask(input);
  if (!("error" in answer)) {
    keep(sheets, key(input.part ?? ""), answer);
    // The first part's sheet is also that part's when it's picked.
    if (!input.part) keep(sheets, key(answer.part), answer);
  }
  return answer;
}

// A page's card: read now if no one has (a few seconds, once).
async function loadCard(input: Asked & { page: PageRef }): Promise<FactsState> {
  const known = cards.get(cardKey(input.page));
  if (known) return known;
  const answer = await ask(input);
  const state = "error" in answer ? null : cardOf(answer, input.page);
  if (!state) return UNREADABLE;
  if (cardSettled(state)) keep(cards, cardKey(input.page), state);
  return state;
}

const chipClass =
  "relative inline-flex h-9 max-w-full items-center rounded-full border px-3 text-[13px] font-medium transition before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

export function PartSheetSection({ conversationId, system, version }: { conversationId: string; system: DrawnSystem; version: string | null }) {
  const openPage = usePageView();
  // The part picked (null: the first, as the server orders them), and a
  // page picked among its others (null: its best).
  const [picked, setPicked] = useState<string | null>(null);
  const [chosen, setChosen] = useState<PageRef | null>(null);
  const [tries, setTries] = useState(0);

  const sheetKey = `${version ?? ""}|${picked ?? ""}|${tries}`;
  const [loaded, setLoaded] = useState<{ key: string; answer: Answer } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadSheet({ conversationId, system, ...(picked ? { part: picked } : {}) }, version ?? "").then((answer) => {
      if (!cancelled) setLoaded({ key: sheetKey, answer });
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, system, picked, version, sheetKey]);

  const answer = loaded?.key === sheetKey ? loaded.answer : null;
  const sheet = answer && !("error" in answer) ? answer : null;
  // The chips stay put while another part's sheet comes.
  const last = loaded && !("error" in loaded.answer) ? loaded.answer : null;
  const parts = (sheet ?? last)?.parts ?? [];
  const part = picked ?? sheet?.part ?? last?.part ?? null;
  const large = sheet ? largePage(sheet, chosen) : null;
  const given = sheet && large ? cardOf(sheet, large) : null;

  // The large page's card: as the sheet brought it when that's settled,
  // else asked for (and read, the first time anyone opens the page).
  const largeKey = large ? `${sheetKey}|${cardKey(large)}` : "";
  const [card, setCard] = useState<{ key: string; state: FactsState } | null>(null);
  useEffect(() => {
    if (!sheet || !large) return;
    const page = { manualId: large.manualId, page: large.page };
    if (given && cardSettled(given) && !cards.has(cardKey(page))) {
      keep(cards, cardKey(page), given);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waits = 0;
    const run = () =>
      void loadCard({ conversationId, system, part: sheet.part, page }).then((state) => {
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
  }, [conversationId, system, sheet, large, given, largeKey]);
  const state = card?.key === largeKey ? card.state : given && cardSettled(given) ? given : null;

  function pick(name: string) {
    if (part !== null && name.toLowerCase() === part.toLowerCase()) return;
    setPicked(name);
    setChosen(null);
  }

  const label = SYSTEM_LABELS[system];
  return (
    <section aria-label="From the manual" data-part-sheet={system} data-part={part ?? undefined} className="@container space-y-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-ink-muted uppercase">
        <BookIcon className="size-3.5" />
        From the manual
      </h3>
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
        <p data-part-loading className="text-sm text-ink-muted">
          {part ? `Finding the ${part.toLowerCase()} in the manuals…` : `Finding the ${label.toLowerCase()} parts…`}
        </p>
      ) : "error" in answer ? (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
        <NoPage part={answer.part} noManual={answer.noManual} />
      ) : (
        <>
          {/* The page and what it says side by side where the sheet has
              room (a wide screen, a portrait tablet), the other pages under
              the page; on a phone the page, what it says, then the others. */}
          <div className="grid gap-3 @[34rem]:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] @[34rem]:grid-rows-[auto_1fr] @[34rem]:items-start @[34rem]:gap-x-4 @[52rem]:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
            <LargePage key={cardKey(large)} page={large} onOpen={() => openPage?.({ manualId: large.manualId, page: large.page, title: large.title })} />
            <PageCard state={state} page={large} className="@[34rem]:col-start-2 @[34rem]:row-span-2 @[34rem]:row-start-1" />
            <OtherPages pages={otherPages(answer, large)} onPick={(page) => setChosen({ manualId: page.manualId, page: page.page })} />
          </div>
          {answer.noManual && <p className="text-xs text-ink-muted">This unit&apos;s manuals aren&apos;t in the library: these are pages its causes cite.</p>}
        </>
      )}
    </section>
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

// The part's page, large: a tap opens it full screen to zoom into.
function LargePage({ page, onOpen }: { page: PartPage; onOpen: () => void }) {
  const { element, url, failed, retry } = usePagePicture(page.manualId, page.page, LARGE_WIDTH);
  return (
    <figure className="mx-auto w-full max-w-[20rem] space-y-1 @[34rem]:max-w-none">
      <button
        ref={element}
        type="button"
        data-part-page={`${page.manualId}:${page.page}`}
        data-ready={url ? "true" : "false"}
        aria-label={failed ? `Page ${page.page} couldn't be drawn. Try again.` : `Page ${page.page} of ${page.title}. Open it full screen to zoom in.`}
        onClick={() => (failed ? retry() : onOpen())}
        className="relative block aspect-[17/22] w-full overflow-hidden rounded-lg border border-white/15 bg-white/[0.06] transition hover:border-white/40 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        {url ? (
          // A picture drawn here from the shop's own manual (no image file to optimise).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="size-full bg-white object-contain object-top" />
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

// What the page says, as read once and checked against its text; while
// it's read, a line saying so (the page is already there to look at).
function PageCard({ state, page, className = "" }: { state: FactsState | null; page: PartPage; className?: string }) {
  const status = state === null || state.status === "unread" ? "reading" : state.status;
  return (
    <section
      aria-label="What the page says"
      aria-busy={status === "reading"}
      data-page-facts={`${page.manualId}:${page.page}`}
      data-state={status}
      className={`min-w-0 space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-3 ${className}`}
    >
      {state?.status === "ready" ? (
        <Facts facts={state.facts} />
      ) : status === "reading" ? (
        <p data-facts-loading className="text-sm text-ink-muted">
          Reading this page for its steps and specs…
        </p>
      ) : status === "empty" ? (
        <p className="text-sm text-ink-muted">No steps or specs to list from this page: it&apos;s all in the page itself.</p>
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

function Facts({ facts }: { facts: PageFacts }) {
  return (
    <>
      {facts.title && (
        <h4 data-facts-title className="text-sm leading-5 font-semibold break-words text-ink">
          {facts.title}
        </h4>
      )}
      {/* Cautions first, as the Safety card comes before the causes. */}
      {facts.cautions.length > 0 && (
        <ul data-facts-cautions aria-label="Cautions" className="space-y-1.5 rounded-md border border-trail/40 bg-trail/10 px-3 py-2 text-sm leading-5 text-trail">
          {facts.cautions.map((caution, index) => (
            <li key={index} className="flex gap-2">
              <WarningIcon className="mt-0.5 size-4" />
              <span className="min-w-0 break-words">{caution}</span>
            </li>
          ))}
        </ul>
      )}
      {facts.steps.length > 0 && (
        <ol data-facts-steps aria-label="Steps" className="space-y-1.5 text-sm leading-5 text-ink">
          {facts.steps.map((step, index) => (
            <li key={index} data-fact-step={step.n} className="flex gap-2">
              <span aria-hidden className="w-6 shrink-0 text-right font-mono text-glow/80 tabular-nums">
                {step.n}.
              </span>
              <span className="min-w-0 break-words">{step.text}</span>
            </li>
          ))}
        </ol>
      )}
      {facts.torques.length > 0 && (
        // The manual's own specs: the teal of a MANUAL spec.
        <div data-facts-torques className="rounded-md border border-glow/45 bg-glow/10 px-3 py-2">
          <p className="text-[10px] font-semibold tracking-wide text-glow/70 uppercase">Torque · from the manual</p>
          {/* The item on the left (wrapping), its value on the right. */}
          <dl className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5">
            {facts.torques.map((torque, index) => (
              <div key={index} data-fact-torque className="contents">
                <dt className="min-w-0 text-sm leading-5 break-words text-ink">{torque.item}</dt>
                <dd className="text-right font-mono text-sm leading-5 font-semibold text-glow tabular-nums">{specText(torque.value)}</dd>
              </div>
            ))}
          </dl>
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
      {facts.notes.length > 0 && (
        <ul data-facts-notes aria-label="Notes" className="space-y-1 text-xs leading-5 text-ink-muted">
          {facts.notes.map((note, index) => (
            <li key={index} className="break-words">
              {note}
            </li>
          ))}
        </ul>
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
