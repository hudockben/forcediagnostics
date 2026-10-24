import * as THREE from "three";

import type { UnitPaint } from "@/lib/unit-paint";

// The 3D unit's materials, shared by every part, for a calm studio render:
// satin paint in the unit's colour (metallic, pearl or matte as Polaris
// names it; Polaris Pursuit Camo as a printed pattern), matte textured
// black plastic, satin black frame, brushed and cast metal, dark rubber,
// vinyl seats, glass, and clear (unlit) light lenses. Nothing is emissive.
// Textures are drawn here (no image files). The flat colours a flagged
// system is drawn in (see look.ts) are made per colour and shared.

export const MATERIAL_KEYS = [
  "paint",
  "accent",
  "plastic",
  "trim",
  "frame",
  "metal",
  "cast",
  "engine",
  "rubber",
  "rim",
  "seat",
  "glass",
  "led",
  "tail",
  "amber",
  "spring",
  "radiator",
  "decal",
] as const;
export type MatKey = (typeof MATERIAL_KEYS)[number];

// A small, fast hash-based value noise (deterministic, so every render of
// a unit is the same).
function hash(x: number, y: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number, seed: number, period: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const wrap = (n: number) => ((n % period) + period) % period;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash(wrap(xi), wrap(yi), seed);
  const b = hash(wrap(xi + 1), wrap(yi), seed);
  const c = hash(wrap(xi), wrap(yi + 1), seed);
  const d = hash(wrap(xi + 1), wrap(yi + 1), seed);
  return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy);
}

// Fractal noise that tiles over size x size texels.
function fbm(x: number, y: number, size: number, cells: number, seed: number, octaves = 3) {
  let sum = 0;
  let amp = 0.5;
  let freq = cells / size;
  let period = cells;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq, seed + o * 17, period);
    amp *= 0.5;
    freq *= 2;
    period *= 2;
  }
  return sum / (1 - Math.pow(0.5, octaves));
}

const hex = (colour: string) => new THREE.Color(colour);

// Each texture's pixels are worked out once a session (a camo print takes
// a moment), then every unit after reuses them.
const pixelCache = new Map<string, Uint8Array>();

function dataTexture(key: string, size: number, pixel: (x: number, y: number) => [number, number, number], srgb: boolean) {
  let data = pixelCache.get(key);
  if (!data) {
    data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b] = pixel(x, y);
        const i = (y * size + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
    pixelCache.set(key, data);
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// Polaris Pursuit Camo: tan ground, olive and brown blotches, dark
// branch-like streaks running up and down. Other camo: rounder blotches.
function camoTexture(kind: "pursuit" | "other") {
  // 128 texels over about 60 cm of panel: finer than any screen shows it.
  const size = 128;
  const layers =
    kind === "pursuit"
      ? [
          { colour: "#9a8a68", cells: 5, sx: 1, sy: 2.6, cut: 0 },
          { colour: "#6e6a4f", cells: 6, sx: 1, sy: 2.2, cut: 0.52 },
          { colour: "#5b4733", cells: 7, sx: 1.2, sy: 3.2, cut: 0.58 },
          { colour: "#2f2a22", cells: 10, sx: 1.6, sy: 5, cut: 0.66 },
          { colour: "#b3a785", cells: 12, sx: 2, sy: 6, cut: 0.7 },
        ]
      : [
          { colour: "#7c7656", cells: 4, sx: 1, sy: 1, cut: 0 },
          { colour: "#5a5a3c", cells: 5, sx: 1, sy: 1.2, cut: 0.5 },
          { colour: "#3c3526", cells: 7, sx: 1, sy: 1.4, cut: 0.58 },
          { colour: "#a0966e", cells: 9, sx: 1.2, sy: 1.2, cut: 0.66 },
        ];
  const colours = layers.map((layer) => hex(layer.colour).convertLinearToSRGB());
  return dataTexture(
    `camo:${kind}`,
    size,
    (x, y) => {
      let pick = 0;
      layers.forEach((layer, i) => {
        if (i === 0) return;
        const n = fbm(x * layer.sx, y * layer.sy, size, layer.cells, 11 + i * 7, 3);
        if (n > layer.cut) pick = i;
      });
      const c = colours[pick];
      // A little grain, so it reads as a print, not flat paint.
      const grain = (hash(x, y, 3) - 0.5) * 10;
      return [c.r * 255 + grain, c.g * 255 + grain, c.b * 255 + grain];
    },
    true,
  );
}

// Fine grain for textured black plastic and seat vinyl (a bump map).
function grainTexture() {
  const size = 128;
  return dataTexture(
    "grain",
    size,
    (x, y) => {
      const n = fbm(x, y, size, 32, 5, 2) * 0.6 + hash(x, y, 9) * 0.4;
      const v = Math.round(n * 255);
      return [v, v, v];
    },
    false,
  );
}

export type Materials = Record<MatKey, THREE.MeshStandardMaterial> & { textures: THREE.Texture[] };

export function makeMaterials(paint: UnitPaint): Materials {
  const textures: THREE.Texture[] = [];
  const grain = grainTexture();
  grain.repeat.set(6, 6);
  textures.push(grain);

  const finish = paint.finish;
  // Satin: a soft sheen, a light clear coat (none on matte).
  const paintMaterial = (colour: string) =>
    new THREE.MeshPhysicalMaterial({
      color: hex(colour),
      metalness: finish === "metallic" ? 0.35 : finish === "pearl" ? 0.15 : 0.0,
      roughness: finish === "matte" ? 0.62 : finish === "metallic" ? 0.38 : 0.42,
      clearcoat: finish === "matte" ? 0 : 0.2,
      clearcoatRoughness: 0.42,
      sheen: finish === "pearl" ? 0.4 : 0,
      sheenColor: hex("#ffffff"),
    });

  const body = paintMaterial(paint.base);
  if (paint.camo) {
    const camo = camoTexture(paint.camo);
    // Body panels' coordinates are in metres: a blotch every 20-40 cm.
    camo.repeat.set(1.6, 1.6);
    textures.push(camo);
    body.map = camo;
    body.color.set("#ffffff");
    body.roughness = 0.66;
    body.clearcoat = 0;
  }
  // A two-tone's second colour; otherwise the trim panels are black.
  const accent = paint.accent ? paintMaterial(paint.accent) : new THREE.MeshStandardMaterial({ color: hex("#1e2023"), roughness: 0.62, metalness: 0.0 });

  const standard = (params: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(params);
  const materials: Omit<Materials, "textures"> = {
    paint: body,
    accent,
    // Matte black textured plastic (fenders' liners, floor, guards).
    plastic: standard({ color: hex("#222427"), roughness: 0.86, metalness: 0, bumpMap: grain, bumpScale: 0.35 }),
    trim: standard({ color: hex("#2a2d30"), roughness: 0.6, metalness: 0.05 }),
    // Painted (powder-coated) black frame and cage.
    frame: standard({ color: hex("#26292c"), roughness: 0.48, metalness: 0.35 }),
    // Brushed steel: shafts, shock bodies, bolts.
    metal: standard({ color: hex("#b9bec2"), roughness: 0.34, metalness: 1 }),
    // Cast aluminium: diffs, knuckles, calipers.
    cast: standard({ color: hex("#9a9fa3"), roughness: 0.55, metalness: 0.8 }),
    engine: standard({ color: hex("#4a4e52"), roughness: 0.55, metalness: 0.55 }),
    rubber: standard({ color: hex("#1a1b1d"), roughness: 0.93, metalness: 0 }),
    // Cast wheels in graphite, so they read against the tyre.
    rim: standard({ color: hex("#4b5055"), roughness: 0.4, metalness: 0.5 }),
    seat: standard({ color: hex("#26282b"), roughness: 0.74, metalness: 0, bumpMap: grain, bumpScale: 0.25 }),
    glass: new THREE.MeshPhysicalMaterial({ color: hex("#a9b8c2"), roughness: 0.06, metalness: 0, transparent: true, opacity: 0.3, clearcoat: 1, depthWrite: false }),
    // Light lenses, unlit: a clear lens over a bright reflector; the tail
    // and turn lenses dark, smoked red and amber.
    led: standard({ color: hex("#eef1f3"), roughness: 0.35, metalness: 0.0 }),
    tail: standard({ color: hex("#4a1519"), roughness: 0.24, metalness: 0.1 }),
    amber: standard({ color: hex("#7a4a14"), roughness: 0.24, metalness: 0.1 }),
    spring: standard({ color: hex("#a3a8ac"), roughness: 0.36, metalness: 0.85 }),
    radiator: standard({ color: hex("#1d1f21"), roughness: 0.62, metalness: 0.45, bumpMap: grain, bumpScale: 0.8 }),
    decal: standard({ color: hex("#d9dcdc"), roughness: 0.45, metalness: 0.05 }),
  };
  return Object.assign(materials, { textures });
}

export function disposeMaterials(materials: Materials) {
  for (const key of MATERIAL_KEYS) materials[key].dispose();
  for (const texture of materials.textures) texture.dispose();
}

// --- Flagged systems and the phantom body ---------------------------------------

// A flagged system's parts: one flat, clear colour, opaque, never
// emissive, with only a whisper of shading (a smooth, narrow ramp: enough
// to show the part's form, never banded into contour lines on its facets).
// Pulled a hair towards the camera, so it wins where it touches the frame.
const TONES = new Uint8Array([196, 226, 255]);
let toneRamp: THREE.DataTexture | null = null;
function tones() {
  if (!toneRamp) {
    toneRamp = new THREE.DataTexture(TONES, TONES.length, 1, THREE.RedFormat);
    toneRamp.minFilter = toneRamp.magFilter = THREE.LinearFilter;
    toneRamp.generateMipmaps = false;
    toneRamp.needsUpdate = true;
  }
  return toneRamp;
}

export function flagMaterial(colour: string) {
  const material = new THREE.MeshToonMaterial({ color: hex(colour), gradientMap: tones() });
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -2;
  return material;
}

// In phantom view, a flagged part's x-ray: where something is in front of
// it (a seat, the engine, a tyre), it still shows, see-through over that,
// so the part the callout points at is always there to see.
export function xrayMaterial(colour: string) {
  return new THREE.MeshBasicMaterial({ color: hex(colour), transparent: true, opacity: 0.6, depthWrite: false, depthFunc: THREE.GreaterDepth, toneMapped: false });
}

// The body in phantom view: its own paint, see-through, drawn once over
// what's behind it (a depth pass first, so overlapping panels don't stack)
// and not over a flagged part (the stencil those parts leave), which shows
// clear and opaque inside.
export function phantomOf(material: THREE.Material, opacity: number) {
  const source = material as THREE.MeshStandardMaterial;
  const ghost = source.clone();
  ghost.transparent = true;
  ghost.opacity = source.transparent ? Math.min(source.opacity, opacity * 0.6) : opacity;
  ghost.depthWrite = false;
  ghost.depthFunc = THREE.LessEqualDepth;
  ghost.side = THREE.FrontSide;
  ghost.stencilWrite = true;
  ghost.stencilRef = STENCIL_FLAGGED;
  ghost.stencilFunc = THREE.NotEqualStencilFunc;
  ghost.stencilWriteMask = 0;
  ghost.stencilZPass = THREE.KeepStencilOp;
  return ghost;
}

// Only depth (the phantom body's first pass).
export function depthOnlyMaterial() {
  return new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
}

export const STENCIL_FLAGGED = 1;

// Every opaque part leaves its mark in the stencil where it's the nearest
// surface: 1 for a flagged part, 0 for any other.
export function markStencil(material: THREE.Material, flagged: boolean) {
  material.stencilWrite = true;
  material.stencilRef = flagged ? STENCIL_FLAGGED : 0;
  material.stencilFunc = THREE.AlwaysStencilFunc;
  material.stencilZPass = THREE.ReplaceStencilOp;
  material.stencilWriteMask = 0xff;
}
