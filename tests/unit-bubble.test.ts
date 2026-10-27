// Where a part's drawing sits on the examine view's stage: beside the part,
// never over its point, inside the stage, off the callouts' labels, kept
// where it was while that holds (as drawn on whole pixels, through a slow
// turn and a label sweeping by); off other flagged parts and the callouts'
// leaders; a strip across the top on a narrow stage; and the leader from
// the bubble's edge to the part, never through the part's own label.
// Pure: no browser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  BUBBLE_CLEAR,
  BUBBLE_MARGIN,
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
