import type { UnitVehicle } from "@/lib/diagnose-zones";
import { brandInfo } from "@/lib/manual-catalog-rules";
import { unitPaint, type UnitPaint } from "@/lib/unit-paint";

// Which unit drawing a conversation gets, and which machine its 3D unit is
// (line, seats, size, paint). Pure, for the server (see unitVehicle in
// src/lib/diagnose-tools.ts) and the tests; the browser only gets the
// answer.

const LABEL_WORDS: [UnitVehicle, RegExp][] = [
  ["utv", /\b(rzr|ranger|general|xpedition|crew|utvs?|side.?by.?sides?)\b/i],
  ["atv", /\b(sportsman|scrambler|atvs?|outlaw|phoenix|trail boss|hawkeye)\b/i],
  ["generator", /\b(generators?)\b/i],
];

const fromBrandVehicle = { UTV: "utv", ATV: "atv", Generator: "generator" } as const satisfies Record<string, UnitVehicle>;

// The drawing for a unit: from the model list's brand codes for its model
// number (RZR, RGR, ATV, GEN, ...) when they agree on one kind of vehicle,
// otherwise from the words in its name; null when neither says.
export function chooseVehicle(unit: { brands: readonly string[]; label: string | null }): UnitVehicle | null {
  const kinds = new Set(
    unit.brands
      .map((code) => brandInfo(code.toUpperCase()).vehicle)
      .filter((vehicle): vehicle is keyof typeof fromBrandVehicle => vehicle in fromBrandVehicle)
      .map((vehicle) => fromBrandVehicle[vehicle]),
  );
  if (kinds.size === 1) return [...kinds][0];
  const label = unit.label ?? "";
  for (const [vehicle, pattern] of LABEL_WORDS) if (pattern.test(label)) return vehicle;
  return null;
}

// Side-by-side lines by name. Polaris lists the 2009-2010 RZR 170 (a youth
// side-by-side) only under ATV; no ATV of its list has these words. Not
// Xpedition: the 2000-2002 Xpedition 325/425 were ATVs.
const SIDE_BY_SIDE_LINES = /\b(rzr|ranger|general)\b/i;

// The whole order: the brand codes listed for the unit's model number; when
// those don't decide it, the codes of the manuals it's using; then the
// words in its name. When the codes say ATV but the unit's name, or the
// titles of its model number's manuals in the list (some numbers are listed
// without a name), have a side-by-side line, it's a side-by-side.
export function vehicleForUnit(unit: {
  numberBrands: readonly string[];
  manualBrands: readonly string[];
  label: string | null;
  numberTitles?: readonly string[];
}): UnitVehicle | null {
  const listed =
    chooseVehicle({ brands: unit.numberBrands, label: null }) ?? chooseVehicle({ brands: unit.manualBrands, label: null });
  if (listed === "atv" && [unit.label, ...(unit.numberTitles ?? [])].some((name) => name && SIDE_BY_SIDE_LINES.test(name))) {
    return "utv";
  }
  return listed ?? chooseVehicle({ brands: [], label: unit.label });
}

// --- Which machine: line, seats, size and paint, for the 3D unit ----------------

// The Polaris lines the 3D unit has a model for. Hawkeye, Trail Boss,
// Magnum and the other utility ATVs are drawn as a Sportsman; Predator,
// Trail Blazer and the adult Outlaw as a Scrambler; the youth Outlaw and
// Phoenix as small sport ATVs; the ACE (one seat) as a General.
export const UNIT_LINES = ["rzr", "ranger", "general", "xpedition", "ace", "sportsman", "scrambler", "outlaw", "phoenix", "generator"] as const;
export type UnitLine = (typeof UNIT_LINES)[number];

export const UNIT_LINE_NAMES: Record<UnitLine, string> = {
  rzr: "RZR",
  ranger: "Ranger",
  general: "General",
  xpedition: "Xpedition",
  ace: "ACE",
  sportsman: "Sportsman",
  scrambler: "Scrambler",
  outlaw: "Outlaw",
  phoenix: "Phoenix",
  generator: "Generator",
};

export const LINE_VEHICLE: Record<UnitLine, UnitVehicle> = {
  rzr: "utv",
  ranger: "utv",
  general: "utv",
  xpedition: "utv",
  ace: "utv",
  sportsman: "atv",
  scrambler: "atv",
  outlaw: "atv",
  phoenix: "atv",
  generator: "generator",
};

export type UnitSize = "youth" | "mid" | "full";

export type UnitSpec = {
  vehicle: UnitVehicle;
  line: UnitLine;
  // Seats, as the machine has them: 1 (ATVs, ACE), 2 (RZR, General, a
  // Sportsman Touring), 3 (a Ranger's bench), 4-6 (RZR 4, General 4, Crew).
  seats: number;
  size: UnitSize;
  // A 6x6 (Sportsman 6x6, Big Boss, Ranger 6x6): a third axle.
  sixWheels: boolean;
  paint: UnitPaint;
};

// Words naming each line, tried in this order on an upper-case text: the
// RZR before the Ranger (the first RZRs were "RANGER RZR"), the General
// before anything else ("POLARIS GENERAL"), the ACE before the Sportsman
// ("SPORTSMAN ACE").
const LINE_WORDS: [UnitLine, RegExp][] = [
  // The Xpedition 325 and 425 of 2000-2002 were utility ATVs.
  ["xpedition", /\bXPEDITION\b(?! ?[34]25)|\bXXP\b/],
  ["generator", /\bGENERATORY?\b|\bGEN(?:ERATOR)?[-\s]?P\d|\bP\d{4}I?E?(?:BT)?\b|\bWATT\b/],
  ["general", /\bGENERAL\b|\bGNL\b|\bGEN-\d\d,/],
  ["rzr", /\bRZR/],
  ["ranger", /\bRANGER\b|\bRGR\b|\bRNGR\b|\bRANEGR\b|\bRGR\d/],
  ["ace", /\bACE\s?\d|\bPOLARIS ACE\b|\bACE\b(?! ?4X4)/],
  ["scrambler", /\bSCRAMBLER\b|\bSCRMBLR\b|\bSCRAM\b|\bSCR\s?\d|\bSCR XP\b|\bPREDATOR\b|\bTRAIL ?BLAZER\b|\bOUTLAW (?:4\d\d|5\d\d)\b/],
  ["outlaw", /\bOUTLAW\b|\bOTLW\b/],
  ["phoenix", /\bPHOENIX\b/],
  ["sportsman", /\bSPORTSMAN|\bSPM\b|\bSPMN|\bSPRTSMN?\b|\bSPRTSM\b|\bSPTMN\b|\bSPTSMN\b|\bSPXP\b|\bHAWKEYE\b|\bTRAIL ?BOSS\b|\bT\.B\.|\bBIG ?BOSS\b|\bMAGNUM\b|\bXPLORER\b|\bWORKER\b|\bATP\b|\bX2\b|\bE?XPEDITION ?[34]25/],
];

// The lines a text names, in the order above.
export function linesNamed(text: string | null | undefined): UnitLine[] {
  const upper = (text ?? "").toUpperCase();
  return LINE_WORDS.filter(([, pattern]) => pattern.test(upper)).map(([line]) => line);
}

// The one line a text names: the first, unless it names lines of two
// kinds of vehicle (a manual title for "Sportsman / Scrambler 850 / 1000"
// names two ATV lines and is still an ATV; "Outlaw 50 / 90 Sportsman 90"
// stays undecided when asked for one line).
function lineOf(text: string | null | undefined, kind: UnitVehicle | null, strict: boolean): UnitLine | null {
  let named = linesNamed(text);
  // The RZR before the Ranger: "RANGER RZR" is a RZR.
  if (named.includes("rzr")) named = named.filter((line) => line !== "ranger");
  // "RGR CREW XP 1000 TRAIL BOSS" is a Ranger edition, not a Trail Boss ATV.
  if (named.some((line) => LINE_VEHICLE[line] === "utv")) named = named.filter((line) => LINE_VEHICLE[line] !== "atv");
  if (kind) named = named.filter((line) => LINE_VEHICLE[line] === kind);
  if (named.length === 0) return null;
  if (strict && named.length > 1) return null;
  return named[0];
}

const BRAND_LINE: Record<string, UnitLine> = { RZR: "rzr", RGR: "ranger", GRL: "general", XXP: "xpedition", GEN: "generator" };

function brandLine(brands: readonly string[]): UnitLine | null {
  const lines = new Set(brands.map((code) => BRAND_LINE[code.toUpperCase()]).filter(Boolean));
  return lines.size === 1 ? [...lines][0] : null;
}

const DEFAULT_LINE: Record<UnitVehicle, UnitLine> = { utv: "ranger", atv: "sportsman", generator: "generator" };

// The engine size in a description: the first number that is one.
const DISPLACEMENTS = new Set([50, 70, 85, 90, 110, 150, 170, 200, 250, 300, 325, 330, 335, 350, 400, 425, 450, 500, 525, 550, 570, 600, 700, 800, 850, 900, 902, 925, 950, 1000, 1500]);
export function displacementOf(text: string): number | null {
  for (const match of text.toUpperCase().matchAll(/(?<![\d.])(\d{2,4})(?![\d.]|X\d)/g)) {
    const n = Number(match[1]);
    if (DISPLACEMENTS.has(n)) return n;
  }
  return null;
}

// Seats, size and a third axle for a line, from a description's words.
export function bodyFor(line: UnitLine, text: string): Pick<UnitSpec, "seats" | "size" | "sixWheels"> {
  const upper = text.toUpperCase();
  const cc = displacementOf(upper);
  const youth = /\bYOUTH\b/.test(upper) || (cc !== null && cc <= 200);
  // "RZR XP 4 1000", "RZR PRO S 4", "TURBO S4", "XP4", "570-4": four seats.
  // "RZR-21,1000S4": a four-seat S 1000.
  const four = /(?<![\w.])(?:XP|S|R|PRO ?XP|PRO ?S|PRO ?R|TURBO|TURBO ?R|TURBO ?S|XP ?1K)?4(?![\w.])|-4\b|\b4P\b|\b\d{3,4}S4\b/.test(upper);
  const sixWheels = /\b6X6\b|\bBIG ?BOSS\b|6X6/.test(upper);
  switch (line) {
    case "rzr":
      return { seats: four && !youth ? 4 : 2, size: youth ? "youth" : /\b570\b|\bTRAIL\b(?! S)|\b50\b|\bRZR 800\b|\bRZR,? ?800\b/.test(upper) && !/\bTRAIL S\b|\bS 800\b|\bRZR S\b/.test(upper) ? "mid" : "full", sixWheels: false };
    case "ranger": {
      if (youth) return { seats: 2, size: "youth", sixWheels: false };
      const crew = /\bCREW\b|\bCR\b/.test(upper);
      const mid = /\bMID[- ]?SIZE\b|\bMIDSIZE\b|\bMIDSZ\b|\bMID\b|\bMS\b/.test(upper) || (!crew && !/\bFULL[- ]?SIZE\b|\bFULLSIZE\b|\bFS\b|\bXP\b|\bSP\b|\bXD\b/.test(upper) && cc !== null && cc <= 570);
      const seats = crew ? (/-6\b/.test(upper) ? 6 : /-5\b/.test(upper) ? 5 : /-4\b/.test(upper) ? 4 : mid ? 4 : 6) : mid ? 2 : 3;
      return { seats, size: mid ? "mid" : "full", sixWheels };
    }
    case "general":
      return { seats: four ? 4 : 2, size: "full", sixWheels: false };
    case "xpedition":
      return { seats: /\b(?:XP|ADV) ?5\b|\b5\b/.test(upper) ? 5 : 3, size: "full", sixWheels: false };
    case "ace":
      return { seats: 1, size: youth ? "youth" : "mid", sixWheels: false };
    case "sportsman": {
      const twoUp = /\bTOURING\b|\bTOUR\b|\bTRG\b|\bX2\b|\b2UP\b|\b2-UP\b/.test(upper);
      return { seats: twoUp && !youth ? 2 : 1, size: youth ? "youth" : "full", sixWheels };
    }
    case "scrambler":
      return { seats: 1, size: youth ? "youth" : "full", sixWheels: false };
    case "outlaw":
    case "phoenix":
      return { seats: 1, size: cc !== null && cc > 200 ? "full" : "youth", sixWheels: false };
    case "generator":
      return { seats: 0, size: "full", sixWheels: false };
  }
}

// What's known about a unit, from the server: the model list's entries for
// its model number (brand codes, descriptions, the titles of the manuals
// listing it), the brand codes and titles of the manuals it's using, and
// its name.
export type UnitFacts = {
  numberBrands: readonly string[];
  descriptions: readonly string[];
  numberTitles: readonly string[];
  manualBrands: readonly string[];
  manualTitles: readonly string[];
  label: string | null;
};

// The machine the 3D unit shows. Its kind of vehicle comes from the brand
// codes as before (vehicleForUnit), unless a description names a line of
// another kind (the ACE, a side-by-side, is listed under ATV). The line:
// the model description's words (the most exact: the first RZRs are listed
// under the Ranger's code), then the model number's brand code, then the
// titles of the manuals that list it, then the manuals' codes and titles,
// then the unit's name, then the kind's usual line. Seats, size and a third
// axle come from the description (or the name); the paint from the
// description, then the name.
export function specForUnit(facts: UnitFacts): UnitSpec | null {
  const described = facts.descriptions.map((text) => lineOf(text, null, false)).find((line) => line !== null) ?? null;
  const titled = [...facts.numberTitles, ...facts.manualTitles].map((title) => lineOf(title, null, false)).find((line) => line !== null) ?? null;
  const kind =
    (described ? LINE_VEHICLE[described] : null) ??
    vehicleForUnit({ numberBrands: facts.numberBrands, manualBrands: facts.manualBrands, label: facts.label, numberTitles: facts.numberTitles }) ??
    (titled ? LINE_VEHICLE[titled] : null);
  if (!kind) return null;
  const fromBrand = (brands: readonly string[]) => {
    const line = brandLine(brands);
    return line && LINE_VEHICLE[line] === kind ? line : null;
  };
  const line =
    (described && LINE_VEHICLE[described] === kind ? described : null) ??
    fromBrand(facts.numberBrands) ??
    facts.numberTitles.map((title) => lineOf(title, kind, true)).find(Boolean) ??
    fromBrand(facts.manualBrands) ??
    facts.manualTitles.map((title) => lineOf(title, kind, true)).find(Boolean) ??
    lineOf(facts.label, kind, false) ??
    DEFAULT_LINE[kind];
  // The words to read seats and size from: the description naming the line,
  // else the name.
  const words = facts.descriptions.find((text) => lineOf(text, kind, false) === line) ?? facts.descriptions[0] ?? facts.label ?? "";
  return { vehicle: kind, line, ...bodyFor(line, words), paint: unitPaint([...facts.descriptions, facts.label], { generator: line === "generator" }) };
}
