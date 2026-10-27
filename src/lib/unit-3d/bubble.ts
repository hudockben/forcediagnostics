// Where a part's drawing goes on the examine view's stage: a bubble with
// the manual's own drawing of the part picked (src/app/(app)/diagnose/
// drawing-bubble.tsx), in free space beside the part, and a thin leader
// from the bubble to the part's callout point. Beside it, never over it:
// the bubble keeps off the part itself (the box round its shape on the
// stage, focus.ts, however big the part: a General's transmission, a fuel
// tank) and clear of its point, inside the stage, off the callouts' labels
// (and the dots where their leaders meet the machine, the other flagged
// parts round their points, and as far as it can their leaders), as near
// the part as that allows, and where it was while that still holds (with a
// little slack), so it stays put as the camera turns or flies and only its
// leader follows the part. Where nowhere on the stage is clear of the part
// (zoomed in on it, the part filling the stage), it covers as little of it
// as it can, against the stage's edge farthest from the part's middle. On
// a narrow (or short) stage it's a strip docked across the top instead,
// its leader down to the part when there's room under it. Pure: stage
// pixels in, a box and a line out.

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };
export type Stage = { width: number; height: number };

// From the stage's edges.
export const BUBBLE_MARGIN = 10;
// From the part's point: room for the part itself round it (a small part,
// or one whose shape isn't known).
export const BUBBLE_CLEAR = 56;
// From the part's box, placed anew; kept while it's clear of the box at
// all (the box moves a little under the camera).
export const PART_GAP = 12;
// Narrower or shorter than this, the bubble is a strip across the top.
export const DOCK_BELOW = { width: 560, height: 360 } as const;
// The strip's height, and the least room under it for a leader.
export const STRIP_HEIGHT = 84;
const LEADER_ROOM = 14;
// Shorter than this a stage has no room for a strip at all: no bubble
// (the sheet beside it has the drawings large).
export const NO_BUBBLE_BELOW = 200;
// A leader shorter than this isn't drawn.
const SHORTEST_LEADER = 6;
// The bubble's rounded corners: a leader leaves from a straight edge.
const CORNER = 10;

export const bubbleDocked = (stage: Stage) => stage.width < DOCK_BELOW.width || stage.height < DOCK_BELOW.height;
export const bubbleFits = (stage: Stage) => stage.height >= NO_BUBBLE_BELOW && stage.width >= 2;

// The strip's box: across the stage's top, inside its margins.
export const stripRect = (stage: Stage, margin = BUBBLE_MARGIN): Rect => ({ x: margin, y: margin, w: Math.max(0, stage.width - margin * 2), h: STRIP_HEIGHT });
// What the strip takes off the top of the stage (the callouts go under it).
export const stripTop = (margin = BUBBLE_MARGIN) => margin + STRIP_HEIGHT;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

export function overlap(a: Rect, b: Rect) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// How far a point is from a box (0 inside it).
export function distanceTo(rect: Rect, point: Point) {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

// A point on the stage (not behind the camera, not off its edges), or null.
export function onStage(point: { x: number; y: number; behind?: boolean } | null | undefined, stage: Stage): Point | null {
  if (!point || point.behind || point.x < 0 || point.y < 0 || point.x > stage.width || point.y > stage.height) return null;
  return { x: point.x, y: point.y };
}

export type PlaceInput = {
  stage: Stage;
  size: { w: number; h: number };
  // The part's point on the stage; null when it's off it (then anywhere
  // free will do, and there's no leader).
  anchor: Point | null;
  // The part itself on the stage: the box round its shape (it may reach
  // past the stage's edges). Never covered while there's room clear of it.
  part?: Rect | null;
  // What the bubble mustn't cover: the callouts' labels and dots, the
  // other flagged parts' points.
  avoid: Rect[];
  // What it had better not cover, but isn't moved past: the callouts'
  // leaders (as short pieces along them).
  soft?: Rect[];
  // Where it was: kept while it's still clear.
  last: Rect | null;
  margin?: number;
  clear?: number;
};

// Where it was is kept while it's within this of the part's clearance (a
// point that moves a little under the camera, or lands half a pixel nearer
// a box drawn on whole pixels, doesn't send it across the part), and while
// it covers the labels by no more than this round their edges.
export const KEEP_SLACK = 8;
const KEEP_EDGE = 2;
// With nowhere clear of the part, places that cover this share of the
// bubble more of the part than the least are as good (the farthest from
// the part's middle of them wins, and where it was is kept among them).
const COVER_TIE = 0.02;
// A pixel nearer the part's point than its clearance counts as this many
// square pixels of the part covered.
const NEAR_WEIGHT = 100;

const inset = (rect: Rect, by: number): Rect => ({ x: rect.x + by, y: rect.y + by, w: Math.max(0, rect.w - by * 2), h: Math.max(0, rect.h - by * 2) });
const centreOf = (rect: Rect): Point => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
// What of a box is on the stage (its edge nearest the stage, when none is).
function onStageOf(rect: Rect, stage: Stage): Rect {
  const x = clamp(rect.x, 0, stage.width);
  const y = clamp(rect.y, 0, stage.height);
  return { x, y, w: Math.max(0, clamp(rect.x + rect.w, 0, stage.width) - x), h: Math.max(0, clamp(rect.y + rect.h, 0, stage.height) - y) };
}

// The bubble's box, floating beside the part.
export function placeBubble({ stage, size, anchor, part = null, avoid, soft = [], last, margin = BUBBLE_MARGIN, clear = BUBBLE_CLEAR }: PlaceInput): Rect {
  const w = Math.max(0, Math.min(size.w, stage.width - margin * 2));
  const h = Math.max(0, Math.min(size.h, stage.height - margin * 2));
  const at = (x: number, y: number): Rect => ({ x: clamp(x, margin, stage.width - margin - w), y: clamp(y, margin, stage.height - margin - h), w, h });
  const sum = (rect: Rect, rects: Rect[]) => rects.reduce((total, other) => total + overlap(rect, other), 0);
  const covered = (rect: Rect) => sum(rect, avoid) * 50 + sum(rect, soft) * 20;
  const tooNear = (rect: Rect, by = clear) => (anchor ? Math.max(0, by - distanceTo(rect, anchor)) : 0);
  // How much of the part it covers (its box grown by `by`), and how near
  // its point it is: none of either is clear of the part.
  const grown = (by: number) => (part ? { x: part.x - by, y: part.y - by, w: part.w + by * 2, h: part.h + by * 2 } : null);
  const onPart = (rect: Rect, by: number, near = clear) => {
    const box = grown(by);
    return (box ? overlap(rect, box) : 0) + tooNear(rect, near) * NEAR_WEIGHT;
  };
  const edges = [...avoid, ...soft].map((other) => inset(other, KEEP_EDGE));
  const kept = last ? at(last.x, last.y) : null;
  if (kept && sum(kept, edges) === 0 && onPart(kept, 0, clear - KEEP_SLACK) === 0) return kept;

  const candidates: Rect[] = [];
  const corners = [at(margin, margin), at(stage.width, margin), at(margin, stage.height), at(stage.width, stage.height)];
  if (anchor) {
    // Right of the part, then left, level with it or along the stage's
    // edges; then above and below it.
    const ys = [anchor.y - h / 2, anchor.y - h + clear, anchor.y - clear, margin, stage.height];
    for (const x of [anchor.x + clear, anchor.x - clear - w]) for (const y of ys) candidates.push(at(x, y));
    const xs = [anchor.x - w / 2, anchor.x + clear - w, anchor.x - clear, margin, stage.width];
    for (const y of [anchor.y - clear - h, anchor.y + clear]) for (const x of xs) candidates.push(at(x, y));
  }
  if (part) {
    // The same round the part's box: past its right, its left, above and
    // below it, level with its point, its edges or the stage's.
    const level = anchor ?? centreOf(part);
    const ys = [level.y - h / 2, part.y, part.y + part.h - h, margin, stage.height];
    for (const x of [part.x + part.w + PART_GAP, part.x - PART_GAP - w]) for (const y of ys) candidates.push(at(x, y));
    const xs = [level.x - w / 2, part.x, part.x + part.w - w, margin, stage.width];
    for (const y of [part.y - PART_GAP - h, part.y + part.h + PART_GAP]) for (const x of xs) candidates.push(at(x, y));
    // Against each edge of the stage, half way along it.
    candidates.push(at(margin, (stage.height - h) / 2), at(stage.width, (stage.height - h) / 2), at((stage.width - w) / 2, margin), at((stage.width - w) / 2, stage.height));
  }
  candidates.push(...corners);
  // Each moved just past a label it would cover (between two rows of
  // callouts, say), up or down, then left or right.
  for (const rect of [...candidates]) {
    for (const other of avoid) {
      if (overlap(rect, other) === 0) continue;
      candidates.push(at(rect.x, other.y + other.h + 4), at(rect.x, other.y - h - 4), at(other.x + other.w + 4, rect.y), at(other.x - w - 4, rect.y));
    }
  }

  // Clear of the part first (its box, with room round it, and its point),
  // then of the labels, then the nearest the part (the shortest leader), a
  // little to its right where it's a tie.
  const clearOf = candidates.filter((rect) => onPart(rect, PART_GAP) === 0);
  if (clearOf.length > 0) {
    let best = clearOf[0];
    let bestScore = Infinity;
    for (const rect of clearOf) {
      const near = anchor ? distanceTo(rect, anchor) : 0;
      const right = anchor && rect.x >= anchor.x ? -4 : 0;
      const score = covered(rect) + near + right;
      if (score < bestScore - 1e-6) {
        best = rect;
        bestScore = score;
      }
    }
    return best;
  }

  // Nowhere clear of it: as little of the part covered as can be (to a
  // share of the bubble), then off the labels, then the farthest from the
  // part's middle (on the stage); where it was, among those as good.
  const cover = (rect: Rect) => onPart(rect, 0);
  const least = Math.min(...candidates.map(cover));
  const tie = least + Math.max(1, w * h * COVER_TIE);
  if (kept && cover(kept) <= tie && sum(kept, edges) === 0) return kept;
  const middle = part ? centreOf(onStageOf(part, stage)) : (anchor ?? { x: stage.width / 2, y: stage.height / 2 });
  let best = candidates[0];
  let bestScore = Infinity;
  for (const rect of candidates) {
    if (cover(rect) > tie) continue;
    const centre = centreOf(rect);
    const score = covered(rect) - Math.hypot(centre.x - middle.x, centre.y - middle.y);
    if (score < bestScore - 1e-6) {
      best = rect;
      bestScore = score;
    }
  }
  return best;
}

// A line on the stage as short square pieces along it, `size` across, at
// most `most` of them (enough to say what it crosses).
export function piecesAlong(points: readonly (readonly [number, number])[], size = 6, most = 12): Rect[] {
  const pieces: Rect[] = [];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const length = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.min(most, Math.max(1, Math.ceil(length / (size * 3))));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      pieces.push({ x: x0 + (x1 - x0) * t - size / 2, y: y0 + (y1 - y0) * t - size / 2, w: size, h: size });
    }
  }
  return pieces;
}

// Whether a straight line from a to b runs through a box.
export function lineCrosses(a: Point, b: Point, rect: Rect) {
  let low = 0;
  let high = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.w - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.h - a.y],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) low = Math.max(low, t);
    else high = Math.min(high, t);
    if (low > high) return false;
  }
  return true;
}

export type Leader = { from: Point; to: Point };

// The leader from the bubble's edge facing the part to the part's point:
// none when the point is off the stage, under the bubble, or too near it
// to draw. `below` keeps it to the box's bottom edge (the strip: a leader
// only down from it, when the part is far enough under it). It doesn't
// run through any of `blocked` (the strip's leader through the part's own
// callout label, which points to the part already, would look tied to the
// label): from the strip's edge beside the label instead, or none.
export function leaderOf(rect: Rect, anchor: Point | null, { below = false, blocked = [] as Rect[] } = {}): Leader | null {
  if (!anchor) return null;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  if (below && anchor.y < bottom + LEADER_ROOM) return null;
  if (distanceTo(rect, anchor) < SHORTEST_LEADER) return null;
  const r = Math.min(CORNER, rect.w / 2, rect.h / 2);
  const along = { x: clamp(anchor.x, rect.x + r, right - r), y: clamp(anchor.y, rect.y + r, bottom - r) };
  const dx = Math.max(rect.x - anchor.x, anchor.x - right, 0);
  const dy = Math.max(rect.y - anchor.y, anchor.y - bottom, 0);
  const from = below || dy >= dx ? { x: along.x, y: anchor.y < rect.y ? rect.y : bottom } : { x: anchor.x < rect.x ? rect.x : right, y: along.y };
  if (Math.hypot(anchor.x - from.x, anchor.y - from.y) < SHORTEST_LEADER) return null;
  const clearOf = (start: Point) => !blocked.some((other) => lineCrosses(start, anchor, other));
  if (clearOf(from)) return { from, to: anchor };
  if (!below) return null;
  // Down from the strip at a slant that passes the label's side (at its
  // bottom edge, where the line is nearest the point under it), the
  // nearer side first.
  const sides = blocked
    .filter((other) => lineCrosses(from, anchor, other))
    .flatMap((other) => {
      const t = (other.y + other.h - bottom) / (anchor.y - bottom);
      if (t <= 0 || t >= 1) return [];
      const past = (x: number) => (x - anchor.x * t) / (1 - t);
      return [past(other.x - 4), past(other.x + other.w + 4)];
    })
    .filter((x) => x >= rect.x + r && x <= right - r)
    .sort((a, b) => Math.abs(a - anchor.x) - Math.abs(b - anchor.x));
  for (const x of sides) {
    const start = { x, y: bottom };
    if (clearOf(start)) return { from: start, to: anchor };
  }
  return null;
}
