import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { HorizontalBlurShader } from "three/examples/jsm/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/examples/jsm/shaders/VerticalBlurShader.js";

// A soft contact shadow under the unit, as a studio photo has: the machine
// seen from below, each part darker the nearer it is to the ground, blurred,
// laid on the ground. Two of them: a tight, darker one where the tyres and
// skid plate meet the ground, and a wide, faint one for the whole body.
// Made once per unit (the machine doesn't move; the camera does), then it's
// a plain texture.
//
// The picture is as wide and deep as the machine's footprint (not a square
// stretched over it), and blurred in several passes, each a step wider than
// the last (1, 2, 3 ... texels): a smooth Gaussian, never the stripes and
// ghost copies of the frame rails one wide 9-tap pass leaves. Its edges
// fade out, so there's no rim where the picture ends.

const LONG_SIDE = 512;

const fadeVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fadeFragment = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
void main() {
  float a = texture2D(map, vUv).a;
  vec2 d = (vUv - 0.5) * 2.0;
  float fade = 1.0 - smoothstep(0.72, 1.0, length(d));
  gl_FragColor = vec4(0.0, 0.0, 0.0, a * fade);
}`;

function shadowPass(
  renderer: THREE.WebGLRenderer,
  unit: THREE.Object3D,
  box: THREE.Box3,
  { height, darkness, steps, spread }: { height: number; darkness: number; steps: number[]; spread: number },
) {
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const width = size.x * spread;
  const depth = size.z * spread;
  // The target's shape follows the footprint's.
  const tw = LONG_SIDE;
  const th = Math.max(64, Math.round((LONG_SIDE * depth) / width));
  const options = { generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
  const target = new THREE.WebGLRenderTarget(tw, th, options);
  const blurTarget = new THREE.WebGLRenderTarget(tw, th, options);

  // From the ground, looking up.
  const camera = new THREE.OrthographicCamera(-width / 2, width / 2, depth / 2, -depth / 2, 0, height);
  camera.position.set(centre.x, 0, centre.z);
  camera.rotation.x = Math.PI / 2;
  camera.updateMatrixWorld();

  const depthMaterial = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
  depthMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.darkness = { value: darkness };
    shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
      "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
      "gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );",
    )}`;
  };
  depthMaterial.depthTest = false;
  depthMaterial.depthWrite = false;

  const scene = new THREE.Scene();
  const parent = unit.parent;
  scene.add(unit);
  scene.overrideMaterial = depthMaterial;
  const clearColour = renderer.getClearColor(new THREE.Color());
  const clearAlpha = renderer.getClearAlpha();
  const toneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  scene.overrideMaterial = null;
  if (parent) parent.add(unit);

  // Blur it: each pass a step wider than the last, across then down.
  const horizontal = new THREE.ShaderMaterial(HorizontalBlurShader);
  const vertical = new THREE.ShaderMaterial(VerticalBlurShader);
  horizontal.depthTest = vertical.depthTest = false;
  const quad = new FullScreenQuad(horizontal);
  for (const step of steps) {
    horizontal.uniforms.tDiffuse.value = target.texture;
    horizontal.uniforms.h.value = step / tw;
    quad.material = horizontal;
    renderer.setRenderTarget(blurTarget);
    quad.render(renderer);
    vertical.uniforms.tDiffuse.value = blurTarget.texture;
    vertical.uniforms.v.value = step / th;
    quad.material = vertical;
    renderer.setRenderTarget(target);
    quad.render(renderer);
  }
  renderer.setRenderTarget(null);
  renderer.setClearColor(clearColour, clearAlpha);
  renderer.toneMapping = toneMapping;
  quad.dispose();
  horizontal.dispose();
  vertical.dispose();
  depthMaterial.dispose();
  blurTarget.dispose();

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth).rotateX(Math.PI / 2),
    new THREE.ShaderMaterial({ uniforms: { map: { value: target.texture } }, vertexShader: fadeVertex, fragmentShader: fadeFragment, transparent: true, depthWrite: false }),
  );
  // The picture was taken from below: turn it back over.
  plane.scale.y = -1;
  plane.position.set(centre.x, 0.002, centre.z);
  plane.renderOrder = -1;
  plane.userData.target = target;
  return plane;
}

export function contactShadow(renderer: THREE.WebGLRenderer, unit: THREE.Object3D): THREE.Group {
  unit.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(unit);
  const group = new THREE.Group();
  group.name = "contact-shadow";
  const tall = box.max.y;
  // Wide and faint: the whole body's shade.
  group.add(shadowPass(renderer, unit, box, { height: tall * 0.9, darkness: 0.5, steps: [1, 2, 3, 4, 5], spread: 1.5 }));
  // Tight and darker: where it meets the ground.
  group.add(shadowPass(renderer, unit, box, { height: tall * 0.3, darkness: 1.1, steps: [1, 1.5, 2], spread: 1.5 }));
  return group;
}

export function disposeShadow(group: THREE.Group) {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    (mesh.userData.target as THREE.WebGLRenderTarget | undefined)?.dispose();
  });
}
