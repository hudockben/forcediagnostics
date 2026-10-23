"use client";

import { useId, useState, type CSSProperties, type KeyboardEvent } from "react";

import {
  SYSTEM_LABELS,
  VEHICLE_DRAWING_NAMES,
  type CauseSystem,
  type Glow,
  type UnitVehicle,
  type ZoneState,
} from "@/lib/diagnose-zones";
import type { Path } from "@/lib/unit-graphic/drawing";
import { sceneFor } from "@/lib/unit-graphic/scene";
import { TEAL, UNIT_GRAPHIC_CSS } from "@/lib/unit-graphic/style";

// The unit as a see-through line drawing, its systems lit by the likely
// causes tagged to them: solid red and pulsing for a likely one, hatched
// for less likely, a dashed outline for unlikely, solid with a white
// outline and a check when confirmed, dimmed and struck when only ruled-out
// causes point there. Lit systems get labels with the list's likelihood
// meter too, so colour is never the only signal. Tapping a system (or its
// label) picks it; the causes list highlights its causes. The layout comes
// from sceneFor (src/lib/unit-graphic/scene.ts).

const GLOW_WORDS: Record<Glow, string> = {
  confirmed: "confirmed",
  high: "high likelihood",
  medium: "medium likelihood",
  low: "low likelihood",
  ruled_out: "ruled out",
  none: "",
};

const METER_LIT: Partial<Record<Glow, number>> = { high: 3, medium: 2, low: 1 };

const round = (n: number) => Math.round(n * 100) / 100;

// A tube is drawn as its outline: a teal stroke with a dark core about two
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

// A system's own paths, styled by its glow (see UNIT_GRAPHIC_CSS).
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

// Where a label's leader meets its part: a check in a red disc for a
// confirmed cause, a cross for ruled out, otherwise a small dot.
function AnchorMark({ at: [x, y], glow, size }: { at: readonly [number, number]; glow: Glow; size: number }) {
  if (glow === "confirmed" || glow === "ruled_out") {
    const r = round(size * (glow === "confirmed" ? 0.9 : 0.62));
    const k = round(r * 0.45);
    return (
      <g data-mark={glow}>
        <circle cx={x} cy={y} r={r} fill={glow === "confirmed" ? "#e5484d" : "#0a1512"} stroke={glow === "confirmed" ? "#fff" : "#8ea49a"} className="n" strokeWidth={glow === "confirmed" ? 1.5 : 1} vectorEffect="non-scaling-stroke" />
        <path
          className="n"
          d={
            glow === "confirmed"
              ? `M${round(x - k)} ${y}l${round(k * 0.7)} ${round(k * 0.75)}l${round(k * 1.3)} ${round(-k * 1.5)}`
              : `M${round(x - k * 0.8)} ${round(y - k * 0.8)}l${round(k * 1.6)} ${round(k * 1.6)}m0 ${round(-k * 1.6)}l${round(-k * 1.6)} ${round(k * 1.6)}`
          }
          fill="none"
          stroke={glow === "confirmed" ? "#fff" : "#8ea49a"}
          strokeWidth={glow === "confirmed" ? 2 : 1.6}
        />
      </g>
    );
  }
  return <circle cx={x} cy={y} r={round(size * 0.28)} fill="var(--g)" />;
}

// The label's state mark: the likelihood meter (as in the causes list), a
// check for confirmed, a cross for ruled out.
function LabelMark({ glow, x, y, font }: { glow: Glow; x: number; y: number; font: number }) {
  const lit = METER_LIT[glow];
  if (lit === undefined) {
    return (
      <text x={x} y={y} fontSize={round(font * 0.85)}>
        {glow === "confirmed" ? "✓" : "✕"}
      </text>
    );
  }
  const bar = round(font * 0.26);
  const tall = round(font * 0.72);
  const bars = (from: number, to: number) =>
    [0, 1, 2]
      .slice(from, to)
      .map((i) => `M${round(x + i * bar * 1.55)} ${round(y - tall / 2)}h${bar}v${tall}h${-bar}z`)
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
    lit.length > 0 && `highlighted: ${lit.map((state) => `${SYSTEM_LABELS[state.system]} (${GLOW_WORDS[state.glow]})`).join(", ")}`,
    ruledOut.length > 0 && `ruled out: ${ruledOut.map((state) => SYSTEM_LABELS[state.system]).join(", ")}`,
  ].filter(Boolean);
  return `${name}; ${parts.join("; ")}.`;
}

export function UnitGraphic({
  vehicle,
  states,
  active,
  onSelect,
}: {
  vehicle: UnitVehicle;
  states: ZoneState[];
  active: CauseSystem | null;
  onSelect: (system: CauseSystem) => void;
}) {
  const scene = sceneFor(vehicle, states);
  const { drawing, font, view } = scene;
  const ids = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [focused, setFocused] = useState<CauseSystem | null>(null);
  const byZone = new Map(scene.zones.map((zone) => [zone.system, zone]));

  const keyDown = (system: CauseSystem) => (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(system);
    }
  };

  return (
    <svg
      className="ug block h-auto w-full select-none"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      data-vehicle={vehicle}
      role="group"
      aria-label={`${VEHICLE_DRAWING_NAMES[vehicle]} systems`}
      style={{ "--hatch": `url(#${ids}-hatch)` } as CSSProperties}
    >
      <style dangerouslySetInnerHTML={{ __html: UNIT_GRAPHIC_CSS }} />
      <defs>
        {/* A lit system's halo: its own paths blurred, under them (no
            second copy of the paths). */}
        <filter id={`${ids}-glow`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" />
          <feComponentTransfer result="halo">
            <feFuncA type="linear" slope="1.25" />
          </feComponentTransfer>
          <feMerge>
            <feMergeNode in="halo" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id={`${ids}-soft`} x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <radialGradient id={`${ids}-floor`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={TEAL} stopOpacity="0.12" />
          <stop offset="100%" stopColor={TEAL} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${ids}-fade`} cx="50%" cy="50%" r="50%">
          <stop offset="35%" stopColor="#fff" stopOpacity="1" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id={`${ids}-grid`} maskContentUnits="objectBoundingBox">
          <rect width="1" height="1" fill={`url(#${ids}-fade)`} />
        </mask>
        {/* Medium likelihood: hatched. */}
        <pattern id={`${ids}-hatch`} width={round(font * 0.42)} height={round(font * 0.42)} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={round(font * 0.15)} height={round(font * 0.42)} fill="#ff8a4c" fillOpacity="0.75" />
        </pattern>
      </defs>

      <g role="img" aria-label={graphicSummary(vehicle, states)}>
        <path d={drawing.grid} fill="none" stroke={TEAL} strokeOpacity={0.16} strokeWidth={0.7} vectorEffect="non-scaling-stroke" mask={`url(#${ids}-grid)`} />
        <path d={drawing.ground} fill={`url(#${ids}-floor)`} />
        <path d={drawing.ground} fill="#000" fillOpacity={0.35} filter={`url(#${ids}-soft)`} />
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
            aria-pressed={active === zone.system}
            aria-label={`${SYSTEM_LABELS[zone.system]}: ${count} ${count === 1 ? "cause" : "causes"}, ${GLOW_WORDS[zone.glow]}. Show in the list.`}
            onKeyDown={keyDown(zone.system)}
            onFocus={() => setFocused(zone.system)}
            onBlur={() => setFocused(null)}
            onClick={() => onSelect(zone.system)}
          >
            {zone.halo ? (
              <g className="h" filter={`url(#${ids}-glow)`}>
                <ZonePaths paths={zone.paths} />
              </g>
            ) : (
              <ZonePaths paths={zone.paths} />
            )}
          </g>
        );
      })}

      {/* Leaders first, then the labels over them. */}
      <g className="ug-ld" aria-hidden>
        {scene.marks.map((mark) => (
          <g key={mark.system} data-leader={mark.system} data-glow="ruled_out">
            <AnchorMark at={mark.at} glow="ruled_out" size={font} />
          </g>
        ))}
        {scene.callouts.map((callout) => {
          const zone = byZone.get(callout.zone);
          const glow = zone?.glow ?? "none";
          return (
            <g key={callout.zone} data-leader={callout.zone} data-glow={glow} data-muted={zone?.muted ?? false}>
              <path className="l n" d={`M${callout.leader.map(([x, y]) => `${x} ${y}`).join("L")}`} />
              <AnchorMark at={callout.leader[0]} glow={glow} size={font} />
            </g>
          );
        })}
      </g>
      <g aria-hidden fontSize={font}>
        {scene.callouts.map((callout) => {
          const zone = byZone.get(callout.zone);
          const glow = zone?.glow ?? "none";
          return (
            <g
              key={callout.zone}
              className="ug-co"
              data-callout={callout.zone}
              data-glow={glow}
              data-muted={zone?.muted ?? false}
              data-active={active === callout.zone}
              data-focus={focused === callout.zone}
              onClick={() => onSelect(callout.zone)}
            >
              {/* A wider invisible target for gloved taps, up to half way
                  to its neighbours. */}
              <rect x={callout.hit.x} y={callout.hit.y} width={callout.hit.w} height={callout.hit.h} fill="transparent" />
              <rect className="p" x={callout.x} y={callout.y} width={callout.w} height={callout.h} rx={callout.h / 2} />
              <LabelMark glow={glow} x={round(callout.x + font * 0.85)} y={round(callout.y + callout.h / 2)} font={font} />
              <text x={round(callout.x + font * 2.25)} y={round(callout.y + callout.h / 2)}>
                {SYSTEM_LABELS[callout.zone]}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
