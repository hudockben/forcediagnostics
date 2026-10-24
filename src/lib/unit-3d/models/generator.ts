import { cylinder, frontPanel, lathe, loft, orient, rbox, section, sidePanel, smoothTube, torus, tube, type Kit } from "../geo";
import type { Layout } from "../layout";
import { wheel } from "../parts";

// A Polaris portable generator: a tube frame, the fuel tank across the
// top (in the unit's colour), the engine with its recoil starter and
// muffler at one end, the alternator and the control panel with its
// outlets at the other, a wheel kit and a fold-down handle.

export function buildGenerator(kit: Kit, L: Layout) {
  const sides = [1, -1] as const;
  const p = L.parts;
  const R = L.tireR;
  const x0 = -0.34;
  const x1 = 0.34;
  const zHalf = 0.25;
  const y0 = 0.05;
  const y1 = 0.56;

  // Frame: two side loops joined by cross tubes, feet at the engine end.
  for (const side of sides) {
    const z = side * zHalf;
    kit.add("body_frame", "frame", tube([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [x0, y0, z]], 0.014, 0.06));
    kit.add("body_frame", "rubber", rbox([x1 - 0.03, 0.02, z], [0.06, 0.04, 0.06], 0.01, [0, 0, 0], 1));
  }
  for (const [x, y] of [
    [x0, y1],
    [x1, y1],
    [x0, y0],
    [x1, y0],
  ] as const) {
    kit.add("body_frame", "frame", cylinder([x, y, -zHalf], [x, y, zHalf], 0.014, 0.014, 8));
  }
  // The handle at the wheel end.
  kit.add("body_frame", "frame", tube([[x0, y1 - 0.06, zHalf], [x0 - 0.12, y1 + 0.02, zHalf - 0.02], [x0 - 0.12, y1 + 0.02, -zHalf + 0.02], [x0, y1 - 0.06, -zHalf]], 0.012, 0.05));
  kit.add("body_frame", "rubber", cylinder([x0 - 0.12, y1 + 0.02, -0.1], [x0 - 0.12, y1 + 0.02, 0.1], 0.018, 0.018, 10));

  for (const side of sides) wheel(kit, [L.axles[0], R, side * (zHalf + 0.06)], side, R, L.tireW, { tread: "turf", spokes: 4, beadlock: false, brakes: false }, side === 1 ? "wheels_tires" : "running");
  kit.add("wheels_tires", "metal", cylinder([L.axles[0], R, -(zHalf + 0.06)], [L.axles[0], R, zHalf + 0.06], 0.008, 0.008, 6));

  // Fuel tank across the top, its cap and fuel gauge.
  const ft = p.fuelTank;
  kit.add(
    "fuel",
    "paint",
    loft([
      section(ft.at[0] - ft.size[0] / 2, ft.size[2] / 2 - 0.03, ft.at[1] - ft.size[1] / 2, ft.at[1] + ft.size[1] / 2 - 0.03, { topHalf: ft.size[2] / 2 - 0.06, p: 3 }),
      section(ft.at[0] - ft.size[0] / 2 + 0.06, ft.size[2] / 2, ft.at[1] - ft.size[1] / 2, ft.at[1] + ft.size[1] / 2, { topHalf: ft.size[2] / 2 - 0.03, crown: 0.01, p: 3 }),
      section(ft.at[0] + ft.size[0] / 2 - 0.06, ft.size[2] / 2, ft.at[1] - ft.size[1] / 2, ft.at[1] + ft.size[1] / 2, { topHalf: ft.size[2] / 2 - 0.03, crown: 0.01, p: 3 }),
      section(ft.at[0] + ft.size[0] / 2, ft.size[2] / 2 - 0.03, ft.at[1] - ft.size[1] / 2, ft.at[1] + ft.size[1] / 2 - 0.03, { topHalf: ft.size[2] / 2 - 0.06, p: 3 }),
    ]),
  );
  kit.add("fuel", "trim", cylinder([ft.at[0] - 0.12, ft.at[1] + ft.size[1] / 2, 0], [ft.at[0] - 0.12, ft.at[1] + ft.size[1] / 2 + 0.035, 0], 0.04, 0.04, 16));
  kit.add("fuel", "trim", cylinder([ft.at[0] + 0.1, ft.at[1] + ft.size[1] / 2, 0.06], [ft.at[0] + 0.1, ft.at[1] + ft.size[1] / 2 + 0.01, 0.06], 0.025, 0.025, 12));
  kit.add("fuel", "rubber", smoothTube([[ft.at[0] + 0.1, ft.at[1] - ft.size[1] / 2, -0.06], [p.engine.at[0] + 0.02, p.engine.at[1] + 0.16, -0.06]], 0.006, 5));

  // Engine: crankcase and a cylinder leaning towards the engine end.
  const e = p.engine;
  kit.add("engine", "engine", rbox([e.at[0], e.at[1] - 0.04, e.at[2]], [e.size[0], e.size[1] * 0.6, e.size[2]], 0.03, [0, 0, 0], 2));
  kit.add("engine", "cast", rbox([e.at[0] + 0.08, e.at[1] + 0.1, e.at[2]], [0.12, 0.14, 0.14], 0.02, [0, 0, -0.5], 2));
  for (let i = 0; i < 4; i++) kit.add("engine", "engine", rbox([e.at[0] + 0.06 + i * 0.016, e.at[1] + 0.06 + i * 0.03, e.at[2]], [0.14, 0.008, 0.16], 0.003, [0, 0, -0.5], 1));

  // Cooling: the flywheel fan's shroud, and the recoil starter on it.
  const rad = p.radiator;
  kit.add("cooling", "plastic", orient(lathe([[0.001, -0.03], [0.1, -0.03], [0.11, 0], [0.1, 0.03], [0.001, 0.03]], 24), [0, 0, 1], rad.at));
  kit.add("cooling", "trim", torus([rad.at[0], rad.at[1], rad.at[2] + 0.032], [0, 0, 1], 0.06, 0.006, 20));

  // Charging and starting: the recoil handle, the electric starter and the
  // battery.
  kit.add("charging_starting", "rubber", cylinder([rad.at[0] + 0.02, rad.at[1] + 0.02, rad.at[2] + 0.04], [rad.at[0] + 0.02, rad.at[1] + 0.02, rad.at[2] + 0.1], 0.012, 0.012, 8));
  kit.add("charging_starting", "trim", rbox([rad.at[0] - 0.04, rad.at[1] + 0.03, rad.at[2] + 0.11], [0.09, 0.025, 0.025], 0.01, [0, 0, 0], 1));
  const bt = p.battery;
  kit.add("charging_starting", "plastic", rbox(bt.at, bt.size, 0.008, [0, 0, 0], 1));
  kit.add("charging_starting", "metal", cylinder([e.at[0] - 0.06, e.at[1] - 0.08, e.at[2] - 0.12], [e.at[0] + 0.06, e.at[1] - 0.08, e.at[2] - 0.12], 0.025, 0.025, 10));

  // Ignition: the coil and the plug lead.
  const coil = p.coil;
  kit.add("ignition", "trim", rbox([coil[0] - 0.06, coil[1] - 0.04, coil[2] + 0.1], [0.04, 0.05, 0.03], 0.008, [0, 0, 0], 1));
  kit.add("ignition", "tail", smoothTube([[coil[0] - 0.06, coil[1] - 0.04, coil[2] + 0.08], [coil[0], coil[1], coil[2] + 0.04], coil], 0.006, 5));
  kit.add("ignition", "rubber", cylinder(coil, [coil[0] + 0.03, coil[1] + 0.02, coil[2]], 0.012, 0.012, 8));

  // Air intake: the air cleaner on the engine's side.
  const ab = p.airbox;
  kit.add("air_intake", "plastic", rbox(ab.at, ab.size, 0.02, [0, 0, 0], 2));

  // Exhaust: muffler under its shield at the engine end.
  const mf = p.muffler;
  kit.add("exhaust", "cast", orient(lathe([[0.001, -mf.size[2] / 2], [mf.size[1] / 2, -mf.size[2] / 2 + 0.01], [mf.size[1] / 2, mf.size[2] / 2 - 0.01], [0.001, mf.size[2] / 2]], 18), [0, 0, 1], mf.at));
  kit.add("exhaust", "metal", sidePanel([[mf.at[0] - 0.08, mf.at[1] + 0.07], [mf.at[0] + 0.08, mf.at[1] + 0.07], [mf.at[0] + 0.08, mf.at[1] + 0.09], [mf.at[0] - 0.08, mf.at[1] + 0.09]], mf.at[2] - 0.12, mf.at[2] + 0.12, { radius: 0.01, bevel: 0.005 }));
  kit.add("exhaust", "metal", cylinder([e.at[0] + 0.1, e.at[1] + 0.08, e.at[2] - 0.08], [mf.at[0], mf.at[1], mf.at[2] + 0.06], 0.014, 0.014, 8));

  // Electrical: the alternator, the control panel with outlets and breakers.
  const alt = p.clutch;
  kit.add("electrical", "paint", orient(lathe([[0.001, -alt.size[0] / 2], [alt.size[1] * 0.45, -alt.size[0] / 2], [alt.size[1] / 2, -alt.size[0] / 2 + 0.02], [alt.size[1] / 2, alt.size[0] / 2 - 0.02], [alt.size[1] * 0.45, alt.size[0] / 2], [0.001, alt.size[0] / 2]], 22), [1, 0, 0], alt.at));
  const panel = p.ecu;
  kit.add("electrical", "plastic", frontPanel([[panel.at[2] - 0.02, panel.at[1] - panel.size[1] / 2], [panel.at[2] + 0.02, panel.at[1] - panel.size[1] / 2], [panel.at[2] + 0.02, panel.at[1] + panel.size[1] / 2], [panel.at[2] - 0.02, panel.at[1] + panel.size[1] / 2]], panel.at[0] - panel.size[0] / 2, panel.at[0] + panel.size[0] / 2, { radius: 0.01, bevel: 0.006 }));
  for (const [dx, dy] of [
    [-0.06, -0.05],
    [0.06, -0.05],
    [-0.06, 0.05],
  ] as const) {
    kit.add("electrical", "trim", orient(lathe([[0.001, 0], [0.025, 0], [0.025, 0.012], [0.001, 0.012]], 14), [0, 0, 1], [panel.at[0] + dx, panel.at[1] + dy, panel.at[2] + 0.02]));
  }
  kit.add("electrical", "tail", rbox([panel.at[0] + 0.06, panel.at[1] + 0.06, panel.at[2] + 0.025], [0.03, 0.02, 0.01], 0.004, [0, 0, 0], 1));
}
