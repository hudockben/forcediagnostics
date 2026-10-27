// Where a part's drawing goes on the examine view's stage: a bubble with
// the manual's own drawing of the part picked (src/app/(app)/diagnose/
// drawing-bubble.tsx), in free space beside the part, and a thin leader
// from the bubble to the part's callout point. Beside it, never over it:
// the bubble keeps clear of the point, inside the stage, off the callouts'
// labels (and the dots where their leaders meet the machine), as near the
// part as that allows, and where it was while that still holds, so it
// stays put as the camera turns or flies and only its leader follows the
// part. On a narrow (or short) stage it's a strip docked across the top
// instead, its leader down to the part when there's room under it. Pure:
// stage pixels in, a box and a line out.

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };
export type Stage = { width: number; height: number };

// From the stage's edges.
export const BUBBLE_MARGIN = 10;
// From the part's point: room for the part itself round it.
export const BUBBLE_CLEAR = 56;
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
  // What the bubble mustn't cover: the callouts' labels and dots.
  avoid: Rect[];
  // Where it was: kept while it's still clear.
  last: Rect | null;
  margin?: number;
  clear?: number;
};

// The bubble's box, floating beside the part.
export function placeBubble({ stage, size, anchor, avoid, last, margin = BUBBLE_MARGIN, clear = BUBBLE_CLEAR }: PlaceInput): Rect {
  const w = Math.max(0, Math.min(size.w, stage.width - margin * 2));
  const h = Math.max(0, Math.min(size.h, stage.height - margin * 2));
  const at = (x: number, y: number): Rect => ({ x: clamp(x, margin, stage.width - margin - w), y: clamp(y, margin, stage.height - margin - h), w, h });
  const covered = (rect: Rect) => avoid.reduce((sum, other) => sum + overlap(rect, other), 0);
  const tooNear = (rect: Rect) => (anchor ? Math.max(0, clear - distanceTo(rect, anchor)) : 0);

  if (last) {
    const kept = at(last.x, last.y);
    if (covered(kept) === 0 && tooNear(kept) === 0) return kept;
  }

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
  candidates.push(...corners);
  // Each moved just past a label it would cover (between two rows of
  // callouts, say), up or down, then left or right.
  for (const rect of [...candidates]) {
    for (const other of avoid) {
      if (overlap(rect, other) === 0) continue;
      candidates.push(at(rect.x, other.y + other.h + 4), at(rect.x, other.y - h - 4), at(other.x + other.w + 4, rect.y), at(other.x - w - 4, rect.y));
    }
  }

  // Clear of the part first, then of the labels, then the nearest the
  // part (the shortest leader), a little to its right where it's a tie.
  let best = candidates[0];
  let bestScore = Infinity;
  for (const rect of candidates) {
    const near = anchor ? distanceTo(rect, anchor) : 0;
    const right = anchor && rect.x >= anchor.x ? -4 : 0;
    const score = tooNear(rect) * 1e6 + covered(rect) * 50 + near + right;
    if (score < bestScore - 1e-6) {
      best = rect;
      bestScore = score;
    }
  }
  return best;
}

export type Leader = { from: Point; to: Point };

// The leader from the bubble's edge facing the part to the part's point:
// none when the point is off the stage, under the bubble, or too near it
// to draw. `below` keeps it to the box's bottom edge (the strip: a leader
// only down from it, when the part is far enough under it).
export function leaderOf(rect: Rect, anchor: Point | null, { below = false } = {}): Leader | null {
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
  return { from, to: anchor };
}
