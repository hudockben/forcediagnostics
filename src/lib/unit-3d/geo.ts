import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { DrawnSystem } from "@/lib/diagnose-zones";

import type { V3 } from "./layout";
import type { MatKey } from "./materials";

// Shapes for the 3D unit's parts, and the kit they're collected in: every
// part belongs to a system (or the shell: the body panels, seats and
// glass, which turn see-through in phantom view) and has a material; the kit
// merges each system's parts per material into one mesh, so a whole
// machine is a few dozen draw calls.

// "running": the wheels other than the one a wheels/tires flag points at
// (a flag on all four would shout over everything else); never flagged.
export type Group = DrawnSystem | "shell" | "running";

const v = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);

// Every geometry the kit takes has the same attributes and no index, so
// they merge.
function normalise(geometry: THREE.BufferGeometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  if (!g.getAttribute("uv")) {
    const count = g.getAttribute("position").count;
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
  g.clearGroups();
  return g;
}

export class Kit {
  private parts = new Map<string, THREE.BufferGeometry[]>();

  add(group: Group, material: MatKey, geometry: THREE.BufferGeometry) {
    const key = `${group}|${material}`;
    const list = this.parts.get(key) ?? [];
    list.push(normalise(geometry));
    this.parts.set(key, list);
  }

  // One geometry per (group, material).
  merged(): { group: Group; material: MatKey; geometry: THREE.BufferGeometry }[] {
    const out: { group: Group; material: MatKey; geometry: THREE.BufferGeometry }[] = [];
    for (const [key, list] of this.parts) {
      const [group, material] = key.split("|") as [Group, MatKey];
      const geometry = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) for (const part of list) part.dispose();
      if (!geometry) continue;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      out.push({ group, material, geometry });
    }
    this.parts.clear();
    return out;
  }
}

// --- Shapes ------------------------------------------------------------------

// A cylinder (or cone) from a to b.
export function cylinder(a: V3, b: V3, r: number, r2 = r, segments = 16, open = false) {
  const start = v(a);
  const end = v(b);
  const length = start.distanceTo(end);
  const g = new THREE.CylinderGeometry(r2, r, length, segments, 1, open);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());
  g.applyQuaternion(q);
  const mid = start.add(end).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

// A rounded box, centred at `at`, turned by `rot` (radians about x, y, z).
export function rbox(at: V3, size: V3, radius: number, rot: V3 = [0, 0, 0], segments = 2) {
  const r = Math.min(radius, Math.min(...size) / 2 - 1e-4);
  const g = new RoundedBoxGeometry(size[0], size[1], size[2], segments, Math.max(r, 0.0005));
  g.rotateX(rot[0]);
  g.rotateY(rot[1]);
  g.rotateZ(rot[2]);
  g.translate(at[0], at[1], at[2]);
  return g;
}

export function sphere(at: V3, r: number, segments = 12) {
  const g = new THREE.SphereGeometry(r, segments, Math.max(6, segments / 2));
  g.translate(at[0], at[1], at[2]);
  return g;
}

// A tube through the points, its corners bent round with radius `bend`.
export function tube(points: V3[], r: number, bend = 0.08, radial = 8) {
  const path = new THREE.CurvePath<THREE.Vector3>();
  const pts = points.map(v);
  let from = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const corner = pts[i];
    if (i === pts.length - 1) {
      path.add(new THREE.LineCurve3(from, corner));
      break;
    }
    const next = pts[i + 1];
    const inLen = corner.distanceTo(from);
    const outLen = corner.distanceTo(next);
    const cut = Math.min(bend, inLen / 2, outLen / 2);
    const a = corner.clone().add(from.clone().sub(corner).normalize().multiplyScalar(cut));
    const b = corner.clone().add(next.clone().sub(corner).normalize().multiplyScalar(cut));
    if (from.distanceTo(a) > 1e-4) path.add(new THREE.LineCurve3(from, a));
    path.add(new THREE.QuadraticBezierCurve3(a, corner, b));
    from = b;
  }
  const length = path.getLength();
  const segments = Math.max(4, Math.min(96, Math.round(length / 0.07) + pts.length * 3));
  return new THREE.TubeGeometry(path, segments, r, radial, false);
}

// A tube along a smooth curve through the points.
export function smoothTube(points: V3[], r: number, radial = 8, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map(v), closed, "centripetal");
  const segments = Math.max(8, Math.min(64, Math.round(curve.getLength() / 0.05)));
  return new THREE.TubeGeometry(curve, segments, r, radial, closed);
}

// A coil spring from a to b.
export function spring(a: V3, b: V3, r: number, wire: number, turns: number) {
  const start = v(a);
  const end = v(b);
  const axis = end.clone().sub(start);
  const length = axis.length();
  axis.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  const points: THREE.Vector3[] = [];
  const steps = Math.round(turns * 10);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = t * turns * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * r, t * length, Math.sin(angle) * r).applyQuaternion(q).add(start));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, steps, wire, 4, false);
}

// A shape with rounded corners from its corner points (x, y), each corner
// rounded by its own radius (or `radius`).
export function roundedShape(points: [number, number, number?][], radius: number) {
  const shape = new THREE.Shape();
  const n = points.length;
  const at = (i: number) => new THREE.Vector2(points[(i + n) % n][0], points[(i + n) % n][1]);
  for (let i = 0; i < n; i++) {
    const prev = at(i - 1);
    const corner = at(i);
    const next = at(i + 1);
    const r = points[i][2] ?? radius;
    const cut = Math.min(r, corner.distanceTo(prev) / 2, corner.distanceTo(next) / 2);
    const a = corner.clone().add(prev.clone().sub(corner).normalize().multiplyScalar(cut));
    const b = corner.clone().add(next.clone().sub(corner).normalize().multiplyScalar(cut));
    if (i === 0) shape.moveTo(a.x, a.y);
    else shape.lineTo(a.x, a.y);
    shape.quadraticCurveTo(corner.x, corner.y, b.x, b.y);
  }
  shape.closePath();
  return shape;
}

// A side-profile panel: the shape (x forward, y up) made solid from z0 to
// z1, its edges rounded by `bevel`.
export function sidePanel(points: [number, number, number?][], z0: number, z1: number, { radius = 0.04, bevel = 0.02, curve = 6 }: { radius?: number; bevel?: number; curve?: number } = {}) {
  const lo = Math.min(z0, z1);
  const hi = Math.max(z0, z1);
  const b = Math.min(bevel, (hi - lo) / 2 - 1e-4);
  const g = new THREE.ExtrudeGeometry(roundedShape(points, radius), {
    depth: Math.max(hi - lo - 2 * b, 1e-4),
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 2,
    curveSegments: curve,
  });
  g.translate(0, 0, lo + b);
  return g;
}

// A plan-view panel: the shape (x forward, z left) made solid from y0 to y1.
export function planPanel(points: [number, number, number?][], y0: number, y1: number, opts: { radius?: number; bevel?: number; curve?: number } = {}) {
  // Drawn as a side panel in (x, -z), then laid flat.
  const g = sidePanel(
    points.map(([x, z, r]) => [x, -z, r]),
    y0,
    y1,
    opts,
  );
  g.rotateX(-Math.PI / 2);
  return g;
}

// A front-profile panel: the shape (z left, y up) made solid from x0 to x1.
export function frontPanel(points: [number, number, number?][], x0: number, x1: number, opts: { radius?: number; bevel?: number; curve?: number } = {}) {
  // Built as a side panel (shape in x, y; solid along z), then x and z
  // swapped: a mirror, so the faces are turned back the right way out.
  const g = sidePanel(points, x0, x1, opts);
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  flipWinding(g);
  return g;
}

// Mirroring turns faces inside out; swap each triangle's corners back.
export function flipWinding(geometry: THREE.BufferGeometry) {
  const g = geometry;
  if (g.index) {
    const index = g.index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < index.length; i += 3) {
      const t = index[i + 1];
      index[i + 1] = index[i + 2];
      index[i + 2] = t;
    }
    g.index.needsUpdate = true;
    return g;
  }
  for (const name of Object.keys(g.attributes)) {
    const attr = g.getAttribute(name) as THREE.BufferAttribute;
    const size = attr.itemSize;
    const array = attr.array as Float32Array;
    for (let i = 0; i < attr.count; i += 3) {
      for (let k = 0; k < size; k++) {
        const a = (i + 1) * size + k;
        const b = (i + 2) * size + k;
        const t = array[a];
        array[a] = array[b];
        array[b] = t;
      }
    }
    attr.needsUpdate = true;
  }
  return g;
}

// A surface of revolution about y: profile points (radius, y).
export function lathe(profile: [number, number][], segments = 24) {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );
}

// Turns a geometry built about the y axis to lie along `axis`, then moves it.
export function orient(geometry: THREE.BufferGeometry, axis: V3, at: V3) {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v(axis).normalize());
  geometry.applyQuaternion(q);
  geometry.translate(at[0], at[1], at[2]);
  return geometry;
}

export function torus(at: V3, axis: V3, r: number, tubeR: number, segments = 24) {
  const g = new THREE.TorusGeometry(r, tubeR, 8, segments);
  // The torus lies in xy (axis z): turn z onto the axis.
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), v(axis).normalize());
  g.applyQuaternion(q);
  g.translate(at[0], at[1], at[2]);
  return g;
}

export function moved(geometry: THREE.BufferGeometry, at: V3, rot: V3 = [0, 0, 0]) {
  geometry.rotateX(rot[0]);
  geometry.rotateY(rot[1]);
  geometry.rotateZ(rot[2]);
  geometry.translate(at[0], at[1], at[2]);
  return geometry;
}

// --- Lofted skins ---------------------------------------------------------------

// A skin through rings of points (every ring the same number of points, in
// the same order round), closed round each ring and capped at both ends:
// hoods, noses, fender flares, tanks. Smooth normals; faces turned outward.
export function loft(rings: V3[][], { caps = true }: { caps?: boolean } = {}) {
  const n = rings[0].length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  rings.forEach((ring, i) => {
    ring.forEach(([x, y, z], j) => {
      positions.push(x, y, z);
      uvs.push(j / n, i / Math.max(1, rings.length - 1));
    });
  });
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j;
      const b = i * n + ((j + 1) % n);
      const c = (i + 1) * n + ((j + 1) % n);
      const d = (i + 1) * n + j;
      index.push(a, b, c, a, c, d);
    }
  }
  if (caps) {
    for (const [ringIndex, flip] of [
      [0, true],
      [rings.length - 1, false],
    ] as const) {
      const ring = rings[ringIndex];
      const centre = ring.reduce((sum, p) => [sum[0] + p[0] / n, sum[1] + p[1] / n, sum[2] + p[2] / n], [0, 0, 0]);
      const c = positions.length / 3;
      positions.push(centre[0], centre[1], centre[2]);
      uvs.push(0.5, 0.5);
      // The cap gets its own copy of the ring, for a crisp edge.
      const start = positions.length / 3;
      for (const [x, y, z] of ring) {
        positions.push(x, y, z);
        uvs.push(0.5, 0.5);
      }
      for (let j = 0; j < n; j++) {
        const a = start + j;
        const b = start + ((j + 1) % n);
        if (flip) index.push(c, b, a);
        else index.push(c, a, b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  // Turn it right way out if the skin's volume came out negative.
  const p = g.getAttribute("position");
  let volume = 0;
  for (let k = 0; k < index.length; k += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(p, index[k]);
    const b = new THREE.Vector3().fromBufferAttribute(p, index[k + 1]);
    const c = new THREE.Vector3().fromBufferAttribute(p, index[k + 2]);
    volume += a.dot(b.cross(c));
  }
  if (volume < 0) flipWinding(g);
  g.computeVertexNormals();
  // Texture coordinates in metres, projected along each point's main
  // direction, so a printed pattern (camo) keeps its size on any panel.
  const normal = g.getAttribute("normal");
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let k = 0; k < p.count; k++) {
    const ax = Math.abs(normal.getX(k));
    const ay = Math.abs(normal.getY(k));
    const az = Math.abs(normal.getZ(k));
    const [x, y, z] = [p.getX(k), p.getY(k), p.getZ(k)];
    if (ay >= ax && ay >= az) uv.setXY(k, x, z);
    else if (ax >= az) uv.setXY(k, z, y);
    else uv.setXY(k, x, y);
  }
  uv.needsUpdate = true;
  return g;
}

// A cross-section ring for loft: a rounded, tapering box in the (z, y)
// plane at x, `half` wide at the bottom and `topHalf` at the top, its top
// raised by `crown` in the middle. p is the corners' squareness (2 round,
// 4-6 boxy).
export function section(x: number, half: number, y0: number, y1: number, { topHalf = half, crown = 0, p = 4, points = 20, zc = 0 }: { topHalf?: number; crown?: number; p?: number; points?: number; zc?: number } = {}): V3[] {
  const ring: V3[] = [];
  const yc = (y0 + y1) / 2;
  const b = (y1 - y0) / 2;
  for (let i = 0; i < points; i++) {
    const t = (i / points) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const zn = Math.sign(c) * Math.pow(Math.abs(c), 2 / p);
    const yn = Math.sign(s) * Math.pow(Math.abs(s), 2 / p);
    const y = yc + yn * b;
    const k = (y - y0) / Math.max(1e-6, y1 - y0);
    const w = half + (topHalf - half) * k;
    const z = zn * w;
    const lift = yn > 0 ? crown * yn * (1 - zn * zn) : 0;
    ring.push([x, y + lift, zc + z]);
  }
  return ring;
}

// A flare over a wheel: a thin strip following an arc round the wheel's
// middle (cx, cy) at radius r, from angle a0 to a1 (0 is straight ahead),
// spanning z0 to z1, `thick` deep, its outer edge turned down by `lip`.
export function flare(cx: number, cy: number, r: number, a0: number, a1: number, z0: number, z1: number, { thick = 0.03, lip = 0.04, steps = 14 }: { thick?: number; lip?: number; steps?: number } = {}) {
  const out = Math.sign(z1 - z0) || 1;
  // The strip's cross-section in (radial, z), round the loop.
  const profile: [number, number][] = [
    [0, z0],
    [thick, z0],
    [thick, z1 - out * 0.02],
    [thick * 0.6, z1],
    [-lip, z1],
    [-lip, z1 - out * thick],
    [0, z1 - out * thick * 1.4],
  ];
  const rings: V3[][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const c = Math.cos(a);
    const s = Math.sin(a);
    rings.push(profile.map(([dr, z]) => [cx + c * (r + dr), cy + s * (r + dr), z] as V3));
  }
  return loft(rings);
}

// --- Faceted panels --------------------------------------------------------------

// A point of a cross section or a path; true marks a crease: the point is
// doubled, so the surface is shaded crisply on either side of it (a panel's
// folded edge) instead of rounded over.
export type CP = [number, number, boolean?];

const doubled = (points: CP[]) => points.flatMap((p) => (p[2] ? [p, p] : [p]));

// A machine's panel across its width at x, symmetric about its middle:
// `half` runs from the top of the middle (z = 0) round the outside of one
// side to the bottom of the middle. Every ring of a loft must be made from
// the same number of points with the same creases.
export function crossRing(x: number, half: CP[]): V3[] {
  const side = doubled(half);
  const other = side
    .slice(1, -1)
    .reverse()
    .map(([z, y]) => [-z, y] as CP);
  return [...side, ...other].map(([z, y]) => [x, y, z] as V3);
}

// A ring at x from a full outline in (z, y), not mirrored.
export function ringAt(x: number, outline: CP[]): V3[] {
  return doubled(outline).map(([z, y]) => [x, y, z] as V3);
}

// A shape swept along a path in side view (x, y): `profile` is its cross
// section in (out, z), out measured from the path along its normal (to the
// path's right as it runs, so a path running front to back over a wheel has
// out pointing away from the wheel). The path's corners are mitred, and a
// crease on the path is a crisp fold across the shape: fender tops, door
// edges, bumpers.
// `profile` can be a function of the path point's index, for a shape that
// changes along the way (each the same number of points and creases).
export function sweep(path: CP[], profile: CP[] | ((i: number) => CP[]), { caps = true }: { caps?: boolean } = {}) {
  const rings: V3[][] = [];
  path.forEach(([x, y, crease], i) => {
    const ring = doubled(typeof profile === "function" ? profile(i) : profile);
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    const t1 = norm2(x - prev[0], y - prev[1]);
    const t2 = norm2(next[0] - x, next[1] - y);
    const a = i === 0 ? t2 : t1;
    const b = i === path.length - 1 ? t1 : t2;
    // The normals of the segments either side, and the mitre between them.
    const n1: [number, number] = [a[1], -a[0]];
    const n2: [number, number] = [b[1], -b[0]];
    let m = norm2(n1[0] + n2[0], n1[1] + n2[1]);
    const cos = m[0] * n1[0] + m[1] * n1[1];
    const k = 1 / Math.max(0.35, cos);
    m = [m[0] * k, m[1] * k];
    const r = ring.map(([out, z]) => [x + m[0] * out, y + m[1] * out, z] as V3);
    rings.push(r);
    if (crease && i > 0 && i < path.length - 1) rings.push(r.map((p) => [...p] as V3));
  });
  return loft(rings, { caps });
}

function norm2(x: number, y: number): [number, number] {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}
