import { circle, frameAt, polygonPath, v3, type Model, type P2, type V3 } from "./iso";

// Pieces the side-by-side and the ATV share: wheels with their brakes, and
// coil-over shocks.

const hullOf = (points: P2[]) => {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list: P2[]) => {
    const out: P2[] = [];
    for (const point of list) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], point) <= 0) out.pop();
      out.push(point);
    }
    return out.slice(0, -1);
  };
  return [...build(sorted), ...build([...sorted].reverse())];
};

// A wheel on an axle along y: the tire (rubber round a see-through rim, so
// the brake shows through), then its brake disc and caliper. side is +1 for
// the machine's left, -1 for its right.
export function wheel(
  m: Model,
  options: {
    at: V3;
    side: 1 | -1;
    r: number;
    width: number;
    rim: number;
    spokes?: number;
    caliperForward?: boolean;
    brakes?: boolean;
    layer?: number;
  },
) {
  const { at, side, r, width, rim } = options;
  const [cx, cy, cz] = at;
  const view = m.cam.view;
  // The face of the tire the camera sees: the outer one on the left, the
  // inner one on the right.
  const faceY = cy + (view[1] > 0 ? width / 2 : -width / 2);
  const otherY = cy + (view[1] > 0 ? -width / 2 : width / 2);
  const frameAtY = (y: number) => frameAt([cx, y, cz], [1, 0, 0], [0, 0, 1]);
  const outward = side * (faceY - cy) > 0;

  const layer = options.layer ?? (side > 0 ? 4 : 0);
  if (options.brakes !== false) m.part("brakes", (b) => {
    const discY = cy - side * 3;
    const disc = r * 0.5;
    b.ring(frameAtY(discY), disc, "p", true);
    b.ring(frameAtY(discY), disc * 0.45, "d");
    // The caliper grips the disc towards the back, or the front.
    const angle = ((options.caliperForward ? 40 : 140) * Math.PI) / 180;
    const px = cx + Math.cos(angle) * disc * 0.85;
    const pz = cz + Math.sin(angle) * disc * 0.85;
    b.box([px - 4, discY - 4, pz - 5], [px + 4, discY + 4, pz + 5]);
  }, { layer });

  m.part("wheels_tires", (b) => {
    const steps = 28;
    const near = circle(r, steps).map(([x, z]) => b.p([cx + x, faceY, cz + z]));
    const far = circle(r, steps).map(([x, z]) => b.p([cx + x, otherY, cz + z]));
    // Rubber: the tire's outline less the rim's opening.
    b.raw({ d: polygonPath(hullOf([...near, ...far])) + b.circlePath(frameAtY(faceY), rim), k: "f", tone: "k", sh: 0.5, eo: true });
    // Tread blocks across the visible part of the tread.
    for (let i = 0; i < steps; i += 1) {
      const t = (i / steps) * Math.PI * 2;
      const normal: V3 = [Math.cos(t), 0, Math.sin(t)];
      if (v3.dot(normal, view) <= 0.05) continue;
      const x = cx + Math.cos(t) * r;
      const z = cz + Math.sin(t) * r;
      const inset = i % 2 === 0 ? 0.18 : 0.42;
      const a = faceY + (otherY - faceY) * inset;
      const c = faceY + (otherY - faceY) * (1 - inset);
      b.line([[x, a, z], [x, c, z]], "d");
    }
    b.ring(frameAtY(faceY), r, "p");
    b.ring(frameAtY(faceY), r - (r - rim) * 0.45, "d");
    // The rim, set in a little from the sidewall, with its spokes and hub.
    const rimY = faceY + (outward ? -side : side) * 3;
    b.ring(frameAtY(rimY), rim, "p");
    b.ring(frameAtY(rimY), rim * 0.32, "p", true);
    const spokes = options.spokes ?? 5;
    for (let i = 0; i < spokes; i++) {
      const t = (i / spokes) * Math.PI * 2 + 0.3;
      const inner: V3 = [cx + Math.cos(t) * rim * 0.32, rimY, cz + Math.sin(t) * rim * 0.32];
      const outer: V3 = [cx + Math.cos(t) * rim * 0.92, rimY, cz + Math.sin(t) * rim * 0.92];
      b.tube([inner, outer], 2.6, "p");
    }
  }, { layer });
}

// A coil-over shock from its lower mount to its upper one.
const sideLayer = (point: V3) => (point[1] > 0 ? 4 : 0);

export function shock(m: Model, lower: V3, upper: V3, options: { r?: number; coils?: number } = {}) {
  m.part("suspension", (b) => {
    const axis = v3.sub(upper, lower);
    const along = (t: number) => v3.add(lower, v3.mul(axis, t));
    b.tube([lower, along(0.55)], 2.4, "p");
    b.tube([along(0.45), upper], 3.8, "p");
    b.spring(along(0.2), along(0.82), options.r ?? 5.5, options.coils ?? 6);
  }, { layer: sideLayer(lower) });
}

// A double A-arm (or trailing arm) as two tubes meeting at the outer joint.
export function arm(m: Model, inner1: V3, inner2: V3, outer: V3, width = 2.6) {
  m.part("suspension", (b) => {
    b.tube([inner1, outer, inner2], width, "p", 2);
  }, { layer: sideLayer(outer) });
}
