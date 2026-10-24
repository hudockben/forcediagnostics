import type { DrawnSystem } from "@/lib/diagnose-zones";

import type { P2 } from "./iso";

// Where the lit systems' callouts go, as in a service manual: a numbered
// circle with the system's name beside it, in a band above the drawing (for
// parts in its upper half) and one below, a thin leader from the circle to
// the part. The likeliest systems take the row nearest the drawing, as many
// as fit; the rest go a row further out. In a row, callouts keep their
// parts' left-to-right order, each circle as near above or below its part
// as the others allow, so leaders don't cross each other.
// No leader runs through another label: a label in an outer row has its
// leader drop through a gap in the rows inside it, moving over the gap if
// it can, or else running along the channel between the rows to it.
// font is the label's text size in drawing units: the drawing scales as a
// whole, so labels keep their size relative to it at any width.
// A compact callout is its numbered circle alone (the key under the unit
// names it), for a narrow plate or where full labels won't fit; fitCallouts
// picks, so that nothing is ever laid out off the plate.

export type CalloutInput = { zone: DrawnSystem; anchor: P2; text: string; rank?: number; compact?: boolean };
export type Rect = { x: number; y: number; w: number; h: number };
export type Callout = CalloutInput &
  Rect & {
    band: "top" | "bottom";
    row: number;
    // From the part to the label's inner edge.
    leader: P2[];
    // Where a tap picks it: the label and half the space around it, so
    // neighbours' targets never overlap.
    hit: Rect;
  };

// Average glyph width of the UI font, as a share of its size, and room for
// the numbered circle at the label's start and the likelihood meter after
// the name.
const GLYPH = 0.58;
export const calloutWidth = (text: string, font: number) => text.length * font * GLYPH + font * 3.7;
const widthOf = (item: CalloutInput, font: number) => (item.compact ? font * 2 : calloutWidth(item.text, font));

// Where a leader meets its callout: the numbered circle's middle, this far
// in from the label's start (a share of the label's height).
export const CIRCLE_AT = 0.5;

type Band = "top" | "bottom";
type Slot = { item: CalloutInput; w: number; h: number; x: number };

// Labels of a row, in their parts' order, each centred on its part, then
// pushed apart and back inside the drawing's width.
function spread(slots: Slot[], box: Rect, gap: number) {
  slots.sort((a, b) => a.item.anchor[0] - b.item.anchor[0]);
  for (const slot of slots) slot.x = slot.item.anchor[0] - slot.h * CIRCLE_AT;
  for (let i = 1; i < slots.length; i++) slots[i].x = Math.max(slots[i].x, slots[i - 1].x + slots[i - 1].w + gap);
  const last = slots.at(-1);
  if (last && last.x + last.w > box.x + box.w) {
    last.x = box.x + box.w - last.w;
    for (let i = slots.length - 2; i >= 0; i--) slots[i].x = Math.min(slots[i].x, slots[i + 1].x - gap - slots[i].w);
  }
  if (slots.length > 0 && slots[0].x < box.x) {
    const shift = box.x - slots[0].x;
    for (const slot of slots) slot.x += shift;
  }
}

export function layoutCallouts(items: CalloutInput[], box: Rect, font: number): { callouts: Callout[]; box: Rect } {
  const h = font * 2;
  // Between labels in a row, between rows (and the first row and the
  // drawing), and a leader's clearance from the labels it passes. Circles
  // alone sit further apart, so each still has a finger-sized target.
  const allCompact = items.length > 0 && items.every((item) => item.compact);
  const gap = font * (allCompact ? 1.5 : 0.9);
  const rowGap = font * (allCompact ? 0.9 : 0.55);
  const clear = font * 0.3;
  const middle = box.y + box.h * 0.48;
  const callouts: Callout[] = [];
  let top = box.y;
  let bottom = box.y + box.h;
  let left = box.x;

  // Each label in the band on its part's side of the middle; but when one
  // band needs a second row and the other has room, the label nearest the
  // middle crosses over (a longer leader beats a row more).
  const bandOf = new Map<CalloutInput, Band>(items.map((item) => [item, item.anchor[1] < middle ? "top" : "bottom"]));
  const width = (band: Band) =>
    items.filter((item) => bandOf.get(item) === band).reduce((sum, item, i) => sum + (i > 0 ? gap : 0) + widthOf(item, font), 0);
  for (let moves = 0; moves < items.length; moves++) {
    const full = (["top", "bottom"] as Band[]).find((band) => width(band) > box.w);
    if (!full) break;
    const other: Band = full === "top" ? "bottom" : "top";
    const nearest = items
      .filter((item) => bandOf.get(item) === full)
      .sort((a, b) => Math.abs(a.anchor[1] - middle) - Math.abs(b.anchor[1] - middle))[0];
    bandOf.set(nearest, other);
    if (width(other) > box.w) {
      bandOf.set(nearest, full);
      break;
    }
  }

  for (const band of ["top", "bottom"] as Band[]) {
    const edge = band === "top" ? box.y : box.y + box.h;
    const rowY = (row: number) => (band === "top" ? box.y - rowGap - h - row * (h + rowGap) : edge + rowGap + row * (h + rowGap));
    const innerEdge = (row: number) => (band === "top" ? rowY(row) + h : rowY(row));
    // The leaders placed in this band so far.
    const placed: [P2, P2][] = [];
    // Between row - 1 and row: where a leader runs across to its label.
    const channel = (row: number) => (band === "top" ? rowY(row) + h + rowGap / 2 : rowY(row) - rowGap / 2);

    // Rows: the likeliest first, as many as fit in each.
    const waiting = items
      .filter((item) => bandOf.get(item) === band)
      .map((item) => ({ item, w: Math.min(widthOf(item, font), box.w), h, x: 0 }))
      .sort((a, b) => (b.item.rank ?? 0) - (a.item.rank ?? 0) || a.item.anchor[0] - b.item.anchor[0]);
    const rows: Slot[][] = [];
    while (waiting.length > 0) {
      const row: Slot[] = [];
      let used = 0;
      for (const slot of [...waiting]) {
        const need = (row.length > 0 ? gap : 0) + slot.w;
        if (row.length === 0 || used + need <= box.w) {
          row.push(slot);
          used += need;
          waiting.splice(waiting.indexOf(slot), 1);
        }
      }
      rows.push(row);
    }

    rows.forEach((row, index) => {
      spread(row, box, gap);
      // The rows inside this one, where a leader can't pass.
      const blocked = rows.slice(0, index).flat().map((slot) => [slot.x - clear, slot.x + slot.w + clear] as const);
      const free = (x: number) => x >= box.x && x <= box.x + box.w && blocked.every(([a, b]) => x <= a || x >= b);
      // The free spot nearest `want`; for a leader from `from`, one whose
      // run to the drawing's edge crosses no leader already placed, if any.
      const nearestFree = (want: number, lo: number, hi: number, from?: P2) => {
        const options = [want, lo, hi, ...blocked.flat()]
          .map((x) => Math.min(Math.max(x, lo), hi))
          .filter(free)
          .sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
        if (options.length === 0) return null;
        if (!from) return options[0];
        return options.find((x) => !placed.some((segment) => segmentsCross([from, [x, edge]], segment))) ?? options[0];
      };
      row.forEach((slot, i) => {
        // The leader meets the label at its numbered circle.
        const inset = h * CIRCLE_AT;
        let pass = nearestFree(slot.x + inset, slot.x + inset, slot.x + inset);
        if (pass === null && index > 0) {
          // Move over a gap in the rows inside, if the neighbours allow.
          const left = i > 0 ? row[i - 1].x + row[i - 1].w + gap : box.x;
          const right = (i < row.length - 1 ? row[i + 1].x - gap : box.x + box.w) - slot.w;
          const via = right >= left ? nearestFree(slot.item.anchor[0], left + inset, right + inset, slot.item.anchor) : null;
          if (via !== null) {
            slot.x = via - inset;
            pass = via;
          }
        }
        const y = rowY(index);
        const inner = innerEdge(index);
        let leader: P2[];
        if (pass !== null) {
          leader = [slot.item.anchor, [pass, edge], [pass, inner]];
        } else {
          // Down through the nearest gap, then along the channel; with no
          // gap at all (a crowd of labels), down the left margin.
          const via = nearestFree(slot.item.anchor[0], box.x + clear, box.x + box.w - clear, slot.item.anchor) ?? box.x - clear * 2;
          left = Math.min(left, via - clear);
          const at = slot.x + inset;
          leader = [slot.item.anchor, [via, edge], [via, channel(index)], [at, channel(index)], [at, inner]];
        }
        const outermost = index === rows.length - 1;
        // Half way to the neighbours (a hair less, for the rounding below).
        const pad = { side: gap * 0.48, inner: rowGap * 0.48, outer: outermost ? font * (allCompact ? 0.95 : 0.6) : rowGap * 0.48 };
        const hit: Rect =
          band === "top"
            ? { x: slot.x - pad.side, y: y - pad.outer, w: slot.w + pad.side * 2, h: h + pad.outer + pad.inner }
            : { x: slot.x - pad.side, y: y - pad.inner, w: slot.w + pad.side * 2, h: h + pad.inner + pad.outer };
        callouts.push({ ...slot.item, band, row: index, x: slot.x, y, w: slot.w, h, leader: dropRepeats(leader), hit });
        placed.push(...segmentsOf(leader));
        if (band === "top") top = Math.min(top, hit.y);
        else bottom = Math.max(bottom, hit.y + hit.h);
      });
    });
  }

  // Two decimals are plenty on screen, and keep the markup small.
  const r = (n: number) => Math.round(n * 100) / 100;
  const rect = <T extends Rect>(v: T): T => ({ ...v, x: r(v.x), y: r(v.y), w: r(v.w), h: r(v.h) });
  return {
    callouts: callouts.map((c) => ({ ...rect(c), leader: c.leader.map(([x, y]): P2 => [r(x), r(y)]), hit: rect(c.hit) })),
    box: rect({ x: left, y: top, w: box.x + box.w - left, h: bottom - top }),
  };
}

// Whether every callout lies inside the bounds.
export function calloutsInside(callouts: Pick<Callout, "x" | "y" | "w" | "h">[], bounds: Rect, slack = 0.5) {
  return callouts.every((c) => c.x >= bounds.x - slack && c.y >= bounds.y - slack && c.x + c.w <= bounds.x + bounds.w + slack && c.y + c.h <= bounds.y + bounds.h + slack);
}

// Callouts laid out to stay inside `bounds` (the canvas, less any bars over
// it): full labels when they fit; else numbered circles alone (the
// service-manual way; the key underneath names them); else, as a last
// resort, each pulled back inside. Never off the edge, never clipped. With
// a system picked (`keep`: full screen, closed in on it, the machine filling
// the view behind the labels) only its label is spelt out, the others are
// numbers.
export function fitCallouts(
  items: CalloutInput[],
  box: Rect,
  font: number,
  bounds: Rect,
  { keep = null, compactOnly = false }: { keep?: DrawnSystem | null; compactOnly?: boolean } = {},
): { callouts: Callout[]; box: Rect; compact: boolean } {
  const tries: CalloutInput[][] = [];
  const picked = !!keep && items.some((item) => item.zone === keep);
  if (!compactOnly && !picked) tries.push(items.map((item) => ({ ...item, compact: false })));
  if (picked) tries.push(items.map((item) => ({ ...item, compact: item.zone !== keep })));
  tries.push(items.map((item) => ({ ...item, compact: true })));
  let last: { callouts: Callout[]; box: Rect } | null = null;
  for (const attempt of tries) {
    last = layoutCallouts(attempt, box, font);
    if (calloutsInside(last.callouts, bounds)) return { ...last, compact: attempt.some((item) => item.compact) };
  }
  // Pulled inside: the label and its target moved, the leader's run to it
  // moved with it (it still starts at the part).
  const r = (n: number) => Math.round(n * 100) / 100;
  const callouts = last!.callouts.map((c) => {
    const dx = Math.min(Math.max(c.x, bounds.x), bounds.x + bounds.w - c.w) - c.x;
    const dy = Math.min(Math.max(c.y, bounds.y), bounds.y + bounds.h - c.h) - c.y;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return c;
    const leader = c.leader.map(([x, y], i): P2 => (i === 0 ? [x, y] : [r(x + dx), r(i === c.leader.length - 1 ? y + dy : y)]));
    const hx = Math.max(bounds.x, c.hit.x + dx);
    const hy = Math.max(bounds.y, c.hit.y + dy);
    const hit = { x: r(hx), y: r(hy), w: r(Math.min(bounds.x + bounds.w, c.hit.x + dx + c.hit.w) - hx), h: r(Math.min(bounds.y + bounds.h, c.hit.y + dy + c.hit.h) - hy) };
    return { ...c, x: r(c.x + dx), y: r(c.y + dy), leader, hit };
  });
  return { callouts, box: last!.box, compact: true };
}

// --- Drawing a callout ---------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

// Where a callout's numbered circle is, for its label rectangle.
export function circleOf(callout: Pick<Callout, "x" | "y" | "h">, font: number) {
  return { cx: round2(callout.x + callout.h * CIRCLE_AT), cy: round2(callout.y + callout.h / 2), r: round2(font * 0.74) };
}

// The leader from the part to the numbered circle's edge.
export function leaderPath(callout: Pick<Callout, "leader" | "band" | "x" | "y" | "h">, font: number) {
  const { cy, r } = circleOf(callout, font);
  const points = callout.leader.map(([x, y]) => [x, y] as [number, number]);
  const last = points[points.length - 1];
  last[1] = round2(callout.band === "top" ? cy + r : cy - r);
  return `M${points.map(([x, y]) => `${x} ${y}`).join("L")}`;
}

function dropRepeats(points: P2[]): P2[] {
  return points.filter((point, i) => i === 0 || Math.hypot(point[0] - points[i - 1][0], point[1] - points[i - 1][1]) > 1e-6);
}

// --- For the tests ----------------------------------------------------------------

type Segment = [P2, P2];

export const segmentsOf = (leader: P2[]): Segment[] => leader.slice(1).map((point, i) => [leader[i], point]);

// Whether a segment passes through a rectangle's inside.
export function segmentHitsRect([a, b]: Segment, r: Rect): boolean {
  // Liang–Barsky clipping against the open rectangle.
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const sides: [number, number][] = [
    [-dx, a[0] - r.x],
    [dx, r.x + r.w - a[0]],
    [-dy, a[1] - r.y],
    [dy, r.y + r.h - a[1]],
  ];
  for (const [p, q] of sides) {
    if (Math.abs(p) < 1e-12) {
      if (q <= 1e-9) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1 - 1e-9) return false;
  }
  return true;
}

// Whether two segments cross (touching at an end doesn't count).
export function segmentsCross([a, b]: Segment, [c, d]: Segment): boolean {
  const orient = (p: P2, q: P2, r: P2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < -1e-9 && o3 * o4 < -1e-9;
}

// How many pairs of leaders cross.
export function leaderCrossings(callouts: Callout[]): number {
  let count = 0;
  for (let i = 0; i < callouts.length; i++) {
    for (let j = i + 1; j < callouts.length; j++) {
      const crosses = segmentsOf(callouts[i].leader).some((s) => segmentsOf(callouts[j].leader).some((t) => segmentsCross(s, t)));
      if (crosses) count++;
    }
  }
  return count;
}
