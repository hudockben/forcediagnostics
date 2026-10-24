"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";

import { CAUSE_SYSTEMS, SYSTEM_LABELS, type CauseSystem, type DrawnSystem, type Glow, type UnitVehicle, type ZoneState } from "@/lib/diagnose-zones";
import { FLAG_COLOURS, KEY_WORDS, LINE_COLOURS, METER_LIT, calloutItems, calloutMark, glowWords, isLit, modeByDefault, unitSummary, type ViewMode } from "@/lib/unit-3d/look";
import type { ProjectedFrame, UnitViewer, ViewPreset } from "@/lib/unit-3d/viewer";
import { CIRCLE_AT, fitCallouts, type Callout } from "@/lib/unit-graphic/callouts";
import { UNIT_LINE_NAMES, type UnitSpec } from "@/lib/unit-vehicle";

import { BackIcon, CheckIcon, CrossIcon, ExpandIcon, PhantomIcon, ResetIcon, SolidIcon, UnitIcon, ZoomInIcon, ZoomOutIcon } from "./icons";
import { UnitGraphic } from "./unit-graphic";

// The unit as a shaded 3D model of the machine (its line, seats and
// colour), rendered like a manufacturer's studio shot with a service
// manual's line-work, on a light plate: in phantom view (the default once
// something is flagged) the body keeps its paint but turns see-through and
// the suspect parts inside are drawn solid in flat colours, called out with
// numbered circles (the causes' numbers in the list). Still on the
// diagnosis screen, where tapping a callout or a part picks that system
// (its causes are highlighted in the list); Expand opens it full screen to
// spin, zoom and pan, where tapping a system flies to it and opens its
// causes and manual pictures. three.js is only loaded here (a dynamic
// import); until it's ready, and wherever WebGL isn't there or fails, the
// line drawing shows instead, in the same box, so nothing jumps. One WebGL
// context serves both views: the canvas moves into the full-screen view and
// back.

export const DRAWN_SYSTEMS = CAUSE_SYSTEMS.filter((system): system is DrawnSystem => system !== "other");
export const isDrawnSystem = (value: unknown): value is DrawnSystem => DRAWN_SYSTEMS.includes(value as DrawnSystem);

// drawing: the server's and the first paint; loading: three.js is building
// the unit; ready: the 3D unit; lost: the GPU took the context away (the
// drawing shows until it's back); fallback: no WebGL here, the drawing.
type Status = "drawing" | "loading" | "ready" | "lost" | "fallback";

// Callouts are laid out for 13px text.
const LABEL_FONT = 13;
// Below this the card's callouts are numbered circles alone (the key names
// them): full labels two to a row would run off a phone's plate.
const FULL_LABELS_FROM = 420;
// Context losses after which the drawing stays for good.
const MAX_LOSSES = 3;

function useReducedMotion() {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

// True in the browser once hydrated, false on the server: portals into
// the document only where there is one.
const noSubscribe = () => () => {};
export function useMounted() {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

// Where full-screen views go: inside the app's shell (so the bay tablet's
// lock, which makes the whole shell inert, covers them too), beside the
// page they cover.
export function overlayRoot() {
  return document.getElementById("app-overlays") ?? document.body;
}

// The latest projected frame, for the callouts (only they redraw as the
// camera moves).
function frameStore() {
  let frame: ProjectedFrame | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => frame,
    set(next: ProjectedFrame | null) {
      frame = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
type FrameStore = ReturnType<typeof frameStore>;

export function unitName(model: UnitSpec) {
  const line = UNIT_LINE_NAMES[model.line];
  const seats = model.vehicle === "utv" && model.seats >= 4 ? ` ${model.seats}-seat` : model.line === "sportsman" && model.seats === 2 ? " Touring" : "";
  const six = model.sixWheels ? " 6x6" : "";
  const size = model.size === "youth" ? "Youth " : "";
  return `${size}${line}${six}${seats}`;
}

export function paintName(model: UnitSpec) {
  return model.paint.known ? model.paint.name : "Paint not listed";
}

// --- The card's header and key -------------------------------------------------------

const headerButton =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

// Solid or phantom: two buttons side by side, the one in use pressed and
// always labelled in words (a gloved finger on a tablet gets no tooltip);
// the other's word too where the card has room.
export function ModeSwitch({ mode, onMode, className = "" }: { mode: ViewMode; onMode: (mode: ViewMode) => void; className?: string }) {
  return (
    <div role="group" aria-label="Body" data-mode-toggle className={`inline-flex shrink-0 rounded-lg border border-white/15 p-0.5 ${className}`}>
      {(["solid", "phantom"] as const).map((option) => (
        <button
          key={option}
          type="button"
          data-mode-option={option}
          aria-pressed={mode === option}
          title={option === "solid" ? "The body as it is" : "See through the body to the flagged parts"}
          onClick={() => onMode(option)}
          className={`inline-flex min-h-10 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none ${
            mode === option ? "bg-white/12 text-ink" : "text-ink-muted hover:text-ink"
          }`}
        >
          {option === "solid" ? <SolidIcon /> : <PhantomIcon />}
          <span className={mode === option ? "" : "sr-only @[26rem]:not-sr-only"}>{option === "solid" ? "Solid" : "Phantom"}</span>
        </button>
      ))}
    </div>
  );
}

// The unit's name and paint (a swatch of it), and the controls.
export function UnitHeader({ title, model, children }: { title: string; model: UnitSpec | null; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pt-3 pb-2 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {model && (
          <span
            aria-hidden
            className="size-3.5 shrink-0 rounded-full border border-white/25"
            style={{ background: model.paint.camo ? "repeating-linear-gradient(135deg,#8f805f 0 3px,#5b4733 3px 6px,#6e6a4f 6px 9px)" : model.paint.base }}
          />
        )}
        <div className="min-w-0">
          <h2 className="truncate text-[15px] leading-5 font-semibold text-ink">{title}</h2>
          {model && <p className="truncate text-xs leading-4 text-ink-muted">{paintName(model)}</p>}
        </div>
      </div>
      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

// The numbered circle of a callout (or the key), by the system's state.
function NumberMark({ glow, muted, rank, size }: { glow: Glow; muted: boolean; rank: number | null; size: number }) {
  const mark = calloutMark(glow, muted);
  return (
    <span
      aria-hidden
      data-number={rank ?? undefined}
      className="grid shrink-0 place-items-center rounded-full border-[1.5px] leading-none font-semibold tabular-nums"
      style={{ width: size, height: size, background: mark.fill, borderColor: mark.ring, color: mark.text, fontSize: Math.round(size * 0.56) }}
    >
      {glow === "ruled_out" ? <CrossIcon className="size-[70%]" /> : rank}
    </span>
  );
}

// A confirmed cause's check: after its number, never over it.
function ConfirmedMark({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      data-mark="confirmed"
      className="grid shrink-0 place-items-center rounded-full border-[1.5px] bg-white"
      style={{ width: size, height: size, borderColor: FLAG_COLOURS.confirmed, color: FLAG_COLOURS.confirmed }}
    >
      <CheckIcon className="size-[78%]" />
    </span>
  );
}

function Meter({ glow }: { glow: Glow }) {
  const lit = METER_LIT[glow];
  if (lit === undefined) return null;
  return (
    <span aria-hidden data-meter={lit} className="flex shrink-0 gap-[2px]">
      {[1, 2, 3].map((segment) => (
        <span key={segment} className={`h-[9px] w-[3px] rounded-[1px] ${segment <= lit ? "bg-current opacity-80" : "bg-current opacity-20"}`} />
      ))}
    </span>
  );
}

// Under the unit: each numbered callout with its name and likelihood in
// words, then the ruled-out systems with their marker.
export function UnitKey({ states, mode }: { states: ZoneState[]; mode: ViewMode | null }) {
  const { numbered, ruledOut } = calloutItems(states);
  if (numbered.length === 0 && ruledOut.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <ul aria-label="Key" className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] leading-5">
        {numbered.map((state) => (
          <li key={state.system} data-key={state.system} data-rank={state.rank} className="flex items-center gap-1.5">
            <NumberMark glow={state.glow} muted={state.muted} rank={state.rank} size={18} />
            {state.glow === "confirmed" && <ConfirmedMark size={15} />}
            <span className="text-ink">{SYSTEM_LABELS[state.system]}</span>
            <span className="text-ink-muted">{state.muted ? `${KEY_WORDS[state.glow as Exclude<Glow, "none">]}, set aside` : KEY_WORDS[state.glow as Exclude<Glow, "none">]}</span>
          </li>
        ))}
        {ruledOut.map((state) => (
          <li key={state.system} data-key={state.system} data-ruled-out className="flex items-center gap-1.5">
            <NumberMark glow="ruled_out" muted={false} rank={null} size={18} />
            <span className="text-ink-muted line-through decoration-ink-muted/60">{SYSTEM_LABELS[state.system]}</span>
            <span className="text-ink-muted">Ruled out</span>
          </li>
        ))}
      </ul>
      {/* On a phone the pressed Phantom button says it, and the causes come first. */}
      {mode === "phantom" && <p className="text-xs text-ink-muted max-sm:hidden">Phantom view: the body is see-through; flagged parts are drawn solid.</p>}
    </div>
  );
}

// --- The unit ---------------------------------------------------------------------------

export function Unit3D({
  model,
  vehicle,
  states,
  active,
  onSelect,
  examining,
  onExamine,
  onCloseExamine,
  sheet,
  title,
  footer,
}: {
  model: UnitSpec;
  vehicle: UnitVehicle;
  // The systems with causes (drawn ones).
  states: ZoneState[];
  active: CauseSystem | null;
  // A system picked on the card: its causes are highlighted in the list.
  onSelect: (system: CauseSystem) => void;
  // The full-screen view: closed (null), open on the whole unit, or on a system.
  examining: DrawnSystem | "unit" | null;
  onExamine: (target: DrawnSystem | "unit") => void;
  onCloseExamine: () => void;
  // What the full-screen view's sheet shows for a system.
  sheet: (system: DrawnSystem) => ReactNode;
  title: string;
  // Under the unit (the key), told whether it's in phantom view.
  footer?: (mode: ViewMode | null) => ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const [status, setStatus] = useState<Status>("drawing");
  const [modeChoice, setModeChoice] = useState<ViewMode | null>(null);
  // Bumped to build the unit again (the GPU gave a lost context back).
  const [generation, setGeneration] = useState(0);
  const losses = useRef(0);
  const viewer = useRef<UnitViewer | null>(null);
  const inlineHost = useRef<HTMLDivElement>(null);
  const stageHost = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [frames] = useState(frameStore);
  // Phantom by default once something is flagged; the tech's choice after
  // that; always solid when nothing is (the switch is hidden then).
  const mode: ViewMode = modeByDefault(states) === "solid" ? "solid" : (modeChoice ?? "phantom");
  // Never full screen without the 3D unit (an address with ?examine on a
  // device without WebGL).
  const open = examining !== null && (status === "ready" || status === "loading");
  const modelKey = `${model.line}|${model.seats}|${model.size}|${model.sixWheels}|${model.paint.key}`;
  const statesKey = JSON.stringify(states.map((state) => [state.system, state.glow, state.muted]));
  // Reduced motion, for a viewer being made, and changed on the live one
  // (no rebuild).
  const motion = useRef(reducedMotion);
  useEffect(() => {
    motion.current = reducedMotion;
    viewer.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion, status]);

  // Load three.js and the viewer, and build the machine, a step at a time.
  useEffect(() => {
    let cancelled = false;
    let made: UnitViewer | null = null;
    const isCancelled = () => cancelled;
    import("@/lib/unit-3d/viewer")
      .then(async (module) => {
        if (cancelled) return;
        if (!module.webglAvailable()) {
          setStatus("fallback");
          return;
        }
        const v = new module.UnitViewer({
          reducedMotion: motion.current,
          onFrame(frame) {
            frames.set(frame);
            const host = v.canvas.parentElement;
            if (host) host.dataset.camera = v.cameraState;
            if (box.current) box.current.dataset.pixels = JSON.stringify(v.pixels);
            setStatus((old) => (old === "loading" ? "ready" : old));
          },
          onLost() {
            // The drawing until the context is back.
            losses.current++;
            frames.set(null);
            setStatus(losses.current >= MAX_LOSSES ? "fallback" : "lost");
          },
          onRestored() {
            // Everything drawn on the GPU is gone: build it all again.
            if (losses.current < MAX_LOSSES) setGeneration((n) => n + 1);
          },
        });
        made = v;
        viewer.current = v;
        setStatus("loading");
        const built = await v.load(model, isCancelled);
        if (!built || cancelled) return;
        // Draws as soon as it has a size (see the effect below).
        const host = inlineHost.current;
        if (host && !v.canvas.parentElement) host.appendChild(v.canvas);
        const { width, height } = host?.getBoundingClientRect() ?? { width: 0, height: 0 };
        v.resize(width, height, Math.min(window.devicePixelRatio || 1, 2));
        v.setView("three_quarter", false);
        // Not over a context lost while it was being built (that shows the
        // drawing until it's back).
        setStatus((old) => (old === "loading" ? "ready" : old));
      })
      .catch((error) => {
        // An old browser, the code couldn't be fetched (offline), or the
        // machine couldn't be built: give back what was made.
        console.error("Couldn't start the 3D unit", error);
        if (viewer.current === made) viewer.current = null;
        made?.dispose();
        made = null;
        if (!cancelled) setStatus("fallback");
      });
    return () => {
      cancelled = true;
      made?.dispose();
      if (viewer.current === made) viewer.current = null;
      frames.set(null);
    };
    // The viewer is made once per machine (and again after a lost context
    // comes back); states, views and motion follow below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, generation]);

  // Which systems are flagged, and how; the one picked; solid or phantom.
  // The page's checks read how they're drawn (no light given off anywhere).
  useEffect(() => {
    const v = viewer.current;
    if (!v || status !== "ready") return;
    v.setStates(states, active, mode);
    const report = v.report();
    if (box.current) {
      box.current.dataset.looks = JSON.stringify(report.looks);
      box.current.dataset.emissive = String(report.emissive);
      box.current.dataset.pixels = JSON.stringify(v.pixels);
    }
    // statesKey stands for states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statesKey, active, mode, status]);

  // The canvas goes where it's shown: the diagnosis screen, or full screen
  // with the controls.
  useEffect(() => {
    const v = viewer.current;
    const host = open ? stageHost.current : inlineHost.current;
    if (!v || !host || status !== "ready") return;
    if (v.canvas.parentElement !== host) host.appendChild(v.canvas);
    // Full screen, a finger turns the machine; on the diagnosis screen it
    // scrolls (or zooms) the page.
    v.canvas.style.touchAction = open ? "none" : "pan-y pinch-zoom";
    v.setControls(open);
    if (open) v.setFit(0.9, 0.72);
    else v.setFit(0.98, 0.72);
    const fit = () => {
      const rect = host.getBoundingClientRect();
      v.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
    };
    fit();
    if (!open) v.setView("three_quarter", false);
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [open, status]);

  // Full screen, close in on the system picked; the whole unit otherwise.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !open || status !== "ready") return;
    if (examining === "unit") v.setView("three_quarter", true);
    else if (examining) v.flyTo(examining, true);
  }, [examining, open, status]);

  // Only draw while it can be seen: not off screen, in a hidden tab, or
  // under a manual page opened full screen.
  const covered = useSearchParams().has("manual-page");
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let inView = true;
    const update = () => viewer.current?.setVisible(!document.hidden && !covered && (open || inView));
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [open, status, covered]);

  const shown = status === "ready";
  const hasLit = states.some((state) => isLit(state.glow));
  const summary = unitSummary(unitName(model), states);
  const withCauses = new Set(states.map((state) => state.system as DrawnSystem));

  return (
    <>
      <UnitHeader title={title} model={model}>
        {shown && hasLit && <ModeSwitch mode={mode} onMode={setModeChoice} />}
        {shown && (
          <button
            ref={expandButton}
            type="button"
            data-expand
            onClick={() => onExamine("unit")}
            aria-label="Expand: examine the unit full screen"
            title="Examine full screen"
            className={`${headerButton} border-white/15 text-ink hover:border-white/30`}
          >
            <ExpandIcon />
            <span className="hidden @[34rem]:inline">Expand</span>
          </button>
        )}
      </UnitHeader>
      <div className="px-3 sm:px-4">
        <div
          ref={box}
          data-unit3d
          data-status={status}
          data-line={model.line}
          data-seats={model.seats}
          data-size={model.size}
          data-six={model.sixWheels}
          data-paint={model.paint.key}
          data-mode={shown ? mode : undefined}
          className="unit-plate relative aspect-[3/2] w-full overflow-hidden rounded-lg sm:aspect-[16/10] xl:aspect-[4/3]"
        >
          {!shown && (
            // The drawing: what the server sends (the same box), what shows
            // (and answers taps) while the 3D unit loads, and where there's
            // no WebGL.
            <div className="absolute inset-0 flex items-center justify-center p-1">
              {/* The drawing fits the box (its own shape, centred). */}
              <div className={`relative size-full [&_svg.ug]:size-full ${vehicle === "generator" ? "max-w-[22rem]" : ""}`}>
                <UnitGraphic vehicle={vehicle} states={states} active={active} onSelect={onSelect} />
              </div>
            </div>
          )}
          <div
            ref={inlineHost}
            role={shown ? "img" : undefined}
            aria-label={shown ? summary : undefined}
            data-unit-canvas
            className={`absolute inset-0 ${shown ? "" : "pointer-events-none opacity-0"} ${open ? "hidden" : ""}`}
            onPointerDown={(event) => tapStart(event)}
            onPointerUp={(event) => {
              const at = tapEnd(event);
              if (!at || !viewer.current) return;
              // A tap on a flagged part picks its system (Expand is the way
              // into full screen).
              const system = viewer.current.pick(at.x, at.y, withCauses);
              if (system) onSelect(system);
            }}
          />
          {shown && !open && <Callouts store={frames} states={states} active={active} onPick={onSelect} action="Show its causes" />}
        </div>
      </div>
      {footer && <div className="px-3 pt-2.5 sm:px-4">{footer(shown ? mode : null)}</div>}
      {open &&
        createPortal(
          <Examine
            model={model}
            title={title}
            states={states}
            active={active}
            examining={examining}
            mode={mode}
            hasLit={hasLit}
            onMode={setModeChoice}
            onPick={(system) => onExamine(system)}
            onClose={() => {
              onCloseExamine();
              requestAnimationFrame(() => expandButton.current?.focus({ preventScroll: true }));
            }}
            onUnit={() => onExamine("unit")}
            viewer={viewer}
            stage={stageHost}
            frames={frames}
            ready={shown}
            summary={summary}
            withCauses={withCauses}
            sheet={sheet}
          />,
          overlayRoot(),
        )}
    </>
  );
}

// While a full-screen view is open: the page behind it doesn't scroll and
// is inert (out of the tab order and hidden from screen readers): every
// part of the app's shell but the overlays the views live in. The bay
// tablet's lock makes the whole shell inert on top of that, views and all,
// and lifting it leaves the page held. Returns the undo. Counted, so the
// page is let go when the last view goes, in whatever order they go (Back
// closes the top one; leaving the page, say by Open in manual, takes them
// all).
let holds = 0;
let held: { overflow: string; inert: [Element, boolean][] } | null = null;
export function holdPage(focus: HTMLElement | null) {
  const root = document.documentElement;
  if (holds++ === 0) {
    const shell = document.getElementById("app-shell");
    const page = shell ? [...shell.children].filter((child) => child.id !== "app-overlays") : [];
    held = { overflow: root.style.overflow, inert: page.map((element): [Element, boolean] => [element, (element as HTMLElement).inert]) };
    root.style.overflow = "hidden";
    for (const element of page) (element as HTMLElement).inert = true;
  }
  focus?.focus({ preventScroll: true });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds > 0 || !held) return;
    root.style.overflow = held.overflow;
    for (const [element, inert] of held.inert) (element as HTMLElement).inert = inert;
    held = null;
  };
}

// A tap (not a drag) on the canvas, in its own pixels.
let tapFrom: { x: number; y: number; at: number } | null = null;
function tapStart(event: ReactPointerEvent) {
  tapFrom = { x: event.clientX, y: event.clientY, at: performance.now() };
}
function tapEnd(event: ReactPointerEvent) {
  const from = tapFrom;
  tapFrom = null;
  if (!from || Math.hypot(event.clientX - from.x, event.clientY - from.y) > 8 || performance.now() - from.at > 600) return null;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// --- Callouts ------------------------------------------------------------------------

const LINE = "#262a2f";
const RANK: Record<Glow, number> = { confirmed: 5, high: 4, medium: 3, low: 2, ruled_out: 1, none: 0 };

// Each lit system's callout, as in a service manual: a numbered circle (its
// cause's number in the Likely causes list) with the system's name and the
// list's likelihood meter beside it, laid out round the machine (a band
// above and one below, never over each other, leaders that don't run
// through another callout), a thin leader to a dot on the part. Always
// inside the plate: where full labels won't fit (a phone, a crowd of
// systems) they're the numbered circles alone, the key underneath naming
// them; in full screen the system picked keeps its name. A part off the
// screen gets no callout. Each is a button. A ruled-out system gets a small
// grey cross where it is.
function Callouts({
  store,
  states,
  active,
  onPick,
  keep = null,
  full = false,
  action,
}: {
  store: FrameStore;
  states: ZoneState[];
  active: CauseSystem | null;
  onPick: (system: DrawnSystem) => void;
  // Full screen: the system whose name stays when the others are numbers.
  keep?: DrawnSystem | null;
  // Full screen: full labels allowed at any width.
  full?: boolean;
  // What a callout does, for its label ("Show its causes", "Examine").
  action: string;
}) {
  const frame = useSyncExternalStore(store.subscribe, store.get, () => null);
  if (!frame || frame.width < 2 || frame.height < 2) return null;
  const { width, height } = frame;
  const byZone = new Map(states.map((state) => [state.system, state]));
  const onCanvas = (point: { x: number; y: number; behind: boolean } | undefined): point is { x: number; y: number; behind: boolean } =>
    !!point && !point.behind && point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
  const items = states
    .filter((state) => isLit(state.glow) && isDrawnSystem(state.system))
    .map((state) => ({ state, point: frame.points.get(state.system as DrawnSystem) }))
    .filter((item): item is { state: ZoneState; point: { x: number; y: number; behind: boolean } } => onCanvas(item.point));
  const margin = 6;
  const bounds = { x: margin, y: margin, w: width - margin * 2, h: height - margin * 2 };
  // The machine's outline, leaving at least a row of callouts above and
  // below.
  const row = LABEL_FONT * 3;
  const inner = {
    x: Math.max(margin, frame.box.x),
    y: Math.max(margin + row, frame.box.y),
    w: Math.min(width - margin * 2, frame.box.w),
    h: Math.min(height - margin * 2 - row * 2, frame.box.h),
  };
  inner.w = Math.max(40, Math.min(inner.w, width - margin - inner.x));
  inner.h = Math.max(40, Math.min(inner.h, height - margin - row - inner.y));
  const { callouts, compact } = fitCallouts(
    items.map(({ state, point }) => ({
      zone: state.system as DrawnSystem,
      anchor: [point.x, point.y] as const,
      // A confirmed one's check sits after its number: room for it.
      text: SYSTEM_LABELS[state.system] + (state.glow === "confirmed" ? "\u2003\u2003" : ""),
      rank: RANK[state.glow] + (state.muted ? -2 : 0),
    })),
    inner,
    LABEL_FONT,
    bounds,
    { keep, compactOnly: !full && width < FULL_LABELS_FROM },
  );
  const ruledOut = states.filter((state) => state.glow === "ruled_out" && isDrawnSystem(state.system));
  const radius = LABEL_FONT * 0.74;
  return (
    <div className="pointer-events-none absolute inset-0" data-labels data-compact={compact}>
      <svg className="absolute inset-0 size-full" aria-hidden>
        {callouts.map((callout: Callout) => {
          const cy = callout.y + callout.h / 2;
          const r = callout.compact ? callout.h * 0.42 : radius;
          const points = callout.leader.map(([x, y]) => [x, y]);
          points[points.length - 1][1] = callout.band === "top" ? cy + r : cy - r;
          return (
            <g key={callout.zone} data-leader={callout.zone} opacity={byZone.get(callout.zone)?.muted ? 0.55 : 0.9}>
              <path d={`M${points.map(([x, y]) => `${x} ${y}`).join("L")}`} fill="none" stroke={LINE} strokeWidth={1} />
              <circle cx={callout.leader[0][0]} cy={callout.leader[0][1]} r={2.6} fill={LINE} />
            </g>
          );
        })}
        {ruledOut.map((state) => {
          const point = frame.points.get(state.system as DrawnSystem);
          if (!onCanvas(point)) return null;
          return (
            <g key={state.system} data-ruled-out={state.system} data-mark="ruled_out" stroke="#5f656b" strokeWidth={1.4}>
              <circle cx={point.x} cy={point.y} r={7} fill="#ffffff" stroke="#6b7076" strokeWidth={1.2} />
              <path d={`M${point.x - 3} ${point.y - 3}l6 6m0 -6l-6 6`} />
            </g>
          );
        })}
      </svg>
      {callouts.map((callout: Callout) => {
        const state = byZone.get(callout.zone)!;
        const count = state.causes.length;
        const picked = active === callout.zone;
        const confirmed = state.glow === "confirmed";
        return (
          <button
            key={callout.zone}
            type="button"
            data-callout={callout.zone}
            data-compact={callout.compact ? "true" : "false"}
            data-glow={state.glow}
            data-muted={state.muted}
            data-active={picked}
            data-rank={state.rank ?? undefined}
            aria-label={`${SYSTEM_LABELS[callout.zone]}: ${count} ${count === 1 ? "cause" : "causes"}, ${glowWords(state.glow)}${state.rank ? ` (number ${state.rank} in the list)` : ""}. ${action}.`}
            aria-pressed={picked}
            onClick={() => onPick(callout.zone)}
            style={{ left: callout.hit.x, top: callout.hit.y, width: callout.hit.w, height: callout.hit.h }}
            className="group pointer-events-auto absolute focus-visible:outline-none"
          >
            <span
              // A soft halo in the plate's grey keeps the name readable where
              // it sits over the machine (zoomed in full screen); no pill.
              className={`absolute flex items-center gap-1.5 rounded-md text-[12.5px] leading-none font-medium whitespace-nowrap text-[#1f2328] [text-shadow:0_0_2px_#e6e8eb,0_0_3px_#e6e8eb,0_0_5px_#e6e8eb] ${state.muted ? "opacity-75" : ""} group-focus-visible:ring-2 group-focus-visible:ring-[#085c52]`}
              style={{
                left: callout.x - callout.hit.x,
                top: callout.y - callout.hit.y,
                width: callout.w,
                height: callout.h,
                paddingLeft: callout.compact ? 0 : callout.h * CIRCLE_AT - radius,
                justifyContent: callout.compact ? "center" : undefined,
              }}
            >
              {/* The one picked: the accent ring round its number (its words stay dark). */}
              <span className="relative rounded-full" style={picked ? { boxShadow: `0 0 0 2px #dde1e5, 0 0 0 4px ${LINE_COLOURS.picked}` } : undefined}>
                <NumberMark glow={state.glow} muted={state.muted} rank={state.rank} size={callout.compact ? Math.round(callout.h * 0.84) : Math.round(radius * 2)} />
                {/* Numbers alone: the check on the ring's corner, clear of the number. */}
                {callout.compact && confirmed && (
                  <span className="absolute -top-1.5 -right-2">
                    <ConfirmedMark size={12} />
                  </span>
                )}
              </span>
              {!callout.compact && (
                <>
                  {confirmed && <ConfirmedMark size={14} />}
                  <span className="min-w-0 truncate">{SYSTEM_LABELS[callout.zone]}</span>
                  <span className="ml-auto pr-1 text-[#3a3f45]">
                    <Meter glow={state.glow} />
                  </span>
                </>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// --- Full screen -------------------------------------------------------------------

const toolClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-charcoal-900 px-3 text-sm font-medium text-ink transition hover:border-white/30 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

const PRESETS: { preset: ViewPreset; label: string; key: string }[] = [
  { preset: "front", label: "Front", key: "1" },
  { preset: "rear", label: "Rear", key: "2" },
  { preset: "left", label: "Left", key: "3" },
  { preset: "right", label: "Right", key: "4" },
  { preset: "top", label: "Top", key: "5" },
];

function Examine({
  model,
  title,
  states,
  active,
  examining,
  mode,
  hasLit,
  onMode,
  onPick,
  onClose,
  onUnit,
  viewer,
  stage,
  frames,
  ready,
  summary,
  withCauses,
  sheet,
}: {
  model: UnitSpec;
  title: string;
  states: ZoneState[];
  active: CauseSystem | null;
  examining: DrawnSystem | "unit" | null;
  mode: ViewMode;
  hasLit: boolean;
  onMode: (mode: ViewMode) => void;
  onPick: (system: DrawnSystem) => void;
  onClose: () => void;
  onUnit: () => void;
  viewer: RefObject<UnitViewer | null>;
  stage: RefObject<HTMLDivElement | null>;
  frames: FrameStore;
  ready: boolean;
  summary: string;
  withCauses: Set<DrawnSystem>;
  sheet: (system: DrawnSystem) => ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const system = examining && examining !== "unit" ? examining : null;
  const state = system ? states.find((s) => s.system === system) : undefined;

  // The page behind doesn't scroll and can't be tabbed to; focus starts
  // on Back.
  useEffect(() => holdPage(closeButton.current), []);

  function view(preset: ViewPreset) {
    setViewsOpen(false);
    viewer.current?.setView(preset, true);
  }

  function onKeyDown(event: KeyboardEvent) {
    const v = viewer.current;
    if (event.key === "Escape") {
      event.preventDefault();
      if (viewsOpen) setViewsOpen(false);
      else onClose();
      return;
    }
    // Keys move the machine unless typing or on a control.
    const target = event.target as HTMLElement;
    if (!v || target.closest("input, textarea, select, [data-sheet]")) return;
    const step = 0.18;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => (event.shiftKey ? v.pan(-1, 0) : v.orbit(-step, 0)),
      ArrowRight: () => (event.shiftKey ? v.pan(1, 0) : v.orbit(step, 0)),
      ArrowUp: () => (event.shiftKey ? v.pan(0, 1) : v.orbit(0, -step * 0.6)),
      ArrowDown: () => (event.shiftKey ? v.pan(0, -1) : v.orbit(0, step * 0.6)),
      "+": () => v.zoom(0.85),
      "=": () => v.zoom(0.85),
      "-": () => v.zoom(1 / 0.85),
      r: () => onUnit(),
      p: () => hasLit && onMode(mode === "phantom" ? "solid" : "phantom"),
    };
    for (const preset of PRESETS) keys[preset.key] = () => view(preset.preset);
    const run = keys[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (run && !(target.tagName === "BUTTON" && (event.key === "Enter" || event.key === " "))) {
      event.preventDefault();
      run();
    }
  }

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`Examine the ${unitName(model)}`}
      data-examine
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[35] flex flex-col bg-charcoal-900 text-ink"
    >
      <header className="@container flex flex-wrap items-center gap-2 border-b border-white/10 bg-charcoal-900 px-3 py-2">
        <button ref={closeButton} type="button" data-examine-close onClick={onClose} className={toolClass}>
          <BackIcon />
          Back
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="truncate text-xs text-ink-muted">{paintName(model)}</p>
        </div>
        {hasLit && <ModeSwitch mode={mode} onMode={onMode} />}
        <button type="button" data-reset onClick={onUnit} className={toolClass} title="R (keyboard)">
          <ResetIcon />
          <span className="max-sm:sr-only">Reset</span>
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:landscape:flex-row">
        {/* The plate: the stage (the canvas and its callouts, nothing over
            them) and, under it, the views and zoom. */}
        <div className="unit-plate flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            className="relative min-h-0 flex-1 overflow-hidden"
            onWheel={(event) => {
              // A wheel over a callout zooms too (the canvas's own controls
              // take it over the canvas).
              if (event.target !== viewer.current?.canvas) viewer.current?.zoom(event.deltaY > 0 ? 1.12 : 1 / 1.12);
            }}
          >
            <div
              ref={stage}
              role="img"
              aria-label={summary}
              data-unit-canvas
              data-stage
              className="absolute inset-0 touch-none"
              onPointerDown={(event) => tapStart(event)}
              onPointerUp={(event) => {
                const at = tapEnd(event);
                if (!at || !viewer.current) return;
                const hit = viewer.current.pick(at.x, at.y, withCauses);
                if (hit) onPick(hit);
              }}
              onContextMenu={(event) => event.preventDefault()}
            />
            {ready && <Callouts store={frames} states={states} active={system ?? active} onPick={onPick} keep={system} full action="Examine" />}
            {!ready && <p className="absolute inset-x-0 top-6 text-center text-sm text-[#5f656b]">Loading the 3D unit…</p>}
          </div>
          <div data-examine-tools className="relative flex shrink-0 items-center gap-2 px-2 pt-1 pb-2">
            {/* Wide: the five views as buttons; a phone: one Views button
                opening them (a row of five would cover the unit). */}
            <div role="group" aria-label="Views" className="flex gap-1.5 max-sm:hidden">
              {PRESETS.map((preset) => (
                <button key={preset.preset} type="button" data-preset={preset.preset} onClick={() => view(preset.preset)} className={plateTool}>
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="sm:hidden">
              <button type="button" data-views aria-expanded={viewsOpen} onClick={() => setViewsOpen((open) => !open)} className={plateTool}>
                <UnitIcon />
                Views
              </button>
              {viewsOpen && (
                <div role="group" aria-label="Views" className="absolute bottom-full left-2 mb-1 flex flex-col gap-1 rounded-lg border border-black/15 bg-white/95 p-1 shadow-md">
                  {PRESETS.map((preset) => (
                    <button key={preset.preset} type="button" data-preset={preset.preset} onClick={() => view(preset.preset)} className={`${plateTool} justify-start border-transparent shadow-none`}>
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="min-w-0 flex-1 truncate text-center text-xs text-[#4b5158] max-lg:invisible">Drag to turn · scroll to zoom · right-drag to move · arrows, + −, 1–5, P for phantom</p>
            <div role="group" aria-label="Zoom" className="ml-auto flex gap-1.5">
              <button type="button" data-zoom="in" aria-label="Zoom in" onClick={() => viewer.current?.zoom(0.8)} className={plateTool}>
                <ZoomInIcon />
              </button>
              <button type="button" data-zoom="out" aria-label="Zoom out" onClick={() => viewer.current?.zoom(1.25)} className={plateTool}>
                <ZoomOutIcon />
              </button>
            </div>
          </div>
        </div>
        {system && (
          <aside
            data-sheet={system}
            aria-label={`${SYSTEM_LABELS[system]}: causes and manual pages`}
            className="flex max-h-[52%] min-h-0 flex-col border-t border-white/10 bg-charcoal-900 lg:landscape:max-h-none lg:landscape:w-[26rem] lg:landscape:border-t-0 lg:landscape:border-l"
          >
            <div className="flex items-center gap-2.5 border-b border-white/10 px-4 py-2">
              {state && <NumberMark glow={state.glow} muted={state.muted} rank={state.rank} size={22} />}
              {state?.glow === "confirmed" && <ConfirmedMark size={16} />}
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[15px] font-semibold text-ink">{SYSTEM_LABELS[system]}</h2>
                {state && <p className="text-xs text-ink-muted">{state.glow === "confirmed" ? "Confirmed" : glowWords(state.glow).replace(/^./, (c) => c.toUpperCase())}</p>}
              </div>
              <button type="button" onClick={onUnit} aria-label="Close the system" className={`${toolClass} border-transparent bg-transparent`}>
                <CrossIcon />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">{sheet(system)}</div>
          </aside>
        )}
      </div>
    </div>
  );
}

// Controls on the light plate.
const plateTool =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-black/15 bg-white/85 px-3 text-sm font-medium text-[#1f2328] shadow-sm transition hover:bg-white focus-visible:ring-2 focus-visible:ring-[#085c52] focus-visible:outline-none";
