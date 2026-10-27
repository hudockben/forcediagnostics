// Where a part's drawing sits on the examine view's stage: beside the part,
// never over its point, inside the stage, off the callouts' labels, kept
// where it was while that holds (as drawn on whole pixels, through a slow
// turn and a label sweeping by); off other flagged parts and the callouts'
// leaders; off all of a large part (the General 4-seat's transmission,
// engine and fuel tank, built as the 3D unit builds them, from every
// direction the camera flies to them and through a turn round them), or
// covering the least of one that fills the stage; a strip across the top
// on a narrow stage; and the leader from the bubble's edge to the part,
// never through the part's own label. Pure: no browser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as THREE from "three";

import type { DrawnSystem } from "../src/lib/diagnose-zones";
import { buildGeometry } from "../src/lib/unit-3d/build";
import { NEAR_PART, PART_SPREAD, flightTo, partBox, partPoints, screenExtent } from "../src/lib/unit-3d/focus";
import { anchorAt, layoutFor, worldBounds } from "../src/lib/unit-3d/layout";
import { UNKNOWN_PAINT } from "../src/lib/unit-paint";
import type { UnitSpec } from "../src/lib/unit-vehicle";
import {
  BUBBLE_CLEAR,
  BUBBLE_MARGIN,
  PART_GAP,
  STRIP_HEIGHT,
  bubbleDocked,
  bubbleFits,
  distanceTo,
  leaderOf,
  lineCrosses,
  onStage,
  overlap,
  piecesAlong,
  placeBubble,
  stripRect,
  stripTop,
  type Rect,
} from "../src/lib/unit-3d/bubble";

const inside = (rect: Rect, stage: { width: number; height: number }) =>
  rect.x >= BUBBLE_MARGIN - 1e-9 && rect.y >= BUBBLE_MARGIN - 1e-9 && rect.x + rect.w <= stage.width - BUBBLE_MARGIN + 1e-9 && rect.y + rect.h <= stage.height - BUBBLE_MARGIN + 1e-9;

describe("the bubble's place", () => {
  const stage = { width: 750, height: 780 };
  const size = { w: 270, h: 300 };

  test("beside the part at the stage's middle (where a flight to a system puts it): clear of its point, inside the stage, near it", () => {
    const anchor = { x: 375, y: 390 };
    const rect = placeBubble({ stage, size, anchor, avoid: [], last: null });
    assert.ok(inside(rect, stage), JSON.stringify(rect));
    assert.ok(distanceTo(rect, anchor) >= BUBBLE_CLEAR - 1e-9, JSON.stringify(rect));
    // As near as that allows, to its right on a tie.
    assert.ok(distanceTo(rect, anchor) < BUBBLE_CLEAR + 1, JSON.stringify(rect));
    assert.ok(rect.x > anchor.x, JSON.stringify(rect));
    assert.deepEqual({ w: rect.w, h: rect.h }, size);
  });

  test("a part near the right edge gets it on its left; near a corner, the other way round", () => {
    const right = placeBubble({ stage, size, anchor: { x: 700, y: 390 }, avoid: [], last: null });
    assert.ok(right.x + right.w <= 700 - BUBBLE_CLEAR + 1e-9 && inside(right, stage), JSON.stringify(right));
    const corner = placeBubble({ stage, size, anchor: { x: 40, y: 40 }, avoid: [], last: null });
    assert.ok(distanceTo(corner, { x: 40, y: 40 }) >= BUBBLE_CLEAR - 1e-9 && inside(corner, stage), JSON.stringify(corner));
  });

  test("off the callouts' labels: it moves past one in its way (between the rows above and below the machine)", () => {
    const anchor = { x: 375, y: 390 };
    const top: Rect = { x: 380, y: 6, w: 360, h: 26 };
    const bottom: Rect = { x: 330, y: 740, w: 400, h: 26 };
    const tall = { w: 270, h: 640 };
    const rect = placeBubble({ stage, size: tall, anchor, avoid: [top, bottom], last: null });
    assert.equal(overlap(rect, top) + overlap(rect, bottom), 0, JSON.stringify(rect));
    assert.ok(distanceTo(rect, anchor) >= BUBBLE_CLEAR - 1e-9 && inside(rect, stage), JSON.stringify(rect));
    // A label right beside the part: the bubble goes to the other side.
    const beside: Rect = { x: 420, y: 200, w: 300, h: 400 };
    const other = placeBubble({ stage, size, anchor, avoid: [beside], last: null });
    assert.equal(overlap(other, beside), 0, JSON.stringify(other));
    assert.ok(other.x + other.w <= anchor.x, JSON.stringify(other));
  });

  test("with no room clear of everything, clear of the part still wins over a label", () => {
    const small = { width: 600, height: 380 };
    const anchor = { x: 300, y: 190 };
    const labels: Rect[] = [
      { x: 0, y: 0, w: 600, h: 120 },
      { x: 0, y: 260, w: 600, h: 120 },
    ];
    const rect = placeBubble({ stage: small, size: { w: 220, h: 240 }, anchor, avoid: labels, last: null });
    assert.ok(distanceTo(rect, anchor) >= BUBBLE_CLEAR - 1e-9, JSON.stringify(rect));
  });

  test("it stays where it was while that's still clear, as the part moves under the camera", () => {
    const first = placeBubble({ stage, size, anchor: { x: 375, y: 390 }, avoid: [], last: null });
    const moved = placeBubble({ stage, size, anchor: { x: 330, y: 420 }, avoid: [], last: first });
    assert.deepEqual(moved, first);
    // Once the part comes up to it, it goes elsewhere (still beside it).
    const anchor = { x: first.x + 20, y: first.y + first.h / 2 };
    const away = placeBubble({ stage, size, anchor, avoid: [], last: first });
    assert.notDeepEqual(away, first);
    assert.ok(distanceTo(away, anchor) >= BUBBLE_CLEAR - 1e-9 && inside(away, stage), JSON.stringify(away));
    // A label moving onto it moves it too.
    const label: Rect = { x: first.x + 10, y: first.y + 10, w: 60, h: 24 };
    const off = placeBubble({ stage, size, anchor: { x: 375, y: 390 }, avoid: [label], last: first });
    assert.equal(overlap(off, label), 0, JSON.stringify(off));
  });

  // As the stage draws it: on whole pixels.
  const drawn = (rect: Rect): Rect => ({ ...rect, x: Math.round(rect.x), y: Math.round(rect.y) });

  test("kept where it was as drawn on whole pixels, the part's point between pixels, on either side of it", () => {
    for (const x of [374.4, 374.7, 374.3, 374.5]) {
      const anchor = { x, y: 390.6 };
      const first = drawn(placeBubble({ stage, size, anchor, avoid: [], last: null }));
      assert.deepEqual(placeBubble({ stage, size, anchor, avoid: [], last: first }), first, `right of ${x}`);
      // On the part's left (a label on its right).
      const beside: Rect = { x: x + 40, y: 100, w: 340, h: 600 };
      const left = drawn(placeBubble({ stage, size, anchor, avoid: [beside], last: null }));
      assert.ok(left.x + left.w <= x, JSON.stringify(left));
      assert.deepEqual(placeBubble({ stage, size, anchor, avoid: [beside], last: left }), left, `left of ${x}`);
    }
    // Two hundred points anywhere: kept every time.
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 200; i++) {
      const anchor = { x: 100 + random() * 550, y: 100 + random() * 580 };
      const first = drawn(placeBubble({ stage, size, anchor, avoid: [], last: null }));
      assert.deepEqual(placeBubble({ stage, size, anchor, avoid: [], last: first }), first, JSON.stringify(anchor));
    }
  });

  test("a slow turn of the camera with nothing in the way: it doesn't move at all", () => {
    let last: Rect | null = null;
    let moves = 0;
    for (let frame = 0; frame < 120; frame++) {
      const anchor = { x: 374.3 + Math.sin(frame / 20) * 5, y: 390 + Math.cos(frame / 15) * 5 };
      const placed: Rect = drawn(placeBubble({ stage, size, anchor, avoid: [], last }));
      if (last && (placed.x !== last.x || placed.y !== last.y)) moves++;
      last = placed;
    }
    assert.equal(moves, 0);
  });

  test("a label sweeping across it moves it once, and it stays where it went when the label's gone", () => {
    const anchor = { x: 374.7, y: 390.2 };
    let last: Rect | null = drawn(placeBubble({ stage, size, anchor, avoid: [], last: null }));
    const start = last;
    const spots: string[] = [];
    for (let step = 0; step <= 40; step++) {
      // A label 120 by 26 moving right to left across the stage, level with the bubble's top.
      const label: Rect = { x: 760 - step * 22, y: start.y + 20, w: 120, h: 26 };
      last = drawn(placeBubble({ stage, size, anchor, avoid: label.x + label.w > 0 ? [label] : [], last }));
      if (spots.at(-1) !== `${last.x},${last.y}`) spots.push(`${last.x},${last.y}`);
      assert.ok(overlap(last, label) === 0 || label.x + label.w <= 0, `${step}: over the label ${JSON.stringify({ last, label })}`);
    }
    // Moved off its way (once, or once more as it reached the new spot), never back and forth.
    assert.ok(spots.length >= 2 && spots.length <= 3, spots.join(" -> "));
    assert.equal(new Set(spots).size, spots.length, spots.join(" -> "));
  });

  test("off another flagged part round its point, and as far as it can off the callouts' leaders", () => {
    const anchor = { x: 375, y: 390 };
    // Another part's point where the bubble would go on the right.
    const other: Rect = { x: 460 - 20, y: 390 - 20, w: 40, h: 40 };
    const rect = placeBubble({ stage, size, anchor, avoid: [other], last: null });
    assert.equal(overlap(rect, other), 0, JSON.stringify(rect));
    // A leader running up through the spot on the right: the left, as near.
    const leader = piecesAlong([
      [520, 700],
      [520, 60],
    ]);
    assert.ok(leader.length >= 10 && leader.every((piece) => piece.w === 6 && piece.h === 6));
    const clear = placeBubble({ stage, size, anchor, avoid: [], soft: leader, last: null });
    assert.ok(leader.every((piece) => overlap(clear, piece) === 0), JSON.stringify(clear));
    assert.ok(distanceTo(clear, anchor) >= BUBBLE_CLEAR - 1e-9 && distanceTo(clear, anchor) < BUBBLE_CLEAR + 1, JSON.stringify(clear));
    // With nowhere clear of a leader, still clear of the part.
    const wall = [...piecesAlong([[40, 0], [40, 780]]), ...piecesAlong([[700, 0], [700, 780]]), ...piecesAlong([[0, 200], [750, 200]]), ...piecesAlong([[0, 600], [750, 600]])];
    const anyway = placeBubble({ stage, size, anchor, avoid: [], soft: wall, last: null });
    assert.ok(distanceTo(anyway, anchor) >= BUBBLE_CLEAR - 1e-9 && inside(anyway, stage), JSON.stringify(anyway));
  });

  test("off the other parts' dots and labels whatever leaders that crosses: a leader is better crossed than a dot covered", () => {
    const anchor = { x: 375, y: 390 };
    // Another flagged part's dot just inside the right of where the bubble goes beside the part.
    const dot: Rect = { x: 699, y: 380, w: 16, h: 16 };
    // Leaders down the left and across above and below the machine.
    const leaders = [
      ...piecesAlong([
        [200, 0],
        [200, 780],
      ]),
      ...piecesAlong([
        [0, 150],
        [750, 150],
      ]),
      ...piecesAlong([
        [0, 640],
        [750, 640],
      ]),
    ];
    const rect = placeBubble({ stage, size, anchor, avoid: [dot], soft: leaders, last: null });
    assert.equal(overlap(rect, dot), 0, JSON.stringify(rect));
    assert.ok(distanceTo(rect, anchor) >= BUBBLE_CLEAR - 1e-9 && inside(rect, stage), JSON.stringify(rect));
    // With no dot there, it keeps off the leaders as before.
    const plain = placeBubble({ stage, size, anchor, avoid: [], soft: leaders, last: null });
    assert.ok(leaders.every((piece) => overlap(plain, piece) === 0), JSON.stringify(plain));
  });

  // Whether a bubble this size fits anywhere on the stage (every few
  // pixels) clear of a part's box with room round it, a square round its
  // point and, unless only the part matters, every label and dot.
  const roomFor = (s: { width: number; height: number }, size: { w: number; h: number }, part: Rect, anchor: { x: number; y: number }, avoid: Rect[]) => {
    const grown: Rect = { x: part.x - PART_GAP, y: part.y - PART_GAP, w: part.w + PART_GAP * 2, h: part.h + PART_GAP * 2 };
    const round: Rect = { x: anchor.x - BUBBLE_CLEAR, y: anchor.y - BUBBLE_CLEAR, w: BUBBLE_CLEAR * 2, h: BUBBLE_CLEAR * 2 };
    for (let y = BUBBLE_MARGIN; y + size.h <= s.height - BUBBLE_MARGIN; y += 6) {
      for (let x = BUBBLE_MARGIN; x + size.w <= s.width - BUBBLE_MARGIN; x += 6) {
        const rect = { x, y, ...size };
        if (overlap(rect, grown) === 0 && overlap(rect, round) === 0 && avoid.every((other) => overlap(rect, other) === 0)) return rect;
      }
    }
    return null;
  };

  test("wherever there's room clear of the part, its point and every label and dot, it goes clear of them all: four hundred crowded stages", () => {
    let seed = 11;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let roomy = 0;
    let partOnly = 0;
    for (let n = 0; n < 400; n++) {
      const s = { width: Math.round(600 + random() * 700), height: Math.round(450 + random() * 500) };
      const size = { w: Math.round(Math.min(440, Math.max(220, s.width * 0.36))), h: Math.round(200 + random() * 260) };
      const part: Rect = { x: s.width * (0.3 + random() * 0.2), y: s.height * (0.3 + random() * 0.2), w: 40 + random() * 220, h: 40 + random() * 200 };
      const anchor = { x: part.x + random() * part.w, y: part.y + random() * part.h };
      // Labels in rows along the top and bottom, and dots and ruled-out marks anywhere.
      const avoid: Rect[] = [];
      for (let k = Math.floor(random() * 10); k > 0; k--) avoid.push({ x: random() * s.width, y: random() < 0.5 ? 6 + random() * 40 : s.height - 40 - random() * 40, w: 70 + random() * 120, h: 34 });
      for (let k = 1 + Math.floor(random() * 24); k > 0; k--) {
        const r = 6 + random() * 14;
        avoid.push({ x: s.width * random() - r, y: s.height * random() - r, w: r * 2, h: r * 2 });
      }
      const soft = piecesAlong([
        [random() * s.width, 0],
        [random() * s.width, s.height],
      ]);
      const rect = placeBubble({ stage: s, size, anchor, part, avoid, soft, last: null });
      const at = `${n}: ${JSON.stringify({ s, size, rect, part, anchor })}`;
      assert.ok(inside(rect, s), at);
      if (roomFor(s, size, part, anchor, avoid)) {
        roomy++;
        assert.ok(avoid.every((other) => overlap(rect, other) === 0), at);
      }
      if (roomFor(s, size, part, anchor, [])) {
        partOnly++;
        const grown: Rect = { x: part.x - PART_GAP, y: part.y - PART_GAP, w: part.w + PART_GAP * 2, h: part.h + PART_GAP * 2 };
        assert.ok(overlap(rect, grown) === 0 && distanceTo(rect, anchor) >= BUBBLE_CLEAR - 1e-9, at);
      }
    }
    // Many had room (it's tight on the small ones).
    assert.ok(roomy > 120 && partOnly > roomy, `${roomy} of 400, ${partOnly} clear of the part`);
  });

  test("the part off the stage: anywhere free, kept where it was", () => {
    const first = placeBubble({ stage, size, anchor: null, avoid: [], last: null });
    assert.ok(inside(first, stage), JSON.stringify(first));
    assert.deepEqual(placeBubble({ stage, size, anchor: null, avoid: [], last: first }), first);
    // A smaller stage (a resize) keeps it on the stage.
    const smaller = { width: 400, height: 380 };
    assert.ok(inside(placeBubble({ stage: smaller, size: { w: 220, h: 240 }, anchor: null, avoid: [], last: { ...first, x: 470 } }), smaller));
  });

  test("never bigger than the stage", () => {
    const tiny = { width: 260, height: 220 };
    const rect = placeBubble({ stage: tiny, size: { w: 400, h: 400 }, anchor: { x: 130, y: 110 }, avoid: [], last: null });
    assert.ok(inside(rect, tiny), JSON.stringify(rect));
  });
});

describe("off all of a large part", () => {
  const stage = { width: 750, height: 780 };
  const size = { w: 270, h: 300 };

  test("the part's box, not only its point: a part reaching well past the clearance on its right gets the bubble past all of it", () => {
    const anchor = { x: 375, y: 390 };
    // A transmission's box from the camera's end: its point near its left.
    const part: Rect = { x: 305, y: 365, w: 165, h: 150 };
    const old = placeBubble({ stage, size, anchor, avoid: [], last: null });
    assert.ok(overlap(old, part) > 0, "the point alone would put it over the part");
    const rect = placeBubble({ stage, size, anchor, part, avoid: [], last: null });
    assert.equal(overlap(rect, part), 0, JSON.stringify(rect));
    assert.ok(distanceTo(rect, anchor) >= BUBBLE_CLEAR - 1e-9 && inside(rect, stage), JSON.stringify(rect));
    // With room round it, and as near the part as that allows.
    const grown: Rect = { x: part.x - PART_GAP, y: part.y - PART_GAP, w: part.w + PART_GAP * 2, h: part.h + PART_GAP * 2 };
    assert.equal(overlap(rect, grown), 0, JSON.stringify(rect));
    assert.ok(distanceTo(rect, anchor) <= 200, JSON.stringify(rect));
    // A label where it would go: past both.
    const label: Rect = { x: 180, y: 40, w: 300, h: 26 };
    const both = placeBubble({ stage, size, anchor, part, avoid: [label], last: null });
    assert.equal(overlap(both, part) + overlap(both, label), 0, JSON.stringify(both));
  });

  test("kept while it's clear of the part's box at all; moved once the box comes onto it, and never onto the part", () => {
    const anchor = { x: 375, y: 390 };
    const part: Rect = { x: 300, y: 360, w: 170, h: 150 };
    const first = placeBubble({ stage, size, anchor, part, avoid: [], last: null });
    // The box a little bigger under the camera (within the room left round it): kept.
    const closer: Rect = { x: part.x - 8, y: part.y - 8, w: part.w + 16, h: part.h + 16 };
    assert.deepEqual(placeBubble({ stage, size, anchor, part: closer, avoid: [], last: first }), first);
    // Grown onto it: moved, clear of it.
    const onto: Rect = { x: first.x + 20, y: first.y + first.h - 30, w: 200, h: 150 };
    assert.ok(overlap(first, onto) > 0);
    const moved = placeBubble({ stage, size, anchor, part: onto, avoid: [], last: first });
    assert.notDeepEqual(moved, first);
    assert.equal(overlap(moved, onto), 0, JSON.stringify({ moved, onto }));
  });

  test("a part filling the stage (zoomed in on it): against the stage's edge farthest from its middle, covering the least of it", () => {
    // The part's box past the stage's top and left; on the stage, its middle up and to the left.
    const part: Rect = { x: -200, y: -100, w: 900, h: 800 };
    const anchor = { x: 340, y: 330 };
    const rect = placeBubble({ stage, size, anchor, part, avoid: [], last: null });
    assert.ok(inside(rect, stage), JSON.stringify(rect));
    assert.deepEqual({ x: rect.x, y: rect.y }, { x: stage.width - BUBBLE_MARGIN - size.w, y: stage.height - BUBBLE_MARGIN - size.h }, JSON.stringify(rect));
    // Kept there while nowhere's better, as the camera moves a little.
    const nudged: Rect = { ...part, x: part.x + 6, y: part.y + 4 };
    assert.deepEqual(placeBubble({ stage, size, anchor: { x: 346, y: 334 }, part: nudged, avoid: [], last: rect }), rect);
    // Its middle down and to the right: the top left.
    const other = placeBubble({ stage, size, anchor: { x: 420, y: 450 }, part: { x: 50, y: 80, w: 900, h: 900 }, avoid: [], last: null });
    assert.deepEqual({ x: other.x, y: other.y }, { x: BUBBLE_MARGIN, y: BUBBLE_MARGIN }, JSON.stringify(other));
    // Off the labels still, where that costs no more of the part.
    const label: Rect = { x: 600, y: 700, w: 140, h: 30 };
    const off = placeBubble({ stage, size, anchor, part: { x: -200, y: -100, w: 1200, h: 1000 }, avoid: [label], last: null });
    assert.equal(overlap(off, label), 0, JSON.stringify(off));
  });

  test("a part off the stage but for its box's edge: kept off what's on the stage", () => {
    const part: Rect = { x: 600, y: 200, w: 400, h: 300 };
    const rect = placeBubble({ stage, size, anchor: null, part, avoid: [], last: null });
    assert.equal(overlap(rect, part), 0, JSON.stringify(rect));
    assert.ok(inside(rect, stage), JSON.stringify(rect));
  });

  // Units as the 3D unit builds them, in Node.
  const base = { paint: UNKNOWN_PAINT, sixWheels: false, size: "full" };
  const unitOf = (spec: Record<string, unknown>) => {
    const layout = layoutFor({ ...base, ...spec } as unknown as UnitSpec);
    const bounds = worldBounds(layout);
    const machineBox = new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max));
    return {
      layout,
      shapes: buildGeometry(layout),
      scale: new THREE.Matrix4().makeScale(layout.scale, layout.scale, layout.scale),
      machine: { size: machineBox.getSize(new THREE.Vector3()).length(), centre: machineBox.getCenter(new THREE.Vector3()) },
    };
  };
  const general = unitOf({ vehicle: "utv", line: "general", seats: 4 });
  // A system's part: its shapes, its point, the box the camera flies to,
  // its points, and its surface inside the box round its point (a point
  // every few centimetres across each of its triangles, so a tube crossing
  // the box with its ends well outside it is there); and, as the part's
  // points were before they were cut to the box, its corners inside it.
  const partOf = (unit: ReturnType<typeof unitOf>, system: DrawnSystem) => {
    const own = unit.shapes.filter((shape) => shape.group === system).map((shape) => ({ geometry: shape.geometry, matrixWorld: unit.scale }));
    const target = new THREE.Vector3(...anchorAt(unit.layout, system)!);
    const near = new THREE.Box3().setFromCenterAndSize(target, new THREE.Vector3(NEAR_PART, NEAR_PART, NEAR_PART));
    const surface: number[] = [];
    const corners: number[] = [];
    const point = new THREE.Vector3();
    for (const shape of own) {
      const position = shape.geometry.getAttribute("position");
      const index = shape.geometry.getIndex();
      const count = index ? index.count : position.count;
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i).applyMatrix4(unit.scale);
        if (near.containsPoint(point)) corners.push(point.x, point.y, point.z);
      }
      for (let n = 0; n + 2 < count; n += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(n + k) : n + k).applyMatrix4(unit.scale));
        if (!new THREE.Box3().setFromPoints([a, b, c]).intersectsBox(near)) continue;
        const steps = Math.max(1, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / 0.03));
        for (let i = 0; i <= steps; i++) {
          for (let j = 0; i + j <= steps; j++) {
            point.set(0, 0, 0).addScaledVector(a, i / steps).addScaledVector(b, j / steps).addScaledVector(c, (steps - i - j) / steps);
            if (near.containsPoint(point)) surface.push(point.x, point.y, point.z);
          }
        }
      }
    }
    // No corners inside: the small box round the point, as it was.
    if (corners.length === 0) for (const x of [-0.15, 0.15]) for (const y of [-0.15, 0.15]) for (const z of [-0.15, 0.15]) corners.push(target.x + x, target.y + y, target.z + z);
    return { own, target, box: partBox(own, target), points: partPoints(own, target), surface: new Float32Array(surface), corners: new Float32Array(corners) };
  };
  // The examine view's stage beside the sheet at 1440 by 900 and 1440 by
  // 860, under it at 820 by 1180, and at 1920 by 1080; the bubble a third
  // of it wide.
  const stages = [
    { width: 749, height: 786 },
    { width: 749, height: 742 },
    { width: 820, height: 520 },
    { width: 1216, height: 962 },
  ];
  // As the bubble draws itself: a third of the stage wide, its drawing in
  // a box between portrait and wide (at most 46% of the stage's height),
  // its name above and Enlarge under it.
  const bubblesFor = (s: { width: number; height: number }) =>
    [0.8, 1.33, 1.7].map((shape) => {
      const w = Math.min(440, Math.max(220, s.width * 0.36));
      return { w, h: Math.min((w - 16) / shape, s.height * 0.46) + 94 };
    });
  // Points on the screen through a camera.
  const projected = (camera: THREE.PerspectiveCamera, s: { width: number; height: number }, points: Float32Array) => {
    const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < points.length; i += 3) {
      const [x, y, z] = [points[i], points[i + 1], points[i + 2]];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      out.push({ x: (((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2) * s.width, y: ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2) * s.height });
    }
    return out;
  };
  // Grown by its outline's line, as the stage does.
  const outlined = (extent: Rect): Rect => ({ x: extent.x - 3, y: extent.y - 3, w: extent.w + 6, h: extent.h + 6 });
  const look = (camera: THREE.PerspectiveCamera, s: { width: number; height: number }, part: ReturnType<typeof partOf>) => {
    camera.updateMatrixWorld();
    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const p = part.target.clone().project(camera);
    const anchor = { x: ((p.x + 1) / 2) * s.width, y: ((1 - p.y) / 2) * s.height };
    const extent = screenExtent(part.points, viewProjection, s.width, s.height)!;
    const cornersOnly = outlined(screenExtent({ points: part.corners, spread: 0 }, viewProjection, s.width, s.height)!);
    return { anchor, extent, box: outlined(extent), cornersOnly, surface: projected(camera, s, part.surface) };
  };
  const under = (rect: Rect, points: { x: number; y: number }[]) => points.filter((p) => p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h).length;
  // Each flight to the part, on each stage, from each direction the camera tries.
  const flights = (unit: ReturnType<typeof unitOf>, part: ReturnType<typeof partOf>, each: (s: { width: number; height: number }, i: number, seen: ReturnType<typeof look>) => void) => {
    for (const s of stages) {
      const camera = new THREE.PerspectiveCamera(22, s.width / s.height, 0.05, 200);
      const { distance, directions } = flightTo(part.box, part.target, unit.machine, camera.fov, s);
      for (const [i, direction] of directions.entries()) {
        camera.position.copy(part.target).addScaledVector(direction, distance);
        camera.lookAt(part.target);
        each(s, i, look(camera, s, part));
      }
    }
  };

  // Before: the bubble placed by the part's point alone covered some of
  // it (the General 4-seat's transmission, engine and fuel tank: none of
  // them under it now from any arrival); or the box round only its corners
  // inside the box round its point (a steering post, a frame's tubes, a
  // prop shaft crossing the box with their corners outside it) left some
  // of it out.
  const cases: { name: string; unit: ReturnType<typeof unitOf>; system: DrawnSystem; before: "point" | "corners" }[] = [
    { name: "the General 4-seat's transmission", unit: general, system: "transmission", before: "point" },
    { name: "the General 4-seat's engine", unit: general, system: "engine", before: "point" },
    { name: "the General 4-seat's fuel tank", unit: general, system: "fuel", before: "point" },
    { name: "the Sportsman's steering", unit: unitOf({ vehicle: "atv", line: "sportsman", seats: 1 }), system: "steering", before: "corners" },
    { name: "the Scrambler's steering", unit: unitOf({ vehicle: "atv", line: "scrambler", seats: 1 }), system: "steering", before: "corners" },
    { name: "the RZR's frame", unit: unitOf({ vehicle: "utv", line: "rzr", seats: 2 }), system: "body_frame", before: "corners" },
    { name: "the youth Ranger's front drive", unit: unitOf({ vehicle: "utv", line: "ranger", seats: 2, size: "youth" }), system: "front_drive", before: "corners" },
    { name: "the Xpedition's transmission", unit: unitOf({ vehicle: "utv", line: "xpedition", seats: 3 }), system: "transmission", before: "corners" },
  ];
  // Whether anywhere on the stage a bubble this size is clear of a box
  // (left of it, right of it, above or below it).
  const roomBeside = (s: { width: number; height: number }, size: { w: number; h: number }, box: Rect) =>
    box.x - BUBBLE_MARGIN >= size.w ||
    s.width - BUBBLE_MARGIN - (box.x + box.w) >= size.w ||
    box.y - BUBBLE_MARGIN >= size.h ||
    s.height - BUBBLE_MARGIN - (box.y + box.h) >= size.h;
  for (const { name, unit, system, before } of cases) {
    const all = before === "point";
    test(`${name}, flown to from each direction the camera tries: none of it under the bubble ${all ? "from any of them" : "wherever there's room clear of it"}`, () => {
      const part = partOf(unit, system);
      assert.ok(part.surface.length > 0, name);
      let was = 0;
      flights(unit, part, (s, i, seen) => {
        const where = `${s.width}x${s.height}, direction ${i}`;
        // The box holds all of the part inside the box round its point (its
        // points grown by their spread, before its outline's line).
        assert.equal(under(seen.extent, seen.surface), seen.surface.length, `${where}: ${JSON.stringify(seen.extent)}`);
        if (before === "corners") was += seen.surface.length - under(seen.cornersOnly, seen.surface);
        for (const size of bubblesFor(s)) {
          const rect = placeBubble({ stage: s, size, anchor: seen.anchor, part: seen.box, avoid: [], last: null });
          const at = `${where}, ${Math.round(size.w)}x${Math.round(size.h)}: ${JSON.stringify({ rect, box: seen.box })}`;
          assert.ok(inside(rect, s) && distanceTo(rect, seen.anchor) >= BUBBLE_CLEAR - 1e-9, at);
          if (all || roomBeside(s, size, seen.box)) assert.equal(under(rect, seen.surface), 0, at);
          if (roomBeside(s, size, seen.box)) assert.equal(overlap(rect, seen.box), 0, at);
          if (before === "point") was += under(placeBubble({ stage: s, size, anchor: seen.anchor, avoid: [], last: null }), seen.surface);
        }
      });
      assert.ok(was > 0, `${name}: ${was}`);
    });
  }

  test("the transmission through a turn of the camera round it (a drag) and a zoom: never over it, and moved only a few times", () => {
    const part = partOf(general, "transmission");
    const s = stages[0];
    const size = bubblesFor(s)[1];
    const camera = new THREE.PerspectiveCamera(22, s.width / s.height, 0.05, 200);
    const { distance, directions } = flightTo(part.box, part.target, general.machine, camera.fov, s);
    const start = new THREE.Spherical().setFromVector3(directions[0].clone().multiplyScalar(distance));
    let last: Rect | null = null;
    const spots = new Set<string>();
    for (let frame = 0; frame <= 120; frame++) {
      const turn = start.clone();
      turn.theta += (frame / 120) * Math.PI * 0.9;
      // Closer in over the second half.
      turn.radius *= frame < 60 ? 1 : 1 - ((frame - 60) / 60) * 0.35;
      camera.position.copy(part.target).add(new THREE.Vector3().setFromSpherical(turn));
      camera.lookAt(part.target);
      const seen = look(camera, s, part);
      const placed = placeBubble({ stage: s, size, anchor: seen.anchor, part: seen.box, avoid: [], last });
      const rect = { ...placed, x: Math.round(placed.x), y: Math.round(placed.y) };
      assert.equal(under(rect, seen.surface), 0, `frame ${frame}: ${JSON.stringify({ rect, box: seen.box })}`);
      spots.add(`${rect.x},${rect.y}`);
      last = placed;
    }
    assert.ok(spots.size <= 8, [...spots].join(" "));
  });

  test("the Sportsman's steering zoomed in close, from each direction: its box still holds all of it (its points grown by the spread they stand for)", () => {
    const sportsman = cases[3].unit;
    const part = partOf(sportsman, "steering");
    const s = stages[1];
    const camera = new THREE.PerspectiveCamera(22, s.width / s.height, 0.05, 200);
    const { directions } = flightTo(part.box, part.target, sportsman.machine, camera.fov, s);
    let boxed = 0;
    for (const [i, direction] of directions.entries()) {
      // Closer than a flight brings it (the camera still outside the box round the part's point).
      for (const distance of [0.8, 1, 1.6]) {
        camera.position.copy(part.target).addScaledVector(direction, distance);
        camera.lookAt(part.target);
        const seen = look(camera, s, part);
        // Only what's in front of the camera, on or near the stage.
        const shown = seen.surface.filter((p) => p.x > -s.width && p.x < s.width * 2 && p.y > -s.height && p.y < s.height * 2);
        assert.equal(under(seen.extent, shown), shown.length, `direction ${i} at ${distance}: ${JSON.stringify(seen.extent)}`);
        // (All of the screen where it reaches round the camera.)
        if (seen.extent.w < s.width || seen.extent.h < s.height) boxed++;
      }
    }
    assert.ok(boxed >= 12, String(boxed));
  });
});

describe("the part on the stage", () => {
  const camera = new THREE.PerspectiveCamera(30, 800 / 600, 0.05, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const cube = (centre: [number, number, number], half: number, spread = 0) => {
    const points: number[] = [];
    for (const x of [-half, half]) for (const y of [-half, half]) for (const z of [-half, half]) points.push(centre[0] + x, centre[1] + y, centre[2] + z);
    return { points: new Float32Array(points), spread };
  };
  const toScreen = (v: THREE.Vector3) => {
    const p = v.clone().project(camera);
    return { x: ((p.x + 1) / 2) * 800, y: ((1 - p.y) / 2) * 600 };
  };

  test("the box round its points as the camera sees them, on the screen's pixels", () => {
    const rect = screenExtent(cube([0, 0, 0], 0.5), viewProjection, 800, 600)!;
    // Centred, the near face's corners the widest.
    assert.ok(Math.abs(rect.x + rect.w / 2 - 400) < 1e-6 && Math.abs(rect.y + rect.h / 2 - 300) < 1e-6, JSON.stringify(rect));
    const near = new THREE.Vector3(0.5, 0.5, 0.5).project(camera);
    assert.ok(Math.abs(rect.x + rect.w - ((near.x + 1) / 2) * 800) < 1e-3, JSON.stringify(rect));
  });

  test("each point grown by its spread as the camera sees it there: all of a ball that size round it inside, little more", () => {
    for (const [x, y, z] of [
      [0, 0, 0],
      [1.4, -0.9, 0.5],
      [-1.2, 1, 3.6],
    ]) {
      const spread = 0.02;
      const rect = screenExtent({ points: new Float32Array([x, y, z]), spread }, viewProjection, 800, 600)!;
      const centre = new THREE.Vector3(x, y, z);
      let left = Infinity;
      let right = -Infinity;
      for (let i = 0; i < 400; i++) {
        // Points over the ball's surface.
        const t = Math.acos(1 - (2 * (i + 0.5)) / 400);
        const f = Math.PI * (1 + Math.sqrt(5)) * i;
        const p = toScreen(centre.clone().add(new THREE.Vector3(Math.sin(t) * Math.cos(f), Math.sin(t) * Math.sin(f), Math.cos(t)).multiplyScalar(spread)));
        assert.ok(p.x >= rect.x - 1e-6 && p.x <= rect.x + rect.w + 1e-6 && p.y >= rect.y - 1e-6 && p.y <= rect.y + rect.h + 1e-6, `${[x, y, z]}: ${JSON.stringify({ p, rect })}`);
        left = Math.min(left, p.x);
        right = Math.max(right, p.x);
      }
      assert.ok(rect.w <= (right - left) * 1.1, `${[x, y, z]}: ${rect.w} for ${right - left}`);
    }
  });

  test("all of it behind the camera: none; reaching round behind it (the camera in among it, or a point's spread across it): all of the screen", () => {
    assert.equal(screenExtent(cube([0, 0, 8], 0.5), viewProjection, 800, 600), null);
    assert.deepEqual(screenExtent(cube([0, 0, 5], 1), viewProjection, 800, 600), { x: 0, y: 0, w: 800, h: 600 });
    assert.equal(screenExtent({ points: new Float32Array(), spread: 0 }, viewProjection, 800, 600), null);
    assert.deepEqual(screenExtent({ points: new Float32Array([0, 0, 4.99]), spread: 0.02 }, viewProjection, 800, 600), { x: 0, y: 0, w: 800, h: 600 });
  });

  test("its points: its shapes round its callout's point only, one a cell; a small box's corners where it has none there", () => {
    const geometry = new THREE.BoxGeometry(0.4, 0.4, 0.4, 8, 8, 8);
    const at = new THREE.Matrix4().makeTranslation(3, 0, 0);
    const shape = { geometry, matrixWorld: at };
    const { points, spread } = partPoints([shape], new THREE.Vector3(3, 0, 0));
    assert.equal(spread, PART_SPREAD);
    assert.ok(points.length > 0 && points.length / 3 < geometry.getAttribute("position").count, String(points.length));
    for (let i = 0; i < points.length; i += 3) assert.ok(Math.abs(points[i] - 3) <= 0.2 + PART_SPREAD);
    // Far from its point: the small box round the point.
    const away = partPoints([shape], new THREE.Vector3(-3, 0, 0)).points;
    assert.equal(away.length, 24);
    assert.ok(away.every((value, i) => (i % 3 === 0 ? Math.abs(value + 3) <= 0.15 + 1e-6 : Math.abs(value) <= 0.15 + 1e-6)));
    // The flight's box is the same part.
    const box = partBox([shape], new THREE.Vector3(3, 0, 0));
    assert.ok(Math.abs(box.min.x - 2.8) < 1e-6 && Math.abs(box.max.x - 3.2) < 1e-6, JSON.stringify(box));
  });

  // An ATV's steering as the 3D unit draws it: the handlebar across the
  // top of the box round its point, the post a long tube through the box,
  // its corners at its ends, outside the box.
  const target = new THREE.Vector3(0.6, 1.0, 0);
  const near = new THREE.Box3().setFromCenterAndSize(target, new THREE.Vector3(NEAR_PART, NEAR_PART, NEAR_PART));
  const handlebar = { geometry: new THREE.BoxGeometry(0.06, 0.04, 0.7), matrixWorld: new THREE.Matrix4().makeTranslation(0.57, 1.3, 0) };
  // Leaning back a little, from above the box to well under it.
  const lean = 0.15;
  const middle = new THREE.Vector3(0.65, 0.75, 0);
  const post = {
    geometry: new THREE.CylinderGeometry(0.02, 0.02, 1.8, 10, 1),
    matrixWorld: new THREE.Matrix4().makeTranslation(middle.x, middle.y, middle.z).multiply(new THREE.Matrix4().makeRotationZ(lean)),
  };
  // A point on the post's middle line, this far up it from its middle.
  const along = (s: number) => middle.clone().add(new THREE.Vector3(-Math.sin(lean) * s, Math.cos(lean) * s, 0));

  test("a tube crossing the box round the part's point with its ends outside it (a steering post): the part of it inside the box is among its points", () => {
    // None of the post's corners is inside the box.
    const position = post.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) assert.ok(!near.containsPoint(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(post.matrixWorld)));
    const alone = partPoints([post], target).points;
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < alone.length; i += 3) {
      low = Math.min(low, alone[i + 1]);
      high = Math.max(high, alone[i + 1]);
      // Inside the box (to a cell's middle).
      assert.ok(near.clone().expandByScalar(PART_SPREAD).containsPoint(new THREE.Vector3(alone[i], alone[i + 1], alone[i + 2])), `${alone[i]},${alone[i + 1]},${alone[i + 2]}`);
    }
    // From the box's bottom to its top, not the small box round the point.
    assert.ok(low <= near.min.y + PART_SPREAD && high >= near.max.y - PART_SPREAD, `${low}..${high}`);
    assert.ok(alone.length / 3 > 8, String(alone.length));
  });

  test("the handlebar and the post, seen from three-quarters: the box on the stage reaches down the post to the box's bottom, and the bubble keeps off the post", () => {
    const camera = new THREE.PerspectiveCamera(22, 749 / 742, 0.05, 100);
    camera.position.set(2.6, 1.6, 3.0);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const stage = { width: 749, height: 742 };
    const screen = (v: THREE.Vector3) => {
      const p = v.clone().project(camera);
      return { x: ((p.x + 1) / 2) * stage.width, y: ((1 - p.y) / 2) * stage.height };
    };
    const extent = screenExtent(partPoints([handlebar, post], target), vp, stage.width, stage.height)!;
    // Where the post leaves the box's bottom.
    const foot = screen(along((near.min.y - middle.y) / Math.cos(lean)));
    assert.ok(extent.y + extent.h >= foot.y - 0.5, JSON.stringify({ extent, foot }));
    // Down the post's middle, inside the box.
    const column = Array.from({ length: 60 }, (_, i) => along(-0.9 + (1.8 * i) / 59))
      .filter((p) => near.containsPoint(p))
      .map(screen);
    assert.ok(column.length > 20, String(column.length));
    const box = { x: extent.x - 3, y: extent.y - 3, w: extent.w + 6, h: extent.h + 6 };
    const rect = placeBubble({ stage, size: { w: 270, h: 320 }, anchor: screen(target), part: box, avoid: [], last: null });
    assert.ok(column.every((p) => !(p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h)), JSON.stringify({ rect, box }));
    // The handlebar alone (the post's corners all outside the box, as the points were) left most of the post out.
    const bar = screenExtent(partPoints([handlebar], target), vp, stage.width, stage.height)!;
    assert.ok(bar.y + bar.h < foot.y - 40, JSON.stringify({ bar, foot }));
  });
});

describe("docked on a narrow stage", () => {
  test("a phone's stage (or a short one) docks it across the top; a tablet's and a wide one float it", () => {
    assert.equal(bubbleDocked({ width: 390, height: 320 }), true);
    assert.equal(bubbleDocked({ width: 900, height: 300 }), true);
    assert.equal(bubbleDocked({ width: 820, height: 480 }), false);
    assert.equal(bubbleDocked({ width: 750, height: 780 }), false);
    assert.equal(bubbleFits({ width: 390, height: 320 }), true);
    assert.equal(bubbleFits({ width: 844, height: 150 }), false);
  });

  test("the strip: across the stage inside its margins, its height off the callouts' top", () => {
    assert.deepEqual(stripRect({ width: 390, height: 320 }), { x: BUBBLE_MARGIN, y: BUBBLE_MARGIN, w: 390 - BUBBLE_MARGIN * 2, h: STRIP_HEIGHT });
    assert.equal(stripTop(), BUBBLE_MARGIN + STRIP_HEIGHT);
  });
});

describe("the leader", () => {
  const rect: Rect = { x: 500, y: 100, w: 240, h: 300 };

  test("from the edge facing the part, straight edge not corner, to the part's point", () => {
    const left = leaderOf(rect, { x: 375, y: 250 });
    assert.deepEqual(left, { from: { x: 500, y: 250 }, to: { x: 375, y: 250 } });
    // Below and to the left: from the bottom edge, in from the corner.
    const below = leaderOf(rect, { x: 480, y: 600 });
    assert.ok(below && below.from.y === 400 && below.from.x > 500 && below.from.x < 520, JSON.stringify(below));
    // Above and well to the left: from the left edge, in from its corner.
    const high = leaderOf(rect, { x: 200, y: 90 });
    assert.ok(high && high.from.x === 500 && high.from.y > 100 && high.from.y <= 110, JSON.stringify(high));
  });

  test("none when the part is off the stage, under the bubble, or right at its edge", () => {
    assert.equal(leaderOf(rect, null), null);
    assert.equal(leaderOf(rect, { x: 600, y: 200 }), null);
    assert.equal(leaderOf(rect, { x: 497, y: 200 }), null);
  });

  test("the strip's: only down from it, when the part is far enough under it", () => {
    const strip = stripRect({ width: 390, height: 320 });
    const down = leaderOf(strip, { x: 200, y: 180 }, { below: true });
    assert.deepEqual(down, { from: { x: 200, y: strip.y + strip.h }, to: { x: 200, y: 180 } });
    assert.equal(leaderOf(strip, { x: 200, y: strip.y + strip.h + 6 }, { below: true }), null);
    assert.equal(leaderOf(strip, { x: 200, y: 40 }, { below: true }), null);
  });

  test("the strip's never runs through the part's own label: down beside it instead, or none", () => {
    const strip = stripRect({ width: 390, height: 320 });
    const anchor = { x: 200, y: 220 };
    // The part's own callout label between the strip and its point.
    const own: Rect = { x: 170, y: 140, w: 70, h: 24 };
    const beside = leaderOf(strip, anchor, { below: true, blocked: [own] });
    assert.ok(beside && beside.from.y === strip.y + strip.h && !lineCrosses(beside.from, beside.to, own), JSON.stringify(beside));
    assert.ok(beside.from.x < own.x || beside.from.x > own.x + own.w, JSON.stringify(beside));
    // A wide label right over the point: no way past it.
    assert.equal(leaderOf(strip, anchor, { below: true, blocked: [{ x: 20, y: 150, w: 350, h: 60 }] }), null);
    // Out of its way, the straight drop.
    assert.deepEqual(leaderOf(strip, anchor, { below: true, blocked: [{ x: 300, y: 140, w: 60, h: 24 }] }), { from: { x: 200, y: strip.y + strip.h }, to: anchor });
  });

  test("a line through a box, or past it", () => {
    const box: Rect = { x: 10, y: 10, w: 20, h: 20 };
    assert.equal(lineCrosses({ x: 0, y: 0 }, { x: 40, y: 40 }, box), true);
    assert.equal(lineCrosses({ x: 0, y: 40 }, { x: 5, y: 0 }, box), false);
    assert.equal(lineCrosses({ x: 20, y: 0 }, { x: 20, y: 5 }, box), false);
    assert.equal(lineCrosses({ x: 20, y: 0 }, { x: 20, y: 15 }, box), true);
  });

  test("a point is on the stage unless it's behind the camera or off an edge", () => {
    const stage = { width: 400, height: 300 };
    assert.deepEqual(onStage({ x: 10, y: 20, behind: false }, stage), { x: 10, y: 20 });
    assert.equal(onStage({ x: 10, y: 20, behind: true }, stage), null);
    assert.equal(onStage({ x: -1, y: 20 }, stage), null);
    assert.equal(onStage({ x: 10, y: 301 }, stage), null);
    assert.equal(onStage(undefined, stage), null);
  });
});
