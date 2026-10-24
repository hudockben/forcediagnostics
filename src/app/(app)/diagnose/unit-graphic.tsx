"use client";

import { useId, useState, type KeyboardEvent } from "react";

import {
  SYSTEM_LABELS,
  VEHICLE_DRAWING_NAMES,
  type CauseSystem,
  type Glow,
  type UnitVehicle,
  type ZoneState,
} from "@/lib/diagnose-zones";
import { METER_LIT, calloutMark, glowWords } from "@/lib/unit-3d/look";
import { circleOf, leaderPath } from "@/lib/unit-graphic/callouts";
import type { Path } from "@/lib/unit-graphic/drawing";
import { sceneFor } from "@/lib/unit-graphic/scene";
import { UNIT_GRAPHIC_CSS } from "@/lib/unit-graphic/style";

// The unit as a line drawing, in the calm manner of a service manual: the
// machine in neutral grey line-work, its suspect systems filled flat (deep
// red for a likely one, amber for less likely, a red outline only for an
// unlikely one, deep red with a check when confirmed, grey with a cross
// when only ruled-out causes point there), each lit system called out with
// a numbered circle (its cause's number in the Likely causes list), its
// name and the list's likelihood meter, so colour is never the only signal.
// Nothing glows or moves. Tapping a system (or its callout) picks it; the
// causes list highlights its causes. The 3D unit's stand-in, on the same
// light plate. The layout comes from sceneFor (src/lib/unit-graphic/scene.ts).

const round = (n: number) => Math.round(n * 100) / 100;

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
            aria-pressed={active === zone.system}
            aria-label={`${SYSTEM_LABELS[zone.system]}: ${count} ${count === 1 ? "cause" : "causes"}, ${glowWords(zone.glow)}${zone.rank ? ` (number ${zone.rank} in the list)` : ""}. Show in the list.`}
            onKeyDown={keyDown(zone.system)}
            onFocus={() => setFocused(zone.system)}
            onBlur={() => setFocused(null)}
            onClick={() => onSelect(zone.system)}
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
  );
}
