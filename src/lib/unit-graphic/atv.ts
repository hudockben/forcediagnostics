import { frameAt, roundRect, stadium, type Model, type V3 } from "./iso";
import { arm, shock, wheel } from "./parts";

// A Polaris-style ATV (Sportsman, Scrambler) seen from the front left:
// fenders and racks front and back, a long saddle, handlebars, and its
// systems in their places, see-through. Centimetres; x forward, y left.

const FRONT_AXLE = 64;
const REAR_AXLE = -62;
const TRACK = 46;
const TIRE = { r: 30, width: 22, rim: 17 };

export function buildAtv(m: Model) {
  const sides = [-1, 1] as const;

  // --- Wheels, brakes, suspension ------------------------------------------
  for (const side of sides) {
    arm(m, [FRONT_AXLE - 12, side * 12, 22], [FRONT_AXLE + 10, side * 12, 22], [FRONT_AXLE, side * 36, 21]);
    arm(m, [FRONT_AXLE - 10, side * 14, 40], [FRONT_AXLE + 8, side * 14, 40], [FRONT_AXLE, side * 34, 39]);
    shock(m, [FRONT_AXLE - 2, side * 30, 23], [FRONT_AXLE - 6, side * 15, 60], { r: 4.6, coils: 5 });
    arm(m, [REAR_AXLE + 14, side * 12, 22], [REAR_AXLE - 8, side * 12, 22], [REAR_AXLE, side * 34, 21]);
    arm(m, [REAR_AXLE + 12, side * 14, 38], [REAR_AXLE - 6, side * 14, 38], [REAR_AXLE, side * 33, 38]);
    shock(m, [REAR_AXLE + 4, side * 30, 24], [REAR_AXLE + 14, side * 16, 64], { r: 4.6, coils: 5 });
    wheel(m, { at: [FRONT_AXLE, side * TRACK, TIRE.r], side, ...TIRE, caliperForward: true });
    wheel(m, { at: [REAR_AXLE, side * TRACK, TIRE.r], side, ...TIRE });
  }

  // --- Frame and body ------------------------------------------------------------
  m.part("body_frame", (b) => {
    // Frame rails under the engine and up under the seat.
    for (const side of sides) {
      b.tube([[88, side * 14, 30], [70, side * 14, 22], [-70, side * 14, 22], [-92, side * 16, 40]], 2.6, "p", 6);
      b.tube([[56, side * 16, 66], [30, side * 18, 60], [-60, side * 18, 60], [-92, side * 16, 50]], 2.4, "p", 8);
    }
    // Floorboards with their toe guards.
    for (const side of sides) {
      const y0 = side > 0 ? 24 : -50;
      b.box([-28, y0, 26], [32, y0 + 26, 29], "b");
      b.face([[30, side * 24, 29], [30, side * 50, 29], [38, side * 50, 42], [38, side * 24, 42]], [0.85, 0, -0.5], "b", { back: true });
    }
  }, { layer: 1 });

  for (const side of sides) {
    m.part("body_frame", (b) => {
      // Fenders: wide, flat-topped, over each wheel.
      const left = side > 0 ? 58 : -34;
      b.sweep([FRONT_AXLE, left, TIRE.r], [1, 0, 0], [0, 0, 1], TIRE.r + 7, 0.2, Math.PI - 0.15, 24, "b", 8);
      b.sweep([REAR_AXLE, left, TIRE.r], [1, 0, 0], [0, 0, 1], TIRE.r + 7, 0.15, Math.PI - 0.2, 24, "b", 8);
    }, { layer: 1 });
  }

  m.part("body_frame", (b) => {
    // Front body and nose, rear body.
    b.loft(
      [
        [30, -30, 52],
        [30, 30, 52],
        [30, 30, 68],
        [30, -30, 68],
      ],
      [
        [100, -24, 42],
        [100, 24, 42],
        [100, 24, 60],
        [100, -24, 60],
      ],
      "b",
    );
    b.loft(
      [
        [-40, -30, 54],
        [-40, 30, 54],
        [-40, 30, 66],
        [-40, -30, 66],
      ],
      [
        [-96, -28, 52],
        [-96, 28, 52],
        [-96, 28, 66],
        [-96, -28, 66],
      ],
      "b",
    );
  }, { layer: 1 });

  m.part("body_frame", (b) => {
    // Saddle.
    b.prism(roundRect(30, 12, 5), frameAt([-58, 0, 74], [0, 1, 0], [0, 0, 1]), 70, "m", { smooth: true });
  });

  m.part("body_frame", (b) => {
    // Front and rear racks, and the front bumper.
    const rack = (x0: number, x1: number, half: number, z: number) => {
      b.tube([[x0, -half, z], [x1, -half, z], [x1, half, z], [x0, half, z], [x0, -half, z]], 2.4, "p", 3);
      for (const x of [x0 + (x1 - x0) / 3, x0 + ((x1 - x0) * 2) / 3]) b.tube([[x, -half, z], [x, half, z]], 1.8, "p");
    };
    rack(44, 98, 40, 72);
    rack(-104, -46, 42, 72);
    b.tube([[100, -26, 30], [110, -26, 44], [110, 26, 44], [100, 26, 30]], 3, "p", 4);
  }, { layer: 3 });

  // --- Inside -------------------------------------------------------------------
  m.part("engine", (b) => {
    b.box([-22, -16, 24], [12, 10, 46]);
    b.box([-12, -12, 46], [8, 6, 64]);
    b.box([-14, -14, 64], [10, 8, 72]);
    for (const z of [50, 55, 60]) b.line([[8, -12, z], [8, 6, z]], "d");
  });

  m.part("ignition", (b) => {
    b.box([-6, -4, 72], [3, 4, 80]);
    b.cylinder([6, 2, 70], [1, 0, 0.6], 2.4, 6);
  });

  m.part("drive_clutch", (b) => {
    b.prism(stadium([6, 36], 13, [-34, 36], 15, 12), frameAt([0, 24, 0], [1, 0, 0], [0, 0, 1]), 12, "p", { smooth: true });
    b.ring(frameAt([6, 24.5, 36], [1, 0, 0], [0, 0, 1]), 5, "d");
    b.ring(frameAt([-34, 24.5, 36], [1, 0, 0], [0, 0, 1]), 6, "d");
  });

  m.part("transmission", (b) => {
    b.box([-50, -14, 22], [-24, 10, 44]);
    b.box([-46, -10, 44], [-32, 2, 50]);
  });

  m.part("rear_drive", (b) => {
    b.cylinder([REAR_AXLE, -2, 28], [0, 1, 0], 8, 18);
    for (const side of sides) {
      b.tube([[REAR_AXLE, side * 7, 28], [REAR_AXLE, side * 36, 29]], 2.8, "p");
      b.cylinder([REAR_AXLE, side * 15, 28], [0, 1, 0], 3.6, 6);
      b.cylinder([REAR_AXLE, side * 32, 29], [0, 1, 0], 3.6, 6);
    }
  });

  m.part("front_drive", (b) => {
    b.box([FRONT_AXLE - 8, -9, 20], [FRONT_AXLE + 8, 9, 36]);
    for (const side of sides) {
      b.tube([[FRONT_AXLE, side * 9, 28], [FRONT_AXLE, side * 36, 29]], 2.8, "p");
      b.cylinder([FRONT_AXLE, side * 16, 28], [0, 1, 0], 3.6, 6);
      b.cylinder([FRONT_AXLE, side * 32, 29], [0, 1, 0], 3.6, 6);
    }
    b.tube([[FRONT_AXLE - 8, -2, 26], [-24, -4, 28]], 2.4, "p");
  });

  m.part("exhaust", (b) => {
    // Header off the front of the cylinder, round the right side, back to
    // the muffler under the rear rack.
    b.tube([[6, -6, 62], [14, -12, 56], [8, -24, 46], [-46, -26, 50], [-62, -22, 60]], 3.6, "p", 8);
    b.cylinder([-76, -22, 62], [1, 0, 0.12], 8, 30);
  });

  m.part("air_intake", (b) => {
    // Airbox under the front body, its duct back to the throttle body.
    b.box([32, -14, 46], [54, 14, 60]);
    b.tube([[32, 0, 56], [16, 0, 66], [-6, -2, 66], [-14, -4, 62]], 4, "p", 6);
  });

  m.part("fuel", (b) => {
    // Tank ahead of the saddle, cap on top.
    b.prism(roundRect(28, 14, 5), frameAt([12, 0, 70], [0, 1, 0], [0, 0, 1]), 26, "p", { smooth: true });
    b.cylinder([30, 0, 78.5], [0, 0, 1], 4, 3);
  });

  m.part("charging_starting", (b) => {
    // Battery under the back of the saddle, starter on the engine.
    b.box([-50, -10, 56], [-34, 10, 68]);
    b.line([[-47, -6, 68], [-37, -6, 68]], "d");
    b.cylinder([12, -16, 30], [1, 0, 0], 4.2, 14);
  });

  m.part("cooling", (b) => {
    // Radiator behind the front bumper, fan behind it.
    b.box([86, -22, 32], [90, 22, 58]);
    for (let z = 36; z < 56; z += 4) b.line([[90, -20, z], [90, 20, z]], "d");
    b.ring(frameAt([85, 0, 45], [0, 1, 0], [0, 0, 1]), 11, "d");
  });

  m.part("electrical", (b) => {
    // Headlights in the nose, the pod light and gauge on the bars, the ECU.
    for (const side of sides) b.ring(frameAt([100.5, side * 15, 52], [0, 1, 0], [0, 0, 1]), 4.6, "p", true);
    b.prism(roundRect(18, 9, 3), frameAt([16, 0, 96], [0, 1, 0], [0, 0, 1]), 14, "p", { smooth: true });
    b.ring(frameAt([22.5, 0, 98], [0, 1, 0], [0.5, 0, 1]), 3.6, "d");
    b.box([-20, 12, 60], [-8, 18, 68]);
  });

  m.part("steering", (b) => {
    // Handlebars with grips, the post down to the front, tie rods.
    b.tube([[24, -34, 98], [26, -18, 94], [28, 0, 92], [26, 18, 94], [24, 34, 98]], 2.4, "p", 6);
    for (const side of sides) b.tube([[24, side * 34, 98], [23, side * 42, 99]], 4, "p");
    b.tube([[28, 0, 92], [44, 0, 52], [52, 0, 34]], 2.6, "p", 6);
    for (const side of sides) b.tube([[54, 0, 32], [FRONT_AXLE - 6, side * 34, 32]], 2, "p");
  }, { layer: 3 });

  m.part("brakes", (b) => {
    // Master cylinder and lever on the right bar.
    b.box([22, -30, 96], [28, -24, 100]);
    b.tube([[20, -28, 98], [14, -38, 98]], 1.6, "p");
  }, { layer: 3 });

  const anchors: [Parameters<Model["anchor"]>[0], V3][] = [
    ["engine", [-2, -3, 56]],
    ["ignition", [-1, 0, 80]],
    ["drive_clutch", [-14, 24, 36]],
    ["transmission", [-37, -2, 48]],
    ["rear_drive", [REAR_AXLE, -2, 34]],
    ["front_drive", [FRONT_AXLE, 0, 34]],
    ["exhaust", [-76, -22, 70]],
    ["air_intake", [43, 0, 60]],
    ["fuel", [26, 0, 82]],
    ["charging_starting", [-42, 0, 68]],
    ["cooling", [90, 0, 58]],
    ["electrical", [22, -2, 99]],
    ["steering", [24, 38, 98]],
    ["suspension", [FRONT_AXLE - 4, 24, 44]],
    ["brakes", [FRONT_AXLE + 6, TRACK - 3, 36]],
    ["wheels_tires", [REAR_AXLE, TRACK + 11, 4]],
    ["body_frame", [-74, 30, 72]],
  ];
  for (const [zone, point] of anchors) m.anchor(zone, point);
}
