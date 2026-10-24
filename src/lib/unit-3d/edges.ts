import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

// Fine edge lines over the shaded unit, for a technical-illustration
// finish: each part's silhouette, where one part meets another, and its
// sharp creases, all in one line weight on screen (a CSS pixel), drawn
// over the shaded picture. The unit's parts are drawn a second time, into
// a small render target, as their surface direction, a part number and
// their depth; a full-screen pass finds where those change and draws the
// lines. A line takes its part's colour and strength from a table (by part
// number), so a flagged system can have a heavier dark outline, a low one a
// red one. Lines are drawn on the nearer side of an edge only, so they stay
// one line wide. On a low pixel-ratio screen (under 1.25), and only while
// the target stays within the canvas's pixel budget, the target is twice
// the size and the lines are smoothed down (supersampled); elsewhere the
// screen's own pixels are fine enough. In phantom view the parts inside and
// the body are passed separately, so both sets of lines show, and the
// flagged parts are drawn over whatever is in front of them (x-ray), so
// their outline shows whole even behind a seat or a tyre.

// creases: every fold in the part's surface gets a line ("all"), only
// sharp folds ("sharp": a flat-coloured flagged part, so its facets don't
// crackle), or none, only its outline ("none": a flagged tyre, not every
// tread block).
export type LineClass = { colour: string; alpha: number; weight: 1 | 2; creases?: "all" | "sharp" | "none"; xray?: boolean };

// The most pixels the lines' target may have (the canvas's own cap).
export const MAX_TARGET_PIXELS = 2_400_000;

const MAX_PARTS = 255;

const normalVertex = /* glsl */ `
varying vec3 vNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const normalFragment = /* glsl */ `
uniform float uId;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  gl_FragColor = vec4(n * 0.5 + 0.5, uId / 255.0);
}`;

const lineVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const lineFragment = /* glsl */ `
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform sampler2D tClass;
uniform vec2 uSize;
uniform float uStep;
uniform float uSS;
uniform float uNear;
uniform float uFar;
uniform float uCrease;
uniform float uOrtho;
varying vec2 vUv;

float lin(float d) {
  if (uOrtho > 0.5) return uNear + d * (uFar - uNear);
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}

vec4 lineAt(vec2 px) {
  vec2 uv = px / uSize;
  float d = texture2D(tDepth, uv).r;
  if (d >= 1.0) return vec4(0.0);
  vec4 c = texture2D(tNormal, uv);
  float id = floor(c.a * 255.0 + 0.5);
  vec3 n = c.rgb * 2.0 - 1.0;
  float z = lin(d);
  vec4 klass = texture2D(tClass, vec2((id + 0.5) / 256.0, 0.25));
  vec4 extra = texture2D(tClass, vec2((id + 0.5) / 256.0, 0.75));
  float weight = extra.r * 255.0;
  // 1 every fold, 0.5 only sharp ones, 0 none.
  float creaseMode = extra.g;
  float e = 0.0;
  float crease = 0.0;
  for (int ring = 1; ring <= 2; ring++) {
    if (ring == 2 && weight < 1.5) break;
    float s = uStep * float(ring);
    for (int k = 0; k < 4; k++) {
      vec2 o = k == 0 ? vec2(s, 0.0) : k == 1 ? vec2(-s, 0.0) : k == 2 ? vec2(0.0, s) : vec2(0.0, -s);
      vec2 quv = (px + o) / uSize;
      float dq = texture2D(tDepth, quv).r;
      vec4 q = texture2D(tNormal, quv);
      float zq = dq >= 1.0 ? 1.0e5 : lin(dq);
      float jump = (zq - z) / max(z, 1.0e-4);
      // The silhouette, on this (the nearer) side.
      e = max(e, smoothstep(0.012, 0.035, jump));
      // Where this part meets another: drawn by the nearer one, or (level)
      // by the higher number.
      float idq = floor(q.a * 255.0 + 0.5);
      if (dq < 1.0 && idq != id && (jump > 0.0012 || (abs(jump) <= 0.0012 && id > idq))) e = 1.0;
      // A sharp crease in the part's own surface (one side only).
      if (ring == 1 && (k == 0 || k == 2) && dq < 1.0 && idq == id && abs(jump) < 0.02) {
        vec3 nq = q.rgb * 2.0 - 1.0;
        float d = dot(n, nq);
        crease = max(crease, creaseMode > 0.75 ? smoothstep(0.78, 0.55, d) : creaseMode > 0.25 ? smoothstep(0.4, 0.2, d) : 0.0);
      }
    }
  }
  return vec4(klass.rgb, max(e, crease * uCrease) * klass.a);
}

void main() {
  vec2 base = floor(vUv * uSize / uSS) * uSS;
  vec4 sum = vec4(0.0);
  float alpha = 0.0;
  for (int i = 0; i < 2; i++) {
    for (int j = 0; j < 2; j++) {
      if ((i > 0 || j > 0) && uSS < 1.5) continue;
      vec4 l = lineAt(base + vec2(float(i), float(j)) + 0.5);
      sum.rgb += l.rgb * l.a;
      alpha += l.a;
    }
  }
  float samples = uSS < 1.5 ? 1.0 : 4.0;
  float a = alpha / samples;
  if (a <= 0.002) discard;
  gl_FragColor = vec4(sum.rgb / max(alpha, 1.0e-4), a);
}`;

// Twice the size (four times the pixels) only on a low pixel-ratio screen
// and within the budget: a 1280 x 800 tablet at 1.5 draws its lines at its
// own resolution, not at 3840 x 2400.
export function supersampling(width: number, height: number, pixelRatio: number): 1 | 2 {
  return pixelRatio < 1.25 && width * height * pixelRatio * pixelRatio * 4 <= MAX_TARGET_PIXELS ? 2 : 1;
}

export class EdgeLines {
  private target: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private groups: { interior: THREE.Group; shell: THREE.Group };
  private materials: THREE.ShaderMaterial[] = [];
  private classData = new Uint8Array(256 * 2 * 4);
  private classTexture: THREE.DataTexture;
  private quad: FullScreenQuad;
  private lineMaterial: THREE.ShaderMaterial;
  private width = 1;
  private height = 1;
  private ss = 1;
  private lineWidth = 1;

  private proxies: THREE.Mesh[] = [];

  // The unit's meshes, each with its part number (from 1) and whether it's
  // part of the body (the shell).
  constructor(meshes: { mesh: THREE.Mesh; shell: boolean }[], scale: number) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.target.depthTexture!.minFilter = this.target.depthTexture!.magFilter = THREE.NearestFilter;
    const interior = new THREE.Group();
    const shell = new THREE.Group();
    for (const group of [interior, shell]) group.scale.setScalar(scale);
    this.groups = { interior, shell };
    this.scene.add(interior, shell);
    if (meshes.length > MAX_PARTS) throw new Error(`Too many parts for the edge lines: ${meshes.length}`);
    meshes.forEach(({ mesh, shell: isShell }, index) => {
      const material = new THREE.ShaderMaterial({
        uniforms: { uId: { value: index + 1 } },
        vertexShader: normalVertex,
        fragmentShader: normalFragment,
        side: (mesh.material as THREE.Material).side,
      });
      this.materials.push(material);
      const proxy = new THREE.Mesh(mesh.geometry, material);
      this.proxies.push(proxy);
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(mesh.matrix);
      (isShell ? shell : interior).add(proxy);
    });
    this.scene.updateMatrixWorld(true);
    this.classTexture = new THREE.DataTexture(this.classData, 256, 2, THREE.RGBAFormat);
    this.classTexture.minFilter = this.classTexture.magFilter = THREE.NearestFilter;
    this.classTexture.generateMipmaps = false;
    this.lineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tNormal: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        tClass: { value: this.classTexture },
        uSize: { value: new THREE.Vector2(1, 1) },
        uStep: { value: 1 },
        uSS: { value: 1 },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uCrease: { value: 1 },
        uOrtho: { value: 0 },
      },
      vertexShader: lineVertex,
      fragmentShader: lineFragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.lineMaterial);
  }

  // Each part's line: colour (sRGB), strength and weight. Part 0 is the
  // background.
  setClasses(classes: LineClass[]) {
    const colour = new THREE.Color();
    this.classData.fill(0);
    classes.forEach((line, index) => {
      const id = index + 1;
      // The lines are written to the screen as they are: sRGB bytes.
      const hex = colour.set(line.colour).getHex();
      this.classData.set([(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, Math.round(line.alpha * 255)], id * 4);
      const creases = line.creases ?? "all";
      this.classData.set([line.weight, creases === "all" ? 255 : creases === "sharp" ? 128 : 0, 0, 255], (256 + id) * 4);
      // A flagged part in phantom view is drawn last and over everything in
      // front of it, so its outline isn't hidden.
      const proxy = this.proxies[index];
      const material = this.materials[index];
      if (proxy && material) {
        proxy.renderOrder = line.xray ? 5 : 0;
        material.depthFunc = line.xray ? THREE.AlwaysDepth : THREE.LessEqualDepth;
      }
    });
    this.classTexture.needsUpdate = true;
  }

  // The canvas's drawing size, and how wide a line is in its pixels.
  resize(width: number, height: number, pixelRatio: number) {
    this.ss = supersampling(width, height, pixelRatio);
    // About 1.5 CSS pixels, in whole pixels of the target.
    this.lineWidth = Math.max(1, Math.round(1.5 * pixelRatio * this.ss)) / this.ss;
    this.width = Math.max(1, Math.round(width * pixelRatio * this.ss));
    this.height = Math.max(1, Math.round(height * pixelRatio * this.ss));
    this.target.setSize(this.width, this.height);
  }

  // The target's size in pixels (the page's checks read it: within budget).
  get targetPixels() {
    return this.width * this.height;
  }

  // Draws the lines of `which` parts over what's on the canvas.
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, which: "all" | "interior" | "shell", crease: number) {
    this.groups.interior.visible = which !== "shell";
    this.groups.shell.visible = which !== "interior";
    const clearColour = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    const toneMapping = renderer.toneMapping;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.clear(true, true, false);
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clearColour, clearAlpha);
    renderer.toneMapping = toneMapping;
    const u = this.lineMaterial.uniforms;
    u.uSize.value.set(this.width, this.height);
    u.uSS.value = this.ss;
    u.uStep.value = Math.round(this.lineWidth * this.ss);
    const cam = camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uOrtho.value = (cam as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0;
    u.uCrease.value = crease;
    renderer.autoClear = false;
    this.quad.render(renderer);
    renderer.autoClear = autoClear;
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    for (const material of this.materials) material.dispose();
    this.lineMaterial.dispose();
    this.classTexture.dispose();
    this.quad.dispose();
  }
}
