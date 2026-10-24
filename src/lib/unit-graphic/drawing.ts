import type { DrawnSystem, UnitVehicle } from "@/lib/diagnose-zones";

import { buildAtv } from "./atv";
import { buildGenerator } from "./generator";
import { camera, model, polygonPath, type Camera, type El, type Model, type P2, type V3 } from "./iso";
import { buildUtv } from "./utv";

// A unit drawing, ready to render: the line-work in painting order (far to
// near) as a few classed paths, each system's own paths (to light up), where
// each system's callout points, the ground shadow, and the bounds.

// c is the path's style: for the line-work, kind + tone (+ shade 0-3 for a
// face), e.g. "fp2", "ld", "tp"; for a system's own paths, f (face), l
// (line), d (fine detail) or t (tube). w is a tube's width.
export type Path = { c: string; d: string; w?: number; eo?: boolean };
export type ZoneShape = { paths: Path[]; anchor: P2 };

export type Drawing = {
  vehicle: UnitVehicle;
  // The whole line-work, merged; and each element with its system, to
  // leave lit systems out (see baseWithout).
  base: Path[];
  pieces: { zone: DrawnSystem; el: El }[];
  zones: Partial<Record<DrawnSystem, ZoneShape>>;
  ground: string;
  box: { x: number; y: number; w: number; h: number };
};

const BUILDERS: Record<UnitVehicle, { build: (m: Model) => void; cam: () => Camera; footprint: [number, number, number, number] }> = {
  // footprint: x0, x1, y0, y1 of the ground shadow.
  utv: { build: buildUtv, cam: () => camera(44, 26), footprint: [-160, 160, -84, 84] },
  atv: { build: buildAtv, cam: () => camera(54, 22), footprint: [-108, 112, -64, 64] },
  generator: { build: buildGenerator, cam: () => camera(50, 24), footprint: [-42, 42, -32, 32] },
};

// Inside the machine: drawn quieter than the outside until lit.
const INSIDE = new Set<DrawnSystem>([
  "engine",
  "fuel",
  "air_intake",
  "ignition",
  "exhaust",
  "cooling",
  "charging_starting",
  "drive_clutch",
  "transmission",
  "front_drive",
  "rear_drive",
  "brakes",
]);

const baseClass = (el: El) => (el.k === "f" ? `f${el.tone}${el.tone === "k" ? "" : Math.round(el.sh * 3)}` : `${el.k}${el.tone}`);
const zoneClass = (el: El) => (el.k === "l" && el.tone === "d" ? "d" : el.k);

// Runs of paths with the same style become one path (painting order
// kept). Faces are all wound the same way (see polygonPath), so overlapping
// ones in a path add up; even-odd ones (a ring with a hole) stay apart.
function merge(els: El[], classOf: (el: El) => string): Path[] {
  const paths: Path[] = [];
  for (const el of els) {
    const c = classOf(el);
    const last = paths[paths.length - 1];
    if (last && last.c === c && last.w === el.w && !last.eo && !el.eo) last.d += el.d;
    else paths.push({ c, d: el.d, ...(el.w !== undefined ? { w: el.w } : {}), ...(el.eo ? { eo: true } : {}) });
  }
  return paths;
}

const cache = new Map<UnitVehicle, Drawing>();

export function drawingFor(vehicle: UnitVehicle): Drawing {
  const cached = cache.get(vehicle);
  if (cached) return cached;
  const spec = BUILDERS[vehicle];
  const m = model(spec.cam());
  spec.build(m);
  const layers = [...m.layers]
    .sort((a, b) => a.layer - b.layer || a.depth - b.depth)
    .map((layer) =>
      INSIDE.has(layer.zone) ? { ...layer, els: layer.els.map((el) => (el.tone === "p" ? { ...el, tone: "i" as const } : el)) } : layer,
    );
  const zoneEls: Partial<Record<DrawnSystem, El[]>> = {};
  for (const layer of layers) (zoneEls[layer.zone] ??= []).push(...layer.els);
  const zones: Partial<Record<DrawnSystem, ZoneShape>> = {};
  for (const [zone, els] of Object.entries(zoneEls) as [DrawnSystem, El[]][]) {
    const point = m.anchors[zone];
    zones[zone] = { paths: merge(els, zoneClass), anchor: point ? m.cam.project(point) : m.cam.project([0, 0, 0] as V3) };
  }
  const [x0, x1, y0, y1] = spec.footprint;
  const groundCorners: V3[] = [
    [x0, y0, 0],
    [x1, y0, 0],
    [x1, y1, 0],
    [x0, y1, 0],
  ];
  const groundPoints = groundCorners.map(m.cam.project);
  const ground = polygonPath(groundPoints);
  const pieces = layers.flatMap((layer) => layer.els.map((el) => ({ zone: layer.zone, el })));
  const base = merge(
    pieces.map((piece) => piece.el),
    baseClass,
  );
  // As wide as the ground under it, but no taller than the machine: the
  // ground's near corner can run off the bottom (it's faint), which keeps
  // the drawing short enough to leave room for the causes below it.
  const bounds = { ...m.bounds };
  for (const [x] of groundPoints) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
  }
  const pad = 6;
  const drawing: Drawing = {
    vehicle,
    base,
    pieces,
    zones,
    ground,
    box: {
      x: Math.floor(bounds.minX - pad),
      y: Math.floor(bounds.minY - pad),
      w: Math.ceil(bounds.maxX - bounds.minX + pad * 2),
      h: Math.ceil(bounds.maxY - bounds.minY + pad * 2),
    },
  };
  cache.set(vehicle, drawing);
  return drawing;
}

// The line-work without the lit systems, which are drawn once, on top, in
// their colours (so a lit drawing isn't bigger than an unlit one by more than
// its labels). Kept for the last few sets of lit systems.
const without = new Map<string, Path[]>();

export function baseWithout(drawing: Drawing, lit: Iterable<DrawnSystem>): Path[] {
  const skip = new Set(lit);
  if (skip.size === 0) return drawing.base;
  const key = `${drawing.vehicle}:${[...skip].sort().join(",")}`;
  const cached = without.get(key);
  if (cached) return cached;
  const paths = merge(
    drawing.pieces.filter((piece) => !skip.has(piece.zone)).map((piece) => piece.el),
    baseClass,
  );
  if (without.size >= 64) without.delete(without.keys().next().value!);
  without.set(key, paths);
  return paths;
}
