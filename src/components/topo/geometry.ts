// Geometry for the Topo HUD scene. Everything here is deterministic and runs
// once at build time, so the page ships as static SVG paths.

export const MAP_W = 1600;
export const MAP_H = 1000;
export const RIDGE_W = 1600;
export const RIDGE_H = 320;

type Point = [number, number];

function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Terrain height: a few hills plus gentle ripples so the contours wander.
function terrain(x: number, y: number) {
  const hill = (cx: number, cy: number, r: number, h: number) =>
    h * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r));
  return (
    hill(360, 300, 230, 1.0) +
    hill(1220, 250, 260, 1.15) +
    hill(820, 660, 320, 0.8) +
    hill(1480, 780, 200, 0.55) +
    hill(110, 840, 190, 0.5) +
    0.12 * Math.sin(x * 0.0061 + 0.8) * Math.cos(y * 0.0073 + 1.9) +
    0.07 * Math.sin(x * 0.013 + y * 0.009 + 2.4) +
    0.04 * Math.cos(x * 0.021 - y * 0.017 + 0.3)
  );
}

// Relative path commands with integer coordinates keep the markup small.
function toPath(points: Point[], closed: boolean) {
  let [px, py] = points[0].map(Math.round);
  let d = `M${px} ${py}`;
  for (const [x, y] of points.slice(1)) {
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (rx === px && ry === py) continue;
    d += `l${rx - px} ${ry - py}`;
    px = rx;
    py = ry;
  }
  return closed ? `${d}z` : d;
}

export type Contour = { d: string; index: boolean };

// Contour lines of the terrain, traced with marching squares. Every fifth
// line is an index contour, drawn brighter like on a printed topo map.
export function contours(levels = 15, cell = 16): Contour[] {
  const nx = Math.ceil(MAP_W / cell);
  const ny = Math.ceil(MAP_H / cell);
  const values: number[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) values.push(terrain(i * cell, j * cell));
  }
  const at = (i: number, j: number) => values[j * (nx + 1) + i];
  const min = Math.min(...values);
  const max = Math.max(...values);

  // Each grid edge gets a numeric key: even for horizontal, odd for vertical.
  const hKey = (i: number, j: number) => 2 * (j * (nx + 1) + i);
  const vKey = (i: number, j: number) => 2 * (j * (nx + 1) + i) + 1;

  const trace = (level: number) => {
    const links = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      if (!links.has(a)) links.set(a, []);
      if (!links.has(b)) links.set(b, []);
      links.get(a)!.push(b);
      links.get(b)!.push(a);
    };

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const tl = at(i, j);
        const tr = at(i + 1, j);
        const br = at(i + 1, j + 1);
        const bl = at(i, j + 1);
        const c =
          (tl > level ? 8 : 0) |
          (tr > level ? 4 : 0) |
          (br > level ? 2 : 0) |
          (bl > level ? 1 : 0);
        const T = hKey(i, j);
        const B = hKey(i, j + 1);
        const L = vKey(i, j);
        const R = vKey(i + 1, j);
        const centerAbove = (tl + tr + br + bl) / 4 > level;
        switch (c) {
          case 1:
          case 14:
            link(L, B);
            break;
          case 2:
          case 13:
            link(B, R);
            break;
          case 3:
          case 12:
            link(L, R);
            break;
          case 4:
          case 11:
            link(T, R);
            break;
          case 6:
          case 9:
            link(T, B);
            break;
          case 7:
          case 8:
            link(L, T);
            break;
          case 5:
            if (centerAbove) {
              link(L, T);
              link(B, R);
            } else {
              link(T, R);
              link(L, B);
            }
            break;
          case 10:
            if (centerAbove) {
              link(T, R);
              link(L, B);
            } else {
              link(L, T);
              link(B, R);
            }
            break;
        }
      }
    }

    const point = (key: number): Point => {
      const idx = key >> 1;
      const i = idx % (nx + 1);
      const j = Math.floor(idx / (nx + 1));
      const vertical = key & 1;
      const a = at(i, j);
      const b = vertical ? at(i, j + 1) : at(i + 1, j);
      const t = (level - a) / (b - a);
      return vertical ? [i * cell, (j + t) * cell] : [(i + t) * cell, j * cell];
    };

    const seen = new Set<number>();
    let d = "";
    const walk = (start: number) => {
      const points = [point(start)];
      seen.add(start);
      let current = start;
      for (;;) {
        const next = links.get(current)!.find((n) => !seen.has(n));
        if (next === undefined) break;
        seen.add(next);
        points.push(point(next));
        current = next;
      }
      const closed = points.length > 2 && links.get(current)!.includes(start);
      d += toPath(points, closed);
    };
    // Lines that run off the map first, then the closed loops.
    for (const [key, neighbors] of links) {
      if (neighbors.length === 1 && !seen.has(key)) walk(key);
    }
    for (const key of links.keys()) {
      if (!seen.has(key)) walk(key);
    }
    return d;
  };

  return Array.from({ length: levels }, (_, k) => ({
    d: trace(min + ((max - min) * (k + 1)) / (levels + 1)),
    index: (k + 1) % 5 === 0,
  }));
}

// A pine silhouette: stacked tiers that widen toward the base, short trunk.
const PINE: Point[] = [
  [0.3, 0.5],
  [0.27, 0.26],
  [0.55, 0.74],
  [0.52, 0.44],
  [0.84, 1],
  [0.84, 0.12],
  [1, 0.12],
];

function pine(x: number, y: number, h: number) {
  const w = h * 0.22;
  const right = PINE.map(([dy, dx]): Point => [x + dx * w, y - h + dy * h]);
  const left = PINE.map(([dy, dx]): Point => [x - dx * w, y - h + dy * h]);
  return toPath([[x, y - h], ...right, ...left.reverse()], true);
}

export type Ridge = { fill: string; crest: string };

// A ridgeline profile covered in pines, as a filled shape plus its crest line.
export function ridge(options: {
  seed: number;
  base: number;
  amplitude: number;
  treeMin: number;
  treeMax: number;
  spacing: number;
}): Ridge {
  const { seed, base, amplitude, treeMin, treeMax, spacing } = options;
  const rand = random(seed);
  const profile = (x: number) =>
    base +
    amplitude *
      (0.6 * Math.sin(x * 0.0042 + seed) +
        0.3 * Math.sin(x * 0.011 + seed * 2.3) +
        0.1 * Math.sin(x * 0.029 + seed * 0.7));

  const crestPoints: Point[] = [];
  for (let x = 0; x <= RIDGE_W; x += 20) crestPoints.push([x, profile(x)]);
  const crest = toPath(crestPoints, false);

  let fill = toPath(
    [[0, RIDGE_H], ...crestPoints, [RIDGE_W, RIDGE_H]],
    true,
  );
  for (let x = rand() * spacing; x < RIDGE_W + spacing; ) {
    const h = treeMin + (treeMax - treeMin) * rand();
    fill += pine(x, profile(x) + 3, h);
    x += spacing * (0.45 + rand());
  }
  return { fill, crest };
}

// Catmull-Rom spline through the points, as cubic Bezier segments.
export function smoothPath(points: Point[]) {
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0]} ${p2[1]}`;
  }
  return d;
}
