import { crossRing, cylinder, flare, frontPanel, lathe, loft, orient, planPanel, rbox, section, sidePanel, smoothTube, sphere, sweep, tube, type CP, type Kit } from "../geo";
import type { Layout, V3 } from "../layout";
import { aArms, halfShaft, rack, shock, wheel } from "../parts";
import { archSpan } from "../shells";

// The ATVs: the Sportsman (utility: wide flat-topped fenders with front and
// rear racks, a handlebar headlight pod, floorboards; the Touring with a
// raised two-up seat; the 6x6 with a third axle and a dump bed) and the
// sport ATVs (Scrambler, Outlaw, Phoenix: no racks, sharper fenders turned
// up at the ends, lights in the nose). Youth models are the same, smaller.

export function buildAtv(kit: Kit, L: Layout) {
  const sport = L.family === "sport_atv";
  const twoUp = L.spec.seats === 2;
  const six = L.spec.sixWheels;
  const R = L.tireR;
  const T = L.track / 2;
  const [front, ...rearAxles] = L.axles;
  const rear = rearAxles[0];
  const sides = [1, -1] as const;
  const p = L.parts;
  const railY = 0.26;
  const topF = sport ? 0.8 : 0.84;
  const topR = sport ? 0.82 : 0.84;

  // --- Wheels, frame, suspension ---------------------------------------------
  L.axles.forEach((x, i) => {
    const w = i === 0 ? L.tireW : L.rearTireW;
    for (const side of sides) wheel(kit, [x, R, side * T], side, R, w, { tread: sport ? "sport" : "utility", spokes: sport ? 6 : 5, beadlock: false, brakes: true }, i === 0 && side === 1 ? "wheels_tires" : "running");
  });
  for (const side of sides) {
    const z = side * 0.17;
    kit.add("body_frame", "frame", tube([[front + 0.32, 0.5, z], [front + 0.12, railY, z], [L.tail + 0.25, railY, z], [L.tail + 0.12, 0.6, z]], 0.02, 0.08));
    kit.add("body_frame", "frame", tube([[front + 0.14, railY, z], [front - 0.05, 0.72, z * 0.9], [rear + 0.1, 0.74, z * 0.9], [L.tail + 0.12, 0.6, z]], 0.018, 0.1));
  }
  for (const x of [front + 0.12, 0, rear, L.tail + 0.2]) kit.add("body_frame", "frame", cylinder([x, railY, -0.17], [x, railY, 0.17], 0.016, 0.016, 8));

  for (const side of sides) {
    aArms(kit, [front, R, side * (T - L.tireW / 2 - 0.03)], side * 0.15, { lowY: R - 0.1, upY: R + 0.11, spread: 0.26, r: 0.015 });
    shock(kit, [front - 0.06, R + 0.36, side * 0.2], [front + 0.01, R - 0.05, side * (T - 0.2)], 0.036);
    for (const x of rearAxles) {
      aArms(kit, [x, R, side * (T - L.rearTireW / 2 - 0.03)], side * 0.15, { lowY: R - 0.1, upY: R + 0.11, spread: 0.24, r: 0.015 });
      shock(kit, [x + 0.08, R + 0.38, side * 0.2], [x, R - 0.05, side * (T - 0.2)], 0.036);
    }
  }

  // --- Drivetrain ---------------------------------------------------------------
  const fd = p.frontDiff!;
  kit.add("front_drive", "cast", rbox(fd.at, fd.size, 0.04, [0, 0, 0], 2));
  for (const side of sides) halfShaft(kit, "front_drive", [front, R, side * 0.1], [front, R, side * (T - L.tireW / 2 - 0.06)], 0.018);
  kit.add("front_drive", "metal", cylinder([p.engine.at[0] + 0.2, 0.36, 0], [front - 0.1, R, 0], 0.02, 0.02, 8));
  const rd = p.rearDiff!;
  kit.add("rear_drive", "cast", rbox(rd.at, rd.size, 0.045, [0, 0, 0], 2));
  for (const x of rearAxles) {
    for (const side of sides) halfShaft(kit, "rear_drive", [x, R, side * 0.11], [x, R, side * (T - L.rearTireW / 2 - 0.06)], 0.019);
  }
  kit.add("rear_drive", "metal", cylinder([p.gearbox.at[0] - 0.1, 0.38, 0], [rear + 0.1, R, 0], 0.02, 0.02, 8));
  if (rearAxles.length > 1) {
    kit.add("rear_drive", "metal", cylinder([rear, R, 0], [rearAxles[1], R, 0], 0.02, 0.02, 8));
    kit.add("rear_drive", "cast", rbox([rearAxles[1], R, 0], rd.size, 0.045, [0, 0, 0], 2));
  }
  const gb = p.gearbox;
  kit.add("transmission", "cast", rbox(gb.at, gb.size, 0.04, [0, 0, 0], 2));
  kit.add("transmission", "trim", cylinder([gb.at[0] + 0.02, gb.at[1] + 0.1, gb.at[2] + 0.12], [gb.at[0] + 0.22, gb.at[1] + 0.36, 0.2], 0.008, 0.008, 6));
  kit.add("transmission", "trim", sphere([gb.at[0] + 0.22, gb.at[1] + 0.37, 0.2], 0.02, 8));

  // --- Engine and its systems ---------------------------------------------------
  const e = p.engine;
  kit.add("engine", "engine", rbox([e.at[0], e.at[1] - 0.04, 0], [e.size[0], e.size[1] * 0.7, e.size[2] * 0.8], 0.05, [0, 0, 0], 2));
  kit.add("engine", "cast", rbox([e.at[0] + 0.05, e.at[1] + e.size[1] * 0.36, 0], [e.size[0] * 0.55, e.size[1] * 0.34, e.size[2] * 0.6], 0.035, [0, 0, -0.25], 2));
  for (let i = 0; i < 3; i++) kit.add("engine", "engine", rbox([e.at[0] + 0.05, e.at[1] + e.size[1] * 0.22 + i * 0.03, 0], [e.size[0] * 0.6, 0.01, e.size[2] * 0.66], 0.004, [0, 0, -0.25], 1));

  const c = p.clutch;
  kit.add(
    "drive_clutch",
    "plastic",
    sidePanel(
      [
        [c.at[0] + c.size[0] / 2, c.at[1] - 0.02, 0.12],
        [c.at[0] + c.size[0] * 0.1, c.at[1] + c.size[1] / 2, 0.14],
        [c.at[0] - c.size[0] / 2, c.at[1] + c.size[1] * 0.25, 0.12],
        [c.at[0] - c.size[0] / 2, c.at[1] - c.size[1] / 2, 0.1],
        [c.at[0] + c.size[0] * 0.2, c.at[1] - c.size[1] / 2, 0.1],
      ],
      c.at[2] - c.size[2] / 2,
      c.at[2] + c.size[2] / 2,
      { radius: 0.08, bevel: 0.025 },
    ),
  );
  kit.add("drive_clutch", "plastic", smoothTube([[c.at[0] + 0.12, c.at[1] + 0.14, c.at[2] - 0.02], [c.at[0] + 0.25, c.at[1] + 0.26, 0.16], [front - 0.3, 0.74, 0.12]], 0.035, 8));

  kit.add("charging_starting", "cast", cylinder([e.at[0] + 0.04, e.at[1] - 0.02, -e.size[2] * 0.4], [e.at[0] + 0.04, e.at[1] - 0.02, -e.size[2] * 0.4 - 0.05], 0.1, 0.09, 16));
  kit.add("charging_starting", "metal", cylinder([e.at[0] + 0.18, e.at[1] - 0.1, -0.05], [e.at[0] + 0.18, e.at[1] - 0.1, -0.2], 0.035, 0.035, 10));
  const bt = p.battery;
  kit.add("charging_starting", "plastic", rbox(bt.at, bt.size, 0.01, [0, 0, 0], 1));
  kit.add("charging_starting", "tail", cylinder([bt.at[0] - 0.04, bt.at[1] + bt.size[1] / 2, bt.at[2]], [bt.at[0] - 0.04, bt.at[1] + bt.size[1] / 2 + 0.02, bt.at[2]], 0.011, 0.011, 8));

  const coil = p.coil;
  kit.add("ignition", "trim", rbox(coil, [0.05, 0.07, 0.045], 0.01, [0, 0, 0], 1));
  kit.add("ignition", "tail", smoothTube([[coil[0], coil[1] - 0.03, coil[2]], [coil[0] + 0.05, coil[1] - 0.08, coil[2] + 0.02], [e.at[0] + 0.08, e.at[1] + 0.16, 0.02]], 0.009, 5));

  const ab = p.airbox;
  kit.add("air_intake", "plastic", rbox(ab.at, ab.size, 0.03, [0, 0, 0], 2));
  kit.add("air_intake", "rubber", smoothTube([[ab.at[0] - ab.size[0] / 2, ab.at[1] - 0.03, 0.02], [e.at[0] + 0.24, e.at[1] + 0.2, 0.06], [e.at[0] + 0.12, e.at[1] + 0.14, 0.04]], 0.032, 8));

  const ft = p.fuelTank;
  kit.add("fuel", "trim", rbox(ft.at, ft.size, 0.05, [0, 0, 0], 2));
  kit.add("fuel", "rubber", smoothTube([[ft.at[0], ft.at[1] - ft.size[1] / 2, -0.06], [e.at[0] + 0.15, e.at[1] + 0.24, -0.08], [e.at[0] + 0.1, e.at[1] + 0.12, -0.06]], 0.008, 5));

  const mf = p.muffler;
  kit.add("exhaust", "metal", smoothTube([[e.at[0] + 0.1, e.at[1] + 0.12, -0.08], [e.at[0] + 0.12, e.at[1] + 0.22, -0.2], [mf.at[0] + mf.size[0] / 2 + 0.12, mf.at[1], mf.at[2] + 0.02], [mf.at[0] + mf.size[0] / 2, mf.at[1], mf.at[2]]], 0.022, 8));
  kit.add("exhaust", "cast", orient(lathe([[0.001, -mf.size[0] / 2 - 0.02], [mf.size[1] * 0.42, -mf.size[0] / 2], [mf.size[1] / 2, -mf.size[0] / 2 + 0.05], [mf.size[1] / 2, mf.size[0] / 2 - 0.04], [mf.size[1] * 0.4, mf.size[0] / 2], [0.001, mf.size[0] / 2 + 0.01]], 16), [1, 0, 0], mf.at));
  kit.add("exhaust", "trim", cylinder([mf.at[0] - mf.size[0] / 2, mf.at[1], mf.at[2]], [mf.at[0] - mf.size[0] / 2 - 0.06, mf.at[1] + 0.01, mf.at[2]], 0.025, 0.025, 10));

  const rad = p.radiator;
  kit.add("cooling", "radiator", rbox(rad.at, rad.size, 0.01, [0, 0, 0.2], 1));
  kit.add("cooling", "trim", cylinder([rad.at[0] - 0.04, rad.at[1], 0], [rad.at[0] - 0.08, rad.at[1], 0], rad.size[1] * 0.42, rad.size[1] * 0.44, 16));
  for (const [dz, dy] of [
    [0.14, 0.1],
    [-0.14, -0.1],
  ] as const) {
    kit.add("cooling", "rubber", smoothTube([[rad.at[0] - 0.02, rad.at[1] + dy, dz], [front - 0.2, 0.5, dz], [e.at[0] + 0.2, e.at[1] + 0.05, dz * 0.6]], 0.014, 5));
  }

  const ecu = p.ecu;
  kit.add("electrical", "cast", rbox(ecu.at, ecu.size, 0.008, [0, 0, 0], 1));
  kit.add("electrical", "trim", smoothTube([[ecu.at[0], ecu.at[1] - 0.02, ecu.at[2]], [front - 0.4, 0.62, -0.14], [e.at[0], e.at[1] + 0.02, -0.18], [bt.at[0], bt.at[1], bt.at[2] - 0.06]], 0.01, 5));

  // --- Body ------------------------------------------------------------------------
  const footY = 0.42;
  const fFoot = front - R - 0.2;
  const rFoot = rear + R + 0.18;
  const rearLast = rearAxles.at(-1)!;
  // The fenders cover the tyres and no more. A Sportsman's are flat decks
  // (for the racks) with deep skirts down the tyres' outsides and a nose
  // between them carrying the headlights; a sport ATV's hug the tyres,
  // their tops falling away to the outside and kicked up at the ends.
  const fOut = T + L.tireW / 2 + (sport ? 0.01 : 0.02);
  const rOut = T + L.rearTireW / 2 + (sport ? 0.01 : 0.02);
  const inner = sport ? 0.14 : 0.16;
  const fenderProfile = (zo: number, side: 1 | -1, drop: number, lip: number): CP[] => [
    [0.025, side * inner],
    [0.025 - drop * 0.6, zo * side - side * 0.035, true],
    [-drop, zo * side, true],
    [-drop - lip, zo * side - side * 0.004, true],
    [-drop - lip, zo * side - side * 0.026, true],
    [-drop * 0.6 - 0.01, zo * side - side * 0.05],
    [-0.01, side * inner],
  ];
  for (const side of sides) {
    const frontPath: CP[] = sport
      ? [
          [L.nose - 0.02, topF - 0.08],
          [L.nose - 0.16, topF - 0.01, true],
          [front - 0.02, topF + 0.0, true],
          [front - R - 0.02, topF - 0.03, true],
          [fFoot + 0.02, footY + 0.08],
        ]
      : [
          [L.nose - 0.02, topF - 0.22],
          [L.nose - 0.08, topF - 0.03, true],
          [front + 0.1, topF, true],
          [front - R - 0.02, topF, true],
          [front - R - 0.14, topF - 0.1, true],
          [fFoot + 0.02, footY + 0.06],
        ];
    kit.add("shell", "paint", sweep(frontPath, fenderProfile(fOut, side, sport ? 0.05 : 0.012, sport ? 0.09 : 0.17)));
    const rearPath: CP[] = sport
      ? [
          [rFoot - 0.02, footY + 0.08],
          [rear + R + 0.02, topR - 0.03, true],
          [rear - R * 0.4, topR + 0.0, true],
          [L.tail + 0.03, topR + 0.06],
        ]
      : [
          [rFoot - 0.02, footY + 0.06],
          [rear + R + 0.14, topR - 0.1, true],
          [rear + R + 0.02, topR, true],
          [rearLast - R * 0.7, topR, true],
          [L.tail + 0.02, topR - 0.04, true],
          [L.tail + 0.0, topR - 0.22],
        ];
    kit.add("shell", "paint", sweep(rearPath, fenderProfile(rOut, side, sport ? 0.05 : 0.012, sport ? 0.09 : 0.17)));
    // Black liners round the tyres under the fenders.
    const [f0, f1] = archSpan(front, R, R + 0.07, R + 0.1, L.nose - 0.04, fFoot + 0.04);
    kit.add("shell", "plastic", flare(front, R, R + 0.07, f0, f1, side * (inner + 0.02), side * (fOut - 0.04), { thick: 0.02, lip: 0.0, steps: 14 }));
    for (const x of rearAxles) {
      const [r0, r1] = archSpan(x, R, R + 0.07, R + 0.1, rFoot - 0.04, L.tail + 0.04);
      kit.add("shell", "plastic", flare(x, R, R + 0.07, r0, r1, side * (inner + 0.02), side * (rOut - 0.04), { thick: 0.02, lip: 0.0, steps: 14 }));
    }
    // Floorboard with its tread plate.
    kit.add("shell", "plastic", planPanel([[fFoot + 0.02, side * 0.2], [rFoot - 0.02, side * 0.2], [rFoot - 0.02, side * (T + 0.06)], [fFoot + 0.02, side * (T + 0.06)]], footY - 0.05, footY - 0.01, { radius: 0.04, bevel: 0.01 }));
    for (let i = 0; i < 4; i++) {
      const x = fFoot - 0.04 - ((fFoot - rFoot - 0.08) * (i + 0.5)) / 4;
      kit.add("shell", "trim", rbox([x, footY, side * (T * 0.5 + 0.12)], [0.03, 0.012, T * 0.7], 0.004, [0, 0, 0], 1));
    }
    // Side panel under the seat.
    kit.add(
      "shell",
      "accent",
      sidePanel(
        [
          [fFoot - 0.02, footY + 0.02],
          [fFoot - 0.02, topF - 0.06],
          [rFoot + 0.04, L.seatY - 0.08],
          [rFoot + 0.04, footY + 0.02],
        ],
        side * 0.16,
        side * 0.22,
        { radius: 0.04, bevel: 0.015 },
      ),
    );
    // Tail light at the back, and the front lights in the fascia.
    kit.add("electrical", "tail", rbox([L.tail + 0.03, topR - (sport ? 0.0 : 0.14), side * 0.18], [0.03, 0.04, 0.08], 0.01, [0, 0, 0], 1));
    if (sport) kit.add("electrical", "led", rbox([L.nose - 0.06, topF - 0.06, side * 0.13], [0.06, 0.035, 0.12], 0.012, [0, side * 0.35, -0.3], 1));
    else kit.add("electrical", "led", rbox([L.nose + 0.0, topF - 0.24, side * 0.24], [0.04, 0.05, 0.12], 0.014, [0, side * 0.2, 0], 1));
  }
  // The nose between the front fenders: a black fascia with the headlights
  // (the Sportsman's low in its corners, a sport ATV's slim in the nose),
  // and the tank cover running back from it to the seat.
  if (sport) {
    kit.add("shell", "plastic", frontPanel([[-0.14, topF - 0.3], [0.14, topF - 0.3], [0.1, topF - 0.1], [-0.1, topF - 0.1]], L.nose - 0.08, L.nose - 0.02, { radius: 0.02, bevel: 0.01 }));
  } else {
    kit.add("shell", "plastic", frontPanel([[-0.24, topF - 0.44], [0.24, topF - 0.44], [inner + 0.02, topF - 0.1], [-(inner + 0.02), topF - 0.1]], L.nose - 0.06, L.nose + 0.0, { radius: 0.03, bevel: 0.012 }));
    kit.add("shell", "trim", frontPanel([[-0.1, topF - 0.4], [0.1, topF - 0.4], [0.08, topF - 0.22], [-0.08, topF - 0.22]], L.nose, L.nose + 0.012, { radius: 0.015, bevel: 0.003 }));
  }
  const cover = (x: number, half: number, top: number, bottom: number): V3[] =>
    crossRing(x, [
      [0, top],
      [half * 0.6, top - 0.005, true],
      [half, top - 0.04, true],
      [half, bottom, true],
      [0, bottom],
    ]);
  kit.add(
    "shell",
    "paint",
    loft(
      sport
        ? [cover(L.nose - 0.12, inner - 0.02, topF - 0.02, topF - 0.2), cover(front - 0.1, inner + 0.01, topF + 0.04, topF - 0.16), cover(front - 0.45, inner + 0.03, topF + 0.12, topF - 0.14), cover(front - 0.66, inner, topF + 0.1, topF - 0.14)]
        : [cover(L.nose - 0.06, inner, topF - 0.03, topF - 0.2), cover(front - 0.18, inner + 0.02, topF + 0.0, topF - 0.16), cover(front - 0.45, inner + 0.04, topF + 0.1, topF - 0.14), cover(front - 0.66, inner + 0.02, topF + 0.09, topF - 0.14)],
    ),
  );
  const seatFront = front - 0.62;
  const seatBack = twoUp ? rear - 0.3 : rear - 0.02;
  const seatRings = [
    section(seatFront, 0.15, L.seatY - 0.12, L.seatY - 0.02, { topHalf: 0.12, crown: 0.01, p: 3 }),
    section(seatFront - 0.12, 0.19, L.seatY - 0.14, L.seatY, { topHalf: 0.17, crown: 0.02, p: 3 }),
    section((seatFront + seatBack) / 2, 0.2, L.seatY - 0.14, L.seatY + 0.01, { topHalf: 0.18, crown: 0.02, p: 3 }),
    section(seatBack + 0.06, 0.19, L.seatY - 0.12, L.seatY + (twoUp ? 0.12 : 0), { topHalf: 0.17, crown: 0.02, p: 3 }),
    section(seatBack, 0.16, L.seatY - 0.1, L.seatY + (twoUp ? 0.12 : -0.01), { topHalf: 0.13, p: 3 }),
  ];
  kit.add("shell", "seat", loft(seatRings));
  if (twoUp) {
    kit.add("shell", "seat", rbox([seatBack - 0.08, L.seatY + 0.26, 0], [0.08, 0.24, 0.34], 0.04, [0, 0, 0.2], 2));
    for (const side of sides) kit.add("body_frame", "frame", tube([[seatBack + 0.1, L.seatY + 0.02, side * 0.22], [seatBack + 0.06, L.seatY + 0.14, side * 0.26], [seatBack - 0.08, L.seatY + 0.14, side * 0.26], [seatBack - 0.1, L.seatY + 0.02, side * 0.22]], 0.012, 0.04));
  }

  // Racks (the Sportsman's), a dump bed (the 6x6's), bumpers.
  if (!sport) {
    rack(kit, "body_frame", front - 0.32, L.nose - 0.08, topF + 0.08, 0.36, 5, 0.013);
    for (const side of sides) for (const x of [front - 0.3, L.nose - 0.1]) kit.add("body_frame", "frame", cylinder([x, topF, side * 0.34], [x, topF + 0.08, side * 0.34], 0.012, 0.012, 6));
    if (six && L.bed) {
      const bed = L.bed;
      kit.add("shell", "plastic", planPanel([[bed.front, 0.42], [bed.back, 0.42], [bed.back, -0.42], [bed.front, -0.42]], bed.floor - 0.04, bed.floor, { radius: 0.03, bevel: 0.01 }));
      for (const side of sides) kit.add("shell", "plastic", sidePanel([[bed.front, bed.floor - 0.04], [bed.back, bed.floor - 0.04], [bed.back, bed.floor + bed.wall], [bed.front, bed.floor + bed.wall]], side * 0.38, side * 0.42, { radius: 0.02, bevel: 0.01 }));
      kit.add("shell", "plastic", frontPanel([[-0.42, bed.floor - 0.04], [0.42, bed.floor - 0.04], [0.42, bed.floor + bed.wall], [-0.42, bed.floor + bed.wall]], bed.back, bed.back + 0.04, { radius: 0.02, bevel: 0.01 }));
      kit.add("shell", "plastic", frontPanel([[-0.42, bed.floor - 0.04], [0.42, bed.floor - 0.04], [0.42, bed.floor + bed.wall], [-0.42, bed.floor + bed.wall]], bed.front - 0.04, bed.front, { radius: 0.02, bevel: 0.01 }));
    } else {
      const rackFront = twoUp ? rear - 0.36 : rear + 0.12;
      rack(kit, "body_frame", L.tail + 0.06, rackFront, topR + 0.08, 0.36, 5, 0.013);
      for (const side of sides) for (const x of [rackFront - 0.02, L.tail + 0.08]) kit.add("body_frame", "frame", cylinder([x, topR, side * 0.34], [x, topR + 0.08, side * 0.34], 0.012, 0.012, 6));
    }
    // Front bumper / brush guard.
    kit.add("body_frame", "frame", tube([[L.nose - 0.12, topF - 0.42, 0.24], [L.nose + 0.04, topF - 0.36, 0.2], [L.nose + 0.04, topF - 0.12, 0.14], [L.nose + 0.04, topF - 0.12, -0.14], [L.nose + 0.04, topF - 0.36, -0.2], [L.nose - 0.12, topF - 0.42, -0.24]], 0.016, 0.05));
  } else {
    kit.add("body_frame", "frame", tube([[L.nose - 0.1, topF - 0.44, 0.18], [L.nose + 0.02, topF - 0.4, 0.12], [L.nose + 0.02, topF - 0.4, -0.12], [L.nose - 0.1, topF - 0.44, -0.18]], 0.016, 0.04));
  }
  kit.add("body_frame", "frame", tube([[L.tail + 0.14, 0.42, 0.18], [L.tail - 0.02, 0.44, 0.14], [L.tail - 0.02, 0.44, -0.14], [L.tail + 0.14, 0.42, -0.18]], 0.016, 0.04));

  // --- Handlebar: column, bar, grips, levers, the headlight pod -----------------
  const st = L.steer;
  kit.add("steering", "metal", cylinder([front - 0.12, 0.5, 0], [st[0] + 0.02, st[1] - 0.04, 0], 0.016, 0.016, 8));
  kit.add("steering", "metal", tube([[st[0] - 0.06, st[1] + 0.06, 0.4], [st[0] - 0.02, st[1] + 0.03, 0.2], [st[0], st[1], 0], [st[0] - 0.02, st[1] + 0.03, -0.2], [st[0] - 0.06, st[1] + 0.06, -0.4]], 0.012, 0.1));
  for (const side of sides) {
    kit.add("steering", "rubber", cylinder([st[0] - 0.05, st[1] + 0.055, side * 0.32], [st[0] - 0.065, st[1] + 0.065, side * 0.44], 0.018, 0.018, 10));
    kit.add("brakes", "trim", cylinder([st[0] - 0.02, st[1] + 0.05, side * 0.26], [st[0] + 0.08, st[1] + 0.04, side * 0.38], 0.007, 0.006, 5));
  }
  if (!sport) {
    // The pod over the bar, with its light and gauge.
    kit.add("shell", "paint", loft([section(st[0] + 0.1, 0.09, st[1] - 0.01, st[1] + 0.06, { topHalf: 0.07, p: 3 }), section(st[0] - 0.01, 0.12, st[1] - 0.04, st[1] + 0.1, { topHalf: 0.09, crown: 0.01, p: 3 }), section(st[0] - 0.1, 0.09, st[1] - 0.02, st[1] + 0.08, { topHalf: 0.07, p: 3 })]));
    kit.add("electrical", "led", rbox([st[0] + 0.1, st[1] + 0.025, 0], [0.03, 0.04, 0.12], 0.012, [0, 0, 0], 1));
    kit.add("electrical", "trim", rbox([st[0] - 0.05, st[1] + 0.1, 0], [0.07, 0.02, 0.09], 0.008, [0, 0, -0.4], 1));
  }
}
