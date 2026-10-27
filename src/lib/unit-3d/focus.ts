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
// The part's points are kept one to a cell this size: enough for its
// outline on the stage to a pixel or two, a few hundred points at most.
const CELL = 0.015;

// A system's shape: a mesh, or anything with its geometry and where it is.
export type PartShape = { geometry: THREE.BufferGeometry; matrixWorld: THREE.Matrix4 };

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

// The part's points, in world space (x, y, z after each other): its shapes'
// corners inside the box round its point, one a cell; where it has none
// there, the small box's corners.
export function partPoints(shapes: PartShape[], target: THREE.Vector3): Float32Array {
  const near = nearBox(target);
  const cells = new Set<string>();
  const kept: number[] = [];
  const point = new THREE.Vector3();
  for (const shape of shapes) {
    const position = shape.geometry.getAttribute("position");
    if (!position) continue;
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(shape.matrixWorld);
      if (!near.containsPoint(point)) continue;
      const cell = `${Math.round(point.x / CELL)},${Math.round(point.y / CELL)},${Math.round(point.z / CELL)}`;
      if (cells.has(cell)) continue;
      cells.add(cell);
      kept.push(point.x, point.y, point.z);
    }
  }
  if (kept.length === 0) {
    const { min, max } = smallBox(target);
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) kept.push(x, y, z);
  }
  return new Float32Array(kept);
}

// Where the part is on a screen width by height (CSS pixels) through a
// camera (viewProjection: its projection times the inverse of where it
// is): the box round its points. All of the screen when the part reaches
// round behind the camera (it's in among it), null when it's all behind.
export function screenExtent(points: Float32Array, viewProjection: THREE.Matrix4, width: number, height: number): Rect | null {
  const m = viewProjection.elements;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let behind = 0;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 1e-6) {
      behind++;
      continue;
    }
    const sx = (((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2) * width;
    const sy = ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2) * height;
    left = Math.min(left, sx);
    right = Math.max(right, sx);
    top = Math.min(top, sy);
    bottom = Math.max(bottom, sy);
  }
  const count = points.length / 3;
  if (count === 0 || behind === count) return null;
  if (behind > 0) return { x: 0, y: 0, w: width, h: height };
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
