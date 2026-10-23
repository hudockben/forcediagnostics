import type { DrawnSystem } from "@/lib/diagnose-zones";

// The little 3D kit the unit drawings are built with: a fixed parallel
// (axonometric) camera, and boxes, extruded profiles, cylinders, panels,
// tubes and springs, each turned straight into SVG path data. Model space is
// in centimetres: x forward, y to the machine's left, z up, the ground at
// z = 0. Pure functions, no DOM, so the drawings can be tested and measured.

export type V3 = readonly [number, number, number];
export type P2 = readonly [number, number];

// b: body shell (faint, see-through), m: seats and trim (between), p: a
// part on the outside (crisp), i: a part inside the machine (quieter until
// lit), d: fine detail lines (fins, tread), k: dark fill that hides what's
// behind (rubber).
export type Tone = "b" | "m" | "p" | "i" | "d" | "k";

// One SVG path: f = filled and outlined, l = outline only, t = a tube (a
// stroke w units wide). sh is how lit a face is (0..1); eo fills even-odd
// (a ring with a hole).
export type El = { d: string; k: "f" | "l" | "t"; tone: Tone; sh: number; w?: number; eo?: boolean };

// layer: painting pass (0 far wheels, 1 body shell, 2 the machine's
// insides, 3 the cage, 4 the near wheels and suspension); depth orders
// parts within a pass.
export type Layer = { zone: DrawnSystem; layer: number; depth: number; els: El[] };

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};
export const v3 = { add, sub, mul, dot, cross, norm };

// The camera looks from yaw degrees round from straight ahead (towards the
// machine's left) and pitch degrees above the ground.
export type Camera = {
  view: V3;
  project: (point: V3) => P2;
  depth: (point: V3) => number;
};

export function camera(yawDegrees: number, pitchDegrees: number): Camera {
  const yaw = (yawDegrees * Math.PI) / 180;
  const pitch = (pitchDegrees * Math.PI) / 180;
  const view: V3 = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
  const right: V3 = [-Math.sin(yaw), Math.cos(yaw), 0];
  const up: V3 = [-Math.sin(pitch) * Math.cos(yaw), -Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch)];
  return { view, project: (point) => [dot(point, right), -dot(point, up)], depth: (point) => dot(point, view) };
}

// Light from above, ahead and to the left of the machine.
const LIGHT = norm([0.45, 0.5, 0.9]);
const shadeOf = (normal: V3) => Math.max(0, Math.min(1, 0.15 + 0.85 * dot(norm(normal), LIGHT)));

// Writes compact SVG path data: coordinates rounded to a tenth, then given
// relative to the last point (from the rounded values, so nothing drifts),
// with repeated commands and needless separators left out.
const tenth = (n: number) => Math.round(n * 10) / 10;
const num = (n: number) => {
  const text = String(Math.round(n * 10) / 10);
  return text === "-0" ? "0" : text.replace(/^(-?)0\./, "$1.");
};

class Pen {
  d = "";
  private x = 0;
  private y = 0;
  private startX = 0;
  private startY = 0;
  private last = "";

  private emit(command: string, values: number[]) {
    let text = command === this.last && command !== "m" && command !== "M" ? "" : command;
    for (const value of values) {
      const part = num(value);
      const needsSpace = text.length > 0 ? !/[a-zA-Z]$/.test(text) : !/[a-zA-Z]$/.test(this.d) && this.d.length > 0;
      text += needsSpace && !part.startsWith("-") && !(part.startsWith(".") && /\.\d*$/.test(text || this.d)) ? ` ${part}` : part;
    }
    this.d += text;
    // Pairs straight after "m" are relative lines, after "M" absolute ones.
    this.last = command === "m" ? "l" : command === "M" ? "L" : command;
  }

  move([px, py]: P2) {
    const [x, y] = [tenth(px), tenth(py)];
    if (this.d === "") this.emit("M", [x, y]);
    else this.emit("m", [x - this.x, y - this.y]);
    this.x = this.startX = x;
    this.y = this.startY = y;
    return this;
  }

  line([px, py]: P2) {
    const [x, y] = [tenth(px), tenth(py)];
    this.emit("l", [x - this.x, y - this.y]);
    this.x = x;
    this.y = y;
    return this;
  }

  curve(c1: P2, c2: P2, end: P2) {
    const [x, y] = [tenth(end[0]), tenth(end[1])];
    this.emit("c", [tenth(c1[0]) - this.x, tenth(c1[1]) - this.y, tenth(c2[0]) - this.x, tenth(c2[1]) - this.y, x - this.x, y - this.y]);
    this.x = x;
    this.y = y;
    return this;
  }

  quad(c: P2, end: P2) {
    const [x, y] = [tenth(end[0]), tenth(end[1])];
    this.emit("q", [tenth(c[0]) - this.x, tenth(c[1]) - this.y, x - this.x, y - this.y]);
    this.x = x;
    this.y = y;
    return this;
  }

  close() {
    this.d += "z";
    this.last = "z";
    this.x = this.startX;
    this.y = this.startY;
    return this;
  }
}

const pen = () => new Pen();

// Every closed shape is written clockwise on screen, so shapes of one style
// can share a path: where two overlap they add up instead of cancelling.
const signedArea = (points: readonly P2[]) =>
  points.reduce((sum, [x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length];
    return sum + x * ny - nx * y;
  }, 0);

export const polygonPath = (points: readonly P2[]) => {
  const ordered = signedArea(points) < 0 ? [...points].reverse() : points;
  const out = pen().move(ordered[0]);
  for (const point of ordered.slice(1)) out.line(point);
  return out.close().d;
};

export const polylinePath = (points: readonly P2[]) => {
  const out = pen().move(points[0]);
  for (const point of points.slice(1)) out.line(point);
  return out.d;
};

// A polyline with its corners rounded off (radius in drawing units).
export function roundedPath(points: readonly P2[], radius: number) {
  if (points.length < 3 || radius <= 0) return polylinePath(points);
  const out = pen().move(points[0]);
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const inLength = Math.hypot(cx - px, cy - py) || 1;
    const outLength = Math.hypot(nx - cx, ny - cy) || 1;
    const r = Math.min(radius, inLength / 2, outLength / 2);
    out.line([cx - ((cx - px) / inLength) * r, cy - ((cy - py) / inLength) * r]);
    out.quad([cx, cy], [cx + ((nx - cx) / outLength) * r, cy + ((ny - cy) / outLength) * r]);
  }
  return out.line(points[points.length - 1]).d;
}

// A smooth curve through the points (Catmull-Rom as cubic Béziers).
export function smoothPath(points: readonly P2[], closed = false) {
  const n = points.length;
  if (n < 3) return closed ? polygonPath(points) : polylinePath(points);
  const at = (i: number) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const out = pen().move(points[0]);
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    out.curve([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2);
  }
  return closed ? out.close().d : out.d;
}

// An ellipse through 12 points (start, two controls, next start, ...): the
// affine image of a circle drawn as four cubic Béziers.
export function bezierLoop(given: readonly P2[]) {
  const points = signedArea([given[0], given[3], given[6], given[9]]) < 0 ? [given[0], ...given.slice(1).reverse()] : given;
  const out = pen().move(points[0]);
  for (let i = 0; i < 4; i++) out.curve(points[i * 3 + 1], points[i * 3 + 2], points[(i * 3 + 3) % 12]);
  return out.close().d;
}

function hull(points: P2[]): P2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const turn = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: P2[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// A plane in model space for a 2D profile: origin, then the profile's u and
// v directions.
export type Frame = { o: V3; u: V3; v: V3 };
export const frameAt = (o: V3, u: V3, v: V3): Frame => ({ o, u: norm(u), v: norm(v) });
const onFrame = (frame: Frame, [a, b]: P2): V3 => add(frame.o, add(mul(frame.u, a), mul(frame.v, b)));

export const circle = (r: number, n = 28, start = 0): P2[] =>
  Array.from({ length: n }, (_, i) => {
    const t = start + (i / n) * Math.PI * 2;
    return [Math.cos(t) * r, Math.sin(t) * r] as P2;
  });

// A rounded rectangle, centred.
export function roundRect(w: number, h: number, r: number, perCorner = 4): P2[] {
  const points: P2[] = [];
  const corners: [number, number, number][] = [
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, Math.PI / 2],
    [-w / 2 + r, -h / 2 + r, Math.PI],
    [w / 2 - r, -h / 2 + r, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= perCorner; i++) {
      const t = start + (i / perCorner) * (Math.PI / 2);
      points.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
    }
  }
  return points;
}

// Two circles joined by their tangents (a CVT cover, a muffler end).
export function stadium(a: P2, ra: number, b: P2, rb: number, n = 16): P2[] {
  const points: P2[] = [];
  for (const [c, r] of [
    [a, ra],
    [b, rb],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      points.push([c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r]);
    }
  }
  return hull(points);
}

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export type Model = {
  cam: Camera;
  // Everything drawn so far lies inside these.
  bounds: Bounds;
  layers: Layer[];
  anchors: Partial<Record<DrawnSystem, V3>>;
  part: (zone: DrawnSystem, build: (b: Builder) => void, options?: { layer?: number; depthAt?: V3 }) => void;
  anchor: (zone: DrawnSystem, point: V3) => void;
};

export type Builder = {
  p: (point: V3) => P2;
  // Plain faces with known outward normals; hidden ones are skipped (or
  // drawn as faint outlines when the face is see-through).
  face: (points: V3[], normal: V3, tone?: Tone, options?: { back?: boolean }) => void;
  box: (min: V3, max: V3, tone?: Tone) => void;
  // A solid between two matching convex sections (same number of corners),
  // each given as points in model space: a tapered hood.
  loft: (a: V3[], b: V3[], tone?: Tone) => void;
  // A convex 2D profile on a frame, pushed depth along the frame's normal
  // (u × v). Smooth profiles draw as their silhouette and the visible end.
  prism: (profile: P2[], frame: Frame, depth: number, tone?: Tone, options?: { smooth?: boolean }) => void;
  cylinder: (center: V3, axis: V3, r: number, length: number, tone?: Tone, n?: number) => void;
  // A circle (or ellipse ring) drawn on a frame.
  ring: (frame: Frame, r: number, tone?: Tone, filled?: boolean) => void;
  // A flat ring between two radii (a tire's sidewall round a see-through rim).
  annulus: (frame: Frame, outer: number, inner: number, tone?: Tone) => void;
  // A circle on a frame as path data (for building other paths).
  circlePath: (frame: Frame, r: number) => string;
  // A curved strip round an axis (a fender): the arc of radius r round
  // center in the plane of u and v, from a0 to a1 radians, w wide along
  // u × v.
  sweep: (center: V3, u: V3, v: V3, r: number, a0: number, a1: number, width: number, tone?: Tone, steps?: number) => void;
  line: (points: V3[], tone?: Tone, options?: { smooth?: boolean; closed?: boolean }) => void;
  tube: (points: V3[], width: number, tone?: Tone, corner?: number) => void;
  spring: (from: V3, to: V3, r: number, turns: number) => void;
  raw: (el: El) => void;
};

export function model(cam: Camera): Model {
  const layers: Layer[] = [];
  const anchors: Partial<Record<DrawnSystem, V3>> = {};
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  function part(zone: DrawnSystem, build: (b: Builder) => void, options: { layer?: number; depthAt?: V3 } = {}) {
    const els: El[] = [];
    const seen: V3[] = [];
    const p = (point: V3) => {
      seen.push(point);
      const flat = cam.project(point);
      bounds.minX = Math.min(bounds.minX, flat[0]);
      bounds.maxX = Math.max(bounds.maxX, flat[0]);
      bounds.minY = Math.min(bounds.minY, flat[1]);
      bounds.maxY = Math.max(bounds.maxY, flat[1]);
      return flat;
    };
    const visible = (normal: V3) => dot(normal, cam.view) > 1e-6;

    const face: Builder["face"] = (points, normal, tone = "p", options = {}) => {
      const d = polygonPath(points.map(p));
      if (visible(normal)) els.push({ d, k: "f", tone, sh: shadeOf(normal) });
      else if (options.back) els.push({ d, k: "l", tone: "b", sh: 0 });
    };

    const box: Builder["box"] = (min, max, tone = "p") => {
      const [x0, y0, z0] = min;
      const [x1, y1, z1] = max;
      const faces: [V3[], V3][] = [
        [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]],
        [[[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], [-1, 0, 0]],
        [[[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0]],
        [[[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]],
        [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]],
        [[[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1]],
      ];
      for (const [points, normal] of faces) face(points, normal, tone);
    };

    const loft: Builder["loft"] = (a, c, tone = "p") => {
      const centre = mul(
        [...a, ...c].reduce((sum, point) => add(sum, point), [0, 0, 0] as V3),
        1 / (a.length + c.length),
      );
      const faceOf = (points: V3[]) => {
        // Newell's normal, turned to point away from the solid's centre.
        let normal: V3 = [0, 0, 0];
        for (let i = 0; i < points.length; i++) {
          const [x1, y1, z1] = points[i];
          const [x2, y2, z2] = points[(i + 1) % points.length];
          normal = add(normal, [(y1 - y2) * (z1 + z2), (z1 - z2) * (x1 + x2), (x1 - x2) * (y1 + y2)]);
        }
        const mid = mul(points.reduce((sum, point) => add(sum, point), [0, 0, 0] as V3), 1 / points.length);
        if (dot(normal, sub(mid, centre)) < 0) normal = mul(normal, -1);
        face(points, normal, tone);
      };
      faceOf(a);
      faceOf(c);
      for (let i = 0; i < a.length; i++) {
        const j = (i + 1) % a.length;
        faceOf([a[i], a[j], c[j], c[i]]);
      }
    };

    const prism: Builder["prism"] = (profile, frame, depth, tone = "p", options = {}) => {
      const w = norm(cross(frame.u, frame.v));
      const near = profile.map((point) => onFrame(frame, point));
      const far = near.map((point) => add(point, mul(w, depth)));
      // The end facing the camera.
      const [front, frontNormal] = visible(w) ? [far, w] : [near, mul(w, -1)];
      if (options.smooth) {
        const outline = hull([...near, ...far].map(p));
        // The sides' light: the side facing the camera most.
        const sideNormal = norm(sub(cam.view, mul(w, dot(cam.view, w))));
        els.push({ d: polygonPath(outline), k: "f", tone, sh: shadeOf(sideNormal) });
        els.push({ d: polygonPath(front.map(p)), k: "f", tone, sh: shadeOf(frontNormal) });
        return;
      }
      // Faceted: every visible side, then the visible end.
      const n = profile.length;
      // Profile winding decides which way the sides face.
      let area = 0;
      for (let i = 0; i < n; i++) area += profile[i][0] * profile[(i + 1) % n][1] - profile[(i + 1) % n][0] * profile[i][1];
      const outwardSign = area > 0 ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const a = near[i];
        const b = near[(i + 1) % n];
        const edge = sub(b, a);
        const normal = mul(norm(cross(edge, w)), outwardSign);
        face([a, b, far[(i + 1) % n], far[i]], normal, tone);
      }
      face(front, frontNormal, tone);
    };

    const cylinder: Builder["cylinder"] = (center, axis, r, length, tone = "p", n = Math.max(10, Math.min(28, Math.round(r * 1.6)))) => {
      const w = norm(axis);
      const helper: V3 = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const u = norm(cross(helper, w));
      const v = norm(cross(w, u));
      const frame = frameAt(sub(center, mul(w, length / 2)), u, v);
      prism(circle(r, n), frame, length, tone, { smooth: true });
    };

    // The circle's affine image: four cubic Béziers.
    const circlePath = (frame: Frame, r: number) => {
      const k = 0.5523 * r;
      const at = (a: number, b: number) => p(onFrame(frame, [a, b]));
      return bezierLoop([at(r, 0), at(r, k), at(k, r), at(0, r), at(-k, r), at(-r, k), at(-r, 0), at(-r, -k), at(-k, -r), at(0, -r), at(k, -r), at(r, -k)]);
    };
    const facingShade = (frame: Frame) => {
      const normal = norm(cross(frame.u, frame.v));
      return shadeOf(dot(normal, cam.view) >= 0 ? normal : mul(normal, -1));
    };

    const ring: Builder["ring"] = (frame, r, tone = "p", filled = false) => {
      els.push({ d: circlePath(frame, r), k: filled ? "f" : "l", tone, sh: facingShade(frame) });
    };

    const annulus: Builder["annulus"] = (frame, outer, inner, tone = "k") => {
      els.push({ d: circlePath(frame, outer) + circlePath(frame, inner), k: "f", tone, sh: facingShade(frame), eo: true });
    };

    const sweep: Builder["sweep"] = (center, u, v, r, a0, a1, width, tone = "b", steps = 10) => {
      const nu = norm(u);
      const nv = norm(v);
      const w = norm(cross(nu, nv));
      const at = (a: number, offset: number) => add(add(center, add(mul(nu, Math.cos(a) * r), mul(nv, Math.sin(a) * r))), mul(w, offset));
      const quads: { points: V3[]; normal: V3; depth: number }[] = [];
      for (let i = 0; i < steps; i++) {
        const a = a0 + ((a1 - a0) * i) / steps;
        const b = a0 + ((a1 - a0) * (i + 1)) / steps;
        const mid = (a + b) / 2;
        const normal = add(mul(nu, Math.cos(mid)), mul(nv, Math.sin(mid)));
        quads.push({ points: [at(a, 0), at(b, 0), at(b, width), at(a, width)], normal, depth: cam.depth(at(mid, width / 2)) });
      }
      for (const quad of quads.sort((x, y) => x.depth - y.depth)) face(quad.points, quad.normal, tone, { back: true });
    };

    const line: Builder["line"] = (points, tone = "p", options = {}) => {
      const flat = points.map(p);
      const d = options.smooth ? smoothPath(flat, options.closed) : options.closed ? polygonPath(flat) : polylinePath(flat);
      els.push({ d, k: "l", tone, sh: 0 });
    };

    const tube: Builder["tube"] = (points, width, tone = "p", corner = 0) => {
      els.push({ d: roundedPath(points.map(p), corner), k: "t", tone, sh: 0, w: width });
    };

    const spring: Builder["spring"] = (from, to, r, turns) => {
      const w = norm(sub(to, from));
      const helper: V3 = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const u = norm(cross(helper, w));
      const v = norm(cross(w, u));
      const steps = Math.round(turns * 6);
      const points: P2[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const angle = t * turns * Math.PI * 2;
        points.push(p(add(add(from, mul(sub(to, from), t)), add(mul(u, Math.cos(angle) * r), mul(v, Math.sin(angle) * r)))));
      }
      els.push({ d: polylinePath(points), k: "l", tone: "p", sh: 0 });
    };

    build({ p, face, box, loft, prism, cylinder, ring, annulus, circlePath, sweep, line, tube, spring, raw: (el) => els.push(el) });
    const centre = options.depthAt ?? mul(seen.reduce((sum, point) => add(sum, point), [0, 0, 0] as V3), 1 / Math.max(1, seen.length));
    layers.push({ zone, layer: options.layer ?? 2, depth: cam.depth(centre), els });
  }

  return {
    cam,
    bounds,
    layers,
    anchors,
    part,
    anchor: (zone, point) => {
      anchors[zone] = point;
    },
  };
}
