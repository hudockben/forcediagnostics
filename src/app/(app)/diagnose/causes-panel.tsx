"use client";

import Link from "next/link";
import { Fragment, useId, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";

import { causeSteps, howToCheckQuestion, specText, type CauseStep } from "@/lib/diagnose-cause-steps";
import { SOURCE_LEVEL_LABELS, evidenceParts, sourceLevel } from "@/lib/diagnose-evidence";
import {
  EFFORT_LABELS,
  STEP_RESULTS,
  checkGroups,
  type Cause,
  type CauseVerdict,
  type Check,
  type ConversationView,
  type DiagnosisReply,
  type Effort,
  type FeedbackEntry,
  type SourceView,
  type StepResult,
  type UnitSuggestion,
} from "@/lib/diagnose-rules";
import { markHint, nextStep, stepKey, stepStateOf, stepStates, type MarkHint, type StepState } from "@/lib/diagnose-step-checks";
import {
  SYSTEM_LABELS,
  VEHICLE_DRAWING_NAMES,
  causeSystem,
  shownStatus,
  zoneStates,
  type CauseState,
  type CauseSystem,
  type DrawnSystem,
  type UnitVehicle,
} from "@/lib/diagnose-zones";
import type { ViewMode } from "@/lib/unit-3d/look";
import type { UnitSpec } from "@/lib/unit-vehicle";
import { drawingFor } from "@/lib/unit-graphic/drawing";
import { checkVin, vinDisagreement } from "@/lib/vin";

import { changeUnitAction, markCauseAction, markStepAction } from "./actions";
import { ManualPictures, PageThumbs, manualPages } from "./manual-pictures";
import {
  BookIcon,
  BulbIcon,
  CausesIcon,
  CheckIcon,
  ChecksIcon,
  ChevronIcon,
  CrossIcon,
  GlobeIcon,
  MeterIcon,
  QuickIcon,
  UnitIcon,
  WarningIcon,
  WrenchIcon,
} from "./icons";
import { overlayRoot, useMounted } from "./overlays";
import { PartSheetSection } from "./part-sheet";
import { SheetView, Unit3D, UnitHeader, UnitKey, isDrawnSystem, unitName } from "./unit-3d";
import { UnitGraphic } from "./unit-graphic";
import { UnitPicker } from "./unit-picker";
import { useHistoryParam } from "./use-history-param";

// The diagnosis at a glance, beside the chat (or on its own tab on a
// tablet): the unit drawing with its suspect systems lit, safety notes,
// Claude's likely causes (each with its confidence and what that rests on),
// each with the checks that confirm or rule it out (with their specs and
// where those come from, each ticked off as the tech does it, with what it
// found) and the tech's "Ruled out" / "This was it", and the unit and
// manuals in use.

// --- Pieces ----------------------------------------------------------------------

export function Section({
  id,
  label,
  icon,
  count,
  aside,
  children,
  className = "",
}: {
  id?: string;
  label: string;
  icon: ReactNode;
  count?: number | string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-label={label} className={`rounded-xl border border-white/10 bg-charcoal-900/70 ${className}`}>
      <h2 className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5 text-[15px] leading-5 font-semibold text-ink">
        <span className="text-ink-muted">{icon}</span>
        <span className="whitespace-nowrap">{label}</span>
        {aside}
        {count !== undefined && (
          <span className="ml-auto shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-xs font-medium text-ink-muted tabular-nums">
            {count}
          </span>
        )}
      </h2>
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

// Chips are 36px to look at and 44px to tap (gloves): the ::before reaches
// 4px above and below, which the 8px between rows of chips leaves free.
const tapTaller = "relative before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']";
const chipBase = `inline-flex h-9 max-w-full items-center gap-1.5 rounded-full border px-3 text-xs font-medium ${tapTaller}`;
const sourceLinkClass = `${chipBase} transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none`;

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function SourceChips({ sources, className = "" }: { sources: SourceView[]; className?: string }) {
  if (sources.length === 0) return null;
  return (
    <ul className={`flex max-w-full flex-wrap gap-2 ${className}`} aria-label="Sources">
      {sources.map((source) => (
        <li key={source.type === "manual" ? `${source.manualId}:${source.page}` : source.type === "web" ? source.url : "general"} className="max-w-full">
          {source.type === "manual" ? (
            <Link
              href={`/library/${source.manualId}?page=${source.page}`}
              title={source.title}
              aria-label={`Manual page ${source.page}: ${source.title}`}
              data-source="manual"
              className={`${sourceLinkClass} border-glow/35 text-glow hover:bg-glow/10`}
            >
              <BookIcon className="size-3.5" />
              p.{source.page}
            </Link>
          ) : source.type === "web" ? (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              title={source.title}
              aria-label={`Web: ${source.title} (${hostOf(source.url)})`}
              data-source="web"
              className={`${sourceLinkClass} border-white/15 text-ink hover:border-white/30`}
            >
              <GlobeIcon className="size-3.5" />
              <span className="truncate">{hostOf(source.url)}</span>
            </a>
          ) : (
            <span data-source="general" title="General knowledge" className={`${chipBase} border-white/10 text-ink-muted`}>
              <BulbIcon className="size-3.5" />
              General<span className="sr-only"> knowledge</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const METER: Record<Cause["likelihood"], { lit: number; color: string }> = {
  high: { lit: 3, color: "bg-suspect" },
  medium: { lit: 2, color: "bg-[#ff8a4c]" },
  low: { lit: 1, color: "bg-ink-muted" },
};

// Likelihood as a three-segment heat bar on the title's first line, and
// while the cause is open, Claude's confidence right after it (the bar is
// set from it, so the two agree). The % has a fixed width, so the bars line
// up down the list; it's muted once another cause was it (set aside, as on
// the drawing). A reply saved before causes carried a confidence has the
// bar alone.
function LikelihoodMeter({ likelihood, confidence, setAside = false }: { likelihood: Cause["likelihood"]; confidence?: number; setAside?: boolean }) {
  const { lit, color } = METER[likelihood];
  return (
    <span className="flex h-6 shrink-0 items-center gap-1.5">
      <span role="img" aria-label={`Likelihood: ${likelihood}`} title={`Likelihood: ${likelihood}`} data-likelihood={likelihood} className="flex gap-0.5">
        {[1, 2, 3].map((segment) => (
          <span key={segment} className={`h-2 w-3.5 rounded-[2px] ${segment <= lit ? color : "bg-white/10"}`} />
        ))}
      </span>
      {confidence !== undefined && (
        <span
          data-confidence={confidence}
          data-set-aside={setAside || undefined}
          title={`Claude's confidence: ${confidence}%${setAside ? " (set aside: another cause was it)" : ""}`}
          className={`w-8 text-right text-xs leading-none font-semibold tabular-nums ${setAside ? "text-ink-muted" : "text-ink/90"}`}
        >
          {confidence}%<span className="sr-only"> confidence</span>
        </span>
      )}
    </span>
  );
}

// Open is the default, so it has no chip.
const STATUS_CHIP: Record<Exclude<CauseState, "open">, { label: string; icon: ReactNode; className: string }> = {
  confirmed: { label: "Confirmed", icon: <CheckIcon className="size-3.5" />, className: "border-suspect/50 bg-suspect/15 text-[#ffb3b6]" },
  ruled_out: { label: "Ruled out", icon: <CrossIcon className="size-3.5" />, className: "border-white/10 text-ink-muted" },
};

function StatusChip({ status }: { status: CauseState }) {
  if (status === "open") return null;
  const chip = STATUS_CHIP[status];
  return (
    <span data-status-chip={status} className={`inline-flex h-9 items-center gap-1 rounded-full border px-3 text-xs font-medium ${chip.className}`}>
      {chip.icon}
      {chip.label}
    </span>
  );
}

const EFFORT_ICONS: Record<Effort, (props: { className?: string }) => ReactNode> = {
  quick: QuickIcon,
  test: MeterIcon,
  teardown: WrenchIcon,
};

// How much work it is to confirm or rule a cause out, so the cheap suspects
// stand out: quiet words at the start of its why line, not a chip (chips
// here are buttons and links). Only on open causes: one that's confirmed or
// ruled out has been. Replies saved before causes carried it have none.
function EffortLead({ effort }: { effort: Effort }) {
  const Icon = EFFORT_ICONS[effort];
  return (
    <span
      data-effort={effort}
      title={`To confirm or rule out: ${EFFORT_LABELS[effort].heading.toLowerCase()} (${EFFORT_LABELS[effort].detail})`}
      className={`font-medium ${effort === "quick" ? "text-ink/90" : "text-ink/75"}`}
    >
      <Icon className="mr-1 inline size-3.5 align-[-2px]" />
      {EFFORT_LABELS[effort].cause}
      <span aria-hidden> · </span>
    </span>
  );
}

// The tech's latest press on a cause (matched by title, which carries over
// between Claude's replies), if any.
function verdictFor(feedback: FeedbackEntry[], title: string): CauseVerdict | null {
  const entry = feedback.findLast((item) => item.title.toLowerCase() === title.toLowerCase());
  return entry && entry.verdict !== "open" ? entry.verdict : null;
}

const markClass =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";

// What a cause's steps suggest, as a small tag on the button's top edge
// (over the gap above the row, so it moves nothing), and for screen readers.
const HINTS: Record<Exclude<MarkHint, null>, { tag: string; detail: string }> = {
  ruled_out: { tag: "All steps OK", detail: "Every step came out OK" },
  confirmed: { tag: "Problem found", detail: "A step found a problem" },
};

function MarkButton({
  mark,
  verdict,
  pending,
  hint = null,
  onMark,
}: {
  mark: "ruled_out" | "confirmed";
  verdict: CauseVerdict | null;
  pending: boolean;
  // This button is what the cause's steps suggest (never pressed for the
  // tech).
  hint?: MarkHint;
  onMark: (verdict: CauseVerdict, viaKeyboard: boolean) => void;
}) {
  const hintId = useId();
  const pressed = verdict === mark;
  const suggested = hint === mark && !pressed;
  const style =
    mark === "ruled_out"
      ? pressed
        ? "border-ink-muted/70 bg-white/10 text-ink"
        : suggested
          ? "border-white/45 text-ink hover:bg-white/[0.06]"
          : "border-white/15 text-ink-muted hover:text-ink"
      : pressed
        ? "border-suspect/70 bg-suspect/20 text-[#ffd0d2]"
        : suggested
          ? "border-glow/70 bg-glow/10 text-glow hover:bg-glow/15"
          : "border-glow/30 text-glow hover:bg-glow/10";
  return (
    <>
      <button
        type="button"
        data-mark={mark}
        data-suggested={suggested || undefined}
        aria-pressed={pressed}
        aria-describedby={suggested ? hintId : undefined}
        disabled={pending}
        onClick={(event) => onMark(pressed ? "open" : mark, event.detail === 0)}
        className={`${markClass} relative ${style}`}
      >
        {mark === "ruled_out" ? <CrossIcon /> : <CheckIcon />}
        {mark === "ruled_out" ? "Ruled out" : "This was it"}
        {suggested && (
          <span
            aria-hidden
            data-mark-hint={mark}
            className={`pointer-events-none absolute -top-2 left-2 rounded border bg-charcoal-800 px-1 text-[11px] leading-[14px] font-medium whitespace-nowrap ${
              mark === "ruled_out" ? "border-white/25 text-ink" : "border-trail/60 text-trail"
            }`}
          >
            {HINTS[mark].tag}
          </span>
        )}
      </button>
      {suggested && (
        <span id={hintId} className="sr-only">
          {HINTS[mark].detail}
        </span>
      )}
    </>
  );
}

// Why Claude thinks so: one line, tap for the rest; led by how much work
// it is to rule in or out, when there's that to say.
function WhyLine({ text, lead }: { text: string; lead?: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!text) return lead ? <p className="text-sm leading-6 text-ink-muted">{lead}</p> : null;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className="-my-2.5 flex min-h-11 w-full items-start gap-1 rounded py-2.5 text-left text-sm leading-6 text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
    >
      <span className={`min-w-0 flex-1 break-words ${open ? "" : "line-clamp-1"}`}>
        {lead}
        {text}
      </span>
      <ChevronIcon className={`mt-1 size-4 transition ${open ? "rotate-180" : ""}`} />
    </button>
  );
}

function SystemChip({ system, active, onSelect }: { system: CauseSystem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-system-chip={system}
      aria-pressed={active}
      title="Show on the drawing"
      aria-label={`${SYSTEM_LABELS[system]}: show on the drawing`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none ${tapTaller} ${
        active ? "border-suspect/60 bg-suspect/15 text-[#ffd0d2]" : "border-white/10 text-ink-muted hover:border-white/25 hover:text-ink"
      }`}
    >
      <UnitIcon className="size-3.5" />
      {SYSTEM_LABELS[system]}
    </button>
  );
}

// --- Causes -------------------------------------------------------------------

type CauseRow = {
  cause: Cause;
  index: number;
  system: CauseSystem;
  status: CauseState;
  verdict: CauseVerdict | null;
  // Not in Claude's reply before this one.
  isNew: boolean;
};

const STATUS_ORDER: Record<CauseState, number> = { confirmed: 0, open: 1, ruled_out: 2 };

// A real mouse hovering: not a finger (a tap fires mouse events too, with
// no leave until the next tap elsewhere, and a scroll can bring the spot
// last tapped over another cause), so not on a touch screen at all.
function mouseHover(event: PointerEvent) {
  return event.pointerType === "mouse" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

// Focus that came from the keyboard (a tap on a button focuses it too, but
// that isn't the tech pointing at the cause).
function keyboardFocus(element: Element) {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function NewTag() {
  return (
    <span data-new title="New in Claude's latest reply" className="mt-1 shrink-0 rounded-full bg-glow/15 px-1.5 py-px text-[10px] font-semibold tracking-wider text-glow uppercase">
      New
    </span>
  );
}

function CauseItem({
  row,
  highlight,
  pending,
  onMark,
  onSelectZone,
  onHoverZone,
  steps,
  refs,
  ticks,
  setAside = false,
  onAsk,
  pictures = "inline",
}: {
  row: CauseRow;
  highlight: boolean;
  pending: boolean;
  onMark: (verdict: CauseVerdict, viaKeyboard: boolean) => void;
  onSelectZone: (system: CauseSystem) => void;
  onHoverZone: (system: CauseSystem | null) => void;
  // The checks that confirm or rule it out, quickest first, while it's
  // open (an empty list when Claude gave none yet); null for a reply whose
  // checks don't say which causes they're for, or a cause that's settled.
  steps: CauseStep<Check>[] | null;
  // The causes by their numbers, for a step that also checks others.
  refs: CauseRef[];
  // The tech's ticks on the steps; none without a reply to tick them on.
  ticks: Ticks | null;
  // Still open, but another cause was it: its % muted, as the drawing tones
  // it down (and its steps no longer point the way: ticks.guide).
  setAside?: boolean;
  // Puts "How do I check cause N, …?" in the message box (not while the
  // conversation is full).
  onAsk?: () => void;
  // The pictures of the pages it cites: in its row of buttons (the list),
  // or a gallery of large ones under it (the full-screen sheet).
  pictures?: "inline" | "large";
}) {
  const { cause, index, system, status, verdict, isNew } = row;
  const [expanded, setExpanded] = useState(false);
  // Hovering (a mouse, not a finger: a tap fires mouse events too, with no
  // leave until the next tap elsewhere) or tabbing to a cause lights its
  // system on the drawing.
  const common = {
    "data-cause": index,
    "data-zone": system,
    "data-status": status,
    "data-highlight": highlight,
    onPointerEnter: (event: PointerEvent) => {
      if (mouseHover(event)) onHoverZone(system);
    },
    onPointerLeave: (event: PointerEvent) => {
      if (mouseHover(event)) onHoverZone(null);
    },
    onFocus: (event: FocusEvent) => {
      if (keyboardFocus(event.target)) onHoverZone(system);
    },
    onBlur: () => onHoverZone(null),
  };
  const ring = highlight ? "ring-2 ring-suspect/60" : "";

  if (status === "ruled_out" && !expanded) {
    // A ruled-out cause: one dim line, tap the title for the rest. The
    // tech's own mark can be undone here; Claude's is just said.
    return (
      <li {...common} className={`rounded-lg border border-white/5 bg-forest-950/30 ${ring}`}>
        <div className="flex items-center gap-2 py-0.5 pr-1 pl-2">
          <span className="w-5 shrink-0 text-center font-mono text-xs text-ink-muted/70">{index + 1}</span>
          <button
            type="button"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
            className="min-h-11 min-w-0 flex-1 truncate rounded text-left text-sm text-ink-muted/80 line-through decoration-ink-muted/60 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
          >
            {cause.title}
          </button>
          {verdict === "ruled_out" ? (
            <>
              <span className="shrink-0 text-xs text-ink-muted">Ruled out</span>
              <button
                type="button"
                data-undo
                aria-label={`Undo ruled out: ${cause.title}`}
                disabled={pending}
                onClick={(event) => onMark("open", event.detail === 0)}
                className={`${markClass} shrink-0 border-white/15 px-3 text-ink-muted hover:text-ink`}
              >
                Undo
              </button>
            </>
          ) : (
            <span className="shrink-0 pr-2 text-xs text-ink-muted">Ruled out by Claude</span>
          )}
        </div>
      </li>
    );
  }

  const confirmed = status === "confirmed";
  // Claude's confidence and what it rests on, while the cause is open (a
  // confirmed one says so already, and a ruled-out one has been checked).
  const confidence = status === "open" && typeof cause.confidence === "number" ? cause.confidence : undefined;
  const evidence = confidence !== undefined ? evidenceParts(cause) : [];
  // What its steps suggest, by its buttons: every one OK, ruled out; a
  // problem found, this was it. Only a suggestion: the tech decides; and
  // none once another cause was it.
  const hint = status === "open" && steps && ticks?.guide ? markHint(steps.map((step) => ticks.stateOf(step.check))) : null;
  return (
    <li
      {...common}
      onClick={() => onSelectZone(system)}
      className={`rounded-lg border p-3 transition ${
        confirmed ? "border-suspect/60 bg-suspect/10" : "border-white/10 bg-forest-950/40"
      } ${status === "ruled_out" ? "opacity-75" : ""} ${ring}`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-md font-mono text-xs ${
            confirmed ? "bg-suspect/25 text-[#ffd0d2]" : "bg-white/5 text-ink-muted"
          }`}
        >
          {index + 1}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start gap-2">
            <p className={`min-w-0 flex-1 leading-6 font-semibold break-words ${status === "ruled_out" ? "text-ink-muted line-through" : "text-ink"}`}>
              {cause.title}
            </p>
            {isNew && <NewTag />}
            <LikelihoodMeter likelihood={cause.likelihood} confidence={confidence} setAside={setAside} />
          </div>
          {/* One quiet line under the title: what the % rests on. On a
              narrow phone a long one wraps between its parts, never inside
              one, and no line starts with a dot. */}
          {evidence.length > 0 && (
            <p data-evidence className="-mt-1.5 text-xs leading-5 text-ink-muted">
              <span className="sr-only">Claude&apos;s {confidence}% rests on: </span>
              {evidence.map((part, index) => (
                <Fragment key={part}>
                  <span className="whitespace-nowrap">
                    {part}
                    {index < evidence.length - 1 && " ·"}
                  </span>
                  {index < evidence.length - 1 && " "}
                </Fragment>
              ))}
            </p>
          )}
          <div onClick={(event) => event.stopPropagation()} className="space-y-2">
            <WhyLine text={cause.why} lead={status === "open" && cause.checkEffort ? <EffortLead effort={cause.checkEffort} /> : undefined} />
            <div data-cause-chips className="flex flex-wrap items-start gap-2">
              <StatusChip status={status} />
              <SystemChip system={system} active={highlight} onSelect={() => onSelectZone(system)} />
              {/* Beside the system chip while there's room for one. */}
              <SourceChips sources={cause.sources} className="min-w-0 flex-1 basis-32" />
            </div>
            {/* The steps before the full-screen sheet's large pictures, so
                what to do is in view first on a phone. */}
            {status === "open" && steps && (
              <HowToCheck
                rank={index + 1}
                title={cause.title}
                steps={steps}
                refs={refs}
                ticks={ticks}
                large={pictures === "large"}
                shownPages={cause.sources}
                onAsk={onAsk}
              />
            )}
            {pictures === "large" && <PageThumbs sources={cause.sources} size="large" />}
          </div>
        </div>
      </div>
      {/* A little more room above the buttons when the steps can suggest
          one, for the tag on its top edge. */}
      <div
        className={`${status === "open" && steps?.length && ticks ? "mt-4" : "mt-2.5"} flex flex-wrap items-center gap-2 pl-8`}
        onClick={(event) => event.stopPropagation()}
      >
        <MarkButton mark="ruled_out" verdict={verdict} pending={pending} hint={hint} onMark={onMark} />
        <MarkButton mark="confirmed" verdict={verdict} pending={pending} hint={hint} onMark={onMark} />
        {pictures === "inline" && <PageThumbs sources={cause.sources} size="inline" className="ml-auto gap-1.5" />}
        {status === "ruled_out" && (
          <button type="button" aria-expanded onClick={() => setExpanded(false)} className={`${markClass} border-transparent text-ink-muted hover:text-ink`}>
            Less
          </button>
        )}
      </div>
    </li>
  );
}

// --- Unit drawing -------------------------------------------------------------

function UnitCard({
  vehicle,
  model,
  rows,
  active,
  onSelect,
  hasReply,
  examining,
  onExamine,
  onCloseExamine,
  sheet,
}: {
  vehicle: UnitVehicle;
  model: UnitSpec | null;
  rows: CauseRow[];
  active: CauseSystem | null;
  onSelect: (system: CauseSystem) => void;
  hasReply: boolean;
  examining: DrawnSystem | "unit" | null;
  onExamine: (target: DrawnSystem | "unit") => void;
  onCloseExamine: () => void;
  sheet: (system: DrawnSystem) => ReactNode;
}) {
  const drawing = drawingFor(vehicle);
  const mounted = useMounted();
  const states = [...zoneStates(rows.map((row) => ({ system: row.system, likelihood: row.cause.likelihood, status: row.status }))).values()];
  const drawn = states.filter((state) => state.system !== "other" && drawing.zones[state.system as Exclude<CauseSystem, "other">]);
  const offDrawing = states.filter((state) => !drawn.includes(state));
  // Without a 3D model, a system tapped on the drawing opens its sheet on its own.
  const sheetOnly = !model && mounted && examining !== null && examining !== "unit" ? examining : null;
  const note = drawn.length > 0 ? null : <p className="text-xs text-ink-muted">{hasReply ? "No system singled out yet." : "Flagged systems show here with Claude's first reply."}</p>;
  const key = (mode: ViewMode | null) => note ?? <UnitKey states={drawn} mode={mode} />;
  return (
    <section id="unit-graphic" aria-label="Unit graphic" className="@container rounded-xl border border-white/10 bg-charcoal-900/70 pb-3 max-lg:scroll-mt-20">
      {model ? (
        <Unit3D
          model={model}
          vehicle={vehicle}
          states={drawn}
          active={active}
          onSelect={onSelect}
          examining={examining}
          onExamine={onExamine}
          onCloseExamine={onCloseExamine}
          sheet={sheet}
          title={unitName(model)}
          footer={key}
        />
      ) : (
        <>
          <UnitHeader title={VEHICLE_DRAWING_NAMES[vehicle]} model={null} />
          <div className="px-3 sm:px-4">
            <div className="unit-plate rounded-lg p-2">
              <div className={`relative mx-auto ${vehicle === "generator" ? "max-w-[15rem] sm:max-w-[20rem]" : "max-w-[19rem] sm:max-w-[28rem]"}`}>
                <UnitGraphic vehicle={vehicle} states={drawn} active={active} onSelect={onSelect} onOpen={onExamine} />
              </div>
            </div>
          </div>
          <div className="px-3 pt-2.5 sm:px-4">{key(null)}</div>
          {sheetOnly &&
            createPortal(
              <SheetView
                title={VEHICLE_DRAWING_NAMES[vehicle]}
                system={sheetOnly}
                state={drawn.find((state) => state.system === sheetOnly)}
                sheet={sheet}
                onClose={onCloseExamine}
              />,
              overlayRoot(),
            )}
        </>
      )}
      {offDrawing.length > 0 && (
        <p className="mt-1.5 px-3 text-xs text-ink-muted sm:px-4">
          Not on the drawing: {offDrawing.map((state) => SYSTEM_LABELS[state.system]).join(", ")}
        </p>
      )}
    </section>
  );
}

// --- Checks ---------------------------------------------------------------------

// A cause as a step refers to it: its number in the list (the drawing's
// callouts carry the same) and its title.
type CauseRef = { rank: number; title: string };

// Causes by their numbers, in the cause list's own small squares: "3", or
// "2 and 4", "1, 2 and 4" (a comma hangs on the square before it).
function CauseNumbers({ refs }: { refs: CauseRef[] }) {
  return refs.map((ref, index) => (
    <Fragment key={ref.rank}>
      {index > 0 && index === refs.length - 1 && <span>and</span>}
      <span className="inline-flex shrink-0 items-baseline">
        <span className="inline-grid size-5 place-items-center rounded-md bg-white/5 font-mono text-[11px] text-ink-muted">{ref.rank}</span>
        {index < refs.length - 2 && <span>,</span>}
      </span>
    </Fragment>
  ));
}

// "Also checks cause 3", or "causes 2 and 4": a check that settles several
// causes is in each of their cards (each complete on its own), and says so,
// so one test is done once.
function AlsoChecks({ refs, className = "" }: { refs: CauseRef[]; className?: string }) {
  return (
    <p
      data-also-checks={refs.map((ref) => ref.rank).join(" ")}
      title={refs.map((ref) => `${ref.rank}. ${ref.title}`).join("\n")}
      className={`flex flex-wrap items-center gap-1.5 text-xs leading-5 text-ink-muted ${className}`}
    >
      <span>{refs.length === 1 ? "Also checks cause" : "Also checks causes"}</span>
      <CauseNumbers refs={refs} />
    </p>
  );
}

// Where a step's spec or procedure comes from (sourceLevel): the shop's
// manuals, a web source, or general knowledge, to verify first. A spec
// carries it as its chip's label: MANUAL (teal), or VERIFY for one with no
// manual page behind it (from the web too: the web is for patterns, not
// specs), amber and dashed, never the manuals' teal, so a number Claude gave
// from memory doesn't pass for one. Amber is kept for that number to check.
function SpecChip({ check, className = "" }: { check: Check; className?: string }) {
  if (!check.expected) return null;
  if (sourceLevel(check) === "manual") {
    return (
      <span
        data-spec="manual"
        data-source-level="manual"
        title={SOURCE_LEVEL_LABELS.manual.detail}
        className={`inline-flex max-w-full items-baseline gap-2 rounded-md border border-glow/45 bg-glow/10 px-2.5 py-1 font-mono text-sm font-semibold break-words text-glow ${className}`}
      >
        <span className="text-[10px] font-semibold tracking-wide text-glow/70 uppercase">{SOURCE_LEVEL_LABELS.manual.label}</span>
        <span className="min-w-0 break-words">{specText(check.expected)}</span>
      </span>
    );
  }
  const web = check.sources.some((source) => source.type === "web");
  return (
    <span
      data-spec="unverified"
      data-source-level="general"
      title={`${web ? "From the web, not your manuals" : "Not from your manuals"} — verify before you rely on it`}
      className={`inline-flex max-w-full items-baseline gap-2 rounded-md border border-dashed border-trail/70 bg-trail/10 px-2.5 py-1 font-mono text-sm font-semibold break-words text-trail ${className}`}
    >
      <span className="flex shrink-0 items-center gap-1 self-center text-[10px] font-semibold tracking-wide text-trail/90 uppercase">
        <WarningIcon className="size-3" />
        Verify
      </span>
      <span className="min-w-0 break-words">{specText(check.expected)}</span>
      <span className="sr-only">Not from your manuals — verify</span>
    </span>
  );
}

// A step without a spec that cites no manual or web page says it's from
// general knowledge in a small tag at the end of its words (so it costs no
// row), quiet and dashed like a cause's General chip: most of Claude's
// quick looks are general, and amber is for a number to verify. A step from
// the manuals or the web needs no tag: its teal page chip or its web chip
// says so.
function LevelTag({ check }: { check: Check }) {
  if (check.expected || sourceLevel(check) !== "general") return null;
  return (
    <span
      data-source-level="general"
      title={SOURCE_LEVEL_LABELS.general.detail}
      className="ml-1.5 inline-flex h-5 items-center rounded border border-dashed border-white/25 px-1.5 align-[1px] text-[11px] leading-none font-medium whitespace-nowrap text-ink-muted"
    >
      General<span className="sr-only"> knowledge, not from your manuals</span>
    </span>
  );
}

// The tech's ticks on the reply's checks: how a check stands (as saved, or
// as just tapped while that's saving), who ticked it, and ticking it (done,
// with OK or a problem found, or taken back) from a place on the screen (a
// list and the step's number in it: "cause-2:1", "start:2", "old:3"), where
// a tick that didn't go through says why. A check that settles several
// causes is one check: ticked in every card it's in.
type Ticks = {
  stateOf: (check: Check) => StepState;
  byOf: (check: Check) => string | null;
  tick: (check: Check, done: boolean, result: StepResult | null, from: HTMLElement, place: string) => void;
  errorAt: (place: string, check: Check) => string | null;
  // Whether the steps point the way (Next, and what they suggest by a
  // cause's buttons): not once a cause was it, and the rest are set aside.
  guide: boolean;
};

const resultClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border px-2.5 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

const RESULT_LOOK: Record<StepResult, { label: string; pressed: string }> = {
  ok: { label: "OK", pressed: "border-glow/60 bg-glow/15 text-glow" },
  problem: { label: "Problem found", pressed: "border-trail/70 bg-trail/15 text-trail" },
};

// A step's tick at the end of its row, 44px for gloved hands: the box, and
// once it's ticked, what the tech found, OK or Problem found (optional; tap
// the one pressed to take it back), 12px clear of the box so a near miss
// doesn't take the tick back. Those two keep their room on the step to do
// next, where "Next" says so (part of the box's button, so tapping the word
// ticks it), so ticking steps in order moves nothing above the next one;
// any other step not done has only its box, which fits at the end of a row
// of chips.
function StepControls({
  action,
  state,
  next,
  by,
  onTick,
}: {
  action: string;
  state: StepState;
  next: boolean;
  by: string | null;
  onTick: (done: boolean, result: StepResult | null, from: HTMLElement) => void;
}) {
  const showNext = next && !state.done;
  return (
    <div data-step-controls className="ml-auto flex shrink-0 items-center gap-3">
      {(state.done || next) && (
        <div role={state.done ? "group" : undefined} aria-label={state.done ? `What “${action}” found` : undefined} className="flex items-center gap-1.5">
          {STEP_RESULTS.map((result) => {
            const pressed = state.result === result;
            return (
              <button
                key={result}
                type="button"
                data-result={result}
                aria-pressed={pressed}
                disabled={!state.done}
                onClick={(event) => onTick(true, pressed ? null : result, event.currentTarget)}
                className={`${resultClass} ${state.done ? "" : "invisible"} ${
                  pressed ? RESULT_LOOK[result].pressed : "border-white/15 text-ink-muted hover:border-white/30 hover:text-ink"
                }`}
              >
                {RESULT_LOOK[result].label}
              </button>
            );
          })}
        </div>
      )}
      <button
        type="button"
        role="checkbox"
        aria-checked={state.done}
        aria-label={`${showNext ? "Next. " : ""}Done: ${action}`}
        title={state.done ? `Done${by ? ` · ${by}` : ""}` : "Mark done"}
        data-step-check={state.done ? "done" : "open"}
        onClick={(event) => onTick(!state.done, null, event.currentTarget)}
        className="group relative grid size-11 shrink-0 place-items-center rounded-lg focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
      >
        {showNext && (
          <span aria-hidden data-next-label className="absolute inset-y-0 right-full flex items-center pr-0.5 pl-2 text-[11px] font-semibold tracking-wide text-glow uppercase">
            Next
          </span>
        )}
        <span
          className={`grid size-6 place-items-center rounded-md border-2 transition ${
            state.done ? "border-glow bg-glow text-forest-950" : next ? "border-glow/80 group-hover:bg-glow/10" : "border-white/35 group-hover:border-white/60"
          }`}
        >
          {state.done && <CheckIcon className="size-4 [stroke-width:2.25]" />}
        </span>
      </button>
    </div>
  );
}

// A done step reads as done, where it was: dimmed, its tick checked.
const doneDim = (state: StepState | null) => `transition-opacity ${state?.done ? "opacity-55" : ""}`;

// How a step stands, as data attributes for the end-to-end checks: where
// its spec or procedure comes from, done, its result, and whether it's the
// one to do next.
const tickData = (check: Check, state: StepState | null, next: boolean) => ({
  "data-step-level": sourceLevel(check),
  ...(state ? { "data-step-done": String(state.done), "data-step-result": state.result ?? undefined, "data-next-step": next || undefined } : {}),
});

// Why a tick on this step didn't go through (it's back as saved), under the
// step, where the tech is looking, rather than at the end of the list.
function TickError({ text, className = "" }: { text: string | null; className?: string }) {
  if (!text) return null;
  return (
    <p role="status" data-step-error className={`text-sm leading-5 text-trail ${className}`}>
      {text}
    </p>
  );
}

// A next check of a reply saved before checks said which causes they're
// for, in its list of its own: its step (numbered on across the tiers, and
// called a step so it isn't taken for a cause's number), what to do, and its
// spec and sources, with where they come from as a cause's steps have it
// (so no General chip: its tag says so).
function CheckItem({ check, step, ticks, next }: { check: Check; step: number; ticks: Ticks | null; next: boolean }) {
  const sources = check.sources.filter((source) => source.type !== "general");
  const state = ticks?.stateOf(check) ?? null;
  const dim = doneDim(state);
  const place = `old:${step}`;
  return (
    <li data-step={step} {...tickData(check, state, next)} className="flex gap-3 rounded-lg border border-white/5 bg-forest-950/40 p-3">
      <span className="flex w-8 shrink-0 flex-col items-center pt-0.5 leading-none" aria-label={`Step ${step}`}>
        <span aria-hidden className="text-[10px] font-semibold tracking-wide text-ink-muted uppercase">
          Step
        </span>
        <span aria-hidden className="mt-1 font-mono text-base font-semibold text-glow">
          {step}
        </span>
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className={`text-sm leading-6 break-words text-ink ${dim}`}>
          {check.action}
          <LevelTag check={check} />
        </p>
        {(check.expected || sources.length > 0 || ticks) && (
          <div className="flex flex-wrap items-center gap-2">
            <SpecChip check={check} className={dim} />
            <SourceChips sources={sources} className={dim} />
            {ticks && state && (
              <StepControls action={check.action} state={state} next={next} by={ticks.byOf(check)} onTick={(done, result, from) => ticks.tick(check, done, result, from, place)} />
            )}
          </div>
        )}
        <TickError text={ticks?.errorAt(place, check) ?? null} />
        <PageThumbs sources={check.sources} className={dim} />
      </div>
    </li>
  );
}

// An older reply's next checks, listed on their own under their tiers
// (quick checks, tests, teardown), numbered on across them; one saved
// before checks had tiers is one list in Claude's order.
function CheckList({ checks, ticks }: { checks: Check[]; ticks: Ticks | null }) {
  const groups = checkGroups(checks);
  // The step to do next, in the order they're listed.
  const shown = groups ? groups.flatMap((group) => group.items.map((item) => item.check)) : checks;
  const next = ticks?.guide ? shown[nextStep(shown.map((check) => ticks.stateOf(check)))] : undefined;
  if (!groups) {
    return (
      <ol className="space-y-2">
        {checks.map((check, index) => (
          <CheckItem key={index} check={check} step={index + 1} ticks={ticks} next={check === next} />
        ))}
      </ol>
    );
  }
  return (
    <div className="space-y-4">
      {groups.map(({ effort, items }) => {
        const Icon = EFFORT_ICONS[effort];
        const label = EFFORT_LABELS[effort];
        return (
          <section key={effort} data-tier={effort} aria-label={`${label.heading}: ${label.detail}`} className="space-y-2">
            <h3 className="flex items-center gap-1.5 px-0.5 text-sm leading-5 text-ink-muted">
              <Icon className="size-4" />
              <span className="font-semibold text-ink">{label.heading}</span>
              <span aria-hidden>·</span>
              <span>{label.detail}</span>
            </h3>
            <ol start={items[0].step} className="space-y-2">
              {items.map((item) => (
                <CheckItem key={item.step} check={item.check} step={item.step} ticks={ticks} next={item.check === next} />
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

// A step's tier as a small tag at the start of it (the cause's own effort
// marks, and one word), so the quick ones stand out without a header per
// tier: a quick one brighter and bolder, as the causes' effort words are.
// Square-cornered: the round chips here are buttons and links.
function TierTag({ tier }: { tier: Effort }) {
  const Icon = EFFORT_ICONS[tier];
  const label = EFFORT_LABELS[tier];
  return (
    <span
      data-tier-tag={tier}
      title={`${label.heading}: ${label.detail}`}
      className={`mr-1.5 inline-flex h-5 items-center gap-1 rounded px-1.5 align-middle text-xs leading-none ${
        tier === "quick" ? "bg-white/[0.12] font-semibold text-ink" : "bg-white/[0.07] font-medium text-ink/80"
      }`}
    >
      <Icon className="size-3" />
      {label.step}
    </span>
  );
}

// One step of a cause's "How to check", or of Start here: its number in the
// card (a list's "1." rather than a square, so it isn't taken for a
// cause's number; teal on the step to do next), its tier, what to do and,
// from general knowledge without a spec, a quiet General tag at the end of
// its words, then in one row that wraps (so a short step takes one line)
// its spec (labelled MANUAL or VERIFY), the manual pages and web pages it
// cites (which say it's from the manuals or the web), the other causes it
// also settles, and pictures of the pages that the card doesn't show
// already (small, at the row's end; under it in the full-screen sheet). No
// "General" chip: most steps would have one, a row each, and it cites
// nothing (the step's tag or VERIFY chip says so; the cause's own chips
// still say where its idea came from).
function StepItem({
  step,
  number,
  list,
  refs,
  large,
  shownPages = [],
  ticks,
  next,
}: {
  step: CauseStep<Check>;
  number: number;
  // Which list it's in ("cause-2", "start"), for where a tick's error shows.
  list: string;
  refs: CauseRef[];
  large: boolean;
  shownPages?: SourceView[];
  ticks: Ticks | null;
  // The first in its list that isn't done.
  next: boolean;
}) {
  const { check, tier, also } = step;
  const alsoRefs = also.flatMap((rank) => refs.filter((ref) => ref.rank === rank));
  const shown = new Set(manualPages(shownPages).map((page) => `${page.manualId}:${page.page}`));
  const pages = manualPages(check.sources).filter((page) => !shown.has(`${page.manualId}:${page.page}`));
  const state = ticks?.stateOf(check) ?? null;
  const dim = doneDim(state);
  const place = `${list}:${number}`;
  // The number hangs off the action's first line (wherever the row centres
  // it beside a chip), in the step's left margin. The tick is last in the
  // row, at its right end (on a line of its own when the row is full).
  return (
    <li data-cause-step={number} data-step-tier={tier ?? undefined} {...tickData(check, state, next)} className="pl-6">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <p className={`relative min-w-0 text-sm leading-6 break-words text-ink ${dim}`}>
          <span
            aria-hidden
            data-step-number
            className={`absolute top-0 -left-6 w-4 text-right font-mono text-xs leading-6 ${next && !state?.done ? "font-semibold text-glow" : "text-ink-muted"}`}
          >
            {number}.
          </span>
          {tier && <TierTag tier={tier} />}
          {check.action}
          <LevelTag check={check} />
        </p>
        <SpecChip check={check} className={dim} />
        <SourceChips sources={check.sources.filter((source) => source.type !== "general")} className={dim} />
        {alsoRefs.length > 0 && <AlsoChecks refs={alsoRefs} className={dim} />}
        {pages.length > 0 && (
          <PageThumbs sources={pages} size={large ? "small" : "inline"} className={`${large ? "basis-full" : ticks ? "gap-1.5" : "ml-auto gap-1.5"} ${dim}`} />
        )}
        {ticks && state && (
          <StepControls action={check.action} state={state} next={next} by={ticks.byOf(check)} onTick={(done, result, from) => ticks.tick(check, done, result, from, place)} />
        )}
        <TickError text={ticks?.errorAt(place, check) ?? null} className="basis-full" />
      </div>
    </li>
  );
}

// An open cause's own steps, quickest first, under its why line and chips;
// or, when no check settles it yet, a way to ask Claude for one (the
// question goes in the message box, to send or change).
function HowToCheck({
  rank,
  title,
  steps,
  refs,
  ticks,
  large,
  shownPages,
  onAsk,
}: {
  rank: number;
  title: string;
  steps: CauseStep<Check>[];
  refs: CauseRef[];
  ticks: Ticks | null;
  large: boolean;
  // The pages the cause's own pictures show already.
  shownPages: SourceView[];
  onAsk?: () => void;
}) {
  const next = ticks?.guide ? nextStep(steps.map((step) => ticks.stateOf(step.check))) : -1;
  if (steps.length === 0) {
    return (
      <div data-no-check className="flex min-h-11 flex-wrap items-center gap-x-3 border-t border-white/[0.06] pt-1">
        <p className="text-xs leading-5 text-ink-muted">No check from Claude yet</p>
        {onAsk && (
          <button
            type="button"
            data-ask-how
            aria-label={`Ask how to check cause ${rank}: ${title}`}
            onClick={onAsk}
            className={`${smallButtonClass} -mx-2 border-transparent px-2 text-glow/90 hover:text-glow hover:underline`}
          >
            Ask how to check
          </button>
        )}
      </div>
    );
  }
  return (
    <div data-how-to-check className="border-t border-white/[0.06] pt-2">
      {/* A label, not a heading: every card has one, and the list below is
          named for its cause. */}
      <p data-steps-label className="text-[11px] leading-4 font-semibold tracking-wide text-ink-muted uppercase">
        How to check
      </p>
      <ol aria-label={`How to check cause ${rank}`} className="mt-1.5 space-y-2.5">
        {steps.map((step, index) => (
          <StepItem key={index} step={step} number={index + 1} list={`cause-${rank}`} refs={refs} large={large} shownPages={shownPages} ticks={ticks} next={index === next} />
        ))}
      </ol>
    </div>
  );
}

// "Start here": the checks for no cause in particular (stored codes, the
// battery's charge), quickest first, before cause 1.
function StartHere({ steps, refs, hasCauses, ticks }: { steps: CauseStep<Check>[]; refs: CauseRef[]; hasCauses: boolean; ticks: Ticks | null }) {
  const next = ticks?.guide ? nextStep(steps.map((step) => ticks.stateOf(step.check))) : -1;
  return (
    <section data-start-here aria-label="Start here" className="mb-2 rounded-lg border border-white/10 bg-forest-950/40 p-3">
      <h3 className="flex flex-wrap items-center gap-x-1.5 text-sm leading-5">
        <ChecksIcon className="size-4 text-ink-muted" />
        <span className="font-semibold text-ink">Start here</span>
        <span aria-hidden className="text-ink-muted max-sm:hidden">
          ·
        </span>
        <span className="text-ink-muted max-sm:basis-full max-sm:pl-[1.375rem]">{hasCauses ? "covers every cause, quickest first" : "quickest first"}</span>
      </h3>
      <ol className="mt-2 space-y-2.5">
        {steps.map((step, index) => (
          <StepItem key={index} step={step} number={index + 1} list="start" refs={refs} large={false} ticks={ticks} next={index === next} />
        ))}
      </ol>
    </section>
  );
}

// --- Unit and manuals -------------------------------------------------------------

const smallButtonClass =
  "inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";

// A small action whose request never got an answer (the bay's Wi-Fi
// dropped, the server restarted, or the app was updated since the page
// loaded: the action throws then rather than answer) is said as the server
// says one that failed there, so what was shown at once goes back.
const NOT_THROUGH = { error: "That didn't go through. Check the connection and try again." };
const notThrough = (): { error: string } => NOT_THROUGH;

function ScopeCard({
  conversation,
  onScope,
  disabled,
}: {
  conversation: ConversationView;
  onScope: (update: Pick<ConversationView, "scope" | "unit" | "vin" | "modelNumber" | "vehicle" | "model">) => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [picked, setPicked] = useState<UnitSuggestion | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { scope, vin } = conversation;
  const count = scope.manuals.length;
  const vinCheck = vin ? checkVin(vin) : null;
  // A VIN for another model than the one the unit was found as (the tech
  // typed both, or Claude looked another model up): said here, by the unit.
  const disagreement = vin && conversation.modelNumber ? vinDisagreement(vin, conversation.modelNumber) : null;

  async function change(input: { modelNumber?: string; wholeLibrary?: boolean }) {
    setPending(true);
    setMessage(null);
    const result = await changeUnitAction({ conversationId: conversation.id, ...input }).catch(notThrough);
    setPending(false);
    if ("error" in result) {
      setMessage(result.error);
      return;
    }
    onScope({
      scope: result.scope,
      unit: result.unit,
      vin: result.vin,
      modelNumber: result.modelNumber,
      vehicle: result.vehicle,
      model: result.model,
    });
    setEditing(false);
    setValue("");
    setPicked(null);
  }

  return (
    <Section label="Unit and manuals" icon={<BookIcon />} count={count > 0 ? count : undefined}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-sm leading-6 text-ink" data-testid="scope-line">
          {scope.label === null
            ? "Searching the shop's whole library"
            : `Using ${count} ${count === 1 ? "manual" : "manuals"} for ${scope.label}`}
        </p>
        {!editing && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setEditing(true)}
            className={`${smallButtonClass} -my-1 border-transparent px-2 text-glow/90 hover:text-glow hover:underline`}
          >
            Change unit
          </button>
        )}
      </div>
      {vin && (
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm leading-6" data-testid="unit-vin">
          <span className="text-xs font-medium text-ink-muted">VIN</span>
          <span className="font-mono tracking-wide break-all text-ink">{vin}</span>
          {vinCheck?.status === "ok" && !vinCheck.checkDigitOk && (
            <span className="text-xs text-trail">check digit doesn&apos;t match: a character may be off</span>
          )}
        </p>
      )}
      {disagreement && (
        <p data-testid="unit-vin-disagree" className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-trail">
          <WarningIcon className="mt-0.5 size-3.5" />
          <span>{disagreement}</span>
        </p>
      )}
      {count > 0 && (
        <details className="text-xs text-ink-muted">
          <summary className="flex min-h-11 cursor-pointer items-center text-glow/90 hover:text-glow">Which manuals</summary>
          <ul className="mt-1 space-y-1">
            {scope.manuals.map((manual) => (
              <li key={manual.id}>
                <Link href={`/library/${manual.id}`} className="hover:text-glow hover:underline">
                  {manual.title}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
      {editing && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) void change({ modelNumber: value.trim() });
          }}
        >
          <label htmlFor="change-unit" className="text-sm font-medium text-ink/90">
            Model number or VIN
          </label>
          <UnitPicker id="change-unit" value={value} onChange={setValue} picked={picked} onPick={setPicked} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending || !value.trim()} className={`${smallButtonClass} border-glow/40 text-glow hover:bg-glow/10`}>
              Use this unit
            </button>
            <button type="button" disabled={pending} onClick={() => void change({ wholeLibrary: true })} className={`${smallButtonClass} border-white/15 text-ink-muted hover:text-ink`}>
              Whole library
            </button>
            <button type="button" onClick={() => setEditing(false)} className={`${smallButtonClass} border-transparent text-ink-muted hover:text-ink`}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {message && (
        <p role="status" className="mt-2 text-sm text-trail">
          {message}
        </p>
      )}
    </Section>
  );
}

// --- The panel ----------------------------------------------------------------------

// Whether an element is wholly in sight: in the window, below the tablet's
// sticky tab bar, and inside the diagnosis pane (which scrolls on its own
// beside the chat on a wide screen).
function inSight(element: Element) {
  const rect = element.getBoundingClientRect();
  const bar = document.querySelector("[data-tabbar]")?.getBoundingClientRect();
  const pane = document.getElementById("diagnosis-pane")?.getBoundingClientRect();
  const top = Math.max(0, bar && bar.height > 0 ? bar.bottom : 0, pane ? pane.top : 0);
  const bottom = Math.min(window.innerHeight, pane ? pane.bottom : Infinity);
  return rect.top >= top - 1 && rect.bottom <= bottom + 1;
}

// What scrolls an element: beside the chat, the diagnosis pane; otherwise
// (null) the page.
function scrollerOf(element: Element) {
  const pane = document.getElementById("diagnosis-pane");
  return pane?.contains(element) && getComputedStyle(pane).overflowY !== "visible" ? pane : null;
}

// Where an element is on screen now, and a way to put it back there after
// what's around it changes height: the page (or, beside the chat, the
// diagnosis pane) scrolls by however far it moved. The browser's own scroll
// anchoring can't be left to it: it may hold on to a cause that just moved.
// When a cause near the end of the list folds up (ruled out, its steps
// gone), a page scrolled to its end gets shorter and the browser pulls it
// down: the panel is padded at its foot for the difference, so it can be
// scrolled back, until that padding is out of sight. The panel, not the
// causes' column: on a wide screen the unit's column beside it can be the
// taller one, and then a longer causes column wouldn't lengthen the page.
function holdOnScreen(element: HTMLElement | null) {
  if (!element) return () => {};
  const top = element.getBoundingClientRect().top;
  return () => {
    const moved = element.getBoundingClientRect().top - top;
    if (Math.abs(moved) < 1) return;
    const pane = scrollerOf(element);
    const room = pane
      ? pane.scrollHeight - pane.clientHeight - pane.scrollTop
      : document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
    const panel = element.closest<HTMLElement>("[data-causes-panel]") ?? element.parentElement;
    if (moved > room && panel) padFoot(panel, moved - room, pane);
    if (pane) pane.scrollBy(0, moved);
    else window.scrollBy(0, moved);
  };
}

// Extra room at the foot of the panel (see holdOnScreen), taken away once
// it's scrolled out of sight below, when nothing on screen moves for it.
function padFoot(panel: HTMLElement, extra: number, pane: HTMLElement | null) {
  const before = parseFloat(panel.style.paddingBottom) || 0;
  panel.style.paddingBottom = `${before + Math.ceil(extra)}px`;
  if (before > 0) return;
  const scroller = pane ?? window;
  const release = () => {
    const padding = parseFloat(panel.style.paddingBottom) || 0;
    const bottom = pane ? pane.getBoundingClientRect().bottom : window.innerHeight;
    if (panel.isConnected && padding > 0 && panel.getBoundingClientRect().bottom - padding < bottom) return;
    panel.style.paddingBottom = "";
    scroller.removeEventListener("scroll", release);
  };
  scroller.addEventListener("scroll", release, { passive: true });
}

export function CausesPanel({
  conversation,
  reply,
  replyTurnId,
  previousTitles,
  busy,
  afterCauses,
  onConversation,
  onAsk,
}: {
  conversation: ConversationView;
  reply: DiagnosisReply | null;
  replyTurnId: string | null;
  // The causes in Claude's reply before this one (lower case), to mark the
  // new ones; null when this is the first.
  previousTitles: Set<string> | null;
  busy: boolean;
  afterCauses?: ReactNode;
  onConversation: (update: Partial<ConversationView>) => void;
  // Puts a question for Claude in the message box, unsent (a cause's "Ask
  // how to check"); none while the conversation is full.
  onAsk?: (question: string) => void;
}) {
  const [pending, setPending] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<CauseSystem | null>(null);
  const [hovered, setHovered] = useState<CauseSystem | null>(null);
  // Ticks the tech just tapped, by their checks' words, shown at once while
  // they save (in order: the app sends one at a time); the saved copy takes
  // over when the last one for a check comes back, and an error puts the
  // check back as saved.
  const [ticking, setTicking] = useState<Map<string, { state: StepState; request: number }>>(() => new Map());
  const requests = useRef(0);
  // Why the last tick didn't go through, under the step it was tapped on
  // (that place, that check, that reply).
  const [tickError, setTickError] = useState<{ place: string; key: string; turnId: string; text: string } | null>(null);

  const rows: CauseRow[] = (reply?.likelyCauses ?? []).map((cause, index) => ({
    cause,
    index,
    system: causeSystem(cause),
    status: shownStatus(cause, conversation.feedback, conversation.outcome?.title ?? null),
    verdict: verdictFor(conversation.feedback, cause.title),
    isNew: previousTitles !== null && !previousTitles.has(cause.title.toLowerCase()),
  }));
  // Confirmed first, then open, ruled-out ones at the bottom; Claude's
  // order within each.
  const ordered = [...rows].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.index - b.index);
  const refs: CauseRef[] = rows.map((row) => ({ rank: row.index + 1, title: row.cause.title }));
  // Once a cause was it, the others still open are set aside (the drawing
  // tones them down), and the steps stop pointing the way.
  const solved = rows.some((row) => row.status === "confirmed");
  // Each open cause's checks in its card, and the ones for no cause in
  // particular first; null for a reply whose checks don't say which causes
  // they're for, which keeps its own Next checks list.
  const plan = reply ? causeSteps(reply.nextChecks, rows) : null;
  const stepsOf = (row: CauseRow) => plan?.byCause.get(row.index + 1) ?? null;
  const askFor = (row: CauseRow) => (onAsk ? () => onAsk(howToCheckQuestion(row.index + 1, row.cause.title)) : undefined);

  // How each check stands: the latest tick on a check with its words, from
  // this reply or an earlier one, so a check Claude gives again stays ticked.
  const saved = stepStates(conversation.stepChecks ?? []);
  const stateOf = (check: Check): StepState => ticking.get(stepKey(check.action))?.state ?? stepStateOf(saved, check.action);
  const ticks: Ticks | null =
    reply && replyTurnId
      ? {
          stateOf,
          byOf: (check) => saved.get(stepKey(check.action))?.userName ?? null,
          tick: (check, done, result, from, place) => void tick(check, done, result, from, place),
          errorAt: (place, check) =>
            tickError && tickError.place === place && tickError.key === stepKey(check.action) && tickError.turnId === replyTurnId ? tickError.text : null,
          guide: !solved,
        }
      : null;

  // Ticks a step (or takes the tick back) at once, and saves it. The tapped
  // control stays where it is on screen whatever changes around it (the
  // note under the list that Claude will hear, say). The server gets how
  // the check stood here too, so a tap on a screen that hasn't seen another
  // device's change doesn't undo it (stale: that's shown instead).
  async function tick(check: Check, done: boolean, result: StepResult | null, from: HTMLElement, place: string) {
    const index = reply?.nextChecks.indexOf(check) ?? -1;
    if (!replyTurnId || index < 0) return;
    const key = stepKey(check.action);
    const was = stateOf(check);
    const request = ++requests.current;
    const steady = (update: () => void) => {
      const hold = from.isConnected ? holdOnScreen(from) : () => {};
      flushSync(update);
      hold();
    };
    steady(() => {
      setTickError(null);
      setTicking((old) => new Map(old).set(key, { state: { done, result: done ? result : null }, request }));
    });
    const outcome = await markStepAction({ conversationId: conversation.id, turnId: replyTurnId, index, done, result, was }).catch(notThrough);
    // Only the last tap on a check settles it; one before it is overtaken.
    const settle = () =>
      setTicking((old) => {
        if (old.get(key)?.request !== request) return old;
        const next = new Map(old);
        next.delete(key);
        return next;
      });
    steady(() => {
      const turnId = replyTurnId;
      if ("error" in outcome) setTickError({ place, key, turnId, text: outcome.error });
      else {
        onConversation({ stepChecks: outcome.stepChecks });
        if (outcome.stale) setTickError({ place, key, turnId, text: "That step was changed on another device. This is how it stands now." });
      }
      settle();
    });
  }

  async function mark(index: number, verdict: CauseVerdict, viaKeyboard: boolean) {
    if (!replyTurnId) return;
    const pressed = verdict === "open" ? rows[index]?.verdict : verdict;
    setPending(index);
    setMessage(null);
    const result = await markCauseAction({ conversationId: conversation.id, turnId: replyTurnId, index, verdict }).catch(notThrough);
    setPending(null);
    if ("error" in result) {
      setMessage(result.error);
      return;
    }
    // The cause may have moved (ruled out sinks, confirmed rises). The page
    // stays where it is for a tap, though the key under the drawing above
    // the list can change height (a ruled-out system joins it); from the
    // keyboard, the focus (and the view) follows the cause.
    const hold = viaKeyboard ? () => {} : holdOnScreen(document.getElementById("likely-causes"));
    flushSync(() => onConversation(result));
    requestAnimationFrame(() => {
      hold();
      const button =
        document.querySelector<HTMLButtonElement>(`li[data-cause="${index}"] button[data-mark="${pressed ?? "ruled_out"}"]`) ??
        document.querySelector<HTMLButtonElement>(`li[data-cause="${index}"] button`);
      button?.focus({ preventScroll: !viaKeyboard });
    });
  }

  // A system picked on the drawing brings its causes into view; one picked
  // from the list brings the drawing into view, if it's out of sight (on a
  // phone it's above the list; beside the chat it can scroll away).
  function selectZone(system: CauseSystem, from: "drawing" | "list") {
    const next = selected === system ? null : system;
    setSelected(next);
    if (!next) return;
    requestAnimationFrame(() => {
      if (from === "drawing") {
        document.querySelector(`li[data-cause][data-zone="${next}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
      const drawing = document.querySelector("#unit-graphic [data-unit3d], #unit-graphic svg.ug");
      if (drawing && !inSight(drawing)) document.getElementById("unit-graphic")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  // Presses and ticks Claude hasn't heard yet (counting ticks still saving),
  // said under the last list on the screen: the causes, or an older reply's
  // own list of checks below them, so the line coming never moves a list.
  const unsent =
    conversation.feedback.filter((entry) => entry.sentInSeq === null).length +
    (conversation.stepChecks ?? []).filter((entry) => entry.sentInSeq === null).length +
    ticking.size;
  const heard = unsent > 0 ? <p className="mt-3 text-xs text-ink-muted">Claude hears about your marks with your next message.</p> : null;
  const oldChecks = reply !== null && !plan && reply.nextChecks.length > 0;
  const active = hovered ?? selected;

  // The full-screen unit, in the address so Back closes it.
  const [examineParam, openExamine, closeExamine] = useHistoryParam("examine");
  const examining: DrawnSystem | "unit" | null = examineParam === null ? null : isDrawnSystem(examineParam) ? examineParam : "unit";

  // The manual pages the reply cites (open causes, then checks), for the
  // pictures beside the unit on a wide screen: the picked system's only.
  const citedBy = (system: CauseSystem | null) =>
    manualPages([
      ...ordered.filter((row) => row.status !== "ruled_out" && (system === null || row.system === system)).flatMap((row) => row.cause.sources),
      ...(system === null ? (reply?.nextChecks ?? []).flatMap((check) => check.sources) : []),
    ]);
  const gallery = citedBy(selected);
  const titles = new Map<string, string>([
    ...conversation.scope.manuals.map((manual): [string, string] => [manual.id, manual.title]),
    ...citedBy(null).map((source): [string, string] => [source.manualId, source.title]),
  ]);

  // A system's sheet in the full-screen view: its parts with their manual
  // pages (From the manual), then its causes, each with its steps and
  // pictures of the manual pages it cites. Asking how to check one closes
  // the view, so the message box is there to see.
  // What a part's sheet depends on besides the system: the reply shown, and
  // the unit and its manuals (the tech can change them in place).
  const partsVersion = [replyTurnId ?? "", conversation.modelNumber ?? "", conversation.scope.label ?? "", conversation.scope.manuals.map((manual) => manual.id).join(",")].join("|");
  function sheet(system: DrawnSystem) {
    const mine = ordered.filter((row) => row.system === system);
    return (
      <div className="space-y-5">
        <PartSheetSection key={system} conversationId={conversation.id} system={system} version={partsVersion} causes={mine.length} />
        {mine.length === 0 ? <p className="text-sm text-ink-muted">No causes point here.</p> : causesOf(mine)}
      </div>
    );
  }

  function causesOf(mine: CauseRow[]) {
    return (
      <section aria-label="Causes here" data-sheet-causes tabIndex={-1} className="scroll-mt-3 space-y-3 focus:outline-none">
        <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Causes</h3>
        <ol className="space-y-2">
          {mine.map((row) => {
            const ask = askFor(row);
            return (
              <CauseItem
                key={`${row.cause.title}-${row.index}`}
                row={row}
                highlight={false}
                pending={pending === row.index}
                onMark={(verdict, viaKeyboard) => void mark(row.index, verdict, viaKeyboard)}
                onSelectZone={() => {}}
                onHoverZone={() => {}}
                steps={stepsOf(row)}
                refs={refs}
                ticks={ticks}
                setAside={solved && row.status === "open"}
                onAsk={
                  ask &&
                  (() => {
                    closeExamine();
                    ask();
                  })
                }
                pictures="large"
              />
            );
          })}
        </ol>
        {message && (
          <p role="status" className="text-sm text-trail">
            {message}
          </p>
        )}
      </section>
    );
  }

  // Wide screens: the causes with their checks, and beside them the unit,
  // its safety notes and the manual pictures. Narrower: the unit and safety
  // above the causes.
  return (
    <ManualPictures titles={titles}>
      <div data-causes-panel className="space-y-4 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] xl:items-start xl:gap-4 xl:space-y-0">
        <div className="space-y-4 xl:sticky xl:top-0 xl:col-start-2 xl:row-start-1">
          {conversation.vehicle && (
            <UnitCard
              vehicle={conversation.vehicle}
              model={conversation.model ?? null}
              rows={rows}
              active={active}
              onSelect={(system) => selectZone(system, "drawing")}
              hasReply={reply !== null}
              examining={examining}
              onExamine={(target) => {
                // The list behind highlights the system's causes, if it has any.
                if (target !== "unit" && rows.some((row) => row.system === target)) setSelected(target);
                openExamine(target);
              }}
              onCloseExamine={closeExamine}
              sheet={sheet}
            />
          )}
          {/* Safety next to the unit, so it's among the first things read: beside
              it on wide screens, straight after it (before the causes) on
              narrower ones. */}
          {reply && reply.safetyNotes.length > 0 && (
            <section aria-label="Safety" className="rounded-xl border border-trail/40 bg-trail/10 px-4 py-3 text-trail">
              <h2 className="flex items-center gap-2 text-[15px] leading-5 font-semibold">
                <WarningIcon />
                Safety
                <span className="ml-auto rounded-full bg-trail/15 px-2 py-0.5 text-xs tracking-normal tabular-nums">{reply.safetyNotes.length}</span>
              </h2>
              <ul className="mt-2 space-y-1.5 text-sm leading-5">
                {reply.safetyNotes.map((note, index) => (
                  <li key={index} className="flex gap-2">
                    <span aria-hidden className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-trail" />
                    <span className="min-w-0 break-words">{note}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {gallery.length > 0 && (
            <Section
              label="Manual pictures"
              icon={<BookIcon />}
              count={gallery.length}
              aside={selected ? <span className="truncate text-xs tracking-normal text-ink-muted normal-case">· {SYSTEM_LABELS[selected]}</span> : undefined}
              className="max-xl:hidden"
            >
              <PageThumbs sources={gallery} size="large" />
            </Section>
          )}
        </div>

        <div className="space-y-4 xl:col-start-1 xl:row-start-1">
          <Section id="likely-causes" label="Likely causes" icon={<CausesIcon />} count={rows.length > 0 ? rows.length : undefined}>
            {plan && plan.general.length > 0 && <StartHere steps={plan.general} refs={refs} hasCauses={rows.length > 0} ticks={ticks} />}
            {!reply || reply.likelyCauses.length === 0 ? (
              <p className="text-sm leading-6 text-ink-muted">
                {reply ? "None yet. Tell Claude more about what the unit is doing." : "Claude's list shows here after its first reply."}
              </p>
            ) : (
              <ol className="space-y-2">
                {ordered.map((row) => (
                  <CauseItem
                    key={`${row.cause.title}-${row.index}`}
                    row={row}
                    highlight={selected === row.system}
                    pending={pending === row.index}
                    onMark={(verdict, viaKeyboard) => void mark(row.index, verdict, viaKeyboard)}
                    onSelectZone={(system) => selectZone(system, "list")}
                    onHoverZone={setHovered}
                    steps={stepsOf(row)}
                    refs={refs}
                    ticks={ticks}
                    setAside={solved && row.status === "open"}
                    onAsk={askFor(row)}
                  />
                ))}
              </ol>
            )}
            {!oldChecks && heard}
            {message && (
              <p role="status" className="mt-2 text-sm text-trail">
                {message}
              </p>
            )}
          </Section>

          {afterCauses}

          {/* A reply saved before checks said which causes they're for:
              its checks as a list of their own, as they always were. */}
          {oldChecks && (
            <Section label="Next checks" icon={<ChecksIcon />} count={reply.nextChecks.length}>
              <CheckList checks={reply.nextChecks} ticks={ticks} />
              {heard}
            </Section>
          )}

          <ScopeCard
            conversation={conversation}
            disabled={busy}
            onScope={onConversation}
          />
        </div>
      </div>
    </ManualPictures>
  );
}
