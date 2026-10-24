import { SYSTEM_LABELS, type DrawnSystem, type Glow, type ZoneState } from "@/lib/diagnose-zones";

// How a system looks for its causes, in the manner of a service manual's
// phantom view: the suspect parts drawn solid in flat, clear colours with a
// dark outline (deep red for high and confirmed, amber for medium), a low
// one only outlined in red, a ruled-out one neutral grey; once a cause is
// confirmed the other suspects are toned down. Nothing glows, pulses or is
// lit from inside. Colour is never the only signal: each system's callout
// carries the cause's number in the Likely causes list and the list's
// likelihood meter, a confirmed one a check, and the key spells it out.
// Pure (no three.js), shared by the 3D unit, the line drawing, the callouts
// and the tests.

export const FLAG_COLOURS = {
  high: "#b3261e",
  confirmed: "#b3261e",
  medium: "#e39b1b",
  low: "#c62d23",
  ruledOut: "#9aa0a6",
} as const;

// Toned down, once another system's cause is confirmed.
export const MUTED_COLOURS = {
  high: "#d6a29c",
  medium: "#ead2a2",
  low: "#d39a94",
} as const;

// The fine lines: every edge, and the dark outline round a flagged part.
export const LINE_COLOURS = {
  edge: "#1d2024",
  flag: "#16181b",
  // The system picked (from the list or the drawing): the app's accent,
  // used only here on the unit.
  active: "#0d8a7a",
  // A picked callout's ring: the accent, deep enough to read on the light
  // plate (5:1); its text stays dark.
  picked: "#085c52",
} as const;

// The plate the unit is drawn on, centre and edge (globals.css .unit-plate):
// every callout mark is checked against both (3:1 for a mark, 4.5:1 for
// text).
export const PLATE = { centre: "#e6e8eb", edge: "#c8cdd2" } as const;

export type ZoneLook = {
  // The colour the system's parts are drawn in, opaque; null: their own
  // materials (as built).
  fill: string | null;
  // The line round the system's parts (weight 2 is twice the usual edge).
  outline: { colour: string; weight: 1 | 2 } | null;
  // On its callout: confirmed (a check) or ruled out (a cross).
  badge: "check" | "cross" | null;
};

export function zoneLook(state: Pick<ZoneState, "glow" | "muted"> | null, { active = false }: { active?: boolean } = {}): ZoneLook {
  const glow: Glow = state?.glow ?? "none";
  const muted = !!state?.muted;
  let look: ZoneLook;
  switch (glow) {
    case "none":
      look = { fill: null, outline: null, badge: null };
      break;
    case "confirmed":
      look = { fill: FLAG_COLOURS.confirmed, outline: { colour: LINE_COLOURS.flag, weight: 2 }, badge: "check" };
      break;
    case "high":
    case "medium":
      look = muted
        ? { fill: MUTED_COLOURS[glow], outline: { colour: LINE_COLOURS.flag, weight: 1 }, badge: null }
        : { fill: FLAG_COLOURS[glow], outline: { colour: LINE_COLOURS.flag, weight: 2 }, badge: null };
      break;
    case "low":
      look = { fill: null, outline: muted ? { colour: MUTED_COLOURS.low, weight: 1 } : { colour: FLAG_COLOURS.low, weight: 2 }, badge: null };
      break;
    case "ruled_out":
      look = { fill: FLAG_COLOURS.ruledOut, outline: { colour: LINE_COLOURS.flag, weight: 1 }, badge: "cross" };
      break;
  }
  if (active) look = { ...look, outline: { colour: LINE_COLOURS.active, weight: 2 } };
  return look;
}

// Lit: what the screen points at (ruled-out systems are done with).
export const isLit = (glow: Glow) => glow === "confirmed" || glow === "high" || glow === "medium" || glow === "low";

// Solid: the body as it is. Phantom: the body in its own paint but
// see-through, with its edges drawn, so the parts inside show.
export type ViewMode = "solid" | "phantom";

// The body's paint in phantom view: see-through, in its own colour, so it
// still looks like the owner's unit. A red one (Indy, Sunset, Solar,
// Havasu Red: many Polaris units) is drawn much greyer, keeping only a hint
// of its hue, so the deep red flagged parts inside stand out from it; a
// dark one (Midnight Blue, Onyx Black, camo) a little more solid, so it
// doesn't wash out to a pale ghost over the light plate.
export function phantomPaint(base: string, { camo = false }: { camo?: boolean } = {}): { colour: string; opacity: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(base.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  let hue = 0;
  if (max !== min) {
    if (max === r) hue = (60 * ((g - b) / (max - min)) + 360) % 360;
    else if (max === g) hue = 60 * ((b - r) / (max - min)) + 120;
    else hue = 60 * ((r - g) / (max - min)) + 240;
  }
  const reddish = saturation > 0.35 && (hue < 28 || hue > 332);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const grey = [0.72, 0.73, 0.75];
  const mix = reddish ? 0.68 : 0;
  const out = [r, g, b].map((c, i) => c + (grey[i] - c) * mix);
  const toHex = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0");
  return { colour: `#${out.map(toHex).join("")}`, opacity: camo || (luminance < 0.12 && !reddish) ? 0.44 : 0.3 };
}

// Phantom once anything is flagged; solid otherwise.
export const modeByDefault = (states: Pick<ZoneState, "glow">[]): ViewMode => (states.some((state) => isLit(state.glow)) ? "phantom" : "solid");

// The callouts and the key: the lit systems by their number, then the
// ruled-out ones (a marker, no number).
export function calloutItems<T extends Pick<ZoneState, "system" | "glow" | "rank">>(states: T[]): { numbered: (T & { system: DrawnSystem; rank: number })[]; ruledOut: (T & { system: DrawnSystem })[] } {
  const drawn = states.filter((state): state is T & { system: DrawnSystem } => state.system !== "other");
  const numbered = drawn
    .filter((state): state is T & { system: DrawnSystem; rank: number } => isLit(state.glow) && state.rank !== null)
    .sort((a, b) => a.rank - b.rank);
  return { numbered, ruledOut: drawn.filter((state) => state.glow === "ruled_out") };
}

// The callout's numbered circle, by state: its fill, ring and number.
// High and confirmed deep red, medium amber (dark number) in a dark amber
// ring, low a red ring on white, toned down once another is confirmed (a
// pale fill in a dark grey ring). Every ring stands out from the plate.
const QUIET_RING = "#6b6f74";
export function calloutMark(glow: Glow, muted: boolean): { fill: string; ring: string; text: string } {
  if (glow === "confirmed") return { fill: FLAG_COLOURS.confirmed, ring: FLAG_COLOURS.confirmed, text: "#ffffff" };
  if (glow === "high") return muted ? { fill: MUTED_COLOURS.high, ring: QUIET_RING, text: "#3b1512" } : { fill: FLAG_COLOURS.high, ring: FLAG_COLOURS.high, text: "#ffffff" };
  if (glow === "medium") return muted ? { fill: MUTED_COLOURS.medium, ring: QUIET_RING, text: "#3d2a07" } : { fill: FLAG_COLOURS.medium, ring: "#7a5208", text: "#1f1503" };
  if (glow === "low") return muted ? { fill: "#ffffff", ring: "#8a4a45", text: "#8a4a45" } : { fill: "#ffffff", ring: FLAG_COLOURS.low, text: FLAG_COLOURS.low };
  return { fill: "#ffffff", ring: "#6b7076", text: "#5f656b" };
}

// WCAG contrast between two colours.
export function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

export const METER_LIT: Partial<Record<Glow, number>> = { high: 3, medium: 2, low: 1 };

const GLOW_WORDS: Record<Glow, string> = {
  confirmed: "confirmed",
  high: "high likelihood",
  medium: "medium likelihood",
  low: "low likelihood",
  ruled_out: "ruled out",
  none: "",
};

// As the key says it.
export const KEY_WORDS: Record<Exclude<Glow, "none">, string> = {
  confirmed: "Confirmed",
  high: "High",
  medium: "Medium",
  low: "Low",
  ruled_out: "Ruled out",
};

// What a screen reader hears for the whole 3D unit (role img).
export function unitSummary(name: string, states: Pick<ZoneState, "system" | "glow">[]) {
  const shown = states.filter((state) => state.system !== "other");
  const lit = shown.filter((state) => isLit(state.glow));
  const ruledOut = shown.filter((state) => state.glow === "ruled_out");
  if (lit.length === 0 && ruledOut.length === 0) return `${name}, 3D model: no systems highlighted yet.`;
  const parts = [
    lit.length > 0 && `highlighted: ${lit.map((state) => `${SYSTEM_LABELS[state.system]} (${GLOW_WORDS[state.glow]})`).join(", ")}`,
    ruledOut.length > 0 && `ruled out: ${ruledOut.map((state) => SYSTEM_LABELS[state.system]).join(", ")}`,
  ].filter(Boolean);
  return `${name}, 3D model; ${parts.join("; ")}.`;
}

export const glowWords = (glow: Glow) => GLOW_WORDS[glow];
