"use client";

import { useId, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import {
  SYSTEM_LABELS,
  VEHICLE_DRAWING_NAMES,
  type CauseSystem,
  type DrawnSystem,
  type Glow,
  type UnitVehicle,
  type ZoneState,
} from "@/lib/diagnose-zones";
import { METER_LIT, calloutMark, glowWords } from "@/lib/unit-3d/look";
import { circleOf, leaderPath } from "@/lib/unit-graphic/callouts";
import { drawingFor, type Path } from "@/lib/unit-graphic/drawing";
import { HIT_ORDER, sceneFor } from "@/lib/unit-graphic/scene";
import { UNIT_GRAPHIC_CSS } from "@/lib/unit-graphic/style";

// The unit as a line drawing, in the calm manner of a service manual: the
// machine in neutral grey line-work, its suspect systems filled flat (deep
// red for a likely one, amber for less likely, a red outline only for an
// unlikely one, deep red with a check when confirmed, grey with a cross
// when only ruled-out causes point there), each lit system called out with
// a numbered circle (its cause's number in the Likely causes list), its
// name and the list's likelihood meter, so colour is never the only signal.
// Nothing glows or moves. Tapping any system, lit or not, opens its sheet
// (its parts, their manual pages and its causes); tapping a callout picks
// its system, and the causes list highlights its causes. The 3D unit's
// stand-in, on the same light plate. The layout comes from sceneFor
// (src/lib/unit-graphic/scene.ts).

const round = (n: number) => Math.round(n * 100) / 100;

// --- Which system a point is on ------------------------------------------------

// The systems that aren't lit are part of the merged line-work, so a tap on
// one is found from the drawing itself: each system's paths, tested in a
// 2D canvas (faces by their fill, lines and tubes a few pixels either side
// of them, so a finger finds a thin hose), small parts first, as they're
// drawn over the big ones. Nothing extra goes in the markup.
type HitShape = { zone: DrawnSystem; faces: { path: Path2D; rule: CanvasFillRule }[]; lines: { path: Path2D; width: number }[] };
const hitShapes = new Map<UnitVehicle, HitShape[]>();
let hitContext: CanvasRenderingContext2D | null = null;

function shapesOf(vehicle: UnitVehicle) {
  let shapes = hitShapes.get(vehicle);
  if (shapes) return shapes;
  const drawing = drawingFor(vehicle);
  shapes = [...HIT_ORDER].reverse().flatMap((zone): HitShape[] => {
    const paths = drawing.zones[zone]?.paths;
    if (!paths) return [];
    return [
      {
        zone,
        faces: paths.filter((path) => path.c === "f").map((path) => ({ path: new Path2D(path.d), rule: path.eo ? "evenodd" : "nonzero" })),
        lines: paths.filter((path) => path.c !== "f").map((path) => ({ path: new Path2D(path.d), width: path.w ?? 0 })),
      },
    ];
  });
  hitShapes.set(vehicle, shapes);
  return shapes;
}

// The system at a point in the drawing's own units; slack is how far from
// a line still counts, in the same units.
function zoneAt(vehicle: UnitVehicle, x: number, y: number, slack: number): DrawnSystem | null {
  hitContext ??= document.createElement("canvas").getContext("2d");
  const g = hitContext;
  if (!g) return null;
  for (const shape of shapesOf(vehicle)) {
    if (shape.faces.some((face) => g.isPointInPath(face.path, x, y, face.rule))) return shape.zone;
    for (const line of shape.lines) {
      g.lineWidth = Math.max(line.width, slack * 2);
      if (g.isPointInStroke(line.path, x, y)) return shape.zone;
    }
  }
  return null;
}

// Where a pointer is on the drawing: a callout (null: it picks its own
// system), a lit system (its own shape, drawn on top), or whatever system's
// parts are under it.
function zoneUnder(svg: SVGSVGElement | null, vehicle: UnitVehicle, event: { clientX: number; clientY: number; target: EventTarget }) {
  const target = event.target as Element;
  if (!svg || target.closest(".ug-co")) return null;
  const lit = target.closest<SVGGElement>("g.ug-z")?.dataset.zone;
  if (lit) return lit as DrawnSystem;
  const ctm = svg.getScreenCTM();
  if (!ctm || ctm.a === 0) return null;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
  // About 6 screen pixels either side of a line.
  return zoneAt(vehicle, point.x, point.y, 6 / ctm.a);
}

// A tube is drawn as its outline: a dark stroke with a light core about two
// screen pixels narrower, so the outline stays hairline.
function BasePath({ path, unitsPerPixel }: { path: Path; unitsPerPixel: number }) {
  if (path.c.startsWith("t")) {
    const w = path.w ?? 2;
    return (
      <>
        <path className={path.c} d={path.d} strokeWidth={w} />
        <path className="tc" d={path.d} strokeWidth={round(Math.max(w - 2.3 * unitsPerPixel, w * 0.35))} />
      </>
    );
  }
  return <path className={path.c} d={path.d} fillRule={path.eo ? "evenodd" : undefined} />;
}

// A system's own paths, styled by its look (see UNIT_GRAPHIC_CSS).
function ZonePaths({ paths }: { paths: Path[] }) {
  return (
    <>
      {paths.map((path, index) => (
        <path
          key={index}
          className={`c ${path.c}`}
          d={path.d}
          fillRule={path.eo ? "evenodd" : undefined}
          strokeWidth={path.c === "t" ? path.w : undefined}
        />
      ))}
    </>
  );
}

// Where a ruled-out system is: a small grey circle with a cross (the key
// says what it means).
function RuledOutMark({ at: [x, y], size }: { at: readonly [number, number]; size: number }) {
  const r = round(size * 0.55);
  const k = round(r * 0.42);
  return (
    <g data-mark="ruled_out">
      <circle cx={x} cy={y} r={r} fill="#ffffff" stroke="#9aa0a6" className="n" strokeWidth={1.2} />
      <path className="n" d={`M${round(x - k)} ${round(y - k)}l${round(k * 2)} ${round(k * 2)}m0 ${round(-k * 2)}l${round(-k * 2)} ${round(k * 2)}`} fill="none" stroke="#5f656b" strokeWidth={1.4} />
    </g>
  );
}

// The likelihood meter, as in the causes list: three bars, the likely
// ones filled.
function Meter({ glow, x, y, font }: { glow: Glow; x: number; y: number; font: number }) {
  const lit = METER_LIT[glow];
  if (lit === undefined) return null;
  const bar = round(font * 0.2);
  const tall = round(font * 0.66);
  const bars = (from: number, to: number) =>
    [0, 1, 2]
      .slice(from, to)
      .map((i) => `M${round(x + i * bar * 1.7)} ${round(y - tall / 2)}h${bar}v${tall}h${-bar}z`)
      .join("");
  return (
    <g data-meter={lit}>
      <path className="m" d={bars(0, lit)} />
      {lit < 3 && <path className="m0" d={bars(lit, 3)} />}
    </g>
  );
}

// What a screen reader hears for the whole drawing.
export function graphicSummary(vehicle: UnitVehicle, states: ZoneState[]) {
  const lit = states.filter((state) => state.system !== "other" && state.glow !== "none" && state.glow !== "ruled_out");
  const ruledOut = states.filter((state) => state.system !== "other" && state.glow === "ruled_out");
  const name = `${VEHICLE_DRAWING_NAMES[vehicle]} diagram`;
  if (lit.length === 0 && ruledOut.length === 0) return `${name}: no systems highlighted yet.`;
  const parts = [
    lit.length > 0 && `highlighted: ${lit.map((state) => `${SYSTEM_LABELS[state.system]} (${glowWords(state.glow)})`).join(", ")}`,
    ruledOut.length > 0 && `ruled out: ${ruledOut.map((state) => SYSTEM_LABELS[state.system]).join(", ")}`,
  ].filter(Boolean);
  return `${name}; ${parts.join("; ")}.`;
}

export function UnitGraphic({
  vehicle,
  states,
  active,
  onSelect,
  onOpen,
}: {
  vehicle: UnitVehicle;
  states: ZoneState[];
  active: CauseSystem | null;
  // A callout tapped: its system's causes are highlighted in the list.
  onSelect: (system: CauseSystem) => void;
  // A system's parts tapped (or Enter on a lit one): its sheet opens.
  onOpen?: (system: DrawnSystem) => void;
}) {
  const scene = sceneFor(vehicle, states);
  const { drawing, font, view } = scene;
  const ids = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [focused, setFocused] = useState<CauseSystem | null>(null);
  const byZone = new Map(scene.zones.map((zone) => [zone.system, zone]));
  const svg = useRef<SVGSVGElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const hover = useRef<{ frame: number; at: { clientX: number; clientY: number; target: EventTarget } | null }>({ frame: 0, at: null });
  const open = onOpen ?? onSelect;

  const keyDown = (system: DrawnSystem) => (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(system);
    }
  };

  // On a mouse, the system under the pointer: the cursor says it can be
  // tapped and its name sits by the pointer (data-hover says which).
  function showHover(zone: DrawnSystem | null, at: { clientX: number; clientY: number } | null) {
    const el = svg.current;
    const tag = label.current;
    if (!el) return;
    el.style.cursor = zone ? "pointer" : "";
    if (zone) el.dataset.hover = zone;
    else delete el.dataset.hover;
    if (!tag) return;
    const host = tag.parentElement?.getBoundingClientRect();
    if (!zone || !at || !host) {
      tag.hidden = true;
      return;
    }
    tag.textContent = SYSTEM_LABELS[zone];
    tag.hidden = false;
    const x = at.clientX - host.left;
    const y = at.clientY - host.top;
    const left = x + 14 + tag.offsetWidth > host.width ? x - 10 - tag.offsetWidth : x + 14;
    tag.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${Math.round(Math.min(host.height - tag.offsetHeight, y + 16))}px)`;
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.pointerType !== "mouse") return;
    hover.current.at = { clientX: event.clientX, clientY: event.clientY, target: event.target };
    if (hover.current.frame) return;
    hover.current.frame = requestAnimationFrame(() => {
      hover.current.frame = 0;
      const at = hover.current.at;
      if (at) showHover(onOpen ? zoneUnder(svg.current, vehicle, at) : null, at);
    });
  }

  function onPointerLeave() {
    hover.current.at = null;
    showHover(null, null);
  }

  function onClick(event: ReactMouseEvent<SVGSVGElement>) {
    if (!onOpen) return;
    const zone = zoneUnder(svg.current, vehicle, event);
    if (zone) onOpen(zone);
  }

  return (
    <>
      <svg
        ref={svg}
        className="ug block h-auto w-full select-none"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        data-vehicle={vehicle}
        role="group"
        aria-label={`${VEHICLE_DRAWING_NAMES[vehicle]} systems`}
        onClick={onClick}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        <style dangerouslySetInnerHTML={{ __html: UNIT_GRAPHIC_CSS }} />
        <defs>
          {/* The soft shadow on the ground under it. */}
          <filter id={`${ids}-soft`} x="-20%" y="-40%" width="140%" height="180%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
        </defs>

        <g role="img" aria-label={graphicSummary(vehicle, states)}>
          <path d={drawing.ground} fill="#000" fillOpacity={0.12} filter={`url(#${ids}-soft)`} />
          {scene.base.map((path, index) => (
            <BasePath key={index} path={path} unitsPerPixel={scene.unitsPerPixel} />
          ))}
        </g>

        {/* The systems with causes, over the line-work, small ones last so
            they win a tap where parts overlap. */}
        {scene.zones.map((zone) => {
          const count = zone.causes.length;
          return (
            <g
              key={zone.system}
              className="ug-z"
              data-zone={zone.system}
              data-glow={zone.glow}
              data-muted={zone.muted}
              data-active={active === zone.system}
              role="button"
              tabIndex={0}
              // Opening the sheet (a dialog) where there is one; else a toggle of the list's highlight.
              aria-pressed={onOpen ? undefined : active === zone.system}
              aria-haspopup={onOpen ? "dialog" : undefined}
              aria-label={`${SYSTEM_LABELS[zone.system]}: ${count} ${count === 1 ? "cause" : "causes"}, ${glowWords(zone.glow)}${zone.rank ? ` (number ${zone.rank} in the list)` : ""}. ${onOpen ? "Open its parts and manual pages." : "Show in the list."}`}
              onKeyDown={keyDown(zone.system)}
              onFocus={() => setFocused(zone.system)}
              onBlur={() => setFocused(null)}
              onClick={onOpen ? undefined : () => onSelect(zone.system)}
            >
              <ZonePaths paths={zone.paths} />
            </g>
          );
        })}

        {/* Ruled-out systems' crosses; then, for each width, the leaders
            and the callouts over them: full labels, or (a narrow card) the
            numbered circles alone. */}
        <g className="ug-ld" aria-hidden>
          {scene.marks.map((mark) => (
            <g key={mark.system} data-leader={mark.system} data-glow="ruled_out">
              <RuledOutMark at={mark.at} size={font} />
            </g>
          ))}
          {/* The dot on each called-out part, the same for both sets. */}
          {scene.callouts.map((callout) => (
            <circle key={callout.zone} className="dot" cx={callout.leader[0][0]} cy={callout.leader[0][1]} r={round(font * 0.2)} />
          ))}
        </g>
        {(["full", "compact"] as const).map((variant) => {
          const callouts = variant === "full" ? scene.callouts : scene.compact;
          const size = variant === "full" ? font : scene.compactFont;
          return (
            <g key={variant} className={variant === "full" ? "ug-f" : "ug-c"} aria-hidden>
              {/* Both sets are in every drawing, so the numbers' set carries
                  only what its styles need: a leader is a bare path, a
                  callout its tap target, circle and number. */}
              <g className="ug-ld">
                {callouts.map((callout) => {
                  const zone = byZone.get(callout.zone);
                  return variant === "full" ? (
                    <g key={callout.zone} data-leader={callout.zone} data-muted={zone?.muted || undefined}>
                      <path className="l" d={leaderPath(callout, size)} />
                    </g>
                  ) : (
                    <path key={callout.zone} className="l" d={leaderPath(callout, size)} data-muted={zone?.muted || undefined} />
                  );
                })}
              </g>
              <g fontSize={variant === "full" ? size : round(size * 0.82)}>
                {callouts.map((callout) => {
                  const zone = byZone.get(callout.zone);
                  const glow = zone?.glow ?? "none";
                  const mark = calloutMark(glow, zone?.muted ?? false);
                  const { cx, cy, r } = circleOf(callout, size);
                  const confirmed = glow === "confirmed";
                  // A confirmed one's check sits after its number, the name
                  // after that.
                  const checkR = round(size * 0.42);
                  const checkX = round(cx + r + size * 0.3 + checkR);
                  const nameX = round(callout.x + callout.h + size * 0.3 + (confirmed ? size * 1.16 : 0));
                  return (
                    <g
                      key={callout.zone}
                      className="ug-co"
                      {...(variant === "full"
                        ? {
                            "data-callout": callout.zone,
                            "data-glow": glow,
                            "data-muted": zone?.muted || undefined,
                            "data-active": active === callout.zone || undefined,
                            "data-focus": focused === callout.zone || undefined,
                            "data-rank": zone?.rank ?? undefined,
                          }
                        : {
                            "data-callout-number": callout.zone,
                            "data-muted": zone?.muted || undefined,
                            "data-active": active === callout.zone || undefined,
                            "data-focus": focused === callout.zone || undefined,
                          })}
                      onClick={() => onSelect(callout.zone)}
                    >
                      {/* A wider invisible target for gloved taps, up to half way
                          to its neighbours. */}
                      <rect x={callout.hit.x} y={callout.hit.y} width={callout.hit.w} height={callout.hit.h} />
                      {/* The callout's own box (the circle, name and meter). */}
                      {variant === "full" && <rect className="p" x={callout.x} y={callout.y} width={callout.w} height={callout.h} />}
                      <circle className="ring n" cx={cx} cy={cy} r={r} fill={mark.fill} stroke={mark.ring} />
                      <text className="num" x={cx} y={cy} fontSize={variant === "full" ? round(size * 0.82) : undefined} fill={mark.text}>
                        {zone?.rank ?? ""}
                      </text>
                      {confirmed && variant === "compact" && (
                        // Numbers alone: the check on the ring's corner, clear of the number.
                        <g data-mark-number="confirmed">
                          <circle cx={round(cx + r * 0.95)} cy={round(cy - r * 0.95)} r={round(size * 0.3)} fill="#ffffff" stroke={mark.ring} className="n" strokeWidth={1.2} />
                          <path
                            className="n"
                            d={`M${round(cx + r * 0.95 - size * 0.14)} ${round(cy - r * 0.95)}l${round(size * 0.09)} ${round(size * 0.1)}l${round(size * 0.17)} ${round(-size * 0.19)}`}
                            fill="none"
                            stroke={mark.ring}
                            strokeWidth={1.4}
                          />
                        </g>
                      )}
                      {confirmed && variant === "full" && (
                        <g data-mark="confirmed">
                          <circle cx={checkX} cy={cy} r={checkR} fill="#ffffff" stroke={mark.ring} className="n" strokeWidth={1.2} />
                          <path
                            className="n"
                            d={`M${round(checkX - size * 0.2)} ${round(cy)}l${round(size * 0.13)} ${round(size * 0.14)}l${round(size * 0.24)} ${round(-size * 0.27)}`}
                            fill="none"
                            stroke={mark.ring}
                            strokeWidth={1.6}
                          />
                        </g>
                      )}
                      {variant === "full" && (
                        <>
                          <text className="name" x={nameX} y={cy}>
                            {SYSTEM_LABELS[callout.zone]}
                          </text>
                          <Meter glow={glow} x={round(callout.x + callout.w - size * 0.95)} y={cy} font={size} />
                        </>
                      )}
                    </g>
                  );
                })}
              </g>
            </g>
          );
        })}
      </svg>
      {/* The system under a mouse pointer, named beside it. */}
      <span
        ref={label}
        hidden
        aria-hidden
        data-hover-label
        className="pointer-events-none absolute top-0 left-0 z-[1] rounded bg-white/90 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-[#1f2328] shadow-sm ring-1 ring-black/10"
      />
    </>
  );
}
