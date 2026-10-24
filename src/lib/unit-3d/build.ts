import * as THREE from "three";

import type { DrawnSystem } from "@/lib/diagnose-zones";
import type { UnitSpec } from "@/lib/unit-vehicle";

import { Kit, flipWinding, type Group } from "./geo";
import { layoutFor, type Layout } from "./layout";
import { makeMaterials, type Materials, type MatKey } from "./materials";
import { buildAtv } from "./models/atv";
import { buildGenerator } from "./models/generator";
import { buildSideBySide } from "./models/sxs";

// A whole 3D unit for a spec: its meshes (one per system and material),
// grouped by system, under one root scaled to the machine's size.

export type UnitMesh = { group: Group; material: MatKey; mesh: THREE.Mesh };

export type BuiltUnit = {
  root: THREE.Group;
  meshes: UnitMesh[];
  byZone: Map<DrawnSystem, THREE.Mesh[]>;
  layout: Layout;
  materials: Materials;
  triangles: number;
  dispose: () => void;
};

// The models are drawn with +z to the machine's left; three.js's axes put
// +z on its right. Each shape is mirrored across the machine's middle as it
// is built (and turned back right way out), so the steering wheel and the
// drive clutch end up on the left, where Polaris puts them (see layout.ts).
const MIRROR = new THREE.Matrix4().makeScale(1, 1, -1);

// The machine's shapes, one per (system, material), on three.js's axes,
// unscaled.
export function buildGeometry(layout: Layout) {
  const kit = new Kit();
  if (layout.family === "generator") buildGenerator(kit, layout);
  else if (layout.family === "utility_atv" || layout.family === "sport_atv") buildAtv(kit, layout);
  else buildSideBySide(kit, layout);
  const parts = kit.merged();
  for (const part of parts) {
    part.geometry.applyMatrix4(MIRROR);
    flipWinding(part.geometry);
    part.geometry.computeBoundingBox();
    part.geometry.computeBoundingSphere();
  }
  return parts;
}

// The shapes of the last few machines built, kept (the browser's copy:
// disposing a mesh frees its GPU buffers, and the same shapes upload again
// next time), so coming back to a page or switching back to a unit doesn't
// build them again.
const shapes = new Map<string, ReturnType<typeof buildGeometry>>();
const SHAPES_KEPT = 3;

export function shapesFor(spec: UnitSpec) {
  const key = `${spec.line}|${spec.seats}|${spec.size}|${spec.sixWheels}`;
  let parts = shapes.get(key);
  if (parts) shapes.delete(key);
  else parts = buildGeometry(layoutFor(spec));
  shapes.set(key, parts);
  while (shapes.size > SHAPES_KEPT) shapes.delete(shapes.keys().next().value!);
  return parts;
}

export function buildUnit(spec: UnitSpec, materials: Materials = makeMaterials(spec.paint)): BuiltUnit {
  const layout = layoutFor(spec);
  const parts = shapesFor(spec);
  const root = new THREE.Group();
  root.name = `unit-${spec.line}`;
  root.scale.setScalar(layout.scale);
  const meshes: UnitMesh[] = [];
  const byZone = new Map<DrawnSystem, THREE.Mesh[]>();
  let triangles = 0;
  for (const part of parts) {
    const mesh = new THREE.Mesh(part.geometry, materials[part.material]);
    mesh.name = `${part.group}:${part.material}`;
    mesh.userData = { group: part.group, material: part.material };
    root.add(mesh);
    meshes.push({ group: part.group, material: part.material, mesh });
    if (part.group !== "shell" && part.group !== "running") byZone.set(part.group, [...(byZone.get(part.group) ?? []), mesh]);
    triangles += part.geometry.getAttribute("position").count / 3;
  }
  root.updateMatrixWorld(true);
  return {
    root,
    meshes,
    byZone,
    layout,
    materials,
    triangles,
    dispose() {
      for (const { mesh } of meshes) mesh.geometry.dispose();
    },
  };
}
