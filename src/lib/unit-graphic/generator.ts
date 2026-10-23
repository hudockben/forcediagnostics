import { circle, frameAt, roundRect, type Model, type V3 } from "./iso";
import { wheel } from "./parts";

// An open-frame portable generator seen from the engine end: tube frame,
// fuel tank on top, engine and muffler at one end, the alternator and its
// control panel at the other, a wheel kit. Only the systems a generator has
// are drawn. Centimetres; x towards the engine end, y left.

export function buildGenerator(m: Model) {
  const sides = [-1, 1] as const;

  for (const side of sides) {
    wheel(m, { at: [-26, side * 30, 10], side, r: 10, width: 6, rim: 5.5, spokes: 4, brakes: false });
  }

  m.part("body_frame", (b) => {
    // Two side loops joined by cross tubes, feet at the engine end.
    for (const side of sides) {
      const y = side * 24;
      b.tube([[-34, y, 6], [34, y, 6], [34, y, 58], [-34, y, 58], [-34, y, 6]], 2.6, "p", 6);
    }
    for (const [x, z] of [
      [-34, 58],
      [34, 58],
      [34, 6],
      [-34, 6],
    ] as const) {
      b.tube([[x, -24, z], [x, 24, z]], 2.6, "p");
    }
    for (const side of sides) b.box([26, side * 24 - 3, 0], [32, side * 24 + 3, 6], "p");
  }, { layer: 3 });

  m.part("fuel", (b) => {
    b.prism(roundRect(44, 13, 5), frameAt([-30, 0, 48], [0, 1, 0], [0, 0, 1]), 48, "p", { smooth: true });
    b.cylinder([-20, 0, 55.5], [0, 0, 1], 4, 3);
    b.ring(frameAt([0, 0, 54.6], [1, 0, 0], [0, 1, 0]), 3, "d");
  });

  m.part("engine", (b) => {
    // Crankcase and a cylinder leaning towards the engine end.
    b.box([0, -14, 8], [24, 12, 28]);
    b.loft(
      [
        [10, -9, 28],
        [24, -9, 28],
        [24, 7, 28],
        [10, 7, 28],
      ],
      [
        [18, -8, 40],
        [30, -8, 40],
        [30, 6, 40],
        [18, 6, 40],
      ],
      "p",
    );
    for (const z of [31, 34, 37]) b.line([[21 + (z - 28) * 0.55, -8, z], [21 + (z - 28) * 0.55, 6, z]], "d");
  });

  m.part("ignition", (b) => {
    b.cylinder([31, -2, 36], [1, 0, 0.3], 2.2, 7);
    b.box([2, 12, 22], [8, 16, 30]);
  });

  m.part("air_intake", (b) => {
    b.box([12, 8, 28], [24, 20, 40]);
    b.line([[13, 20, 31], [23, 20, 31]], "d");
  });

  m.part("exhaust", (b) => {
    // Muffler under a heat shield at the engine end.
    b.cylinder([30, -14, 46], [0, 1, 0], 6, 18);
    b.tube([[24, -8, 38], [28, -10, 44]], 2.4, "p");
  });

  m.part("cooling", (b) => {
    // The flywheel fan's shroud on the left of the engine.
    const frame = frameAt([10, 13, 18], [1, 0, 0], [0, 0, 1]);
    b.prism(circle(9, 20), frameAt([10, 15, 18], [1, 0, 0], [0, 0, 1]), 3, "p", { smooth: true });
    for (const r of [3.5, 6]) b.ring(frame, r, "d");
  });

  m.part("charging_starting", (b) => {
    // Battery by the alternator, the electric starter on the engine.
    b.box([-30, -20, 7], [-18, -8, 19]);
    b.cylinder([6, -15, 12], [1, 0, 0], 3.4, 10);
  });

  m.part("electrical", (b) => {
    // Alternator, and its control panel with outlets on the near side.
    b.cylinder([-14, 0, 22], [1, 0, 0], 12, 24);
    b.box([-32, 20, 12], [-6, 23, 38], "p");
    for (const [x, z] of [
      [-26, 30],
      [-13, 30],
      [-26, 19],
      [-13, 19],
    ] as const) {
      b.ring(frameAt([x, 23.5, z], [1, 0, 0], [0, 0, 1]), 3, "d");
    }
  });

  const anchors: [Parameters<Model["anchor"]>[0], V3][] = [
    ["engine", [12, -2, 28]],
    ["fuel", [-6, 0, 55]],
    ["ignition", [33, -2, 38]],
    ["air_intake", [18, 20, 40]],
    ["exhaust", [30, -14, 52]],
    ["cooling", [10, 16, 27]],
    ["charging_starting", [-24, -14, 19]],
    ["electrical", [-19, 23, 38]],
    ["wheels_tires", [-26, 33, 0]],
    ["body_frame", [0, 24, 58]],
  ];
  for (const [zone, point] of anchors) m.anchor(zone, point);
}
