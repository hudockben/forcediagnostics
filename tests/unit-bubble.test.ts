// Where a part's drawing sits on the examine view's stage: beside the part,
// never over its point, inside the stage, off the callouts' labels, kept
// where it was while that holds; a strip across the top on a narrow stage;
// and the leader from the bubble's edge to the part. Pure: no browser.
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
  onStage,
  overlap,
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

  test("a point is on the stage unless it's behind the camera or off an edge", () => {
    const stage = { width: 400, height: 300 };
    assert.deepEqual(onStage({ x: 10, y: 20, behind: false }, stage), { x: 10, y: 20 });
    assert.equal(onStage({ x: 10, y: 20, behind: true }, stage), null);
    assert.equal(onStage({ x: -1, y: 20 }, stage), null);
    assert.equal(onStage({ x: 10, y: 301 }, stage), null);
    assert.equal(onStage(undefined, stage), null);
  });
});
