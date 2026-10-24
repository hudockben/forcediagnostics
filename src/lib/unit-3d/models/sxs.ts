import { crossRing, cylinder, flare, frontPanel, lathe, loft, orient, planPanel, rbox, section, sidePanel, smoothTube, sphere, sweep, torus, tube, type CP, type Kit } from "../geo";
import type { Layout, V3 } from "../layout";
import { aArms, halfShaft, rack, shock, wheel } from "../parts";
import { archSpan } from "../shells";

// The side-by-sides: RZR (sport: low and wide, long-travel arms, bucket
// seats, a sloped hood with slim LED lights, open at the back with a small
// rack), Ranger (utility: upright cab and cage, bench seat, flat dump bed,
// brush guard), General and ACE (crossover: sporty stance, small dump box),
// Xpedition (an enclosed cab with doors and glass, and a box). All share a
// chassis: frame, wheels, suspension, the drivetrain and the engine bay.

export function buildSideBySide(kit: Kit, L: Layout) {
  const sport = L.family === "sport_sxs";
  const utility = L.family === "utility_sxs";
  const cab = L.family === "cab_sxs";
  const cross = L.family === "crossover_sxs";
  const R = L.tireR;
  const W = L.tireW;
  const T = L.track / 2;
  const [front, ...rearAxles] = L.axles;
  const lastAxle = rearAxles.at(-1)!;
  const sides = [1, -1] as const;
  const across = L.rows[0].across;
  const firstRow = L.rows[0].x;
  const lastRow = L.rows.at(-1)!.x;
  // Half the cab's width (the cage's sides) and the body's.
  const cabHalf = across === 1 ? 0.42 : across === 3 ? 0.66 : 0.62;
  const bodyHalf = Math.min(T - W / 2 + 0.06, cabHalf + 0.02);
  const cage = L.cage!;
  const railY = L.clearance + 0.04;

  // --- Wheels, frame, suspension -------------------------------------------
  for (const x of L.axles) {
    for (const side of sides) {
      wheel(kit, [x, R, side * T], side, R, W, { tread: sport ? "sport" : "utility", spokes: sport ? 7 : cab ? 6 : 5, beadlock: sport, brakes: true }, x === front && side === 1 ? "wheels_tires" : "running");
    }
  }

  // Lower rails, cross members, and the uprights the front arms hang on.
  for (const side of sides) {
    const z = side * 0.3;
    kit.add("body_frame", "frame", tube([[front + 0.32, railY + 0.16, z], [front + 0.1, railY, z], [L.tail + 0.2, railY, z], [L.tail + 0.05, railY + 0.22, z]], 0.024, 0.1));
    kit.add("body_frame", "frame", tube([[front + 0.3, railY + 0.16, z], [front + 0.12, R + 0.36, side * 0.26], [cage.footFront, 0.8, side * 0.4]], 0.02, 0.08));
    // Side rails at the cab's foot, which the cage stands on.
    kit.add("body_frame", "frame", tube([[cage.footFront, 0.92, side * cabHalf * 0.72], [cage.footFront - 0.05, railY + 0.06, side * cabHalf], [cage.footBack + 0.05, railY + 0.06, side * cabHalf], [cage.footBack, 0.92, side * cabHalf * 0.8]], 0.022, 0.12));
  }
  for (const x of [front + 0.1, cage.footFront, firstRow, cage.footBack, L.tail + 0.22]) {
    kit.add("body_frame", "frame", cylinder([x, railY, -0.3], [x, railY, 0.3], 0.018, 0.018, 8));
  }

  for (const side of sides) {
    const hub: V3 = [front, R, side * (T - W / 2 - 0.04)];
    aArms(kit, hub, side * 0.22, { lowY: R - 0.12, upY: R + 0.13, spread: sport ? 0.36 : 0.3 });
    // The RZR's front shocks lie further over, under its low hood.
    shock(kit, [front - 0.1, R + (sport ? 0.3 : 0.42), side * (sport ? 0.26 : 0.3)], [front + 0.02, R - 0.06, side * (T - (sport ? 0.3 : 0.26))], sport ? 0.05 : 0.042, { reservoir: sport });
  }
  for (const x of rearAxles) {
    for (const side of sides) {
      const hub: V3 = [x, R, side * (T - W / 2 - 0.04)];
      if (sport) {
        // Long-travel trailing arm from beside the seats back to the hub,
        // located by three radius rods.
        const pivot: V3 = [firstRow + 0.15, R + 0.08, side * 0.42];
        kit.add("suspension", "frame", tube([pivot, [x - 0.25, R + 0.02, side * (T - 0.28)], [x, R, side * (T - W / 2 - 0.1)]], 0.03, 0.2));
        kit.add("suspension", "cast", rbox([x, R, side * (T - W / 2 - 0.08)], [0.16, 0.26, 0.07], 0.025, [0, 0, 0], 1));
        for (const [dy, len] of [
          [-0.1, 0.62],
          [0.08, 0.5],
          [0.16, 0.56],
        ] as const) {
          kit.add("suspension", "metal", cylinder([x + 0.02, R + dy, side * (T - W / 2 - 0.1)], [x + 0.06, R + dy * 0.6, side * (T - W / 2 - 0.1 - len)], 0.014, 0.014, 6));
        }
        shock(kit, [x + 0.34, R + 0.66, side * 0.4], [x - 0.12, R + 0.02, side * (T - 0.3)], 0.05, { reservoir: true });
      } else {
        aArms(kit, hub, side * 0.24, { lowY: R - 0.12, upY: R + 0.12, spread: 0.3 });
        shock(kit, [x + 0.1, R + 0.5, side * 0.32], [x, R - 0.06, side * (T - 0.26)], 0.042);
      }
    }
  }

  // --- Drivetrain --------------------------------------------------------------
  const p = L.parts;
  const fd = p.frontDiff!;
  kit.add("front_drive", "cast", rbox(fd.at, fd.size, 0.05, [0, 0, 0], 2));
  kit.add("front_drive", "cast", cylinder([fd.at[0] - fd.size[0] / 2 - 0.08, fd.at[1], 0], [fd.at[0] - fd.size[0] / 2, fd.at[1], 0], 0.05, 0.08, 12));
  for (const side of sides) halfShaft(kit, "front_drive", [front, R + 0.02, side * 0.12], [front, R, side * (T - W / 2 - 0.1)], 0.022);
  // The prop shaft forward from the gearbox to the front diff.
  kit.add("front_drive", "metal", cylinder([p.gearbox.at[0] + 0.1, 0.42, 0.02], [front - 0.2, R + 0.02, 0], 0.026, 0.026, 10));

  const rd = p.rearDiff!;
  kit.add("rear_drive", "cast", rbox(rd.at, rd.size, 0.06, [0, 0, 0], 2));
  for (const x of rearAxles) {
    for (const side of sides) halfShaft(kit, "rear_drive", [rd.at[0] + (x - rd.at[0]) * 0.2, rd.at[1], side * 0.13], [x, R, side * (T - W / 2 - 0.1)], 0.024);
  }
  if (rearAxles.length > 1) {
    kit.add("rear_drive", "metal", cylinder([rd.at[0], rd.at[1], 0], [lastAxle, R, 0], 0.024, 0.024, 8));
    kit.add("rear_drive", "cast", rbox([lastAxle, R + 0.03, 0], [0.22, 0.22, 0.26], 0.05, [0, 0, 0], 2));
  }
  const gb = p.gearbox;
  kit.add("transmission", "cast", rbox(gb.at, gb.size, 0.05, [0, 0, 0], 2));
  kit.add("transmission", "cast", cylinder([gb.at[0], gb.at[1], gb.at[2] - gb.size[2] / 2], [rd.at[0], rd.at[1], 0], 0.07, 0.08, 10));
  // The shift cable up to the lever by the driver.
  kit.add("transmission", "trim", smoothTube([[gb.at[0] + 0.1, gb.at[1] + 0.14, 0.1], [firstRow - 0.1, 0.5, 0.12], [firstRow + 0.35, 0.82, 0.08]], 0.008, 5));

  // --- Engine bay ----------------------------------------------------------------
  const e = p.engine;
  const ex = e.at[0];
  const ey = e.at[1];
  kit.add("engine", "engine", rbox([ex, ey - 0.05, 0], [e.size[0], e.size[1] * 0.75, e.size[2] * 0.8], 0.06, [0, 0, 0], 2));
  kit.add("engine", "cast", rbox([ex + 0.04, ey + e.size[1] * 0.38, 0], [e.size[0] * 0.62, e.size[1] * 0.32, e.size[2] * 0.62], 0.04, [0, 0, -0.12], 2));
  // Cylinder head fins and the oil pan.
  for (let i = 0; i < 3; i++) kit.add("engine", "engine", rbox([ex + 0.04, ey + e.size[1] * 0.24 + i * 0.03, 0], [e.size[0] * 0.7, 0.012, e.size[2] * 0.66], 0.005, [0, 0, -0.12], 1));
  kit.add("engine", "cast", rbox([ex - 0.02, ey - e.size[1] * 0.48, 0], [e.size[0] * 0.8, 0.08, e.size[2] * 0.6], 0.03, [0, 0, 0], 1));

  // Drive clutch: the CVT cover on the left of the engine, its air duct.
  const c = p.clutch;
  const cz = c.at[2];
  kit.add(
    "drive_clutch",
    "plastic",
    sidePanel(
      [
        [c.at[0] + c.size[0] / 2, c.at[1] + 0.02, 0.16],
        [c.at[0] + c.size[0] * 0.15, c.at[1] + c.size[1] / 2, 0.18],
        [c.at[0] - c.size[0] / 2, c.at[1] + c.size[1] * 0.3, 0.16],
        [c.at[0] - c.size[0] / 2, c.at[1] - c.size[1] / 2, 0.12],
        [c.at[0] + c.size[0] * 0.2, c.at[1] - c.size[1] / 2, 0.14],
      ],
      cz - c.size[2] / 2,
      cz + c.size[2] / 2,
      { radius: 0.12, bevel: 0.03 },
    ),
  );
  kit.add("drive_clutch", "plastic", smoothTube([[c.at[0] + 0.12, c.at[1] + 0.16, cz], [c.at[0] + 0.3, c.at[1] + 0.32, cz - 0.04], [lastRow - 0.28, 0.98, 0.3]], 0.045, 10));
  kit.add("drive_clutch", "metal", cylinder([c.at[0] - 0.12, c.at[1], cz + c.size[2] / 2], [c.at[0] - 0.12, c.at[1], cz + c.size[2] / 2 + 0.012], 0.05, 0.05, 12));

  // Charging and starting: the stator cover, the starter, the battery.
  kit.add("charging_starting", "cast", cylinder([ex + 0.05, ey - 0.02, -e.size[2] * 0.4], [ex + 0.05, ey - 0.02, -e.size[2] * 0.4 - 0.06], 0.12, 0.11, 18));
  kit.add("charging_starting", "metal", cylinder([ex + 0.24, ey - 0.1, -0.06], [ex + 0.24, ey - 0.1, -0.24], 0.04, 0.04, 12));
  const bt = p.battery;
  kit.add("charging_starting", "plastic", rbox(bt.at, bt.size, 0.012, [0, 0, 0], 1));
  for (const [dz, mat] of [
    [-0.04, "tail"],
    [0.04, "trim"],
  ] as const) {
    kit.add("charging_starting", mat, cylinder([bt.at[0], bt.at[1] + bt.size[1] / 2, bt.at[2] + dz], [bt.at[0], bt.at[1] + bt.size[1] / 2 + 0.025, bt.at[2] + dz], 0.012, 0.012, 8));
  }
  kit.add("charging_starting", "tail", smoothTube([[bt.at[0], bt.at[1] + bt.size[1] / 2 + 0.02, bt.at[2] - 0.04], [bt.at[0] - 0.2, 0.45, 0.1], [ex + 0.24, ey - 0.06, -0.15]], 0.008, 5));

  // Ignition: coils on the head, leads into it.
  const coil = p.coil;
  for (const dz of [-0.07, 0.07]) {
    kit.add("ignition", "trim", rbox([coil[0], coil[1], coil[2] + dz], [0.08, 0.1, 0.07], 0.012, [0, 0, 0], 1));
    kit.add("ignition", "tail", cylinder([coil[0], coil[1] - 0.05, coil[2] + dz], [coil[0] - 0.02, coil[1] - 0.12, coil[2] + dz], 0.016, 0.016, 8));
  }

  // Air intake: the airbox, its tube to the throttle body.
  const ab = p.airbox;
  kit.add("air_intake", "plastic", rbox(ab.at, ab.size, 0.04, [0, 0, 0], 2));
  kit.add("air_intake", "rubber", smoothTube([[ab.at[0] + ab.size[0] / 2, ab.at[1] - 0.04, ab.at[2]], [ab.at[0] + 0.3, ab.at[1] - 0.1, ab.at[2] * 0.5], [ex + 0.18, ey + e.size[1] * 0.42, 0.08]], 0.04, 10));
  kit.add("air_intake", "metal", cylinder([ex + 0.16, ey + e.size[1] * 0.4, 0.06], [ex + 0.08, ey + e.size[1] * 0.3, 0.04], 0.035, 0.035, 12));

  // Fuel: tank, filler neck and cap, the line to the engine.
  const ft = p.fuelTank;
  kit.add("fuel", "trim", rbox(ft.at, ft.size, 0.05, [0, 0, 0], 2));
  kit.add("fuel", "trim", cylinder([ft.at[0] + 0.1, ft.at[1] + ft.size[1] / 2, ft.at[2] - 0.08], [ft.at[0] + 0.12, ft.at[1] + ft.size[1] / 2 + 0.16, ft.at[2] - 0.14], 0.03, 0.03, 10));
  kit.add("fuel", "cast", cylinder([ft.at[0] + 0.12, ft.at[1] + ft.size[1] / 2 + 0.16, ft.at[2] - 0.14], [ft.at[0] + 0.125, ft.at[1] + ft.size[1] / 2 + 0.19, ft.at[2] - 0.145], 0.045, 0.045, 14));
  kit.add("fuel", "rubber", smoothTube([[ft.at[0] - ft.size[0] / 2, ft.at[1] - 0.06, ft.at[2]], [ft.at[0] - 0.4, 0.42, -0.1], [ex + 0.12, ey + 0.12, -0.08]], 0.01, 5));

  // Exhaust: header out of the head to the muffler, and its tip.
  const mf = p.muffler;
  const muffAxis: V3 = sport ? [1, 0, 0] : [1, 0, 0];
  kit.add("exhaust", "metal", smoothTube([[ex + 0.12, ey + 0.12, -0.12], [ex + 0.05, ey + 0.2, -0.24], [mf.at[0] + mf.size[0] / 2 + 0.1, mf.at[1], mf.at[2] + 0.02], [mf.at[0] + mf.size[0] / 2, mf.at[1], mf.at[2]]], 0.026, 10));
  kit.add("exhaust", "cast", orient(lathe([[0.001, -mf.size[0] / 2 - 0.02], [mf.size[1] * 0.42, -mf.size[0] / 2], [mf.size[1] / 2, -mf.size[0] / 2 + 0.06], [mf.size[1] / 2, mf.size[0] / 2 - 0.05], [mf.size[1] * 0.4, mf.size[0] / 2], [0.001, mf.size[0] / 2 + 0.01]], 18), muffAxis, mf.at));
  kit.add("exhaust", "trim", cylinder([mf.at[0] - mf.size[0] / 2, mf.at[1], mf.at[2]], [mf.at[0] - mf.size[0] / 2 - 0.08, mf.at[1] + 0.02, mf.at[2]], 0.03, 0.03, 10));

  // Cooling: the radiator up front, fan, hoses back to the engine.
  const rad = p.radiator;
  kit.add("cooling", "radiator", rbox(rad.at, rad.size, 0.012, [0, 0, 0.28], 1));
  kit.add("cooling", "trim", cylinder([rad.at[0] - 0.05, rad.at[1], 0], [rad.at[0] - 0.1, rad.at[1] - 0.02, 0], rad.size[1] * 0.4, rad.size[1] * 0.42, 18));
  for (const [dz, dy] of [
    [0.22, 0.12],
    [-0.22, -0.14],
  ] as const) {
    kit.add("cooling", "rubber", smoothTube([[rad.at[0] - 0.02, rad.at[1] + dy, dz], [front - 0.25, 0.5, dz * 0.8], [firstRow, railY + 0.08, dz * 0.6], [ex + 0.2, ey, dz * 0.4]], 0.017, 6));
  }
  kit.add("cooling", "trim", rbox([rad.at[0] - 0.12, rad.at[1] + rad.size[1] / 2 - 0.04, 0.24], [0.07, 0.07, 0.07], 0.015, [0, 0, 0], 1));

  // Electrical: the ECU and fuse box under the hood, the harness back to
  // the engine, the lights.
  const ecu = p.ecu;
  kit.add("electrical", "cast", rbox(ecu.at, ecu.size, 0.01, [0, 0, 0], 1));
  kit.add("electrical", "trim", rbox([ecu.at[0] + 0.02, ecu.at[1], ecu.at[2] + 0.22], [0.14, 0.06, 0.1], 0.01, [0, 0, 0], 1));
  kit.add("electrical", "trim", smoothTube([[ecu.at[0], ecu.at[1] - 0.02, ecu.at[2]], [cage.footFront - 0.05, 0.62, -0.2], [firstRow, railY + 0.14, -0.22], [ex + 0.1, ey - 0.08, -0.2]], 0.012, 6));

  // --- Cab ----------------------------------------------------------------------------
  const floorY = railY + 0.06;
  kit.add("shell", "plastic", planPanel([[cage.footFront + 0.08, cabHalf - 0.02], [cage.footBack + 0.12, cabHalf - 0.02], [cage.footBack + 0.12, -cabHalf + 0.02], [cage.footFront + 0.08, -cabHalf + 0.02]], floorY, floorY + 0.03, { radius: 0.06, bevel: 0.01 }));
  for (const row of L.rows) seats(kit, row.x, row.across, L.seatY, cabHalf, utility || (cab && row.across === 3), sport);
  // Dash across the cab, steering column and wheel.
  const dashX = firstRow + 0.6;
  kit.add(
    "shell",
    "plastic",
    frontPanel(
      [
        [-cabHalf + 0.02, 0.7],
        [cabHalf - 0.02, 0.7],
        [cabHalf - 0.04, 0.94],
        [0.0, 0.99],
        [-cabHalf + 0.04, 0.94],
      ],
      dashX - 0.08,
      dashX + 0.08,
      { radius: 0.06, bevel: 0.03 },
    ),
  );
  const st = L.steer;
  kit.add("steering", "trim", cylinder([dashX + 0.02, st[1] - 0.18, st[2]], [st[0], st[1], st[2]], 0.025, 0.02, 10));
  kit.add("steering", "trim", torus([st[0] - 0.01, st[1], st[2]], [Math.cos(0.9), Math.sin(0.9), 0], 0.18, 0.019, 32));
  for (const angle of [Math.PI / 2, Math.PI * 1.15, -Math.PI * 0.15]) {
    const dir: V3 = [-Math.sin(0.9) * Math.cos(angle), Math.cos(0.9) * Math.cos(angle), Math.sin(angle)];
    kit.add("steering", "trim", cylinder([st[0], st[1], st[2]], [st[0] + dir[0] * 0.17, st[1] + dir[1] * 0.17, st[2] + dir[2] * 0.17], 0.012, 0.012, 6));
  }
  kit.add("steering", "cast", sphere([st[0] + 0.01, st[1] + 0.01, st[2]], 0.045, 12));
  // Steering shaft down to the rack, the rack and tie rods.
  kit.add("steering", "metal", cylinder([dashX, st[1] - 0.2, st[2]], [front - 0.08, R + 0.2, 0.06], 0.014, 0.014, 6));
  kit.add("steering", "cast", cylinder([front - 0.1, R + 0.18, -0.2], [front - 0.1, R + 0.18, 0.2], 0.03, 0.03, 10));
  for (const side of sides) kit.add("steering", "metal", cylinder([front - 0.1, R + 0.18, side * 0.2], [front - 0.12, R + 0.05, side * (T - W / 2 - 0.1)], 0.012, 0.012, 6));

  // --- Cage and roof -----------------------------------------------------------------
  const cageR = sport ? 0.026 : 0.024;
  const cageHalf = cabHalf;
  const roofY = cage.roofY;
  for (const side of sides) {
    const z = side * cageHalf;
    const zIn = side * (cageHalf - 0.04);
    kit.add(
      "body_frame",
      "frame",
      tube(
        [
          [cage.footFront, 0.92, side * (cageHalf - 0.08)],
          [cage.roofFront, roofY, zIn],
          [cage.roofBack, roofY, zIn],
          [cage.footBack, 0.92, z],
        ],
        cageR,
        0.16,
      ),
    );
    // Four seats: a hoop between the rows.
    for (const row of L.rows.slice(1)) {
      kit.add("body_frame", "frame", tube([[row.x + 0.38, roofY, zIn], [row.x + 0.36, 0.9, z]], cageR * 0.9, 0.1));
    }
  }
  for (const x of [cage.roofFront, cage.roofBack]) kit.add("body_frame", "frame", cylinder([x, roofY, -cageHalf + 0.04], [x, roofY, cageHalf - 0.04], cageR, cageR, 10));
  // Behind the seats: a cross brace (RZR) or the bed's front wall.
  if (sport) {
    const braceX = cage.roofBack + (cage.footBack - cage.roofBack) * 0.45;
    const braceY = roofY + (0.92 - roofY) * 0.45;
    kit.add("body_frame", "frame", cylinder([braceX, braceY, -cageHalf + 0.03], [cage.footBack, 0.94, cageHalf - 0.03], cageR * 0.8, cageR * 0.8, 8));
    // Rear braces from the roof's back corners down to the back of the frame.
    for (const side of sides) kit.add("body_frame", "frame", tube([[cage.roofBack, roofY, side * (cageHalf - 0.04)], [L.tail + 0.3, 0.98, side * 0.36], [L.tail + 0.16, 0.6, side * 0.32]], cageR * 0.85, 0.08));
  }
  // Roof: moulded black plastic (painted on the Xpedition), domed a little,
  // with a lip round its edge.
  const roofMat = cab ? "paint" : "plastic";
  const rf = cage.roofFront + 0.1;
  const rb = cage.roofBack - 0.08;
  const rh = cageHalf + 0.05;
  kit.add(
    "shell",
    roofMat,
    loft([
      section(rf + 0.05, rh - 0.06, roofY + 0.012, roofY + 0.04, { p: 6, points: 24 }),
      section(rf - 0.03, rh, roofY + 0.005, roofY + 0.065, { p: 6, crown: 0.012, points: 24 }),
      section((rf + rb) / 2, rh, roofY + 0.005, roofY + 0.075, { p: 6, crown: 0.022, points: 24 }),
      section(rb + 0.05, rh, roofY + 0.005, roofY + 0.065, { p: 6, crown: 0.012, points: 24 }),
      section(rb - 0.02, rh - 0.05, roofY + 0.012, roofY + 0.045, { p: 6, points: 24 }),
    ]),
  );

  // --- Body --------------------------------------------------------------------------
  if (sport) rzrBody(kit, L, { cabHalf, bodyHalf });
  else if (cab) xpeditionBody(kit, L, { cabHalf, bodyHalf });
  else utilityBody(kit, L, { cabHalf, bodyHalf, cross });

  // Lights: the headlights and tail lights are part of the electrical.
  void lastRow;
}

// Bucket seats (or a bench) for a row at x: cushion, back, bolsters.
function seats(kit: Kit, x: number, across: number, seatY: number, cabHalf: number, bench: boolean, sport: boolean) {
  const width = (cabHalf * 2 - 0.12) / across;
  if (bench) {
    const w = cabHalf * 2 - 0.14;
    kit.add("shell", "seat", rbox([x, seatY - 0.06, 0], [0.5, 0.12, w], 0.05, [0, 0, 0], 3));
    kit.add("shell", "seat", rbox([x - 0.27, seatY + 0.22, 0], [0.1, 0.44, w], 0.05, [0, 0, 0.12], 3));
    kit.add("shell", "plastic", rbox([x, seatY - 0.2, 0], [0.44, 0.18, w - 0.04], 0.03, [0, 0, 0], 1));
    for (let i = 1; i < across; i++) {
      const z = -cabHalf + 0.07 + i * (w / across);
      kit.add("shell", "trim", rbox([x + 0.02, seatY + 0.005, z], [0.46, 0.012, 0.012], 0.005, [0, 0, 0], 1));
    }
    return;
  }
  for (let i = 0; i < across; i++) {
    const z = -cabHalf + 0.06 + width * (i + 0.5);
    const w = Math.min(width - 0.06, 0.5);
    kit.add("shell", "seat", rbox([x, seatY - 0.05, z], [0.48, 0.12, w], 0.05, [0, 0, 0], 3));
    if (sport) {
      // A sport bucket: the back, and a headrest above it with the harness
      // gap between.
      kit.add("shell", "seat", rbox([x - 0.25, seatY + 0.24, z], [0.12, 0.5, w * 0.92], 0.06, [0, 0, 0.16], 3));
      kit.add("shell", "seat", rbox([x - 0.33, seatY + 0.6, z], [0.1, 0.17, w * 0.58], 0.05, [0, 0, 0.16], 3));
    } else {
      kit.add("shell", "seat", rbox([x - 0.25, seatY + 0.26, z], [0.11, 0.54, w * 0.92], 0.05, [0, 0, 0.16], 3));
    }
    // Side bolsters, and a head rest on the RZR's buckets.
    for (const s of [-1, 1]) {
      kit.add("shell", "seat", rbox([x - 0.04, seatY + 0.03, z + s * (w / 2 - 0.03)], [0.42, 0.1, 0.07], 0.03, [0, 0, 0], 2));
      kit.add("shell", "seat", rbox([x - 0.22, seatY + 0.28, z + s * (w / 2 - 0.02)], [0.12, 0.42, 0.07], 0.03, [0, 0, 0.16], 2));
    }
    kit.add("shell", "plastic", rbox([x, seatY - 0.18, z], [0.4, 0.16, w - 0.08], 0.03, [0, 0, 0], 1));
  }
}

// --- RZR ------------------------------------------------------------------------------

function rzrBody(kit: Kit, L: Layout, { cabHalf, bodyHalf }: { cabHalf: number; bodyHalf: number }) {
  const R = L.tireR;
  const W = L.tireW;
  const T = L.track / 2;
  const front = L.axles[0];
  const rear = L.axles[1];
  const nose = L.nose;
  const cage = L.cage!;
  const sides = [1, -1] as const;
  const cowl = cage.footFront - 0.02;
  // The fenders reach out over the tyres (the long-travel arms put the
  // wheels well outside the body); the body between them is narrow.
  const fo = T + W / 2 + 0.03;
  const hoodHalf = bodyHalf - 0.12;
  const fenderTop = 2 * R + 0.17;

  // The hood: a low wedge from the cowl down to a pointed nose, a raised
  // spine down its middle, its edges folded down to the fenders.
  const hood = (x: number, half: number, top: number, bottom: number, spine: number): V3[] =>
    crossRing(x, [
      [0, top + spine],
      [half * 0.34, top + spine * 0.9, true],
      [half * 0.52, top + spine * 0.15, true],
      [half - 0.05, top, true],
      [half, top - 0.06, true],
      [half, bottom, true],
      [0, bottom],
    ]);
  kit.add(
    "shell",
    "paint",
    loft([
      hood(nose - 0.01, 0.2, 0.58, 0.5, 0.0),
      hood(nose - 0.1, 0.27, 0.64, 0.48, 0.015),
      hood(front + 0.18, hoodHalf - 0.06, 0.76, 0.48, 0.03),
      hood(front - 0.12, hoodHalf, 0.84, 0.48, 0.035),
      hood(cowl + 0.08, hoodHalf + 0.02, 0.9, 0.5, 0.03),
      hood(cowl, hoodHalf + 0.02, 0.92, 0.5, 0.02),
    ]),
  );
  // The black front fascia under the nose: the grille and the bumper, a
  // skid plate under it.
  const fascia = (x: number, half: number, top: number, bottom: number) =>
    crossRing(x, [
      [0, top],
      [half - 0.04, top, true],
      [half, top - 0.04, true],
      [half, bottom + 0.03, true],
      [half - 0.05, bottom, true],
      [0, bottom],
    ]);
  kit.add("shell", "plastic", loft([fascia(nose + 0.06, 0.2, 0.52, 0.36), fascia(nose - 0.04, 0.3, 0.52, 0.32), fascia(front + 0.16, 0.34, 0.5, 0.32)]));
  kit.add("shell", "trim", loft([fascia(nose + 0.075, 0.15, 0.49, 0.41), fascia(nose + 0.055, 0.16, 0.495, 0.405)]));
  kit.add("cooling", "radiator", rbox([nose + 0.06, 0.45, 0], [0.02, 0.07, 0.26], 0.01, [0, 0, 0], 1));

  for (const side of sides) {
    // The front fender: an angular shell over the tyre, from the headlight
    // back to the door, its top falling away to the outside and its outer
    // edge turned down; narrower at the nose.
    const zi = side * (hoodHalf - 0.02);
    const fenderPath: CP[] = [
      [nose - 0.02, 0.6],
      [nose - 0.17, 0.79, true],
      [front + 0.2, fenderTop - 0.02, true],
      [front - 0.24, fenderTop, true],
      [front - 0.46, fenderTop - 0.12, true],
      [cowl - 0.02, 0.68],
    ];
    const fender = (zo: number, drop: number): CP[] => [
      [0.03, zi],
      [0.03 - drop * 0.7, zo - side * 0.04, true],
      [-drop, zo, true],
      [-drop - 0.08, zo - side * 0.005, true],
      [-drop - 0.08, zo - side * 0.03, true],
      [-drop * 0.7 - 0.01, zo - side * 0.06],
      [-0.01, zi],
    ];
    kit.add("shell", "paint", sweep(fenderPath, (i) => fender(side * (i === 0 ? fo - 0.16 : i === 1 ? fo - 0.05 : fo), i === 0 ? 0.03 : 0.09)));
    // Black liner under the fender, round the tyre's top.
    const [f0, f1] = archSpan(front, R, R + 0.1, R + 0.18, nose - 0.05, cowl + 0.05);
    kit.add("shell", "plastic", flare(front, R, R + 0.1, f0, f1, side * (hoodHalf + 0.02), side * (fo - 0.06), { thick: 0.02, lip: 0.0, steps: 14 }));
    // Slim LED headlights in the fenders' sloping noses, raked up to the
    // outside.
    const [hx, hy] = [nose - 0.095, 0.695];
    const face = Math.atan2(0.15, 0.19);
    kit.add("shell", "plastic", rbox([hx + Math.cos(face) * 0.035, hy + Math.sin(face) * 0.035, side * (hoodHalf + 0.15)], [0.02, 0.07, 0.26], 0.015, [side * 0.22, 0, face], 1));
    kit.add("electrical", "led", rbox([hx + Math.cos(face) * 0.047, hy + Math.sin(face) * 0.047, side * (hoodHalf + 0.155)], [0.012, 0.03, 0.22], 0.01, [side * 0.22, 0, face], 1));

    // The rear fender over the rear tyre, and its liner.
    kit.add(
      "shell",
      "paint",
      sweep(
        [
          [cage.footBack + 0.02, 0.64],
          [rear + 0.5, fenderTop - 0.06, true],
          [rear + 0.2, fenderTop, true],
          [L.tail + 0.16, fenderTop - 0.01, true],
          [L.tail + 0.02, 0.76],
        ],
        fender(side * fo, 0.05).map(([n, z]) => [n, z === zi ? side * (bodyHalf - 0.06) : z] as CP),
      ),
    );
    const [r0, r1] = archSpan(rear, R, R + 0.1, R + 0.2, cage.footBack, L.tail + 0.05);
    kit.add("shell", "plastic", flare(rear, R, R + 0.1, r0, r1, side * (bodyHalf - 0.04), side * (fo - 0.06), { thick: 0.02, lip: 0.0, steps: 14 }));

    // Half doors: a sharp top edge falling to the back, the accent flash
    // along it; the black rocker and the rock slider under them.
    const zOut = side * (bodyHalf + 0.04);
    const zIn = side * (bodyHalf - 0.01);
    for (const row of L.rows) {
      kit.add(
        "shell",
        "paint",
        sidePanel(
          [
            [row.x + 0.56, 0.5, 0.04],
            [row.x + 0.6, 0.88, 0.05],
            [row.x + 0.3, 0.9, 0.04],
            [row.x - 0.3, 0.8, 0.06],
            [row.x - 0.34, 0.5, 0.04],
          ],
          zIn,
          zOut,
          { radius: 0.03, bevel: 0.012 },
        ),
      );
      kit.add("shell", "accent", sidePanel([[row.x + 0.5, 0.78], [row.x + 0.48, 0.81], [row.x - 0.24, 0.71], [row.x - 0.22, 0.68]], zOut, zOut + side * 0.008, { radius: 0.01, bevel: 0.003 }));
    }
    kit.add("shell", "plastic", sidePanel([[cowl + 0.02, 0.4], [cage.footBack - 0.06, 0.4], [cage.footBack - 0.06, 0.5], [cowl + 0.02, 0.5]], side * (bodyHalf - 0.06), side * (bodyHalf + 0.05), { radius: 0.03, bevel: 0.012 }));
    kit.add("body_frame", "frame", tube([[cowl - 0.02, 0.44, side * (bodyHalf - 0.02)], [cowl - 0.12, 0.38, side * (bodyHalf + 0.09)], [cage.footBack + 0.06, 0.38, side * (bodyHalf + 0.09)], [cage.footBack - 0.04, 0.44, side * (bodyHalf - 0.02)]], 0.02, 0.06));
    kit.add("electrical", "tail", rbox([L.tail + 0.05, 0.86, side * (bodyHalf - 0.14)], [0.03, 0.05, 0.14], 0.01, [0, 0, 0], 1));
  }

  // Behind the seats, over the engine: the black cargo box and its rack.
  const box = (x: number, half: number, top: number, bottom: number) =>
    crossRing(x, [
      [0, top],
      [half - 0.03, top, true],
      [half, top - 0.03, true],
      [half, bottom, true],
      [0, bottom],
    ]);
  kit.add("shell", "plastic", loft([box(cage.footBack - 0.02, bodyHalf - 0.08, 0.92, 0.6), box(L.tail + 0.12, bodyHalf - 0.08, 0.92, 0.6), box(L.tail + 0.04, bodyHalf - 0.14, 0.88, 0.62)]));
  rack(kit, "body_frame", L.tail + 0.1, cage.footBack - 0.04, 0.99, bodyHalf - 0.14, 6, 0.011);
  for (const side of sides) {
    for (const x of [L.tail + 0.1, cage.footBack - 0.04]) kit.add("body_frame", "frame", cylinder([x, 0.92, side * (bodyHalf - 0.14)], [x, 0.99, side * (bodyHalf - 0.14)], 0.011, 0.011, 6));
  }
  // Rear and front bumpers.
  kit.add("body_frame", "frame", tube([[L.tail + 0.14, 0.5, 0.34], [L.tail + 0.0, 0.54, 0.3], [L.tail + 0.0, 0.54, -0.3], [L.tail + 0.14, 0.5, -0.34]], 0.022, 0.06));
  kit.add("body_frame", "frame", tube([[nose - 0.14, 0.36, 0.26], [nose + 0.08, 0.38, 0.2], [nose + 0.08, 0.38, -0.2], [nose - 0.14, 0.36, -0.26]], 0.022, 0.06));
  void cabHalf;
}

// --- Ranger, General, ACE ----------------------------------------------------------------

function utilityBody(kit: Kit, L: Layout, { cabHalf, bodyHalf, cross }: { cabHalf: number; bodyHalf: number; cross: boolean }) {
  const R = L.tireR;
  const W = L.tireW;
  const T = L.track / 2;
  const front = L.axles[0];
  const rearAxles = L.axles.slice(1);
  const nose = L.nose;
  const cage = L.cage!;
  const bed = L.bed!;
  const sides = [1, -1] as const;
  const cowl = cage.footFront - 0.02;
  const fo = T + W / 2 + 0.04;
  const grilleHalf = Math.min(0.48, cabHalf - 0.12);

  // The front clip, crisply folded panels. The General: a sporty wedge of a
  // hood between angular fenders over its tyres, an upright black grille
  // with slim LED lights at its top corners. The Ranger: a tall, flat hood
  // whose sides fold down to flat fender tops, an upright black fascia with
  // big square headlights high at its corners and a brush guard.
  const hoodHalf = cross ? Math.min(0.46, cabHalf - 0.18) : grilleHalf + 0.02;
  const fenderTop = 2 * R + (cross ? 0.19 : 0.17);
  const hoodRing = (x: number, half: number, top: number, bottom: number, spine: number): V3[] =>
    crossRing(x, [
      [0, top + spine],
      [half * 0.36, top + spine * 0.85, true],
      [half * 0.55, top + spine * 0.1, true],
      [half - 0.04, top, true],
      [half, top - 0.05, true],
      [half, bottom, true],
      [0, bottom],
    ]);
  kit.add(
    "shell",
    "paint",
    loft(
      cross
        ? [
            hoodRing(nose - 0.06, hoodHalf - 0.12, 0.76, 0.6, 0.0),
            hoodRing(nose - 0.14, hoodHalf - 0.06, 0.8, 0.58, 0.015),
            hoodRing(front - 0.1, hoodHalf, 0.92, 0.6, 0.03),
            hoodRing(cowl + 0.06, hoodHalf + 0.02, 0.99, 0.62, 0.025),
            hoodRing(cowl, hoodHalf + 0.02, 1.0, 0.62, 0.02),
          ]
        : [
            hoodRing(nose - 0.02, hoodHalf, 0.97, fenderTop - 0.04, 0.0),
            hoodRing(nose - 0.08, hoodHalf, 1.0, fenderTop - 0.04, 0.012),
            hoodRing(front - 0.2, hoodHalf, 1.04, fenderTop - 0.04, 0.018),
            hoodRing(cowl, hoodHalf, 1.07, fenderTop - 0.04, 0.012),
          ],
    ),
  );
  for (const side of sides) {
    const zi = side * (hoodHalf - 0.03);
    const drop = cross ? 0.07 : 0.015;
    const lip = cross ? 0.1 : 0.15;
    const fender = (zo: number): CP[] => [
      [0.03, zi],
      [0.03 - drop * 0.7, zo - side * 0.04, true],
      [-drop, zo, true],
      [-drop - lip, zo - side * 0.005, true],
      [-drop - lip, zo - side * 0.03, true],
      [-drop * 0.7 - 0.01, zo - side * 0.06],
      [-0.01, zi],
    ];
    const path: CP[] = cross
      ? [
          [nose - 0.04, 0.64],
          [nose - 0.16, 0.8, true],
          [front + 0.22, fenderTop - 0.02, true],
          [front - 0.24, fenderTop, true],
          [front - 0.46, fenderTop - 0.12, true],
          [cowl - 0.02, 0.7],
        ]
      : [
          [nose - 0.02, 0.62],
          [nose - 0.05, fenderTop - 0.02, true],
          [front + 0.06, fenderTop, true],
          [front - 0.3, fenderTop, true],
          [front - 0.44, fenderTop - 0.12, true],
          [cowl - 0.02, 0.62],
        ];
    kit.add("shell", "paint", sweep(path, (i) => fender(side * (cross && i === 0 ? fo - 0.14 : cross && i === 1 ? fo - 0.04 : fo))));
    // Black liner round the tyre's top under the fender.
    const [f0, f1] = archSpan(front, R, R + 0.1, R + 0.16, nose - 0.05, cowl + 0.05);
    kit.add("shell", "plastic", flare(front, R, R + 0.1, f0, f1, side * (hoodHalf + 0.0), side * (fo - 0.06), { thick: 0.02, lip: 0.0, steps: 14 }));
  }

  if (cross) {
    // The upright black grille between the fenders, its mesh, the bumper.
    const g = hoodHalf - 0.1;
    kit.add("shell", "plastic", frontPanel([[-g, 0.4], [g, 0.4], [g + 0.04, 0.66], [g - 0.04, 0.74], [-(g - 0.04), 0.74], [-(g + 0.04), 0.66]], nose - 0.08, nose + 0.02, { radius: 0.03, bevel: 0.012 }));
    kit.add("shell", "trim", frontPanel([[-(g - 0.06), 0.47], [g - 0.06, 0.47], [g - 0.04, 0.66], [-(g - 0.04), 0.66]], nose + 0.02, nose + 0.035, { radius: 0.02, bevel: 0.004 }));
    for (let i = 0; i < 4; i++) kit.add("shell", "plastic", rbox([nose + 0.04, 0.5 + i * 0.045, 0], [0.012, 0.012, 2 * (g - 0.08)], 0.004, [0, 0, 0], 1));
    for (const side of sides) {
      // Slim LED lights raked up to the outside at the grille's top corners.
      const [hx, hy] = [nose - 0.1, 0.72];
      const face = Math.atan2(0.16, 0.12);
      kit.add("shell", "plastic", rbox([hx + Math.cos(face) * 0.035, hy + Math.sin(face) * 0.035, side * (hoodHalf + 0.06)], [0.02, 0.07, 0.24], 0.015, [side * 0.2, 0, face], 1));
      kit.add("electrical", "led", rbox([hx + Math.cos(face) * 0.047, hy + Math.sin(face) * 0.047, side * (hoodHalf + 0.065)], [0.012, 0.03, 0.2], 0.01, [side * 0.2, 0, face], 1));
    }
    kit.add("shell", "plastic", rbox([nose - 0.02, 0.37, 0], [0.12, 0.08, 2 * hoodHalf - 0.06], 0.025, [0, 0, 0], 1));
    kit.add("body_frame", "frame", tube([[nose - 0.12, 0.4, 0.44], [nose + 0.06, 0.42, 0.36], [nose + 0.06, 0.42, -0.36], [nose - 0.12, 0.4, -0.44]], 0.022, 0.06));
  } else {
    // The upright black fascia: big square headlights high at its corners,
    // the grille between, the bumper under it; the brush guard in front.
    const g = hoodHalf;
    kit.add("shell", "plastic", frontPanel([[-g, 0.42], [g, 0.42], [g, 0.94], [g - 0.04, 0.98], [-(g - 0.04), 0.98], [-g, 0.94]], nose - 0.04, nose + 0.02, { radius: 0.02, bevel: 0.012 }));
    for (const side of sides) {
      const lamp: [number, number][] = [
        [side * (g - 0.03), 0.93],
        [side * (g - 0.24), 0.93],
        [side * (g - 0.22), 0.82],
        [side * (g - 0.03), 0.8],
      ];
      kit.add("shell", "trim", frontPanel(lamp.map(([z, y]) => [z + side * 0.01, y]), nose + 0.02, nose + 0.035, { radius: 0.015, bevel: 0.004 }));
      kit.add("electrical", "led", frontPanel(lamp.map(([z, y]) => [z - side * 0.015, y + (y > 0.9 ? -0.015 : 0.015)]), nose + 0.035, nose + 0.045, { radius: 0.012, bevel: 0.003 }));
      kit.add("body_frame", "frame", tube([[nose - 0.02, 0.38, side * (g - 0.02)], [nose + 0.16, 0.42, side * (g - 0.06)], [nose + 0.16, 0.84, side * (g - 0.1)], [nose + 0.02, 0.92, side * (g - 0.14)]], 0.022, 0.08));
    }
    kit.add("shell", "trim", frontPanel([[-(g - 0.27), 0.52], [g - 0.27, 0.52], [g - 0.27, 0.9], [-(g - 0.27), 0.9]], nose + 0.02, nose + 0.035, { radius: 0.02, bevel: 0.004 }));
    for (let i = 0; i < 5; i++) kit.add("shell", "plastic", rbox([nose + 0.04, 0.56 + i * 0.07, 0], [0.012, 0.016, 2 * (g - 0.29)], 0.004, [0, 0, 0], 1));
    kit.add("shell", "plastic", rbox([nose, 0.43, 0], [0.1, 0.1, 2 * g], 0.025, [0, 0, 0], 1));
    kit.add("body_frame", "frame", cylinder([nose + 0.16, 0.84, -(g - 0.1)], [nose + 0.16, 0.84, g - 0.1], 0.02, 0.02, 10));
    kit.add("body_frame", "frame", cylinder([nose + 0.16, 0.46, -(g - 0.06)], [nose + 0.16, 0.46, g - 0.06], 0.024, 0.024, 10));
    for (const dz of [-0.1, 0.1]) kit.add("body_frame", "frame", cylinder([nose + 0.16, 0.46, dz], [nose + 0.16, 0.84, dz], 0.016, 0.016, 8));
  }

  // Under the bed: painted rear fenders round the rear wheels, flat-topped
  // at the bed's floor, and their black liners.
  const ro = T + W / 2 + 0.035;
  const bh = Math.min(bodyHalf + 0.02, 0.68);
  const lastAxle = rearAxles.at(-1)!;
  const deck = bed.floor - 0.03;
  for (const side of sides) {
    const zi = side * (bh - 0.12);
    const rearFender: CP[] = [
      [0.025, zi],
      [0.025, ro * side - side * 0.03, true],
      [0.0, ro * side, true],
      [-0.13, ro * side - side * 0.005, true],
      [-0.13, ro * side - side * 0.03, true],
      [-0.01, ro * side - side * 0.05],
      [-0.01, zi],
    ];
    kit.add(
      "shell",
      "paint",
      sweep(
        [
          [bed.front + 0.02, 0.5],
          [rearAxles[0] + R + 0.16, deck - 0.02, true],
          [lastAxle - R - 0.06, deck - 0.02, true],
          [bed.back + 0.01, 0.6],
        ],
        rearFender,
      ),
    );
    for (const x of rearAxles) {
      const [r0, r1] = archSpan(x, R, R + 0.08, R + 0.12, bed.front + 0.02, bed.back);
      kit.add("shell", "plastic", flare(x, R, R + 0.08, r0, r1, side * (bh - 0.1), side * (ro - 0.06), { thick: 0.02, lip: 0.0, steps: 14 }));
    }
  }

  for (const side of sides) {
    const zOut = side * (bodyHalf + 0.03);
    const zIn = side * (bodyHalf - 0.02);
    // Half doors (black plastic on the Ranger, painted on the General).
    for (const row of L.rows) {
      kit.add(
        "shell",
        cross ? "paint" : "plastic",
        sidePanel(
          [
            [row.x + 0.4, 0.46],
            [row.x + 0.42, 0.92, 0.08],
            [row.x - 0.14, 0.95, 0.12],
            [row.x - 0.3, 0.82],
            [row.x - 0.3, 0.46],
          ],
          zIn,
          zOut,
          { radius: 0.05, bevel: 0.02 },
        ),
      );
    }
    // The rocker under the cab.
    kit.add(
      "shell",
      "plastic",
      sidePanel(
        [
          [cowl + 0.02, 0.38],
          [bed.front + 0.04, 0.38],
          [bed.front + 0.04, 0.5],
          [cowl + 0.02, 0.5],
        ],
        side * (bodyHalf - 0.04),
        side * (bodyHalf + 0.05),
        { radius: 0.04, bevel: 0.02 },
      ),
    );
    kit.add("electrical", "tail", rbox([bed.back - 0.01, bed.floor - 0.12, side * (bh - 0.1)], [0.03, 0.1, 0.1], 0.01, [0, 0, 0], 1));
  }

  // The dump bed (a small box on the General): floor, walls, tailgate.
  const wall = bed.wall;
  kit.add("shell", "plastic", planPanel([[bed.front, bh], [bed.back, bh], [bed.back, -bh], [bed.front, -bh]], bed.floor - 0.04, bed.floor, { radius: 0.03, bevel: 0.01 }));
  for (const side of sides) {
    kit.add(
      "shell",
      "plastic",
      sidePanel(
        [
          [bed.front, bed.floor - 0.04],
          [bed.back, bed.floor - 0.04],
          [bed.back, bed.floor + wall],
          [bed.front, bed.floor + wall],
        ],
        side * (bh - 0.04),
        side * bh,
        { radius: 0.02, bevel: 0.01 },
      ),
    );
    // The bed's top rail and its stake pockets.
    kit.add("shell", "trim", rbox([(bed.front + bed.back) / 2, bed.floor + wall + 0.012, side * (bh - 0.02)], [bed.front - bed.back, 0.024, 0.06], 0.01, [0, 0, 0], 1));
  }
  kit.add("shell", "plastic", frontPanel([[-bh, bed.floor - 0.04], [bh, bed.floor - 0.04], [bh, bed.floor + wall], [-bh, bed.floor + wall]], bed.back, bed.back + 0.04, { radius: 0.02, bevel: 0.01 }));
  kit.add("shell", "plastic", frontPanel([[-bh, bed.floor - 0.04], [bh, bed.floor - 0.04], [bh, bed.floor + wall + 0.08], [-bh, bed.floor + wall + 0.08]], bed.front - 0.04, bed.front, { radius: 0.02, bevel: 0.01 }));
  kit.add("body_frame", "frame", tube([[bed.back + 0.04, 0.5, 0.3], [bed.back - 0.04, 0.52, 0.26], [bed.back - 0.04, 0.52, -0.26], [bed.back + 0.04, 0.5, -0.3]], 0.02, 0.06));
}

// --- Xpedition --------------------------------------------------------------------------

function xpeditionBody(kit: Kit, L: Layout, { cabHalf, bodyHalf }: { cabHalf: number; bodyHalf: number }) {
  // A Ranger-like front and bed, with a closed cab: windshield, doors with
  // glass, a painted roof and rear wall.
  utilityBody(kit, L, { cabHalf, bodyHalf, cross: false });
  const cage = L.cage!;
  const sides = [1, -1] as const;
  const roofY = cage.roofY;
  // Windshield between the front pillars.
  kit.add(
    "shell",
    "glass",
    frontPanel(
      [
        [-cabHalf + 0.06, 1.12],
        [cabHalf - 0.06, 1.12],
        [cabHalf - 0.06, roofY - 0.02],
        [-cabHalf + 0.06, roofY - 0.02],
      ],
      (cage.footFront + cage.roofFront) / 2 - 0.01,
      (cage.footFront + cage.roofFront) / 2 + 0.01,
      { radius: 0.04, bevel: 0.004 },
    ),
  );
  for (const side of sides) {
    for (const row of L.rows) {
      // A full door: painted below, glass above.
      kit.add(
        "shell",
        "paint",
        sidePanel(
          [
            [row.x + 0.44, 0.46],
            [row.x + 0.46, 1.06],
            [row.x - 0.34, 1.06],
            [row.x - 0.34, 0.46],
          ],
          side * (cabHalf - 0.0),
          side * (cabHalf + 0.05),
          { radius: 0.05, bevel: 0.02 },
        ),
      );
      kit.add(
        "shell",
        "glass",
        sidePanel(
          [
            [row.x + 0.4, 1.08],
            [row.x + 0.2, roofY - 0.06],
            [row.x - 0.3, roofY - 0.06],
            [row.x - 0.3, 1.08],
          ],
          side * (cabHalf + 0.012),
          side * (cabHalf + 0.03),
          { radius: 0.05, bevel: 0.004 },
        ),
      );
      kit.add("shell", "trim", rbox([row.x - 0.2, 0.96, side * (cabHalf + 0.06)], [0.12, 0.025, 0.02], 0.008, [0, 0, 0], 1));
    }
    // Mirror.
    kit.add("shell", "plastic", rbox([cage.footFront + 0.02, 1.16, side * (cabHalf + 0.14)], [0.04, 0.1, 0.14], 0.02, [0, 0, 0], 1));
  }
  // Rear wall with its window.
  kit.add("shell", "paint", frontPanel([[-cabHalf, 0.9], [cabHalf, 0.9], [cabHalf, 1.2], [-cabHalf, 1.2]], cage.footBack - 0.02, cage.footBack + 0.02, { radius: 0.03, bevel: 0.01 }));
  kit.add("shell", "glass", frontPanel([[-cabHalf + 0.06, 1.2], [cabHalf - 0.06, 1.2], [cabHalf - 0.06, roofY - 0.04], [-cabHalf + 0.06, roofY - 0.04]], cage.footBack - 0.01, cage.footBack + 0.01, { radius: 0.03, bevel: 0.004 }));
}
