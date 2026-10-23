"use client";

import Link from "next/link";
import { useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";

import type {
  Cause,
  CauseVerdict,
  Check,
  ConversationView,
  DiagnosisReply,
  FeedbackEntry,
  ScopeView,
  SourceView,
  UnitSuggestion,
} from "@/lib/diagnose-rules";
import {
  SYSTEM_LABELS,
  VEHICLE_DRAWING_NAMES,
  causeSystem,
  shownStatus,
  zoneStates,
  type CauseState,
  type CauseSystem,
  type Glow,
  type UnitVehicle,
} from "@/lib/diagnose-zones";
import { drawingFor } from "@/lib/unit-graphic/drawing";

import { changeUnitAction, markCauseAction } from "./actions";
import {
  BookIcon,
  BulbIcon,
  CausesIcon,
  CheckIcon,
  ChecksIcon,
  ChevronIcon,
  CrossIcon,
  GlobeIcon,
  UnitIcon,
  WarningIcon,
} from "./icons";
import { UnitGraphic } from "./unit-graphic";
import { UnitPicker } from "./unit-picker";

// The diagnosis at a glance, beside the chat (or on its own tab on a
// tablet): the unit drawing with its suspect systems lit, Claude's likely
// causes with the tech's "Ruled out" / "This was it", the checks to do next
// with their specs, safety notes, and the unit and manuals in use.

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
      <h2 className="flex items-center gap-2 border-b border-white/5 px-4 py-2 font-mono text-[13px] font-medium tracking-[0.16em] text-glow uppercase">
        {icon}
        <span className="whitespace-nowrap">{label}</span>
        {aside}
        {count !== undefined && (
          <span className="ml-auto shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-xs tracking-normal text-ink-muted normal-case tabular-nums">
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

function LikelihoodMeter({ likelihood }: { likelihood: Cause["likelihood"] }) {
  const { lit, color } = METER[likelihood];
  return (
    <span role="img" aria-label={`Likelihood: ${likelihood}`} title={`Likelihood: ${likelihood}`} data-likelihood={likelihood} className="flex shrink-0 gap-0.5 pt-2">
      {[1, 2, 3].map((segment) => (
        <span key={segment} className={`h-2 w-3.5 rounded-[2px] ${segment <= lit ? color : "bg-white/10"}`} />
      ))}
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

// The tech's latest press on a cause (matched by title, which carries over
// between Claude's replies), if any.
function verdictFor(feedback: FeedbackEntry[], title: string): CauseVerdict | null {
  const entry = feedback.findLast((item) => item.title.toLowerCase() === title.toLowerCase());
  return entry && entry.verdict !== "open" ? entry.verdict : null;
}

const markClass =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";

function MarkButton({
  mark,
  verdict,
  pending,
  onMark,
}: {
  mark: "ruled_out" | "confirmed";
  verdict: CauseVerdict | null;
  pending: boolean;
  onMark: (verdict: CauseVerdict, viaKeyboard: boolean) => void;
}) {
  const pressed = verdict === mark;
  const style =
    mark === "ruled_out"
      ? pressed
        ? "border-ink-muted/70 bg-white/10 text-ink"
        : "border-white/15 text-ink-muted hover:text-ink"
      : pressed
        ? "border-suspect/70 bg-suspect/20 text-[#ffd0d2]"
        : "border-glow/30 text-glow hover:bg-glow/10";
  return (
    <button
      type="button"
      data-mark={mark}
      aria-pressed={pressed}
      disabled={pending}
      onClick={(event) => onMark(pressed ? "open" : mark, event.detail === 0)}
      className={`${markClass} ${style}`}
    >
      {mark === "ruled_out" ? <CrossIcon /> : <CheckIcon />}
      {mark === "ruled_out" ? "Ruled out" : "This was it"}
    </button>
  );
}

// Why Claude thinks so: one line, tap for the rest.
function WhyLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className="-my-2.5 flex min-h-11 w-full items-start gap-1 rounded py-2.5 text-left text-sm leading-6 text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
    >
      <span className={`min-w-0 flex-1 break-words ${open ? "" : "line-clamp-1"}`}>{text}</span>
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
}: {
  row: CauseRow;
  highlight: boolean;
  pending: boolean;
  onMark: (verdict: CauseVerdict, viaKeyboard: boolean) => void;
  onSelectZone: (system: CauseSystem) => void;
  onHoverZone: (system: CauseSystem | null) => void;
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
  return (
    <li
      {...common}
      onClick={() => onSelectZone(system)}
      className={`rounded-lg border p-3 transition ${
        confirmed ? "border-suspect/60 bg-suspect/10 shadow-[0_0_24px_-8px] shadow-suspect/60" : "border-white/10 bg-forest-950/40"
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
            <LikelihoodMeter likelihood={cause.likelihood} />
          </div>
          <div onClick={(event) => event.stopPropagation()} className="space-y-2">
            {cause.why && <WhyLine text={cause.why} />}
            <div className="flex flex-wrap items-start gap-2">
              <StatusChip status={status} />
              <SystemChip system={system} active={highlight} onSelect={() => onSelectZone(system)} />
              {/* Beside the system chip while there's room for one. */}
              <SourceChips sources={cause.sources} className="min-w-0 flex-1 basis-32" />
            </div>
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2 pl-8" onClick={(event) => event.stopPropagation()}>
        <MarkButton mark="ruled_out" verdict={verdict} pending={pending} onMark={onMark} />
        <MarkButton mark="confirmed" verdict={verdict} pending={pending} onMark={onMark} />
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

// The legend shows each state's look on the drawing and its mark on the
// labels: the likelihood meter, a check, a cross.
const LEGEND: { glow: Exclude<Glow, "none">; label: string; swatch: string; mark: ReactNode }[] = [
  { glow: "confirmed", label: "Confirmed", swatch: "border-white bg-[#d93a40]", mark: <CheckIcon className="size-3 text-[#ffb3b6]" /> },
  { glow: "high", label: "High", swatch: "border-[#ff4d55] bg-[#ff4d55]/45 shadow-[0_0_6px_#ff4d55]", mark: <MiniMeter lit={3} color="bg-[#ff4d55]" /> },
  {
    glow: "medium",
    label: "Medium",
    swatch: "border-[#ff8a4c] bg-[repeating-linear-gradient(135deg,#ff8a4c_0_1.5px,transparent_1.5px_4px)]",
    mark: <MiniMeter lit={2} color="bg-[#ff8a4c]" />,
  },
  { glow: "low", label: "Low", swatch: "border-dashed border-[#ff6b70]", mark: <MiniMeter lit={1} color="bg-[#ff6b70]" /> },
  { glow: "ruled_out", label: "Ruled out", swatch: "border-dashed border-ink-muted bg-forest-950", mark: <CrossIcon className="size-3" /> },
];

function MiniMeter({ lit, color }: { lit: number; color: string }) {
  return (
    <span aria-hidden className="flex gap-px">
      {[1, 2, 3].map((segment) => (
        <span key={segment} className={`h-2 w-[3px] rounded-[1px] ${segment <= lit ? color : "bg-white/20"}`} />
      ))}
    </span>
  );
}

function UnitCard({
  vehicle,
  rows,
  active,
  onSelect,
  hasReply,
}: {
  vehicle: UnitVehicle;
  rows: CauseRow[];
  active: CauseSystem | null;
  onSelect: (system: CauseSystem) => void;
  hasReply: boolean;
}) {
  const drawing = drawingFor(vehicle);
  const states = [...zoneStates(rows.map((row) => ({ system: row.system, likelihood: row.cause.likelihood, status: row.status }))).values()];
  const drawn = states.filter((state) => state.system !== "other" && drawing.zones[state.system as Exclude<CauseSystem, "other">]);
  const lit = drawn.filter((state) => state.glow !== "ruled_out").length;
  const offDrawing = states.filter((state) => !drawn.includes(state));
  const present = new Set(drawn.map((state) => state.glow));
  return (
    <Section
      id="unit-graphic"
      label="Unit graphic"
      icon={<UnitIcon />}
      aside={<span className="truncate text-xs tracking-normal text-ink-muted normal-case max-sm:hidden">· {VEHICLE_DRAWING_NAMES[vehicle]}</span>}
      count={lit > 0 ? `${lit} ${lit === 1 ? "system" : "systems"}` : undefined}
      className="max-lg:scroll-mt-20"
    >
      <div className={`relative mx-auto ${vehicle === "generator" ? "max-w-[15rem] sm:max-w-[20rem]" : "max-w-[19rem] sm:max-w-[28rem]"}`}>
        {/* HUD corner marks, as on the sign-in card. */}
        {["-top-1 -left-1 border-t border-l rounded-tl-lg", "-top-1 -right-1 border-t border-r rounded-tr-lg", "-bottom-1 -left-1 border-b border-l rounded-bl-lg", "-right-1 -bottom-1 border-r border-b rounded-br-lg"].map((corner) => (
          <span key={corner} aria-hidden className={`pointer-events-none absolute size-3.5 border-glow/40 ${corner}`} />
        ))}
        <UnitGraphic vehicle={vehicle} states={drawn} active={active} onSelect={onSelect} />
      </div>
      {present.size > 0 ? (
        <ul aria-label="Legend" className="mt-2 flex flex-wrap justify-center gap-x-2.5 gap-y-1 text-[11px] text-ink-muted">
          {LEGEND.filter((item) => present.has(item.glow)).map((item) => (
            <li key={item.glow} data-legend={item.glow} className="flex items-center gap-1">
              <span aria-hidden className={`inline-block h-2.5 w-4 rounded-sm border ${item.swatch}`} />
              {item.mark}
              {item.label}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-center text-xs text-ink-muted">
          {hasReply ? "No system singled out yet." : "Lights up with Claude's first reply."}
        </p>
      )}
      {offDrawing.length > 0 && (
        <p className="mt-1 text-center text-xs text-ink-muted">
          Not on the drawing: {offDrawing.map((state) => SYSTEM_LABELS[state.system]).join(", ")}
        </p>
      )}
    </Section>
  );
}

// --- Checks and safety --------------------------------------------------------

function CheckItem({ check, step }: { check: Check; step: number }) {
  return (
    <li className="flex gap-3 rounded-lg border border-white/5 bg-forest-950/40 p-3">
      <span className="grid size-7 shrink-0 place-items-center rounded-full border border-glow/40 font-mono text-sm text-glow">{step}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm leading-6 break-words text-ink">{check.action}</p>
        {(check.expected || check.unverifiedSpec || check.sources.length > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {check.expected &&
              (check.unverifiedSpec ? (
                // Not from the shop's manuals: amber and dashed, never the
                // manual spec's teal, so it doesn't pass for one.
                <span
                  data-spec="unverified"
                  title="Not from your manuals — verify before you rely on it"
                  className="inline-flex max-w-full items-baseline gap-2 rounded-md border border-dashed border-trail/70 bg-trail/10 px-2.5 py-1 font-mono text-sm font-semibold break-words text-trail"
                >
                  <span className="flex shrink-0 items-center gap-1 self-center text-[10px] font-medium tracking-[0.15em] text-trail/80">
                    <WarningIcon className="size-3" />
                    VERIFY
                  </span>
                  <span className="min-w-0 break-words">{check.expected}</span>
                  <span className="sr-only">Not from your manuals — verify</span>
                </span>
              ) : (
                <span
                  data-spec="manual"
                  className="inline-flex max-w-full items-baseline gap-2 rounded-md border border-glow/45 bg-glow/10 px-2.5 py-1 font-mono text-sm font-semibold break-words text-glow"
                >
                  <span className="text-[10px] font-medium tracking-[0.15em] text-glow/60">SPEC</span>
                  <span className="min-w-0 break-words">{check.expected}</span>
                </span>
              ))}
            {check.unverifiedSpec && !check.expected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-trail/15 px-2 py-1 text-xs font-medium text-trail">
                <WarningIcon className="size-3.5" />
                Not from your manuals — verify
              </span>
            )}
            <SourceChips sources={check.sources} />
          </div>
        )}
      </div>
    </li>
  );
}

// --- Unit and manuals -------------------------------------------------------------

const smallButtonClass =
  "inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";

function ScopeCard({
  conversation,
  onScope,
  disabled,
}: {
  conversation: ConversationView;
  onScope: (scope: ScopeView, unit: string | null, vehicle: UnitVehicle | null) => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [picked, setPicked] = useState<UnitSuggestion | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { scope } = conversation;
  const count = scope.manuals.length;

  async function change(input: { modelNumber?: string; wholeLibrary?: boolean }) {
    setPending(true);
    setMessage(null);
    const result = await changeUnitAction({ conversationId: conversation.id, ...input });
    setPending(false);
    if ("error" in result) {
      setMessage(result.error);
      return;
    }
    onScope(result.scope, result.unit, result.vehicle);
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
            Model number
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

export function CausesPanel({
  conversation,
  reply,
  replyTurnId,
  previousTitles,
  busy,
  afterCauses,
  onConversation,
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
}) {
  const [pending, setPending] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<CauseSystem | null>(null);
  const [hovered, setHovered] = useState<CauseSystem | null>(null);

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

  async function mark(index: number, verdict: CauseVerdict, viaKeyboard: boolean) {
    if (!replyTurnId) return;
    const pressed = verdict === "open" ? rows[index]?.verdict : verdict;
    setPending(index);
    setMessage(null);
    const result = await markCauseAction({ conversationId: conversation.id, turnId: replyTurnId, index, verdict });
    setPending(null);
    if ("error" in result) {
      setMessage(result.error);
      return;
    }
    onConversation(result);
    // The cause may have moved (ruled out sinks, confirmed rises). The page
    // stays where it is for a tap; from the keyboard, the focus (and the
    // view) follows the cause.
    requestAnimationFrame(() => {
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
      const drawing = document.querySelector("#unit-graphic svg.ug");
      if (drawing && !inSight(drawing)) document.getElementById("unit-graphic")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  const unsent = conversation.feedback.filter((entry) => entry.sentInSeq === null).length;
  const active = hovered ?? selected;

  return (
    <div className="space-y-4">
      {conversation.vehicle && (
        <UnitCard vehicle={conversation.vehicle} rows={rows} active={active} onSelect={(system) => selectZone(system, "drawing")} hasReply={reply !== null} />
      )}

      <Section label="Likely causes" icon={<CausesIcon />} count={rows.length > 0 ? rows.length : undefined}>
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
              />
            ))}
          </ol>
        )}
        {unsent > 0 && <p className="mt-3 text-xs text-ink-muted">Claude hears about your marks with your next message.</p>}
        {message && (
          <p role="status" className="mt-2 text-sm text-trail">
            {message}
          </p>
        )}
      </Section>

      {afterCauses}

      {reply && reply.nextChecks.length > 0 && (
        <Section label="Next checks" icon={<ChecksIcon />} count={reply.nextChecks.length}>
          <ol className="space-y-2">
            {reply.nextChecks.map((check, index) => (
              <CheckItem key={index} check={check} step={index + 1} />
            ))}
          </ol>
        </Section>
      )}

      {reply && reply.safetyNotes.length > 0 && (
        <section aria-label="Safety" className="rounded-xl border border-trail/40 bg-trail/10 px-4 py-3 text-trail">
          <h2 className="flex items-center gap-2 font-mono text-[13px] font-medium tracking-[0.16em] uppercase">
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

      <ScopeCard
        conversation={conversation}
        disabled={busy}
        onScope={(scope, unit, vehicle) => onConversation({ scope, unit, vehicle })}
      />
    </div>
  );
}
