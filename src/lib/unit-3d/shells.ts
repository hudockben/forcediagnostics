// Where a black arch liner (or a flare) round a wheel starts and ends.
// Pure geometry, for the side-by-sides and ATVs.

// The angles (0 straight ahead, pi straight back) an arch liner of radius
// r round a wheel's middle (x, cy) runs between: from where it rises above
// `base` (a liner doesn't hang below the panels round it), and no further
// than the panels' ends (clipFront, clipBack).
export function archSpan(x: number, cy: number, r: number, base: number, clipFront: number, clipBack: number): [number, number] {
  const lift = Math.asin(Math.min(1, Math.max(0, (base - cy) / r)));
  const atFront = Math.acos(Math.min(1, Math.max(-1, (clipFront - x) / r)));
  const atBack = Math.PI - Math.acos(Math.min(1, Math.max(-1, (x - clipBack) / r)));
  return [Math.max(lift, atFront) + 0.02, Math.min(Math.PI - lift, atBack) - 0.02];
}
