import type { DrawnSystem } from "@/lib/diagnose-zones";
import type { UnitLine, UnitSpec } from "@/lib/unit-vehicle";

// Where everything is on a 3D unit: the machine's proportions for its line,
// seats and size, and the places of the parts each system is made of, which
// both the three.js models (src/lib/unit-3d/models/) and the labels'
// anchors use. Pure (no three.js), so the tests can check every line.
//
// Metres, the machine as it stands: y up, the ground at y = 0, x forward
// (the front axle at +wheelbase/2), and here (as the models are drawn) z to
// the machine's left: the driver's side, where the drive clutch is. That is
// a left-handed frame; three.js's is right-handed (x forward and y up put +z
// on the machine's right), so everything is mirrored across the machine's
// middle (z to -z) on its way to the screen: the shapes as they're built
// (build.ts) and every point (worldPoint, worldBounds, anchorAt). Without
// that every machine would come out mirror-image, its steering wheel on the
// right. Youth and mid-size machines are built at full size and scaled as a
// whole (scale).

export type V3 = [number, number, number];
export type Box = { at: V3; size: V3 };

export type Family =
  | "sport_sxs" // RZR
  | "utility_sxs" // Ranger
  | "crossover_sxs" // General, ACE
  | "cab_sxs" // Xpedition
  | "utility_atv" // Sportsman and the other utility ATVs
  | "sport_atv" // Scrambler, Outlaw, Phoenix
  | "generator";

export const LINE_FAMILY: Record<UnitLine, Family> = {
  rzr: "sport_sxs",
  ranger: "utility_sxs",
  general: "crossover_sxs",
  ace: "crossover_sxs",
  xpedition: "cab_sxs",
  sportsman: "utility_atv",
  scrambler: "sport_atv",
  outlaw: "sport_atv",
  phoenix: "sport_atv",
  generator: "generator",
};

export type Layout = {
  family: Family;
  spec: UnitSpec;
  // The whole machine is scaled by this (youth and mid-size).
  scale: number;
  wheelbase: number;
  track: number;
  tireR: number;
  tireW: number;
  rearTireW: number;
  clearance: number;
  // Axles' x, front first (a 6x6 has two at the rear).
  axles: number[];
  // Front and rear of the body, and its height at the cowl / tank.
  nose: number;
  tail: number;
  // Seat rows: each row's x (the seat's middle) and how many across.
  rows: { x: number; across: number }[];
  // Height of the seat cushion's top.
  seatY: number;
  // Side-by-sides: the cage (front pillar foot x, roof front and back x,
  // roof height, rear pillar foot x) and the bed (front and back x, floor y).
  cage: { footFront: number; roofFront: number; roofBack: number; roofY: number; footBack: number } | null;
  bed: { front: number; back: number; floor: number; wall: number } | null;
  // Where the steering is: the wheel's (or the bar's) middle.
  steer: V3;
  // The parts each system is made of.
  parts: {
    engine: Box;
    clutch: Box;
    gearbox: Box;
    frontDiff: Box | null;
    rearDiff: Box | null;
    fuelTank: Box;
    airbox: Box;
    radiator: Box;
    muffler: Box;
    battery: Box;
    ecu: Box;
    coil: V3;
  };
  // Where each system's label points (unscaled).
  anchors: Partial<Record<DrawnSystem, V3>>;
  // The machine's extent (unscaled).
  bounds: { min: V3; max: V3 };
};

// The systems a generator has (it has no drivetrain, steering or brakes).
export const GENERATOR_ZONES: DrawnSystem[] = [
  "engine",
  "fuel",
  "air_intake",
  "ignition",
  "exhaust",
  "cooling",
  "charging_starting",
  "electrical",
  "wheels_tires",
  "body_frame",
];

const SIZE_SCALE = { youth: 0.68, mid: 0.9, full: 1 } as const;
// A youth side-by-side (RZR 200: 2.41 m long on 1.65 m, 1.56 m tall) isn't
// a shrunken adult one: a shorter wheelbase for its length, a taller cage
// for its size, smaller tyres.
const YOUTH_SXS_SCALE = 0.8;

const box = (at: V3, size: V3): Box => ({ at, size });
const top = (b: Box, lift = 0): V3 => [b.at[0], b.at[1] + b.size[1] / 2 + lift, b.at[2]];
const side = (b: Box, dz: number): V3 => [b.at[0], b.at[1], b.at[2] + (Math.sign(dz) * b.size[2]) / 2 + dz];

function sideBySide(spec: UnitSpec, family: Family): Layout {
  const rowsCount = spec.seats >= 4 ? 2 : 1;
  const across = spec.line === "ace" ? 1 : spec.seats === 3 || spec.seats === 6 || spec.seats === 5 ? 3 : 2;
  const base = {
    // Wheelbase (one row, two rows), track, tyre radius and width, ground
    // clearance, overhang ahead of the front axle and behind the rear one,
    // seat and roof heights: RZR XP 1000 (3.0 m long on 2.29 m), Ranger XP
    // 1000 (3.06 m on 2.06 m), General XP 1000 (2.98 m on 2.06 m),
    // Xpedition XP (3.45 m on 2.67 m) and their four-seat versions.
    sport_sxs: { wb: [2.29, 2.95], track: 1.4, r: 0.38, w: 0.25, clear: 0.36, front: 0.44, rear: 0.34, seatY: 0.66, roofY: 1.74 },
    utility_sxs: { wb: [2.06, 2.9], track: 1.3, r: 0.35, w: 0.23, clear: 0.32, front: 0.44, rear: 0.58, seatY: 0.8, roofY: 1.96 },
    crossover_sxs: { wb: [2.06, 2.9], track: 1.36, r: 0.37, w: 0.25, clear: 0.34, front: 0.45, rear: 0.47, seatY: 0.74, roofY: 1.9 },
    cab_sxs: { wb: [2.67, 3.4], track: 1.45, r: 0.38, w: 0.26, clear: 0.34, front: 0.45, rear: 0.4, seatY: 0.78, roofY: 2.0 },
  }[family as "sport_sxs" | "utility_sxs" | "crossover_sxs" | "cab_sxs"];
  const p = { ...base };
  const youth = spec.size === "youth";
  if (youth) {
    p.roofY += 0.16;
    p.r *= 0.92;
    p.front *= 1.2;
  }
  const narrow = spec.line === "ace" ? 0.78 : 1;
  const wb = p.wb[rowsCount - 1] * (spec.line === "ace" ? 0.9 : 1) * (youth ? 0.9 : 1);
  const track = p.track * narrow;
  const front = wb / 2;
  const rear = -wb / 2;
  const sixWheels = spec.sixWheels;
  const axles = sixWheels ? [front, rear, rear - 0.86] : [front, rear];
  const nose = front + p.front;
  const lastAxle = axles.at(-1)!;
  // The cab: the front row sits just behind the front wheels' reach.
  const firstRow = front - p.r - 0.8;
  const rowGap = 0.86;
  const rows = Array.from({ length: rowsCount }, (_, i) => ({ x: firstRow - i * rowGap, across }));
  const lastRow = rows.at(-1)!.x;
  const sport = family === "sport_sxs";
  // RZR: the engine behind the seats under a small rack, open at the back.
  // The others: the engine under the seats or the bed, a bed behind.
  const bed =
    family === "utility_sxs"
      ? { front: lastRow - 0.42, back: lastAxle - p.rear, floor: 0.86, wall: 0.3 }
      : family === "crossover_sxs"
        ? { front: lastRow - 0.42, back: lastAxle - p.rear, floor: 0.92, wall: 0.24 }
        : family === "cab_sxs"
          ? { front: lastRow - 0.5, back: lastAxle - p.rear, floor: 0.9, wall: 0.3 }
          : null;
  const tail = lastAxle - p.rear;
  // The RZR's cage rakes back hard from the cowl; the others' stand up.
  const cage = {
    footFront: front - p.r - 0.12,
    roofFront: firstRow + (sport ? 0.14 : 0.4),
    roofBack: lastRow - (sport ? 0.6 : 0.36),
    roofY: p.roofY,
    footBack: lastRow - (sport ? 0.5 : 0.44),
  };
  const engineX = sport ? rear + 0.5 : family === "utility_sxs" ? lastRow - 0.18 : lastRow - 0.36;
  const engineY = sport ? 0.66 : 0.58;
  const engine = box([engineX, engineY, 0], [0.5, 0.4, 0.46]);
  const clutch = box([engineX + (sport ? 0.08 : 0.12), engineY - 0.02, track / 2 - 0.34], [0.62, 0.42, 0.16]);
  const gearbox = box([engineX - 0.34, 0.5, 0.02], [0.3, 0.3, 0.36]);
  const frontDiff = box([front, p.r + 0.02, 0], [0.24, 0.24, 0.28]);
  const rearDiff = box([sixWheels ? rear - 0.43 : rear, p.r + 0.04, 0], [0.26, 0.26, 0.3]);
  const fuelTank = sport ? box([firstRow - 0.02, 0.5, -0.3], [0.5, 0.24, 0.36]) : box([firstRow - 0.05, 0.52, -0.36], [0.46, 0.26, 0.3]);
  const airbox = sport ? box([lastRow - 0.52, 1.02, -0.3], [0.34, 0.26, 0.3]) : box([firstRow + 0.05, 0.98, 0.0], [0.3, 0.2, 0.32]);
  // Under the RZR's low hood the radiator sits lower and shorter.
  const radiator = sport ? box([front + 0.14, 0.5, 0], [0.07, 0.26, 0.56]) : box([front + 0.16, 0.62, 0], [0.07, 0.34, 0.56]);
  const muffler = sport
    ? box([rear - 0.2, 0.86, -0.24], [0.4, 0.2, 0.2])
    : box([lastAxle - 0.32, 0.62, -0.42], [0.44, 0.2, 0.2]);
  const battery = box([firstRow - 0.02, 0.5, 0.3], [0.2, 0.18, 0.15]);
  const ecu = box([front - 0.12, 0.66, -0.3], [0.2, 0.06, 0.16]);
  const coil: V3 = [engineX + 0.06, engineY + 0.3, 0];
  const steer: V3 = [firstRow + 0.42, sport ? 1.04 : 1.1, across === 1 ? 0 : 0.34];
  const roofTop = p.roofY + 0.05;
  const anchors: Partial<Record<DrawnSystem, V3>> = {
    engine: top(engine, 0.04),
    fuel: side(fuelTank, -0.02),
    air_intake: top(airbox, 0.02),
    ignition: [coil[0], coil[1] + 0.08, coil[2]],
    exhaust: top(muffler, 0.02),
    cooling: top(radiator, 0.02),
    charging_starting: side(battery, 0.04),
    electrical: [nose - 0.12, 0.86, 0.36 * narrow],
    drive_clutch: side(clutch, 0.02),
    transmission: top(gearbox, 0.02),
    front_drive: [front - 0.1, p.r + 0.12, 0.18],
    rear_drive: [rearDiff.at[0] - 0.05, p.r + 0.16, 0.2],
    brakes: [front, p.r, track / 2 - 0.1],
    steering: [steer[0], steer[1] + 0.12, steer[2]],
    suspension: [front - 0.06, p.r + 0.42, track / 2 - 0.22],
    wheels_tires: [front, p.r * 1.75, track / 2 + p.w / 2],
    body_frame: [(cage.roofFront + cage.roofBack) / 2, roofTop, 0],
  };
  const width = track + p.w;
  return {
    family,
    spec,
    scale: youth ? YOUTH_SXS_SCALE : SIZE_SCALE[spec.size],
    wheelbase: wb,
    track,
    tireR: p.r,
    tireW: p.w,
    rearTireW: p.w,
    clearance: p.clear,
    axles,
    nose,
    tail,
    rows,
    seatY: p.seatY,
    cage,
    bed,
    steer,
    parts: { engine, clutch, gearbox, frontDiff, rearDiff, fuelTank, airbox, radiator, muffler, battery, ecu, coil },
    anchors,
    bounds: { min: [tail, 0, -width / 2], max: [nose, roofTop, width / 2] },
  };
}

function atv(spec: UnitSpec, family: Family): Layout {
  const sport = family === "sport_atv";
  const twoUp = spec.seats === 2;
  // A youth ATV (Outlaw 110: 1.45 m long on 0.99 m, 0.99 m wide) is stubby:
  // a longer wheelbase for its length, short ends, a wider track.
  const youth = spec.size === "youth";
  const ends = youth ? 0.75 : 1;
  const wb = (sport ? 1.28 : twoUp ? 1.46 : 1.3) * (youth ? 1.08 : 1);
  const track = (sport ? 1.02 : 0.98) * (youth ? 1.12 : 1);
  const r = sport ? 0.33 : 0.32;
  const w = sport ? 0.2 : 0.2;
  const rw = sport ? 0.26 : 0.25;
  const front = wb / 2;
  const rear = -wb / 2;
  const axles = spec.sixWheels ? [front + 0.25, rear + 0.25, rear - 0.55] : [front, rear];
  const f = axles[0];
  const lastAxle = axles.at(-1)!;
  // Sportsman 570: 2.11 m long on 1.3 m; Scrambler XP 1000: 2.18 m on 1.3 m.
  const nose = f + (sport ? 0.44 : 0.46) * ends;
  const tail = lastAxle - (sport ? 0.42 : 0.38) * ends;
  const seatY = sport ? 0.88 : 0.9;
  const engine = box([-0.02, 0.5, 0], [0.42, 0.36, 0.34]);
  const clutch = box([0.0, 0.46, 0.24], [0.5, 0.34, 0.12]);
  const gearbox = box([-0.28, 0.42, 0], [0.24, 0.26, 0.28]);
  const frontDiff = box([f, r + 0.0, 0], [0.2, 0.2, 0.22]);
  const rearDiff = box([axles[1], r + 0.02, 0], [0.22, 0.22, 0.24]);
  const fuelTank = box([f - 0.62, 0.84, 0], [0.34, 0.2, 0.32]);
  const airbox = box([f - 0.36, 0.78, 0], [0.24, 0.18, 0.26]);
  const radiator = box([f + 0.08, 0.62, 0], [0.06, 0.3, 0.38]);
  const muffler = box([lastAxle - 0.12, 0.68, -0.3], [0.36, 0.16, 0.16]);
  const battery = box([-0.42, 0.72, 0.08], [0.18, 0.16, 0.12]);
  const ecu = box([f - 0.22, 0.86, -0.12], [0.14, 0.05, 0.1]);
  const coil: V3 = [0.04, 0.78, -0.06];
  const steer: V3 = [f - 0.36, sport ? 1.04 : 1.03, 0];
  const anchors: Partial<Record<DrawnSystem, V3>> = {
    engine: [engine.at[0], engine.at[1] + 0.1, engine.at[2] - 0.2],
    fuel: top(fuelTank, 0.04),
    air_intake: [airbox.at[0], airbox.at[1] + 0.06, 0.16],
    ignition: [coil[0], coil[1] + 0.04, coil[2] - 0.08],
    exhaust: top(muffler, 0.06),
    cooling: [radiator.at[0] + 0.06, radiator.at[1] + 0.12, 0],
    charging_starting: side(battery, 0.08),
    electrical: [steer[0] + 0.06, steer[1] + 0.08, 0],
    drive_clutch: side(clutch, 0.02),
    transmission: [gearbox.at[0], gearbox.at[1], 0.2],
    front_drive: [f, r + 0.14, 0.12],
    rear_drive: [axles[1], r + 0.16, 0.14],
    brakes: [f, r, track / 2 - 0.12],
    steering: [steer[0], steer[1] + 0.06, 0.32],
    suspension: [f - 0.04, r + 0.3, track / 2 - 0.2],
    wheels_tires: [f, r * 1.75, track / 2 + w / 2],
    body_frame: sport ? [f - 0.1, 0.88, 0.3] : [f + 0.22, 1.0, 0.25],
  };
  const width = track + rw;
  return {
    family,
    spec,
    scale: SIZE_SCALE[spec.size === "youth" ? "youth" : "full"],
    wheelbase: wb,
    track,
    tireR: r,
    tireW: w,
    rearTireW: rw,
    clearance: 0.28,
    axles,
    nose,
    tail,
    rows: [{ x: twoUp ? -0.28 : -0.22, across: 1 }],
    seatY,
    cage: null,
    bed: spec.sixWheels ? { front: rear + 0.2, back: tail + 0.02, floor: 0.82, wall: 0.24 } : null,
    steer,
    parts: { engine, clutch, gearbox, frontDiff, rearDiff, fuelTank, airbox, radiator, muffler, battery, ecu, coil },
    anchors,
    bounds: { min: [tail, 0, -width / 2], max: [nose, 1.25, width / 2] },
  };
}

function generator(spec: UnitSpec): Layout {
  // An open-frame generator: x towards the engine end, the control panel
  // on the left (+z), a wheel kit at the alternator end.
  const r = 0.1;
  const engine = box([0.12, 0.26, -0.02], [0.24, 0.24, 0.28]);
  const fuelTank = box([0, 0.5, 0], [0.48, 0.13, 0.36]);
  const airbox = box([0.18, 0.36, 0.17], [0.12, 0.12, 0.1]);
  const radiator = box([0.1, 0.18, 0.16], [0.18, 0.18, 0.04]);
  const muffler = box([0.3, 0.44, -0.14], [0.12, 0.12, 0.2]);
  const battery = box([-0.24, 0.13, -0.14], [0.12, 0.12, 0.12]);
  const ecu = box([-0.19, 0.25, 0.22], [0.26, 0.26, 0.03]);
  const clutch = box([-0.14, 0.22, 0], [0.24, 0.24, 0.24]);
  const coil: V3 = [0.31, 0.36, -0.02];
  const anchors: Partial<Record<DrawnSystem, V3>> = {
    engine: [0.12, 0.38, -0.12],
    fuel: top(fuelTank, 0.04),
    air_intake: [airbox.at[0], airbox.at[1] + 0.06, airbox.at[2] + 0.04],
    ignition: [coil[0] + 0.02, coil[1] + 0.04, coil[2]],
    exhaust: top(muffler, 0.04),
    cooling: [radiator.at[0], radiator.at[1] + 0.06, radiator.at[2] + 0.05],
    charging_starting: [battery.at[0], battery.at[1] + 0.07, battery.at[2] - 0.05],
    electrical: [ecu.at[0], ecu.at[1] + 0.12, ecu.at[2] + 0.02],
    wheels_tires: [-0.26, r * 1.8, 0.33],
    body_frame: [0.0, 0.6, 0.24],
  };
  return {
    family: "generator",
    spec,
    scale: 1,
    wheelbase: 0,
    track: 0.6,
    tireR: r,
    tireW: 0.06,
    rearTireW: 0.06,
    clearance: 0.06,
    axles: [-0.26],
    nose: 0.36,
    tail: -0.36,
    rows: [],
    seatY: 0,
    cage: null,
    bed: null,
    steer: [0, 0, 0],
    parts: { engine, clutch, gearbox: clutch, frontDiff: null, rearDiff: null, fuelTank, airbox, radiator, muffler, battery, ecu, coil },
    anchors,
    bounds: { min: [-0.38, 0, -0.33], max: [0.38, 0.62, 0.36] },
  };
}

export function layoutFor(spec: UnitSpec): Layout {
  const family = LINE_FAMILY[spec.line];
  if (family === "generator") return generator(spec);
  if (family === "utility_atv" || family === "sport_atv") return atv(spec, family);
  return sideBySide(spec, family);
}

// The systems drawn on a unit (all of them but other, except on a
// generator).
export function zonesOf(layout: Layout): DrawnSystem[] {
  return Object.keys(layout.anchors) as DrawnSystem[];
}

// A point of the layout where it is on screen's axes (three.js's): z
// mirrored (the machine's left is -z there), unscaled or scaled.
export function worldPoint(layout: Layout, point: V3, scaled = true): V3 {
  const s = scaled ? layout.scale : 1;
  return [point[0] * s, point[1] * s, -point[2] * s];
}

// The machine's extent on screen's axes, scaled.
export function worldBounds(layout: Layout): { min: V3; max: V3 } {
  const s = layout.scale;
  const { min, max } = layout.bounds;
  return { min: [min[0] * s, min[1] * s, -max[2] * s], max: [max[0] * s, max[1] * s, -min[2] * s] };
}

// An anchor where the machine stands, scaled, on screen's axes.
export function anchorAt(layout: Layout, system: DrawnSystem): V3 | null {
  const point = layout.anchors[system];
  return point ? worldPoint(layout, point) : null;
}
