"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";

import { CAUSE_SYSTEMS, SYSTEM_LABELS, type CauseSystem, type DrawnSystem, type Glow, type UnitVehicle, type ZoneState } from "@/lib/diagnose-zones";
import { FLAG_COLOURS, KEY_WORDS, LINE_COLOURS, METER_LIT, calloutItems, calloutMark, glowWords, isLit, modeByDefault, unitSummary, type ViewMode } from "@/lib/unit-3d/look";
import { BUBBLE_CLEAR, STRIP_HEIGHT, bubbleDocked, bubbleFits, leaderOf, onStage, piecesAlong, placeBubble, stripRect, stripTop, type Rect } from "@/lib/unit-3d/bubble";
import type { ProjectedFrame, UnitViewer, ViewPreset } from "@/lib/unit-3d/viewer";
import { CIRCLE_AT, fitCallouts, type Callout } from "@/lib/unit-graphic/callouts";
import { UNIT_LINE_NAMES, type UnitSpec } from "@/lib/unit-vehicle";

import { DrawingBubble, StageDrawingsContext, sameStageDrawings, stageDrawingsKey, type StageDrawings } from "./drawing-bubble";
import { BackIcon, CheckIcon, CrossIcon, ExpandIcon, PhantomIcon, ResetIcon, SolidIcon, UnitIcon, ZoomInIcon, ZoomOutIcon } from "./icons";
import { holdPage, overlayRoot } from "./overlays";
import { UnitGraphic } from "./unit-graphic";

// The unit as a shaded 3D model of the machine (its line, seats and
// colour), rendered like a manufacturer's studio shot with a service
// manual's line-work, on a light plate: in phantom view (the default once
// something is flagged) the body keeps its paint but turns see-through and
// the suspect parts inside are drawn solid in flat colours, called out with
// numbered circles (the causes' numbers in the list). Still on the
// diagnosis screen, where tapping a callout picks that system (its causes
// are highlighted in the list) and tapping any part, flagged or not, opens
// the full-screen view on its system; Expand opens it on the whole unit to
// spin, zoom and pan, where tapping a system flies to it and opens its
// sheet: its parts with their manual pages, and its causes; the part
// picked there gets a bubble on the unit beside it with its drawings from
// the manual (drawing-bubble.tsx), a leader to it. three.js is
// only loaded here (a dynamic import); until it's ready, and wherever WebGL
// isn't there or fails, the line drawing shows instead, in the same box, so
// nothing jumps, and a system tapped on it opens the same sheet full screen
// on its own. One WebGL context serves both views: the canvas moves into
// the full-screen view and back.

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
      {/* On a phone the pressed Phantom button says it, and the causes come
          first. No longer than it was, so the card stays its size. */}
      {mode === "phantom" && <p className="text-xs text-ink-muted max-sm:hidden">Phantom view: flagged parts solid. Tap a part for its manual pages.</p>}
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
  // The 3D unit full screen only where there is one; without it (no WebGL,
  // or the GPU took it away) a system's sheet opens on its own, and the
  // whole unit (an address with ?examine=unit) not at all.
  const open = examining !== null && (status === "ready" || status === "loading");
  const sheetOnly = examining !== null && examining !== "unit" && (status === "fallback" || status === "lost") ? examining : null;
  const [hover] = useState(hoverPicker);
  useEffect(() => () => hover.stop(), [hover]);
  const pick: Pick = (x, y) => viewer.current?.pick(x, y) ?? null;
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
                <UnitGraphic vehicle={vehicle} states={states} active={active} onSelect={onSelect} onOpen={onExamine} />
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
            // A tap on any part opens the full-screen view on its system (a
            // callout, over the canvas, picks its system instead). On the
            // click, not the pointer coming up: a touch that stops the page
            // scrolling gets no click, so it doesn't open the view.
            onClick={(event) => {
              const at = tapEnd(event);
              if (!at || !viewer.current) return;
              const system = viewer.current.pick(at.x, at.y, at.slack);
              if (system) onExamine(system);
            }}
            onPointerMove={(event) => shown && hover.move(event, pick)}
            onPointerLeave={(event) => hover.leave(event)}
          />
          {shown && !open && <Callouts store={frames} states={states} active={active} onPick={onSelect} action="Show its causes" />}
          {shown && !open && <HoverLabel picker={hover} />}
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
            hover={hover}
            sheet={sheet}
          />,
          overlayRoot(),
        )}
      {sheetOnly &&
        createPortal(
          <SheetView title={title} system={sheetOnly} state={states.find((state) => state.system === sheetOnly)} sheet={sheet} onClose={onCloseExamine} />,
          overlayRoot(),
        )}
    </>
  );
}

// On a mouse, the part under the pointer (a finger has no hover): the
// cursor says it can be tapped, its system's name sits by the pointer, and
// data-hover on the canvas's box says which. One raycast a frame at most,
// none while a button is down (turning the machine), and nothing redrawn.
// Made once per unit, like the frame store.
type Pick = (x: number, y: number) => DrawnSystem | null;
function hoverPicker() {
  let label: HTMLSpanElement | null = null;
  let frame = 0;
  let at: { host: HTMLElement; x: number; y: number; pick: Pick } | null = null;

  function show(host: HTMLElement, system: DrawnSystem | null, x = 0, y = 0) {
    host.style.cursor = system ? "pointer" : "";
    if (system) host.dataset.hover = system;
    else delete host.dataset.hover;
    if (!label) return;
    if (!system) {
      label.hidden = true;
      return;
    }
    label.textContent = SYSTEM_LABELS[system];
    label.hidden = false;
    const left = x + 14 + label.offsetWidth > host.clientWidth ? x - 10 - label.offsetWidth : x + 14;
    label.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${Math.round(Math.min(host.clientHeight - label.offsetHeight, y + 16))}px)`;
  }

  return {
    setLabel(element: HTMLSpanElement | null) {
      label = element;
    },
    move(event: ReactPointerEvent<HTMLElement>, pick: Pick) {
      const host = event.currentTarget;
      if (event.pointerType !== "mouse" || event.buttons !== 0) {
        at = null;
        show(host, null);
        return;
      }
      const rect = host.getBoundingClientRect();
      at = { host, x: event.clientX - rect.left, y: event.clientY - rect.top, pick };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (at) show(at.host, at.pick(at.x, at.y), at.x, at.y);
      });
    },
    leave(event: ReactPointerEvent<HTMLElement>) {
      at = null;
      show(event.currentTarget, null);
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
      at = null;
    },
  };
}
type HoverPicker = ReturnType<typeof hoverPicker>;

// The hovered system's name, on the light plate.
function HoverLabel({ picker }: { picker: HoverPicker }) {
  return (
    <span
      ref={(element) => picker.setLabel(element)}
      hidden
      aria-hidden
      data-hover-label
      className="pointer-events-none absolute top-0 left-0 z-[1] rounded bg-white/90 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-[#1f2328] shadow-sm ring-1 ring-black/10"
    />
  );
}

// A tap (not a drag) on the canvas, in its own pixels, with the slack a
// finger needs (a mouse needs none).
const FINGER_SLACK = 10;
let tapFrom: { x: number; y: number; at: number; finger: boolean } | null = null;
function tapStart(event: ReactPointerEvent) {
  tapFrom = { x: event.clientX, y: event.clientY, at: performance.now(), finger: event.pointerType !== "mouse" };
}
function tapEnd(event: ReactMouseEvent) {
  const from = tapFrom;
  tapFrom = null;
  if (!from || Math.hypot(event.clientX - from.x, event.clientY - from.y) > 8 || performance.now() - from.at > 600) return null;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top, slack: from.finger ? FINGER_SLACK : 0 };
}

// --- Callouts ------------------------------------------------------------------------

const LINE = "#262a2f";
const RANK: Record<Glow, number> = { confirmed: 5, high: 4, medium: 3, low: 2, ruled_out: 1, none: 0 };

type CalloutOptions = {
  // Full screen: the system whose name stays when the others are numbers.
  keep?: DrawnSystem | null;
  // Full screen: full labels allowed at any width.
  full?: boolean;
  // What the stage's top has over it (the drawing's strip on a phone):
  // the callouts go under it.
  top?: number;
};

// Where the callouts go for a frame (the callouts themselves, and what
// the drawing's bubble keeps off): the lit systems' labels and leaders,
// and the ruled-out systems' points, those on the canvas.
function calloutLayout(frame: ProjectedFrame, states: ZoneState[], { keep = null, full = false, top = 0 }: CalloutOptions) {
  const { width, height } = frame;
  const onCanvas = (point: { x: number; y: number; behind: boolean } | undefined): point is { x: number; y: number; behind: boolean } =>
    !!point && !point.behind && point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
  const items = states
    .filter((state) => isLit(state.glow) && isDrawnSystem(state.system))
    .map((state) => ({ state, point: frame.points.get(state.system as DrawnSystem) }))
    .filter((item): item is { state: ZoneState; point: { x: number; y: number; behind: boolean } } => onCanvas(item.point));
  const margin = 6;
  const bounds = { x: margin, y: margin + top, w: width - margin * 2, h: height - margin * 2 - top };
  // The machine's outline, leaving at least a row of callouts above and
  // below.
  const row = LABEL_FONT * 3;
  const inner = {
    x: Math.max(margin, frame.box.x),
    y: Math.max(margin + top + row, frame.box.y),
    w: Math.min(width - margin * 2, frame.box.w),
    h: Math.min(height - margin * 2 - top - row * 2, frame.box.h),
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
  const ruledOut = states
    .filter((state) => state.glow === "ruled_out" && isDrawnSystem(state.system))
    .map((state) => ({ system: state.system as DrawnSystem, point: frame.points.get(state.system as DrawnSystem) }))
    .filter((item): item is { system: DrawnSystem; point: { x: number; y: number; behind: boolean } } => onCanvas(item.point));
  return { callouts, compact, ruledOut };
}

// Round another flagged part's point, what the drawing's bubble keeps off
// (some of the part itself).
const OTHER_PART = Math.round(BUBBLE_CLEAR * 0.35);

// What the drawing's bubble mustn't cover (see src/lib/unit-3d/bubble.ts):
// each callout's label (and a little round it), the dot its leader ends in
// (for another system, some of the part round it), and the ruled-out
// marks; and, as far as it can, the leaders between them. And the picked
// system's own label, which the strip's leader mustn't run through.
function calloutObstacles(frame: ProjectedFrame, states: ZoneState[], options: CalloutOptions): BubbleObstacles {
  const { callouts, ruledOut } = calloutLayout(frame, states, options);
  const around = (x: number, y: number, r: number): Rect => ({ x: x - r, y: y - r, w: r * 2, h: r * 2 });
  const label = (callout: Callout): Rect => ({ x: callout.x - 4, y: callout.y - 4, w: callout.w + 8, h: callout.h + 8 });
  const own = callouts.find((callout) => callout.zone === options.keep);
  return {
    avoid: [
      ...callouts.flatMap((callout) => [label(callout), around(callout.leader[0][0], callout.leader[0][1], callout.zone === options.keep ? 8 : OTHER_PART)]),
      ...ruledOut.map(({ point }) => around(point.x, point.y, 10)),
    ],
    soft: callouts.flatMap((callout) => piecesAlong(callout.leader)),
    own: own ? label(own) : null,
  };
}
type BubbleObstacles = { avoid: Rect[]; soft: Rect[]; own: Rect | null };

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
  top = 0,
  action,
}: CalloutOptions & {
  store: FrameStore;
  states: ZoneState[];
  active: CauseSystem | null;
  onPick: (system: DrawnSystem) => void;
  // What a callout does, for its label ("Show its causes", "Examine").
  action: string;
}) {
  const frame = useSyncExternalStore(store.subscribe, store.get, () => null);
  if (!frame || frame.width < 2 || frame.height < 2) return null;
  const byZone = new Map(states.map((state) => [state.system, state]));
  const { callouts, compact, ruledOut } = calloutLayout(frame, states, { keep, full, top });
  const radius = LABEL_FONT * 0.74;
  return (
    <div className="pointer-events-none absolute inset-0" data-labels data-compact={compact} data-top={top}>
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
        {ruledOut.map(({ system, point }) => (
          <g key={system} data-ruled-out={system} data-mark="ruled_out" stroke="#5f656b" strokeWidth={1.4}>
            <circle cx={point.x} cy={point.y} r={7} fill="#ffffff" stroke="#6b7076" strokeWidth={1.2} />
            <path d={`M${point.x - 3} ${point.y - 3}l6 6m0 -6l-6 6`} />
          </g>
        ))}
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
  hover,
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
  hover: HoverPicker;
  sheet: (system: DrawnSystem) => ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const system = examining && examining !== "unit" ? examining : null;
  const state = system ? states.find((s) => s.system === system) : undefined;

  // The part picked in the sheet, and its drawings for the bubble on the
  // stage, as the sheet finds them; the part whose bubble was closed (it
  // stays closed until another part is picked).
  const [drawings, setDrawings] = useState<{ shown: StageDrawings | null; closed: string | null }>({ shown: null, closed: null });
  const report = useCallback(
    (of: DrawnSystem, next: StageDrawings | null) =>
      setDrawings((old) => {
        if (!next) return old.shown?.system === of ? { shown: null, closed: old.closed } : old;
        if (old.shown && sameStageDrawings(old.shown, next)) return old;
        return { shown: next, closed: old.closed === stageDrawingsKey(next) ? old.closed : null };
      }),
    [],
  );
  // The part's chip tapped again: its bubble back, if it was put away.
  const reopen = useCallback((of: DrawnSystem) => setDrawings((old) => (old.closed && old.shown?.system === of ? { shown: old.shown, closed: null } : old)), []);
  const toStage = useMemo(() => ({ report, reopen }), [report, reopen]);
  // Floating beside the part, docked across the top (a narrow stage), or
  // none (a stage too short for it, or no frame yet).
  const room = useSyncExternalStore(frames.subscribe, () => roomOf(frames.get()), () => "none" as const);
  const shown = drawings.shown;
  const bubble =
    ready && system && room !== "none" && shown?.system === system && shown.state !== "none" && drawings.closed !== stageDrawingsKey(shown) ? shown : null;
  const docked = room === "dock";
  // On a narrow stage the strip goes across the callouts' top row, and they
  // go under it: only once it has a drawing, or one is sure to come (an
  // exploded view). While a drawing may yet come to nothing, the line
  // under the stage says it's being looked for instead (a strip there
  // would hide the top row, and take its taps, or drop it and bring it
  // back).
  const looking = bubble !== null && docked && bubble.state !== "found" && !bubble.sure;
  const strip = looking ? null : bubble;
  const top = strip && docked ? stripTop() + 4 : 0;

  function closeBubble() {
    setDrawings((old) => ({ shown: old.shown, closed: old.shown ? stageDrawingsKey(old.shown) : null }));
    // To the part's chip in the sheet, where another part is picked.
    const chip = dialog.current?.querySelector<HTMLElement>('[data-sheet] [data-part-chip][aria-pressed="true"]');
    (chip ?? closeButton.current)?.focus({ preventScroll: true });
  }

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
    if (!v || target.closest("input, textarea, select, [data-sheet], [data-bubble]")) return;
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
            // A size container: the bubble on it is sized by the stage.
            className="relative min-h-0 flex-1 overflow-hidden [container-type:size]"
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
                const hit = viewer.current.pick(at.x, at.y, at.slack);
                if (hit) onPick(hit);
              }}
              onPointerMove={(event) => ready && hover.move(event, (x, y) => viewer.current?.pick(x, y) ?? null)}
              onPointerLeave={(event) => hover.leave(event)}
              onContextMenu={(event) => event.preventDefault()}
            />
            {ready && <Callouts store={frames} states={states} active={system ?? active} onPick={onPick} keep={system} full top={top} action="Examine" />}
            {ready && <HoverLabel picker={hover} />}
            {strip && system && (
              <BubbleLayer frames={frames} system={system} docked={docked} obstacles={(frame) => calloutObstacles(frame, states, { keep: system, full: true, top })}>
                <DrawingBubble shown={strip} docked={docked} onClose={closeBubble} />
              </BubbleLayer>
            )}
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
            {/* The tap first, so it's what's left when the line is cut short;
                a finger's version below lg. While the part's drawing is
                looked for on a narrow stage, that instead (short enough for
                a phone; the part's chip is pressed in the sheet under it). */}
            <p className="min-w-0 flex-1 truncate text-center text-xs text-[#4b5158]">
              <span role="status" data-looking={looking ? "true" : undefined}>
                {looking ? "Finding the drawing…" : ""}
              </span>
              {!looking && (
                <>
                  <span className="max-lg:hidden">Click a part for its manual pages · drag to turn · scroll to zoom · right-drag to move · arrows, + −, 1–5, P for phantom</span>
                  <span className="lg:hidden">Tap a part for its manual pages</span>
                </>
              )}
            </p>
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
          <StageDrawingsContext value={toStage}>
            <SystemSheet
              system={system}
              state={state}
              sheet={sheet}
              onClose={onUnit}
              // Below the unit on a phone or a portrait tablet; beside it on a
              // wide screen, wider from 1280 so a part's manual page and what
              // it says sit side by side.
              className="max-h-[52%] border-t border-white/10 lg:landscape:max-h-none lg:landscape:w-[26rem] lg:landscape:border-t-0 lg:landscape:border-l xl:landscape:w-[min(44rem,48vw)]"
            />
          </StageDrawingsContext>
        )}
      </div>
    </div>
  );
}

// The bubble's room on the stage (see src/lib/unit-3d/bubble.ts).
function roomOf(frame: ProjectedFrame | null): "float" | "dock" | "none" {
  if (!frame || !bubbleFits(frame)) return "none";
  return bubbleDocked(frame) ? "dock" : "float";
}

// Round the part's box on the stage: its outline's line.
const PART_LINE = 3;

// The drawing's bubble on the stage and its leader to the part: placed
// again on every frame the camera moves (as the callouts are), straight on
// the elements, nothing rendered again: beside the part (off all of it, as
// the frame has its shape, however big), off the callouts, where it was
// while that's still clear (src/lib/unit-3d/bubble.ts); docked
// across the top on a narrow stage. Where it was is kept as worked out,
// not as drawn on whole pixels (half a pixel nearer the part mustn't send
// it across). The leader goes when the part's point leaves the stage (or,
// docked, when the part's own label is in its way). Placed before it's
// painted, so it never shows where it isn't.
function BubbleLayer({
  frames,
  system,
  docked,
  obstacles,
  children,
}: {
  frames: FrameStore;
  system: DrawnSystem;
  docked: boolean;
  obstacles: (frame: ProjectedFrame) => BubbleObstacles;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const leader = useRef<SVGGElement>(null);
  const last = useRef<Rect | null>(null);
  const placeNow = useRef<(() => void) | null>(null);
  // The latest callouts to keep off: they can change without a new frame
  // (a cause marked in the sheet), and then it's placed again.
  const keepOff = useRef(obstacles);
  useEffect(() => {
    keepOff.current = obstacles;
    placeNow.current?.();
  });
  useLayoutEffect(() => {
    const element = box.current;
    const lead = leader.current;
    const line = lead?.querySelector("line");
    const dot = lead?.querySelector("circle");
    if (!element || !lead || !line || !dot) return;
    let size = { w: element.offsetWidth, h: element.offsetHeight };
    const place = () => {
      const frame = frames.get();
      if (!frame || frame.width < 2 || frame.height < 2) {
        element.style.visibility = "hidden";
        lead.style.display = "none";
        return;
      }
      const stage = { width: frame.width, height: frame.height };
      const anchor = onStage(frame.points.get(system), stage);
      // The part itself, as this frame has it, and its outline's line.
      const extent = frame.extent(system);
      const part = extent && { x: extent.x - PART_LINE, y: extent.y - PART_LINE, w: extent.w + PART_LINE * 2, h: extent.h + PART_LINE * 2 };
      const { avoid, soft, own } = keepOff.current(frame);
      const placed = docked ? stripRect(stage) : placeBubble({ stage, size, anchor, part, avoid, soft, last: last.current });
      last.current = placed;
      const rect = { x: Math.round(placed.x), y: Math.round(placed.y), w: placed.w, h: placed.h };
      element.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
      element.style.width = docked ? `${rect.w}px` : "";
      element.style.visibility = "";
      element.dataset.placed = `${rect.x},${rect.y},${Math.round(rect.w)},${Math.round(rect.h)}`;
      // Where the part is on the stage (the page's checks read it).
      element.dataset.part = part ? [part.x, part.y, part.w, part.h].map((n) => n.toFixed(1)).join(",") : "";
      const shown = leaderOf(rect, anchor, { below: docked, blocked: docked && own ? [own] : [] });
      if (!shown) {
        lead.style.display = "none";
        lead.dataset.shown = "false";
        return;
      }
      line.setAttribute("x1", String(shown.from.x));
      line.setAttribute("y1", String(shown.from.y));
      line.setAttribute("x2", String(shown.to.x));
      line.setAttribute("y2", String(shown.to.y));
      dot.setAttribute("cx", String(shown.to.x));
      dot.setAttribute("cy", String(shown.to.y));
      lead.style.display = "";
      lead.dataset.shown = "true";
    };
    // Its size as it's drawn (the drawing loaded, another one swiped to).
    const observer = new ResizeObserver(() => {
      size = { w: element.offsetWidth, h: element.offsetHeight };
      place();
    });
    observer.observe(element);
    const stop = frames.subscribe(place);
    placeNow.current = place;
    place();
    return () => {
      placeNow.current = null;
      observer.disconnect();
      stop();
    };
  }, [frames, system, docked]);
  return (
    <>
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full">
        <g ref={leader} data-bubble-leader style={{ display: "none" }}>
          <line stroke={LINE_COLOURS.picked} strokeWidth={1.25} />
          <circle r={3.2} fill={LINE_COLOURS.picked} stroke="#ffffff" strokeWidth={1} />
        </g>
      </svg>
      <div ref={box} data-bubble={system} data-docked={docked} className={`absolute top-0 left-0 ${docked ? "" : "w-max"}`} style={{ visibility: "hidden", height: docked ? STRIP_HEIGHT : undefined }} onWheel={(event) => event.stopPropagation()}>
        {children}
      </div>
    </>
  );
}

// A system's sheet: its number, name and how likely it is, then what the
// diagnosis screen gives it (its parts with their manual pages, and its
// causes). Beside the unit in the examine view, or full screen on its own
// where there's no 3D unit.
function SystemSheet({
  system,
  state,
  sheet,
  onClose,
  className = "",
}: {
  system: DrawnSystem;
  state: ZoneState | undefined;
  sheet: (system: DrawnSystem) => ReactNode;
  // Back to the whole unit (the examine view); none on its own.
  onClose?: () => void;
  className?: string;
}) {
  return (
    <aside data-sheet={system} aria-label={`${SYSTEM_LABELS[system]}: parts, manual pages and causes`} className={`flex min-h-0 flex-col bg-charcoal-900 ${className}`}>
      <div className="flex items-center gap-2.5 border-b border-white/10 px-4 py-2">
        {state && <NumberMark glow={state.glow} muted={state.muted} rank={state.rank} size={22} />}
        {state?.glow === "confirmed" && <ConfirmedMark size={16} />}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-ink">{SYSTEM_LABELS[system]}</h2>
          <p className="text-xs text-ink-muted">
            {!state ? "No causes point here" : state.glow === "confirmed" ? "Confirmed" : glowWords(state.glow).replace(/^./, (c) => c.toUpperCase())}
          </p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close the system" className={`${toolClass} border-transparent bg-transparent`}>
            <CrossIcon />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">{sheet(system)}</div>
    </aside>
  );
}

// Where there's no 3D unit to examine (no WebGL, the GPU took it away, or
// a unit the 3D models don't cover), a system tapped on the drawing opens
// its sheet full screen on its own: in the address like the examine view
// (?examine=<system>), so Back or Esc closes it, the page behind held, and
// the focus back where it was.
export function SheetView({
  title,
  system,
  state,
  sheet,
  onClose,
}: {
  title: string;
  system: DrawnSystem;
  state: ZoneState | undefined;
  sheet: (system: DrawnSystem) => ReactNode;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  // What had the focus when it opened (a system on the drawing), as first
  // rendered: by the time effects run the focus may be on Back already.
  const [from] = useState(() => (document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : null));
  useEffect(() => {
    const release = holdPage(closeButton.current);
    return () => {
      release();
      requestAnimationFrame(() => from?.isConnected && from.focus({ preventScroll: true }));
    };
  }, [from]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${SYSTEM_LABELS[system]} of the ${title}`}
      data-sheet-view={system}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      className="fixed inset-0 z-[35] flex flex-col bg-charcoal-900 text-ink"
    >
      <header className="flex items-center gap-2 border-b border-white/10 bg-charcoal-900 px-3 py-2">
        <button ref={closeButton} type="button" data-examine-close onClick={onClose} className={toolClass}>
          <BackIcon />
          Back
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="truncate text-xs text-ink-muted">Parts and manual pages</p>
        </div>
      </header>
      <SystemSheet system={system} state={state} sheet={sheet} className="mx-auto w-full max-w-5xl flex-1" />
    </div>
  );
}

// Controls on the light plate.
const plateTool =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-black/15 bg-white/85 px-3 text-sm font-medium text-[#1f2328] shadow-sm transition hover:bg-white focus-visible:ring-2 focus-visible:ring-[#085c52] focus-visible:outline-none";
