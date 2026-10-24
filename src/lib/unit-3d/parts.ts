import * as THREE from "three";

import { cylinder, lathe, orient, rbox, spring, tube, type Kit } from "./geo";
import type { V3 } from "./layout";

// Parts every machine has some of: wheels (tyre with tread, rim, hub),
// brakes, A-arms, shocks with coil springs, half shafts with CV boots.

export type WheelStyle = {
  // Sport tyres have tall, open lugs; utility ones flatter blocks.
  tread: "sport" | "utility" | "turf";
  spokes: number;
  beadlock: boolean;
  brakes: boolean;
};

// A wheel at `at` (its middle), the outside facing side (+1 left, -1 right).
// Its tyre and rim belong to the wheels and tyres system on the wheel its
// callout points at (the front left), to the plain running gear elsewhere.
export function wheel(kit: Kit, at: V3, side: 1 | -1, r: number, w: number, style: WheelStyle, group: "wheels_tires" | "running" = "wheels_tires") {
  const rimR = r * (style.tread === "turf" ? 0.62 : 0.58);
  const half = w / 2;
  const wall = r - rimR;
  // The tyre's cross-section: bead, a sidewall bulging a little, a round
  // shoulder, a nearly flat crown.
  const profile: [number, number][] = [
    [rimR * 1.01, -half * 0.8],
    [rimR + wall * 0.22, -half * 0.97],
    [rimR + wall * 0.5, -half * 1.0],
    [r - wall * 0.26, -half * 0.97],
    [r - wall * 0.12, -half * 0.9],
    [r - wall * 0.04, -half * 0.78],
    [r - 0.002, -half * 0.6],
    [r, -half * 0.3],
    [r, half * 0.3],
    [r - 0.002, half * 0.6],
    [r - wall * 0.04, half * 0.78],
    [r - wall * 0.12, half * 0.9],
    [r - wall * 0.26, half * 0.97],
    [rimR + wall * 0.5, half * 1.0],
    [rimR + wall * 0.22, half * 0.97],
    [rimR * 1.01, half * 0.8],
  ];
  kit.add(group, "rubber", orient(lathe(profile, 40), [0, 0, side], at));

  // Tread moulded into the carcass: staggered centre blocks and shoulder
  // blocks that wrap the shoulder, each a low block with sloped sides (so
  // the tread reads as rubber, not gear teeth).
  if (style.tread !== "turf") {
    const pitch = style.tread === "sport" ? 18 : 20;
    const depth = r * (style.tread === "sport" ? 0.04 : 0.03);
    const lug = (length: number, width: number, height: number, angle: number, radius: number, axial: number, tilt: number, skew: number) => {
      // A square frustum (4 sides), scaled to the block, its base on the
      // carcass: x round the tyre, y out from it, z across it.
      const g = new THREE.CylinderGeometry(0.5 * 0.72, 0.5, 1, 4, 1);
      g.rotateY(Math.PI / 4);
      g.scale(length * Math.SQRT2, height, width * Math.SQRT2);
      g.rotateY(skew);
      g.translate(0, height / 2, 0);
      // Tilted round the shoulder, then out to the carcass and round.
      g.rotateX(tilt);
      g.translate(0, radius, axial);
      g.rotateZ(angle);
      return g;
    };
    for (let i = 0; i < pitch; i++) {
      const a = (i / pitch) * Math.PI * 2;
      const step = (Math.PI * 2 * r) / pitch;
      for (const s of [-1, 1] as const) {
        const stagger = s > 0 ? 0 : 0.5;
        const angle = a + (stagger * Math.PI * 2) / pitch;
        // A centre block, angled like a chevron.
        const centre = lug(step * 0.42, half * 0.62, depth, angle, r - 0.003, s * half * 0.3, 0, s * 0.35);
        // A shoulder block wrapping round the edge, alternately long and short.
        const long = i % 2 === 0;
        const shoulder = lug(step * 0.46, half * (long ? 0.42 : 0.32), depth * 0.9, angle + Math.PI / pitch, r - wall * 0.06, s * half * 0.8, -s * 0.75, 0);
        for (const g of [centre, shoulder]) {
          g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, side)));
          g.translate(at[0], at[1], at[2]);
          kit.add(group, "rubber", g);
        }
      }
    }
  }

  // Rim: the barrel and its lip, a cast face with spoke windows, the hub.
  const out = side;
  const barrel = lathe(
    [
      [rimR * 0.9, -half * 0.78],
      [rimR * 1.0, -half * 0.84],
      [rimR * 1.03, -half * 0.9],
      [rimR * 0.96, -half * 0.72],
      [rimR * 0.88, 0],
      [rimR * 0.96, half * 0.72],
      [rimR * 1.03, half * 0.9],
      [rimR * 1.0, half * 0.84],
      [rimR * 0.9, half * 0.78],
    ],
    36,
  );
  kit.add(group, "rim", orient(barrel, [0, 0, 1], at));
  const spokes = style.spokes;
  const faceShape = new THREE.Shape();
  faceShape.absarc(0, 0, rimR * 0.93, 0, Math.PI * 2, false);
  for (let i = 0; i < spokes; i++) {
    // A window between two spokes: wide at the rim, narrow at the hub.
    const a0 = ((i + 0.5) / spokes) * Math.PI * 2;
    const span = (Math.PI * 2) / spokes;
    const outer = rimR * 0.8;
    const inner = rimR * 0.4;
    const halfOut = span * 0.5 - 0.16 * (6 / spokes) * 0.9;
    const halfIn = span * 0.5 - 0.42 * (6 / spokes) * 0.9;
    const hole = new THREE.Path();
    const pts: [number, number][] = [];
    for (let k = 0; k <= 6; k++) {
      const t = a0 - halfOut + (2 * halfOut * k) / 6;
      pts.push([Math.cos(t) * outer, Math.sin(t) * outer]);
    }
    pts.push([Math.cos(a0 + halfIn) * inner, Math.sin(a0 + halfIn) * inner]);
    pts.push([Math.cos(a0 - halfIn) * inner, Math.sin(a0 - halfIn) * inner]);
    hole.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) hole.lineTo(x, y);
    hole.closePath();
    faceShape.holes.push(hole);
  }
  const face = new THREE.ExtrudeGeometry(faceShape, { depth: 0.018, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.006, bevelSegments: 1, curveSegments: 10 });
  // Extruded along +z: turned to face out on this side, set into the rim.
  if (side < 0) {
    face.rotateY(Math.PI);
  }
  face.translate(at[0], at[1], at[2] + out * half * 0.38);
  kit.add(group, "rim", face);
  const faceZ = at[2] + out * (half * 0.38 + 0.026);
  kit.add(group, "rim", cylinder([at[0], at[1], faceZ - out * 0.01], [at[0], at[1], faceZ + out * 0.025], rimR * 0.3, rimR * 0.24, 18));
  kit.add(group, "metal", cylinder([at[0], at[1], faceZ + out * 0.02], [at[0], at[1], faceZ + out * 0.04], rimR * 0.1, rimR * 0.08, 12));
  if (style.beadlock) {
    // The beadlock ring round the rim's outer lip.
    kit.add(group, "metal", orient(lathe([[rimR * 0.9, 0], [rimR * 1.04, 0], [rimR * 1.04, 0.012], [rimR * 0.9, 0.012]], 36), [0, 0, side], [at[0], at[1], at[2] + out * half * 0.86]));
  }

  if (style.brakes) {
    const disc = at[2] - out * half * 0.15;
    kit.add("brakes", "metal", cylinder([at[0], at[1], disc - 0.005], [at[0], at[1], disc + 0.005], rimR * 0.72, rimR * 0.72, 24));
    kit.add("brakes", "trim", cylinder([at[0], at[1], disc - 0.012], [at[0], at[1], disc + 0.012], rimR * 0.3, rimR * 0.3, 12));
    // The caliper, on the back of the disc.
    const ca = 2.3;
    kit.add(
      "brakes",
      "cast",
      rbox([at[0] + Math.cos(ca) * rimR * 0.66, at[1] + Math.sin(ca) * rimR * 0.66, disc], [rimR * 0.34, rimR * 0.18, 0.05], 0.012, [0, 0, ca + Math.PI / 2], 1),
    );
  }
}

// An upper and lower A-arm from the frame (inner z) out to the hub.
export function aArms(kit: Kit, hub: V3, innerZ: number, { spread = 0.32, lowY, upY, r = 0.018 }: { spread?: number; lowY: number; upY: number; r?: number }) {
  const out = Math.sign(hub[2]);
  const knuckleZ = hub[2] - out * 0.08;
  for (const [y, hubY] of [
    [lowY, hub[1] - 0.09],
    [upY, hub[1] + 0.11],
  ] as const) {
    const ball: V3 = [hub[0], hubY, knuckleZ];
    kit.add("suspension", "frame", tube([[hub[0] + spread / 2, y, innerZ], ball, [hub[0] - spread / 2, y, innerZ]], r, 0.04, 8));
  }
  // The knuckle between the arms.
  kit.add("suspension", "cast", rbox([hub[0], hub[1], knuckleZ], [0.07, 0.26, 0.06], 0.02, [0, 0, 0], 1));
}

// A shock: body, shaft and coil spring from the top mount to the bottom.
export function shock(kit: Kit, topAt: V3, bottomAt: V3, r: number, { reservoir = false }: { reservoir?: boolean } = {}) {
  const a = new THREE.Vector3(...topAt);
  const b = new THREE.Vector3(...bottomAt);
  const length = a.distanceTo(b);
  const dir = b.clone().sub(a).normalize();
  const along = (t: number): V3 => {
    const p = a.clone().add(dir.clone().multiplyScalar(length * t));
    return [p.x, p.y, p.z];
  };
  kit.add("suspension", "trim", cylinder(along(0), along(0.55), r * 0.62, r * 0.62, 12));
  kit.add("suspension", "metal", cylinder(along(0.5), along(1), r * 0.26, r * 0.26, 8));
  kit.add("suspension", "spring", spring(along(0.08), along(0.86), r, r * 0.16, 7));
  kit.add("suspension", "cast", cylinder(along(-0.03), along(0.04), r * 0.7, r * 0.7, 10));
  if (reservoir) {
    const offset = new THREE.Vector3(0, 0, 1).cross(dir).normalize().multiplyScalar(r * 1.3);
    const p0 = new THREE.Vector3(...along(0.02)).add(offset);
    const p1 = new THREE.Vector3(...along(0.34)).add(offset);
    kit.add("suspension", "trim", cylinder([p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z], r * 0.48, r * 0.48, 10));
  }
}

// A half shaft from the diff out to the hub, with its two CV boots.
export function halfShaft(kit: Kit, group: "front_drive" | "rear_drive", from: V3, to: V3, r = 0.02) {
  kit.add(group, "metal", cylinder(from, to, r, r, 8));
  for (const t of [0.12, 0.88]) {
    const p: V3 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
    const dir: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const boot = lathe(
      [
        [r * 1.1, -0.06],
        [r * 2.4, -0.04],
        [r * 1.8, -0.015],
        [r * 2.3, 0.005],
        [r * 1.6, 0.03],
        [r * 1.1, 0.06],
      ],
      14,
    );
    kit.add(group, "rubber", orient(boot, dir, p));
  }
}

// A rectangular grid rack of tube (cargo racks): outer loop and slats.
export function rack(kit: Kit, group: "body_frame", x0: number, x1: number, y: number, halfW: number, slats: number, r = 0.012) {
  kit.add(group, "frame", tube([[x0, y, -halfW], [x1, y, -halfW], [x1, y, halfW], [x0, y, halfW], [x0, y, -halfW]], r, 0.05));
  for (let i = 1; i < slats; i++) {
    const x = x0 + ((x1 - x0) * i) / slats;
    kit.add(group, "frame", cylinder([x, y, -halfW], [x, y, halfW], r * 0.8, r * 0.8, 6));
  }
}
