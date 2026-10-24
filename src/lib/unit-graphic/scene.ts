import { SYSTEM_LABELS, type DrawnSystem, type Glow, type UnitVehicle, type ZoneState } from "@/lib/diagnose-zones";

import { layoutCallouts, type Callout, type Rect } from "./callouts";
import { baseWithout, drawingFor, type Drawing, type Path } from "./drawing";

// Everything the unit graphic draws for a set of lit systems, worked out
// without React (so the tests can check it, and measure it): the line-work
// without the lit systems, the lit systems in tap order, their labels, and
// the view box. The drawing scales as a whole, so this doesn't depend on
// the width it's shown at: the server and the browser draw the same thing.

// Label text size as a share of the drawing's width: about 11-12px at the
// width the panel shows it on a phone or beside the chat (the generator,
// a squarer drawing, is shown narrower; see UnitCard).
export const LABEL_SHARE: Record<UnitVehicle, number> = { utv: 0.0355, atv: 0.0355, generator: 0.047 };

// The numbered circles alone are drawn this much bigger than the labels'
// text: about 11px numbers on a phone.
export const COMPACT_SCALE = 1.9;

// Drawn last, so they win a tap where parts overlap: small parts after big.
export const HIT_ORDER: DrawnSystem[] = [
  "body_frame",
  "wheels_tires",
  "suspension",
  "brakes",
  "rear_drive",
  "front_drive",
  "transmission",
  "steering",
  "cooling",
  "exhaust",
  "engine",
  "drive_clutch",
  "fuel",
  "air_intake",
  "charging_starting",
  "electrical",
  "ignition",
];

// Which labels get the nearest spots.
const RANK: Record<Glow, number> = { confirmed: 5, high: 4, medium: 3, low: 2, ruled_out: 1, none: 0 };

export type LitZone = ZoneState & { system: DrawnSystem; paths: Path[] };

export type Scene = {
  drawing: Drawing;
  font: number;
  // The numbered circles alone (a narrow card shows these instead of the
  // full labels; see UNIT_GRAPHIC_CSS), at their own, bigger size: the
  // drawing scales down on a phone, and the numbers must still read.
  compact: Callout[];
  compactFont: number;
  // Drawing units per screen pixel at the width it's usually shown, for
  // the tube outlines.
  unitsPerPixel: number;
  base: Path[];
  zones: LitZone[];
  callouts: Callout[];
  // Ruled-out systems: a grey marker with a cross where a callout would
  // point (the key says what it means).
  marks: { system: DrawnSystem; at: readonly [number, number] }[];
  view: Rect;
};

export function sceneFor(vehicle: UnitVehicle, states: ZoneState[]): Scene {
  const drawing = drawingFor(vehicle);
  const font = Math.round(drawing.box.w * LABEL_SHARE[vehicle] * 100) / 100;
  const drawn = states.filter(
    (state): state is ZoneState & { system: DrawnSystem } =>
      state.system !== "other" && state.glow !== "none" && drawing.zones[state.system as DrawnSystem] !== undefined,
  );
  const byZone = new Map(drawn.map((state) => [state.system, state]));
  const zones: LitZone[] = HIT_ORDER.filter((zone) => byZone.has(zone)).map((zone) => {
    const state = byZone.get(zone)!;
    return { ...state, paths: drawing.zones[zone]!.paths };
  });
  // Ruled-out systems are dimmed with a cross on the drawing, but not
  // labelled: they're done with, and the labels are for what's left.
  const items = drawn
    .filter((state) => state.glow !== "ruled_out")
    .map((state) => ({
      zone: state.system,
      anchor: drawing.zones[state.system]!.anchor,
      // A confirmed one's check sits after its number: room for it.
      text: SYSTEM_LABELS[state.system] + (state.glow === "confirmed" ? "\u2003\u2003" : ""),
      rank: RANK[state.glow] + (state.muted ? -2 : 0),
    }));
  const { callouts, box: fullBox } = layoutCallouts(items, drawing.box, font);
  const compactFont = Math.round(font * COMPACT_SCALE * 100) / 100;
  const { callouts: compact, box: compactBox } = layoutCallouts(
    items.map((item) => ({ ...item, compact: true })),
    drawing.box,
    compactFont,
  );
  // The view holds both (the card shows one or the other).
  const x = Math.min(fullBox.x, compactBox.x);
  const y = Math.min(fullBox.y, compactBox.y);
  const box = { x, y, w: Math.max(fullBox.x + fullBox.w, compactBox.x + compactBox.w) - x, h: Math.max(fullBox.y + fullBox.h, compactBox.y + compactBox.h) - y };
  return {
    drawing,
    font,
    compact,
    compactFont,
    unitsPerPixel: drawing.box.w / 340,
    base: baseWithout(
      drawing,
      zones.map((zone) => zone.system),
    ),
    zones,
    callouts,
    marks: zones
      .filter((zone) => zone.glow === "ruled_out")
      .map((zone) => ({ system: zone.system, at: drawing.zones[zone.system]!.anchor.map((n) => Math.round(n * 100) / 100) as [number, number] })),
    view: box,
  };
}
