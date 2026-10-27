import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import type { CauseSystem, DrawnSystem, ZoneState } from "@/lib/diagnose-zones";
import type { UnitSpec } from "@/lib/unit-vehicle";

import { buildUnit, type BuiltUnit } from "./build";
import type { Group } from "./geo";
import { EdgeLines, type LineClass } from "./edges";
import { anchorAt, worldBounds, type Layout } from "./layout";
import { LINE_COLOURS, isLit, phantomPaint, zoneLook, type ViewMode, type ZoneLook } from "./look";
import { depthOnlyMaterial, disposeMaterials, flagMaterial, makeMaterials, markStencil, phantomOf, xrayMaterial, type Materials } from "./materials";
import { contactShadow, disposeShadow } from "./shadow";

// The 3D unit on screen, rendered like a manufacturer's studio shot with a
// technical illustration's line-work: soft key, fill and rim lights and a
// studio environment, the unit in its own satin paint, a soft contact
// shadow on a plain backdrop (the page's, behind a clear canvas), and fine
// edge lines of one weight over it all (edges.ts). In phantom view the body
// keeps its paint but turns see-through, and the flagged parts inside are
// drawn solid in flat colours with a dark outline (look.ts). It draws only
// when something changed (a new view, a resize, a camera move) or while
// the camera moves (a flight, the controls settling); nothing pulses, and
// nothing is drawn while hidden. Loaded only on the Diagnose conversation
// page (a dynamic import).

export type ViewPreset = "three_quarter" | "front" | "rear" | "left" | "right" | "top";

export const VIEW_PRESETS: { preset: ViewPreset; label: string }[] = [
  { preset: "front", label: "Front" },
  { preset: "rear", label: "Rear" },
  { preset: "left", label: "Left" },
  { preset: "right", label: "Right" },
  { preset: "top", label: "Top" },
];

// Where the camera looks from (three.js's axes: x the machine's front, y
// up, -z its left). The usual studio three-quarter view is from the front
// left: the driver's side, where the drive clutch is. Left and right are
// the machine's own, as a manual's side views are (from the left, the front
// points left).
export const DIRECTIONS: Record<ViewPreset, THREE.Vector3> = {
  three_quarter: new THREE.Vector3(1, 0.28, -0.9),
  front: new THREE.Vector3(1, 0.14, 0.0001),
  rear: new THREE.Vector3(-1, 0.16, 0.0001),
  left: new THREE.Vector3(0.0001, 0.1, -1),
  right: new THREE.Vector3(0.0001, 0.1, 1),
  // Not straight down: at the pole the controls can't settle (see tick).
  // Tipped a hair to the left side, so the front points left as it does in
  // the Left view.
  top: new THREE.Vector3(0.0001, 1, -0.1),
};

// Where each system's callout points, in CSS pixels of the canvas.
export type ProjectedFrame = {
  width: number;
  height: number;
  points: Map<DrawnSystem, { x: number; y: number; behind: boolean }>;
  // The machine's outline on screen.
  box: { x: number; y: number; w: number; h: number };
};

export type ViewerOptions = {
  reducedMotion: boolean;
  // Called after a render whose camera or size changed.
  onFrame?: (frame: ProjectedFrame) => void;
  // The WebGL context was lost (a backgrounded tab, the GPU short of
  // memory): show something else until it's back.
  onLost?: () => void;
  // The browser gave the context back: everything drawn on the GPU (the
  // studio light, the shadow) is gone, so the page builds the unit again.
  onRestored?: () => void;
};

// Let the browser breathe between the steps of building a unit (taps and
// scrolls get through instead of waiting for one long task).
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// How a system is drawn now (for the page's checks: no glow anywhere).
export type LookReport = { system: DrawnSystem; fill: string | null; outline: string | null; emissive: number; opaque: boolean };

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);


// three.js needs WebGL 2.
export function webglAvailable() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    const ok = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

// The most pixels the canvas draws (a tablet's full screen at its pixel
// ratio would be up to twice this): GPU memory for the canvas (its
// multisampled buffers) and the edge lines' target stays modest.
const MAX_PIXELS = 2_400_000;

type Part = { group: Group; key: string; base: THREE.Material; mesh: THREE.Mesh; depth: THREE.Mesh | null; xray: THREE.Mesh | null };

const QUIET_GREY = "#a9afb5";


export class UnitViewer {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(22, 1, 0.05, 200);
  private controls: OrbitControls | null = null;
  private envTarget: THREE.WebGLRenderTarget;
  private unit: BuiltUnit | null = null;
  private materials: Materials | null = null;
  private parts: Part[] = [];
  private shadow: THREE.Group | null = null;
  private edges: EdgeLines | null = null;
  private looks = new Map<DrawnSystem, { state: ZoneState | null; look: ZoneLook }>();
  private flagMaterials = new Map<string, THREE.Material>();
  private xrayMaterials = new Map<string, THREE.Material>();
  private phantoms = new Map<THREE.Material, THREE.Material>();
  private quiet = new Map<THREE.Material, THREE.Material>();
  private depthMaterial = depthOnlyMaterial();
  private mode: ViewMode = "solid";
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private frameNeeded = false;
  private raf = 0;
  private visible = true;
  private flight: { from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; start: number; ms: number } | null = null;
  private target = new THREE.Vector3();
  private cameraKey = "";
  private fitMargin = { x: 0.88, y: 0.66 };
  // The last view asked for (a preset or a system), until the tech moves
  // the camera: shown again when the canvas changes size (a sheet opening
  // under it, a phone turned), so the machine isn't left cropped.
  private lastView: { preset: ViewPreset } | { system: DrawnSystem } | null = null;
  // How far back the whole machine needs the camera (the controls may go
  // further, never less: a tall, narrow phone screen needs it far back).
  private frameDistance = 0;
  private disposed = false;
  private frames = 0;
  private readonly options: ViewerOptions;

  constructor(options: ViewerOptions) {
    this.options = options;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "block size-full select-none outline-none";
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, stencil: true, powerPreference: "low-power" });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTarget = pmrem.fromScene(room, 0.04);
    room.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose?.();
    });
    pmrem.dispose();
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.38;
    // A studio's lights: a soft key from the front left (the side the
    // camera is on) and above, a cooler fill from the other side, a rim
    // from behind.
    // Measured so the paint reads as its own colour on the panels facing
    // the camera (not lifted to a pale tint on the tops).
    const hemi = new THREE.HemisphereLight(0xffffff, 0x50555a, 0.22);
    const key = new THREE.DirectionalLight(0xfffaf2, 2.05);
    key.position.set(4, 4.2, -6.5);
    const fill = new THREE.DirectionalLight(0xe4ecf5, 0.55);
    fill.position.set(-1.5, 3, 6);
    const rim = new THREE.DirectionalLight(0xffffff, 0.85);
    rim.position.set(-6.5, 4.5, -1.5);
    this.scene.add(hemi, key, fill, rim);
    this.canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored, false);
  }

  private lost = false;

  private onContextLost = (event: Event) => {
    // Asks the browser to give the context back when it can.
    event.preventDefault();
    this.lost = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.options.onLost?.();
  };

  private onContextRestored = () => {
    this.lost = false;
    // What it had on the GPU went with the old context: the page builds a
    // new viewer, and this one is only thrown away (see dispose).
    this.stale = true;
    this.options.onRestored?.();
  };
  private stale = false;

  setReducedMotion(on: boolean) {
    this.options.reducedMotion = on;
    if (this.controls) this.controls.enableDamping = !on;
    if (on && this.flight) {
      const { to, toTarget } = this.flight;
      this.flight = null;
      this.moveCamera(to, toTarget, false);
    }
  }

  // --- The machine ----------------------------------------------------------------

  setUnit(spec: UnitSpec) {
    this.clearUnit();
    this.materials = makeMaterials(spec.paint);
    this.unit = buildUnit(spec, this.materials);
    this.finishUnit();
  }

  // The same, a step at a time, the browser free between steps, and the
  // shaders compiled before the first frame (in parallel where the GPU
  // driver can): no seconds-long freeze while a tablet builds it.
  async load(spec: UnitSpec, cancelled: () => boolean = () => false) {
    this.clearUnit();
    await breathe();
    if (cancelled() || this.disposed) return false;
    this.materials = makeMaterials(spec.paint);
    await breathe();
    if (cancelled() || this.disposed) return false;
    this.unit = buildUnit(spec, this.materials);
    await breathe();
    if (cancelled() || this.disposed) return false;
    this.finishUnit();
    await breathe();
    if (cancelled() || this.disposed) return false;
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      // Compiled on the first frame instead.
    }
    return !cancelled() && !this.disposed;
  }

  private finishUnit() {
    if (!this.unit) return;
    this.scene.add(this.unit.root);
    this.parts = this.unit.meshes.map(({ group, material: key, mesh }) => {
      const base = mesh.material as THREE.Material;
      let depth: THREE.Mesh | null = null;
      if (group === "shell") {
        // The phantom body's depth pass (its own mesh on the same shape).
        depth = new THREE.Mesh(mesh.geometry, this.depthMaterial);
        depth.renderOrder = 10;
        depth.visible = false;
        this.unit!.root.add(depth);
      } else markStencil(base, false);
      return { group, key, base, mesh, depth, xray: null };
    });
    this.depthMaterial.polygonOffset = true;
    this.depthMaterial.polygonOffsetFactor = 1;
    this.depthMaterial.polygonOffsetUnits = 1;
    this.edges = new EdgeLines(
      this.unit.meshes.map(({ group, mesh }) => ({ mesh, shell: group === "shell" })),
      this.unit.layout.scale,
    );
    this.edges.resize(this.width, this.height, this.pixelRatio);
    this.shadow = contactShadow(this.renderer, this.unit.root);
    this.scene.add(this.shadow);
    this.looks.clear();
    this.applyLooks();
    this.setView("three_quarter", false);
  }

  get layout(): Layout | null {
    return this.unit?.layout ?? null;
  }

  get triangles() {
    return this.unit?.triangles ?? 0;
  }

  private clearUnit() {
    if (this.unit) {
      this.scene.remove(this.unit.root);
      this.unit.dispose();
      this.unit = null;
    }
    this.parts = [];
    this.edges?.dispose();
    this.edges = null;
    if (this.shadow) {
      this.scene.remove(this.shadow);
      disposeShadow(this.shadow);
      this.shadow = null;
    }
    for (const material of [...this.phantoms.values(), ...this.quiet.values()]) material.dispose();
    this.phantoms.clear();
    this.quiet.clear();
    if (this.materials) disposeMaterials(this.materials);
    this.materials = null;
  }

  // --- Systems with causes ----------------------------------------------------------

  // The systems' states (from zoneStates), the one picked, and the view.
  setStates(states: ZoneState[], active: CauseSystem | null, mode: ViewMode) {
    if (!this.unit) return;
    this.mode = mode;
    const byZone = new Map(states.filter((s) => s.system !== "other").map((s) => [s.system as DrawnSystem, s]));
    this.looks.clear();
    for (const zone of this.unit.byZone.keys()) {
      const state = byZone.get(zone) ?? null;
      this.looks.set(zone, { state, look: zoneLook(state, { active: active === zone }) });
    }
    this.applyLooks();
    this.requestRender();
  }

  private flagMaterial(colour: string) {
    let material = this.flagMaterials.get(colour);
    if (!material) {
      material = flagMaterial(colour);
      markStencil(material, true);
      this.flagMaterials.set(colour, material);
    }
    return material;
  }

  // In phantom view the parts inside that aren't flagged step back to
  // light neutral greys (tyres stay dark), so the flagged ones read first.
  private quietOf(material: THREE.Material, key: string) {
    if (key === "rubber" || key === "glass") return material;
    let quiet = this.quiet.get(material);
    if (!quiet) {
      const source = material as THREE.MeshStandardMaterial;
      const q = source.clone();
      q.map = null;
      q.bumpMap = null;
      q.color = source.color.clone().lerp(new THREE.Color(QUIET_GREY), 0.72);
      q.metalness = Math.min(source.metalness, 0.25);
      q.roughness = Math.max(source.roughness, 0.55);
      quiet = q;
      this.quiet.set(material, quiet);
    }
    return quiet;
  }

  // The body in phantom view: its paint see-through (greyer if it's red,
  // more solid if it's dark; see phantomPaint), the rest at the same
  // opacity.
  private phantom(material: THREE.Material, key: string) {
    let ghost = this.phantoms.get(material);
    if (!ghost) {
      const source = material as THREE.MeshStandardMaterial;
      const paint = phantomPaint(`#${source.color.getHexString(THREE.SRGBColorSpace)}`, { camo: !!source.map });
      const painted = key === "paint" || key === "accent";
      ghost = phantomOf(material, painted ? paint.opacity : 0.3);
      if (painted && !source.map) (ghost as THREE.MeshStandardMaterial).color.set(paint.colour);
      this.phantoms.set(material, ghost);
    }
    return ghost;
  }

  private xrayMaterial(colour: string) {
    let material = this.xrayMaterials.get(colour);
    if (!material) {
      material = xrayMaterial(colour);
      this.xrayMaterials.set(colour, material);
    }
    return material;
  }

  private applyLooks() {
    if (!this.unit || !this.edges) return;
    const phantom = this.mode === "phantom";
    const classes: LineClass[] = [];
    for (const part of this.parts) {
      if (part.group === "shell") {
        part.mesh.material = phantom ? this.phantom(part.base, part.key) : part.base;
        part.mesh.renderOrder = phantom ? 11 : 0;
        if (part.depth) part.depth.visible = phantom && !(part.base as THREE.Material).transparent;
        classes.push({ colour: LINE_COLOURS.edge, alpha: phantom ? 0.5 : 0.8, weight: 1 });
        continue;
      }
      const entry = this.looks.get(part.group as DrawnSystem) ?? null;
      const look = entry?.look ?? null;
      const rubber = part.key === "rubber";
      // A flagged tyre stays rubber, outlined in the flag's colour round its
      // silhouette (not round every tread block); its rim takes the fill. A
      // solid bright tyre would shout over the parts inside it.
      const fill = look?.fill && !rubber ? look.fill : null;
      part.mesh.material = fill ? this.flagMaterial(fill) : phantom ? this.quietOf(part.base, part.key) : part.base;
      // In phantom view a lit system (not one set aside) shows through what
      // is in front of it.
      const xray = phantom && !!entry?.state && isLit(entry.state.glow) && !entry.state.muted && !!look?.outline;
      if (xray && fill && !rubber) {
        if (!part.xray) {
          part.xray = new THREE.Mesh(part.mesh.geometry, this.xrayMaterial(fill));
          part.xray.renderOrder = 20;
          this.unit.root.add(part.xray);
        }
        part.xray.material = this.xrayMaterial(fill);
        part.xray.visible = true;
      } else if (part.xray) part.xray.visible = false;
      classes.push(
        look?.outline
          ? { colour: rubber && look.fill ? look.fill : look.outline.colour, alpha: 1, weight: look.outline.weight, creases: rubber ? "none" : fill ? "sharp" : "all", xray }
          : { colour: LINE_COLOURS.edge, alpha: phantom ? 0.42 : 0.8, weight: 1 },
      );
    }
    this.edges.setClasses(classes);
  }

  // How each system is drawn, for the page's checks.
  report(): { mode: ViewMode; looks: LookReport[]; emissive: number } {
    const looks: LookReport[] = [];
    for (const [system, { state, look }] of this.looks) {
      if (!state) continue;
      const materials = this.parts.filter((part) => part.group === system).map((part) => part.mesh.material as THREE.MeshStandardMaterial);
      looks.push({
        system,
        fill: look.fill,
        outline: look.outline?.colour ?? null,
        emissive: Math.max(0, ...materials.map((m) => (m.emissive ? m.emissive.r + m.emissive.g + m.emissive.b : 0) * (m.emissiveIntensity ?? 0))),
        opaque: materials.every((m) => !m.transparent && m.opacity === 1),
      });
    }
    // Every material on screen that gives off light (there should be none).
    const all = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) all.add(m);
    });
    const emissive = [...all].filter((m) => {
      const s = m as THREE.MeshStandardMaterial;
      return s.emissive && s.emissiveIntensity > 0 && s.emissive.getHex() !== 0;
    }).length;
    return { mode: this.mode, looks, emissive };
  }

  // The canvas's and the edge lines' sizes in pixels (the page's checks
  // read them: within the budget on any screen).
  get pixels() {
    return { canvas: this.canvas.width * this.canvas.height, lines: this.edges?.targetPixels ?? 0 };
  }

  // --- Camera -------------------------------------------------------------------------

  // The space the machine fills, as a share of the canvas (the rest is for
  // the callouts above and below).
  setFit(x: number, y: number) {
    this.fitMargin = { x, y };
  }

  // The view asked for, framed again for the canvas's new shape (or a new
  // fit); a flight on its way there is steered to the new place.
  reframe() {
    const last = this.lastView;
    if (!last || !this.unit) return;
    const view = "preset" in last ? this.presetCamera(last.preset) : this.systemCamera(last.system);
    if (!view) return;
    if (this.flight) {
      this.flight.to = view.position;
      this.flight.toTarget = view.target;
    } else this.moveCamera(view.position, view.target, false);
  }

  private bounds() {
    const { min, max } = worldBounds(this.unit!.layout);
    return new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
  }

  // Where the camera goes to see the whole machine from a direction.
  private framing(direction: THREE.Vector3) {
    const box = this.bounds();
    const center = box.getCenter(new THREE.Vector3());
    center.y *= 0.86;
    const dir = direction.clone().normalize();
    const corners: THREE.Vector3[] = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    let distance = box.getSize(new THREE.Vector3()).length() * 1.4;
    const camera = this.camera.clone();
    for (let i = 0; i < 10; i++) {
      camera.position.copy(center).addScaledVector(dir, distance);
      camera.lookAt(center);
      camera.updateMatrixWorld();
      let need = 0;
      for (const corner of corners) {
        const p = corner.clone().project(camera);
        need = Math.max(need, Math.abs(p.x) / this.fitMargin.x, Math.abs(p.y) / this.fitMargin.y);
      }
      distance *= 0.35 + 0.65 * need;
    }
    return { position: center.clone().addScaledVector(dir, distance), target: center };
  }

  setView(preset: ViewPreset, animate = true) {
    if (!this.unit) return;
    const { position, target } = this.presetCamera(preset);
    this.lastView = { preset };
    this.moveCamera(position, target, animate);
  }

  private presetCamera(preset: ViewPreset) {
    const view = this.framing(DIRECTIONS[preset]);
    this.frameDistance = view.position.distanceTo(view.target);
    if (this.controls) this.controls.maxDistance = this.maxDistance();
    return view;
  }

  private maxDistance() {
    const size = this.unit ? this.bounds().getSize(new THREE.Vector3()).length() : 4;
    return Math.max(size * 3, this.frameDistance * 1.6);
  }

  // Close in on a system's parts, from where they're seen best: a few
  // views round the part (its side, three-quarter front and rear, from
  // above, the far side) are tried, rays cast from each to points on the
  // part, and the one least in the way of the rest of the machine (cage
  // tubes, a tyre, a seat; the see-through body doesn't count in phantom
  // view) wins, ties going to the side the camera is already on. Framed on
  // the part's own size with the machine round it.
  flyTo(system: DrawnSystem, animate = true) {
    const view = this.systemCamera(system);
    if (!view) return;
    this.lastView = { system };
    this.moveCamera(view.position, view.target, animate);
  }

  private systemCamera(system: DrawnSystem): { position: THREE.Vector3; target: THREE.Vector3 } | null {
    if (!this.unit) return null;
    const anchor = anchorAt(this.unit.layout, system);
    if (!anchor) return null;
    const target = new THREE.Vector3(...anchor);
    const box = this.bounds();
    const size = box.getSize(new THREE.Vector3()).length();
    const centre = box.getCenter(new THREE.Vector3());
    const own = this.unit.byZone.get(system) ?? [];
    const partBox = new THREE.Box3();
    for (const mesh of own) {
      mesh.geometry.computeBoundingBox();
      partBox.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
    }
    // Round the callout's point: a system's hoses or harness can run the
    // machine's length, but the view is of the part there.
    const near = new THREE.Box3().setFromCenterAndSize(target, new THREE.Vector3(0.9, 0.9, 0.9));
    if (partBox.isEmpty() || !partBox.intersectsBox(near)) partBox.setFromCenterAndSize(target, new THREE.Vector3(0.3, 0.3, 0.3));
    else partBox.intersect(near);
    // Close enough to see the part, far enough to keep the machine round it
    // (on a narrow, portrait screen further still).
    const radius = partBox.getSize(new THREE.Vector3()).length() / 2;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const portrait = this.width < this.height ? Math.min(2, this.height / this.width) : 1;
    const distance = Math.max(size * 1.3, (radius / Math.sin(fov / 2)) * 2.4) * portrait;
    const side = Math.abs(target.z - centre.z) > size * 0.04 ? Math.sign(target.z - centre.z) : -1;
    const end = Math.abs(target.x - centre.x) > size * 0.08 ? Math.sign(target.x - centre.x) : 1;
    const candidates = [
      new THREE.Vector3(0.75 * end, 0.45, 0.75 * side),
      new THREE.Vector3(0.05, 0.4, side),
      new THREE.Vector3(-0.75 * end, 0.45, 0.75 * side),
      new THREE.Vector3(0.35 * end, 1, 0.35 * side),
      new THREE.Vector3(end, 0.4, 0.15 * side),
      new THREE.Vector3(0.6 * end, 0.45, -0.75 * side),
    ].map((v) => v.normalize());
    const current = this.camera.position.clone().sub(this.target).normalize();
    const blockers = this.occluders(system);
    const samples = [partBox.getCenter(new THREE.Vector3()), target];
    for (const corner of [partBox.min, partBox.max]) {
      for (const k of [0.3, 0.7]) samples.push(partBox.getCenter(new THREE.Vector3()).lerp(corner, k));
    }
    const ray = new THREE.Raycaster();
    let best = { score: Infinity, dir: candidates[0] };
    for (const dir of candidates) {
      const from = target.clone().addScaledVector(dir, distance);
      let blocked = 0;
      for (const point of samples) {
        const toward = point.clone().sub(from);
        const length = toward.length();
        ray.set(from, toward.normalize());
        ray.far = length - 0.02;
        if (ray.intersectObjects(blockers, false).length > 0) blocked++;
      }
      // Least in the way, then nearest the side already looked from; from
      // above only when it's clearly better (a plan view says less about
      // where a part sits).
      const score = blocked / samples.length - dir.dot(current) * 0.08 + (dir.y > 0.8 ? 0.2 : 0);
      if (score < best.score) best = { score, dir };
    }
    return { position: target.clone().addScaledVector(best.dir, distance), target };
  }

  // What can be in the way of a system's parts: everything else, but the
  // see-through body in phantom view.
  private occluders(system: DrawnSystem) {
    return this.parts.filter((part) => part.group !== system && !(part.group === "shell" && this.mode === "phantom")).map((part) => part.mesh);
  }

  private moveCamera(position: THREE.Vector3, target: THREE.Vector3, animate: boolean) {
    if (!animate || this.options.reducedMotion) {
      this.flight = null;
      this.camera.position.copy(position);
      this.target.copy(target);
      this.camera.lookAt(this.target);
      if (this.controls) {
        this.controls.target.copy(this.target);
        this.controls.update();
      }
      this.requestRender();
      return;
    }
    this.flight = { from: this.camera.position.clone(), to: position, fromTarget: this.target.clone(), toTarget: target, start: performance.now(), ms: 650 };
    this.requestRender();
  }

  // Orbit (drag), zoom (pinch, wheel), pan (two fingers, right drag), for
  // the examine view; off for the still view on the diagnosis screen.
  setControls(on: boolean) {
    if (on && !this.controls) {
      const controls = new OrbitControls(this.camera, this.canvas);
      controls.enableDamping = !this.options.reducedMotion;
      controls.dampingFactor = 0.12;
      controls.screenSpacePanning = true;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.minPolarAngle = 0.08;
      const size = this.unit ? this.bounds().getSize(new THREE.Vector3()).length() : 4;
      controls.minDistance = size * 0.18;
      controls.maxDistance = this.maxDistance();
      controls.target.copy(this.target);
      controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      controls.addEventListener("change", () => {
        this.target.copy(controls.target);
        this.requestRender();
      });
      controls.addEventListener("start", () => {
        this.flight = null;
        this.lastView = null;
      });
      this.controls = controls;
    } else if (!on && this.controls) {
      this.controls.dispose();
      this.controls = null;
    }
  }

  // Keyboard and button moves in the examine view.
  orbit(dTheta: number, dPhi: number) {
    this.lastView = null;
    const offset = this.camera.position.clone().sub(this.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += dTheta;
    spherical.phi = Math.min(Math.max(spherical.phi + dPhi, 0.08), Math.PI * 0.49);
    offset.setFromSpherical(spherical);
    this.moveCamera(this.target.clone().add(offset), this.target.clone(), false);
  }

  zoom(factor: number) {
    this.lastView = null;
    const offset = this.camera.position.clone().sub(this.target);
    const size = this.unit ? this.bounds().getSize(new THREE.Vector3()).length() : 4;
    const length = Math.min(Math.max(offset.length() * factor, size * 0.18), this.maxDistance());
    offset.setLength(length);
    this.moveCamera(this.target.clone().add(offset), this.target.clone(), false);
  }

  pan(dx: number, dy: number) {
    this.lastView = null;
    const offset = this.camera.position.clone().sub(this.target);
    const right = new THREE.Vector3().crossVectors(this.camera.up, offset).normalize();
    const up = new THREE.Vector3().crossVectors(offset, right).normalize();
    const step = offset.length() * 0.08;
    const move = right.multiplyScalar(-dx * step).add(up.multiplyScalar(dy * step));
    this.moveCamera(this.camera.position.clone().add(move), this.target.clone().add(move), false);
  }

  // The camera as a short string, for tests (e2e reads it to see a drag
  // moved it) and to know when callouts must move.
  get cameraState() {
    const p = this.camera.position;
    return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}|${this.camera.position.distanceTo(this.target).toFixed(3)}`;
  }

  // --- Size, visibility, drawing ----------------------------------------------------------

  resize(width: number, height: number, pixelRatio: number) {
    if (width < 2 || height < 2) return;
    this.width = width;
    this.height = height;
    this.pixelRatio = Math.min(pixelRatio, Math.sqrt(MAX_PIXELS / (width * height)));
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.edges?.resize(width, height, this.pixelRatio);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.cameraKey = "";
    this.reframe();
    this.requestRender();
  }

  // Stop drawing while off screen or in a hidden tab.
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else this.requestRender();
  }

  requestRender() {
    this.frameNeeded = true;
    if (!this.raf && this.visible && !this.disposed && !this.lost) this.raf = requestAnimationFrame(this.tick);
  }

  private draw() {
    this.renderer.render(this.scene, this.camera);
    if (!this.edges) return;
    if (this.mode === "phantom") {
      // The parts inside (seen through the body), then the body's own.
      this.edges.render(this.renderer, this.camera, "interior", 0.6);
      this.edges.render(this.renderer, this.camera, "shell", 0.8);
    } else this.edges.render(this.renderer, this.camera, "all", 1);
  }

  private tick = (now: number) => {
    this.raf = 0;
    // Nothing is drawn (or reported) before the canvas has a size: a frame
    // of the 1 x 1 canvas would put every callout in one heap off the
    // plate until the next frame. resize() asks for the first frame.
    if (this.disposed || !this.visible || this.lost || this.width < 2 || this.height < 2) return;
    let moving = false;
    if (this.flight) {
      const t = Math.min(1, (now - this.flight.start) / this.flight.ms);
      const k = easeInOut(t);
      this.camera.position.lerpVectors(this.flight.from, this.flight.to, k);
      this.target.lerpVectors(this.flight.fromTarget, this.flight.toTarget, k);
      this.camera.lookAt(this.target);
      if (this.controls) this.controls.target.copy(this.target);
      if (t >= 1) this.flight = null;
      moving = true;
    } else if (this.controls) {
      // Damping keeps the camera moving a moment after a drag; it has
      // stopped once the camera no longer visibly moves (the controls can
      // report tiny changes for ever near a pole, which would draw every
      // frame).
      const before = this.cameraState;
      moving = this.controls.update() && this.cameraState !== before;
    }
    if (this.frameNeeded || moving) {
      this.frameNeeded = false;
      this.draw();
      // How many frames it has drawn (the browser checks read it to see it
      // stops when nothing moves).
      this.canvas.dataset.frames = String(++this.frames);
      const key = `${this.cameraState}|${this.width}x${this.height}`;
      if (key !== this.cameraKey) {
        this.cameraKey = key;
        this.options.onFrame?.(this.project());
      }
    }
    if (moving || this.frameNeeded) this.raf = requestAnimationFrame(this.tick);
  };

  // Every system's callout point on screen.
  project(): ProjectedFrame {
    const points = new Map<DrawnSystem, { x: number; y: number; behind: boolean }>();
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    this.camera.updateMatrixWorld();
    const toScreen = (v: THREE.Vector3) => {
      const p = v.clone().project(this.camera);
      return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height, behind: p.z > 1 };
    };
    if (this.unit) {
      for (const zone of this.unit.byZone.keys()) {
        const anchor = anchorAt(this.unit.layout, zone);
        if (anchor) points.set(zone, toScreen(new THREE.Vector3(...anchor)));
      }
      const b = this.bounds();
      for (const x of [b.min.x, b.max.x]) {
        for (const y of [b.min.y, b.max.y]) {
          for (const z of [b.min.z, b.max.z]) {
            const p = toScreen(new THREE.Vector3(x, y, z));
            box.minX = Math.min(box.minX, p.x);
            box.maxX = Math.max(box.maxX, p.x);
            box.minY = Math.min(box.minY, p.y);
            box.maxY = Math.max(box.maxY, p.y);
          }
        }
      }
    }
    return { width: this.width, height: this.height, points, box: { x: box.minX, y: box.minY, w: box.maxX - box.minX, h: box.maxY - box.minY } };
  }

  // The system under a point on the canvas (CSS pixels): the part the tech
  // sees there. In phantom view a flagged part is drawn through what's in
  // front of it (a seat, the engine, a tyre), so it's that one, not the
  // nearer part it shows through; else the nearest part of any system (the
  // wheels a wheels/tires flag doesn't point at count as wheels/tires). The
  // body's panels aren't a system: a tap goes through them to the part
  // behind. With slack (a finger, a glove), a flagged part that close to
  // the point is the one tapped, and a tap just off the machine still finds
  // the part nearest it.
  pick(x: number, y: number, slack = 0): DrawnSystem | null {
    if (!this.unit || this.width < 1 || this.height < 1) return null;
    const meshes = this.unit.meshes.filter(({ group }) => group !== "shell").map(({ mesh }) => mesh);
    const ray = new THREE.Raycaster();
    const hitsAt = (px: number, py: number) => {
      ray.setFromCamera(new THREE.Vector2((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1), this.camera);
      return ray.intersectObjects(meshes, false).map((hit) => hit.object.userData.group as DrawnSystem | "running");
    };
    // What's seen flagged along a ray: in phantom view any flagged part on
    // it (drawn over the rest), in solid view the nearest part if flagged.
    const flaggedOn = (groups: (DrawnSystem | "running")[]) =>
      (this.mode === "phantom" ? groups : groups.slice(0, 1)).find((group): group is DrawnSystem => group !== "running" && this.flagged(group)) ?? null;
    const system = (group: DrawnSystem | "running" | undefined) => (group === "running" ? "wheels_tires" : (group ?? null));
    const centre = hitsAt(x, y);
    const seen = flaggedOn(centre);
    if (seen || slack <= 0) return seen ?? system(centre[0]);
    const around = [
      [slack, 0],
      [-slack, 0],
      [0, slack],
      [0, -slack],
    ].map(([dx, dy]) => hitsAt(x + dx, y + dy));
    for (const groups of around) {
      const near = flaggedOn(groups);
      if (near) return near;
    }
    return system(centre[0] ?? around.find((groups) => groups.length > 0)?.[0]);
  }

  // Whether a system is drawn flagged: lit, not set aside, outlined in its
  // flag's colour (filled too, or only outlined for a low one), which is
  // what phantom view draws through what's in front (as applyLooks does).
  private flagged(system: DrawnSystem) {
    const entry = this.looks.get(system);
    return !!entry?.state && isLit(entry.state.glow) && !entry.state.muted && !!entry.look.outline;
  }

  // The systems lit (for tests).
  litSystems(): DrawnSystem[] {
    return [...this.looks].filter(([, entry]) => entry.state && isLit(entry.state.glow)).map(([zone]) => zone);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost, false);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored, false);
    this.setControls(false);
    // After a lost context its buffers and programs belong to a context
    // that's gone: deleting them in the restored one only fills the console
    // with WebGL errors. Lose this one for good first (calls on a lost
    // context do nothing), then let go of the rest.
    if (this.stale && !this.lost) this.renderer.forceContextLoss();
    this.clearUnit();
    for (const material of [...this.flagMaterials.values(), ...this.xrayMaterials.values()]) material.dispose();
    this.depthMaterial.dispose();
    this.envTarget.dispose();
    this.renderer.dispose();
    // Give the context back now, not when the canvas is collected: a tablet
    // only has a few.
    if (!this.lost && !this.stale) this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
