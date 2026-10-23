import { frameAt, roundRect, stadium, type Model, type V3 } from "./iso";
import { arm, shock, wheel } from "./parts";

// A Polaris-style side-by-side (Ranger, General, RZR, Xpedition) seen from
// the front left: roll cage, two seats, hood, cargo bed, and its systems in
// their places, see-through like an X-ray. Centimetres; x forward, y left.

const FRONT_AXLE = 102;
const REAR_AXLE = -108;
const TRACK = 66; // wheel centre from the middle
const TIRE = { r: 34, width: 26, rim: 20 };

export function buildUtv(m: Model) {
  const sides = [-1, 1] as const;

  // --- Wheels, brakes, suspension (each corner) ---------------------------
  for (const side of sides) {
    const y = side * TRACK;
    // Front: double A-arms and a coil-over leaning in.
    arm(m, [FRONT_AXLE - 14, side * 20, 28], [FRONT_AXLE + 12, side * 20, 28], [FRONT_AXLE, side * 52, 25]);
    arm(m, [FRONT_AXLE - 12, side * 22, 52], [FRONT_AXLE + 10, side * 22, 52], [FRONT_AXLE, side * 50, 50]);
    shock(m, [FRONT_AXLE - 2, side * 44, 30], [FRONT_AXLE - 6, side * 26, 74]);
    // Rear: trailing arm, radius rods and a coil-over.
    arm(m, [REAR_AXLE + 78, side * 38, 32], [REAR_AXLE + 70, side * 30, 40], [REAR_AXLE, side * 52, 30], 3.6);
    arm(m, [REAR_AXLE - 8, side * 18, 28], [REAR_AXLE + 8, side * 18, 28], [REAR_AXLE, side * 50, 27], 2.6);
    shock(m, [REAR_AXLE + 4, side * 48, 36], [REAR_AXLE + 18, side * 36, 84]);
    wheel(m, { at: [FRONT_AXLE, y, TIRE.r], side, ...TIRE });
    wheel(m, { at: [REAR_AXLE, y, TIRE.r], side, ...TIRE });
  }

  // --- Frame, cage and body ---------------------------------------------------
  m.part("body_frame", (b) => {
    // Floor pan and rocker panels.
    b.face([[-58, -58, 36], [62, -58, 36], [62, 58, 36], [-58, 58, 36]], [0, 0, 1], "b");
    for (const side of sides) b.box([-56, side > 0 ? 54 : -62, 30], [58, side > 0 ? 62 : -54, 42], "b");
  }, { layer: 1 });

  m.part("body_frame", (b) => {
    // Cargo bed: a tub over the engine bay.
    b.box([-152, -64, 80], [-58, 64, 104], "b");
    b.line([[-148, -60, 104], [-62, -60, 104], [-62, 60, 104], [-148, 60, 104]], "b", { closed: true });
    for (const x of [-130, -105, -80]) b.line([[x, 64, 82], [x, 64, 102]], "d");
  }, { layer: 1 });

  m.part("body_frame", (b) => {
    // Hood: wide at the dash, tapering and dropping to the nose.
    const section = (x: number, half: number, low: number, high: number, chamfer: number): V3[] => [
      [x, -half, low],
      [x, half, low],
      [x, half, high - chamfer],
      [x, half - chamfer * 1.4, high],
      [x, -half + chamfer * 1.4, high],
      [x, -half, high - chamfer],
    ];
    b.loft(section(58, 56, 56, 96, 8), section(118, 52, 50, 84, 8), "b");
    b.loft(section(118, 52, 50, 84, 8), section(150, 44, 44, 70, 7), "b");
    // Dash.
    b.box([44, -56, 70], [58, 56, 96], "b");
  }, { layer: 1 });

  m.part("cooling", (b) => {
    // The grille in the nose, in front of the radiator.
    b.face([[150.5, -26, 50], [150.5, 26, 50], [150.5, 26, 64], [150.5, -26, 64]], [1, 0, 0], "i");
    for (const z of [53, 56.5, 60]) b.line([[151, -24, z], [151, 24, z]], "d");
  }, { layer: 1 });

  for (const side of sides) {
    m.part("body_frame", (b) => {
      // Fenders over each wheel.
      // The sweep runs from y towards -y, so start at the fender's left edge.
      const left = side > 0 ? 80 : -50;
      b.sweep([FRONT_AXLE, left, TIRE.r], [1, 0, 0], [0, 0, 1], TIRE.r + 9, 0.15, Math.PI - 0.25, 30, "b", 9);
      b.sweep([REAR_AXLE, left, TIRE.r], [1, 0, 0], [0, 0, 1], TIRE.r + 9, 0.2, Math.PI - 0.15, 30, "b", 9);
      // Half door.
      const y = side * 62;
      b.face([[44, y, 44], [44, y, 80], [-30, y, 82], [-36, y, 44]], [0, side, 0], "b", { back: true });
    }, { layer: 1 });
  }

  // Seats: driver on the left, passenger on the right.
  for (const side of sides) {
    m.part("body_frame", (b) => {
      const y0 = side > 0 ? 14 : -46;
      b.box([-14, y0, 52], [22, y0 + 32, 62], "m");
      b.prism(
        [
          [-18, 60],
          [-7, 60],
          [-13, 124],
          [-26, 122],
        ],
        frameAt([0, y0 + 32, 0], [1, 0, 0], [0, 0, 1]),
        32,
        "m",
      );
    }, { depthAt: [0, side * 30, 80] });
  }

  // The roll cage.
  m.part("body_frame", (b) => {
    for (const side of sides) {
      const y = side * 60;
      b.tube([[58, y, 84], [30, y, 172], [-48, y, 176], [-54, y, 104], [-58, y, 62]], 4.2, "p", 16);
      b.tube([[44, side * 63, 78], [-34, side * 63, 80]], 3, "p");
    }
    b.tube([[30, -60, 172], [30, 60, 172]], 4.2, "p");
    b.tube([[-48, -60, 176], [-48, 60, 176]], 4.2, "p");
    b.tube([[-9, -60, 174], [-9, 60, 174]], 3.4, "p");
    b.tube([[-53, -60, 112], [-53, 60, 112]], 4, "p");
    b.tube([[-50, 60, 170], [-54, -60, 114]], 3.4, "p");
    // Front bumper and rear hitch bar.
    b.tube([[142, -40, 44], [154, -40, 58], [154, 40, 58], [142, 40, 44]], 4, "p", 6);
    b.tube([[-152, -40, 66], [-158, -40, 70], [-158, 40, 70], [-152, 40, 66]], 3.4, "p", 4);
  }, { layer: 3 });

  // --- Engine bay (under the bed, behind the seats) -------------------------
  m.part("engine", (b) => {
    b.box([-74, -30, 38], [-36, 12, 68]);
    b.box([-72, -28, 68], [-38, 10, 78]);
    b.prism(roundRect(30, 10, 3), frameAt([-55, 8, 83], [1, 0, 0], [0, 0, 1]), 32, "p", { smooth: true });
    for (const z of [48, 58]) b.line([[-36, -30, z], [-36, 12, z]], "d");
  });

  m.part("ignition", (b) => {
    for (const y of [-17, -1]) {
      b.box([-60, y - 4, 88], [-50, y + 4, 99]);
      b.cylinder([-55, y, 85], [0, 0, 1], 2.4, 6);
    }
  });

  m.part("drive_clutch", (b) => {
    // CVT cover on the left of the engine and transmission: primary at the
    // front, secondary at the back.
    b.prism(stadium([-48, 50], 19, [-94, 52], 22, 12), frameAt([0, 32, 0], [1, 0, 0], [0, 0, 1]), 17, "p", { smooth: true });
    b.ring(frameAt([-48, 32.5, 50], [1, 0, 0], [0, 0, 1]), 8, "d");
    b.ring(frameAt([-94, 32.5, 52], [1, 0, 0], [0, 0, 1]), 9, "d");
    // Cooling duct up to the cage.
    b.tube([[-62, 30, 70], [-60, 34, 92], [-56, 44, 104]], 5, "p", 8);
  });

  m.part("transmission", (b) => {
    b.box([-104, -24, 30], [-76, 14, 60]);
    b.box([-100, -18, 60], [-84, 4, 66]);
  });

  m.part("rear_drive", (b) => {
    b.cylinder([REAR_AXLE, -5, 32], [0, 1, 0], 11, 24);
    for (const side of sides) {
      b.tube([[REAR_AXLE, side * 8, 32], [REAR_AXLE, side * 52, 33]], 3.4, "p");
      b.cylinder([REAR_AXLE, side * 18, 32], [0, 1, 0], 4.6, 7);
      b.cylinder([REAR_AXLE, side * 47, 33], [0, 1, 0], 4.6, 7);
    }
  });

  m.part("front_drive", (b) => {
    b.box([FRONT_AXLE - 10, -11, 22], [FRONT_AXLE + 10, 11, 42]);
    for (const side of sides) {
      b.tube([[FRONT_AXLE, side * 11, 32], [FRONT_AXLE, side * 52, 33]], 3.4, "p");
      b.cylinder([FRONT_AXLE, side * 19, 32], [0, 1, 0], 4.4, 7);
      b.cylinder([FRONT_AXLE, side * 46, 33], [0, 1, 0], 4.4, 7);
    }
    // Prop shaft back to the transmission.
    b.tube([[FRONT_AXLE - 10, 0, 32], [-76, -4, 38]], 3, "p");
  });

  m.part("exhaust", (b) => {
    // Header off the front of the engine, back along the right side to the
    // muffler behind the transmission.
    b.tube([[-37, -18, 72], [-26, -22, 64], [-28, -40, 56], [-100, -44, 60], [-126, -40, 72]], 4.6, "p", 10);
    b.cylinder([-138, -24, 80], [0, 1, 0], 13, 40);
    b.tube([[-140, -2, 80], [-156, 8, 84]], 4.4, "p");
  });

  m.part("air_intake", (b) => {
    // Airbox behind the passenger, its snorkel up by the cage, and the
    // intake into the throttle body.
    b.box([-44, -56, 70], [-14, -30, 96]);
    b.prism(roundRect(30, 4, 1.5), frameAt([-29, -30, 98], [1, 0, 0], [0, 0, 1]), 26, "p", { smooth: true });
    b.tube([[-30, -30, 86], [-40, -16, 86], [-44, -8, 80]], 5, "p", 6);
  });

  m.part("fuel", (b) => {
    // Tank under the driver's seat, its filler and the pump.
    b.prism(roundRect(36, 16, 5), frameAt([6, 50, 45], [1, 0, 0], [0, 0, 1]), 34, "p", { smooth: true });
    b.ring(frameAt([8, 33, 53.5], [1, 0, 0], [0, 1, 0]), 5, "p", true);
    b.tube([[-8, 46, 50], [-16, 58, 72]], 3.4, "p");
    b.cylinder([-17, 60, 74], [-0.3, 1, 0.5], 4.6, 4);
  });

  m.part("charging_starting", (b) => {
    // Battery under the passenger seat, its cable to the starter.
    b.box([-4, -48, 38], [20, -26, 54]);
    b.line([[0, -30, 54], [16, -30, 54]], "d");
    b.cylinder([-44, -33, 44], [1, 0, 0], 5, 16);
  });

  m.part("cooling", (b) => {
    // Radiator behind the grille, fan behind it, hoses back to the engine.
    b.box([118, -42, 46], [124, 42, 88]);
    for (let z = 51; z < 86; z += 5) b.line([[124, -40, z], [124, 40, z]], "d");
    b.ring(frameAt([117, 0, 67], [0, 1, 0], [0, 0, 1]), 17, "d");
    b.tube([[118, 30, 84], [106, 30, 80], [100, 26, 66]], 2.6, "p", 4);
    b.tube([[118, -30, 50], [104, -28, 46]], 2.6, "p");
  });

  m.part("electrical", (b) => {
    // Gauge in front of the driver, headlights, ECU and its harness.
    b.ring(frameAt([52, 30, 98], [0, 1, 0], [0.4, 0, 1]), 7, "p", true);
    for (const side of [-1, 1]) {
      // Angular headlights at the nose's corners.
      const y = side * 34;
      b.face(
        [
          [151, y - side * 7, 62],
          [150, y + side * 8, 58],
          [149, y + side * 8, 66],
          [148, y - side * 8, 70],
        ],
        [1, 0, 0.2],
        "p",
      );
    }
    b.box([46, -34, 72], [56, -18, 80]);
  });

  m.part("steering", (b) => {
    // Wheel, column, EPS unit and the rack with its tie rods.
    const normal: V3 = [-0.85, 0, 0.53];
    const u: V3 = [0, 1, 0];
    const v: V3 = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]];
    const hub: V3 = [28, 30, 104];
    b.tube([hub, [56, 28, 80], [64, 26, 72]], 3.4, "p", 4);
    b.box([58, 18, 64], [70, 32, 76]);
    b.tube([[64, 24, 64], [FRONT_AXLE - 6, 10, 46]], 3, "p");
    b.tube([[FRONT_AXLE - 6, -40, 46], [FRONT_AXLE - 6, 40, 46]], 4, "p");
    for (const side of sides) b.tube([[FRONT_AXLE - 6, side * 40, 46], [FRONT_AXLE - 8, side * 54, 42]], 2.6, "p");
    const rim: V3[] = Array.from({ length: 19 }, (_, i) => {
      const t = (i / 18) * Math.PI * 2;
      return [hub[0] + v[0] * Math.sin(t) * 16, hub[1] + Math.cos(t) * 16, hub[2] + v[2] * Math.sin(t) * 16];
    });
    b.tube(rim, 3, "p", 4);
    for (const [a, c] of [[0, -1], [0.87, 0.5], [-0.87, 0.5]] as const) {
      b.line([hub, [hub[0] + v[0] * c * 15, hub[1] + a * 15, hub[2] + v[2] * c * 15]], "p");
    }
  });

  // Where each system's callout points.
  m.anchor("engine", [-56, -10, 62]);
  m.anchor("ignition", [-55, -9, 99]);
  m.anchor("drive_clutch", [-70, 32, 52]);
  m.anchor("transmission", [-90, -5, 60]);
  m.anchor("rear_drive", [REAR_AXLE, -5, 40]);
  m.anchor("front_drive", [FRONT_AXLE, 0, 42]);
  m.anchor("exhaust", [-138, -24, 92]);
  m.anchor("air_intake", [-29, -43, 98]);
  m.anchor("fuel", [6, 50, 52]);
  m.anchor("charging_starting", [8, -37, 54]);
  m.anchor("cooling", [124, 0, 86]);
  m.anchor("electrical", [52, 30, 104]);
  m.anchor("steering", [28, 46, 104]);
  m.anchor("suspension", [FRONT_AXLE - 4, 34, 70]);
  m.anchor("brakes", [FRONT_AXLE - 9, TRACK - 3, 44]);
  m.anchor("wheels_tires", [REAR_AXLE, TRACK + 13, 4]);
  m.anchor("body_frame", [-9, 60, 174]);
}
