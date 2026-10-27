import * as THREE from "three";

import type { Rect } from "./bubble";

// A system's part as the examine view sees it: what the camera flies to
// (viewer.ts) and what the drawing's bubble keeps off on the stage
// (bubble.ts). A system's hoses or harness can run the machine's length,
// but the view of it is of the part round its callout's point: its shapes
// inside a box this size round the point (world units, the machine's
// metres), or a small box round the point where none of them is. Pure
// three.js maths: no WebGL, no DOM (the tests build the shapes in Node).

export const NEAR_PART = 0.9;
const SMALL_PART = 0.3;
// The part's points are kept one to a cell this size, at the cell's
// middle: its outline on the stage to a pixel or so, under two thousand
// points for the largest (a line's wheels and tyres).
const CELL = 0.005;
// How far any of the part's shape is from the nearest of its points (half
// a cell's diagonal): its box on the stage is grown by this as the camera
// sees it there, so it holds all of the part however close the camera.
export const PART_SPREAD = (CELL * Math.sqrt(3)) / 2;

// A system's shape: a mesh, or anything with its geometry and where it is.
export type PartShape = { geometry: THREE.BufferGeometry; matrixWorld: THREE.Matrix4 };
// The part as points (world space, x, y, z after each other) and how far
// its shape is from them at most (world units).
export type PartPoints = { points: Float32Array; spread: number };

const nearBox = (target: THREE.Vector3) => new THREE.Box3().setFromCenterAndSize(target, new THREE.Vector3(NEAR_PART, NEAR_PART, NEAR_PART));
const smallBox = (target: THREE.Vector3) => new THREE.Box3().setFromCenterAndSize(target, new THREE.Vector3(SMALL_PART, SMALL_PART, SMALL_PART));

// The box round the part, in world space: its shapes' box within the box
// round its point, or the small box round the point.
export function partBox(shapes: PartShape[], target: THREE.Vector3): THREE.Box3 {
  const box = new THREE.Box3();
  for (const shape of shapes) {
    shape.geometry.computeBoundingBox();
    box.union(shape.geometry.boundingBox!.clone().applyMatrix4(shape.matrixWorld));
  }
  const near = nearBox(target);
  if (box.isEmpty() || !box.intersectsBox(near)) return smallBox(target);
  return box.intersect(near);
}

const AXES = ["x", "y", "z"] as const;

// A flat polygon cut to what of it is inside a box (one face of the box
// after another): the corners of what's left, none when it's all outside.
export function clipToBox(polygon: THREE.Vector3[], box: THREE.Box3): THREE.Vector3[] {
  let out = polygon;
  for (const axis of AXES) {
    for (const low of [true, false]) {
      const limit = low ? box.min[axis] : box.max[axis];
      const inside = (v: THREE.Vector3) => (low ? v[axis] >= limit : v[axis] <= limit);
      const corners = out;
      out = [];
      for (let i = 0; i < corners.length; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % corners.length];
        if (inside(a)) out.push(a);
        if (inside(a) !== inside(b)) out.push(a.clone().lerp(b, (limit - a[axis]) / (b[axis] - a[axis])));
      }
      if (out.length === 0) return out;
    }
  }
  return out;
}

// The part's points: its shapes inside the box round its point, cut to
// the box where they cross it (a steering post, a frame's tubes, a prop
// shaft: corners of them well outside it, the part of them inside it what
// the camera frames), one a cell; where it has none there, the small
// box's corners.
export function partPoints(shapes: PartShape[], target: THREE.Vector3): PartPoints {
  const near = nearBox(target);
  const cells = new Set<number>();
  const kept: number[] = [];
  const keep = (point: THREE.Vector3) => {
    const i = Math.round(point.x / CELL);
    const j = Math.round(point.y / CELL);
    const k = Math.round(point.z / CELL);
    // One number a cell (the machine is well inside forty metres across).
    const cell = ((i + 4096) * 8192 + (j + 4096)) * 8192 + (k + 4096);
    if (cells.has(cell)) return;
    cells.add(cell);
    kept.push(i * CELL, j * CELL, k * CELL);
  };
  const corner = new THREE.Vector3();
  const lows = [near.min.x, near.min.y, near.min.z];
  const highs = [near.max.x, near.max.y, near.max.z];
  for (const shape of shapes) {
    const position = shape.geometry.getAttribute("position");
    if (!position) continue;
    // Its corners where they are (each once), then its triangles.
    const at = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) corner.fromBufferAttribute(position, i).applyMatrix4(shape.matrixWorld).toArray(at, i * 3);
    const index = shape.geometry.getIndex();
    const count = index ? index.count : position.count;
    const vertex = (n: number) => (index ? index.getX(n) : n) * 3;
    triangles: for (let n = 0; n + 2 < count; n += 3) {
      const a = vertex(n);
      const b = vertex(n + 1);
      const c = vertex(n + 2);
      let inside = true;
      for (let axis = 0; axis < 3; axis++) {
        const low = lows[axis];
        const high = highs[axis];
        const least = Math.min(at[a + axis], at[b + axis], at[c + axis]);
        const most = Math.max(at[a + axis], at[b + axis], at[c + axis]);
        // All of it past one face: none of it inside.
        if (most < low || least > high) continue triangles;
        if (least < low || most > high) inside = false;
      }
      const triangle = [a, b, c].map((i) => new THREE.Vector3(at[i], at[i + 1], at[i + 2]));
      // All three corners inside: the triangle as it is.
      for (const point of inside ? triangle : clipToBox(triangle, near)) keep(point);
    }
  }
  if (kept.length === 0) {
    const { min, max } = smallBox(target);
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) kept.push(x, y, z);
  }
  return { points: new Float32Array(kept), spread: PART_SPREAD };
}

const length = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

// Where the part is on a screen width by height (CSS pixels) through a
// camera (viewProjection: its projection times the inverse of where it
// is): the box round its points, each grown by its spread as the camera
// sees it where it is (more the nearer the camera). All of the screen
// when the part reaches round behind the camera (it's in among it), null
// when it's all behind.
export function screenExtent({ points, spread }: PartPoints, viewProjection: THREE.Matrix4, width: number, height: number): Rect | null {
  const m = viewProjection.elements;
  // How far a point a spread from another can be from the camera's plane
  // (the depth's row is a unit's length for a camera that isn't scaled).
  const depth = length(m[3], m[7], m[11]) * spread;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let behind = 0;
  let round = false;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 1e-6) {
      behind++;
      continue;
    }
    if (w - depth <= 1e-6) {
      round = true;
      continue;
    }
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    // Within a spread of the point, how far across and down the screen
    // the shape can be from it (the most a move that far shifts it).
    const across = spread > 0 ? ((length(m[0] - nx * m[3], m[4] - nx * m[7], m[8] - nx * m[11]) * spread) / (w - depth)) * (width / 2) : 0;
    const down = spread > 0 ? ((length(m[1] - ny * m[3], m[5] - ny * m[7], m[9] - ny * m[11]) * spread) / (w - depth)) * (height / 2) : 0;
    const sx = ((nx + 1) / 2) * width;
    const sy = ((1 - ny) / 2) * height;
    left = Math.min(left, sx - across);
    right = Math.max(right, sx + across);
    top = Math.min(top, sy - down);
    bottom = Math.max(bottom, sy + down);
  }
  const count = points.length / 3;
  if (count === 0 || behind === count) return null;
  if (behind > 0 || round) return { x: 0, y: 0, w: width, h: height };
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// The camera's flight to a part (viewer.ts picks among the directions the
// one least in the way of the rest of the machine): how far back (close
// enough to see the part, far enough to keep the machine round it; on a
// narrow, portrait screen further still) and the directions tried round
// it (its side, three-quarter front and rear, from above, its end, the far
// side), given the part's box, the machine's size and middle, the
// camera's field of view (degrees) and the screen's shape.
export function flightTo(part: THREE.Box3, target: THREE.Vector3, machine: { size: number; centre: THREE.Vector3 }, fov: number, screen: { width: number; height: number }) {
  const { size, centre } = machine;
  const radius = part.getSize(new THREE.Vector3()).length() / 2;
  const half = THREE.MathUtils.degToRad(fov) / 2;
  const portrait = screen.width < screen.height ? Math.min(2, screen.height / screen.width) : 1;
  const distance = Math.max(size * 1.3, (radius / Math.sin(half)) * 2.4) * portrait;
  const side = Math.abs(target.z - centre.z) > size * 0.04 ? Math.sign(target.z - centre.z) : -1;
  const end = Math.abs(target.x - centre.x) > size * 0.08 ? Math.sign(target.x - centre.x) : 1;
  const directions = [
    new THREE.Vector3(0.75 * end, 0.45, 0.75 * side),
    new THREE.Vector3(0.05, 0.4, side),
    new THREE.Vector3(-0.75 * end, 0.45, 0.75 * side),
    new THREE.Vector3(0.35 * end, 1, 0.35 * side),
    new THREE.Vector3(end, 0.4, 0.15 * side),
    new THREE.Vector3(0.6 * end, 0.45, -0.75 * side),
  ].map((v) => v.normalize());
  return { distance, directions };
}
