// Diagnose's 3D unit: which machine a unit is (line, seats, size and paint,
// read from Polaris's model list the way the real list writes it), where
// every system sits on each line's model, the models' size (lean enough
// for a bay tablet), how a system looks for each state of its causes, and
// how the conversation folds. Pure: no database, no WebGL (the geometry is
// built in Node).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as THREE from "three";

import type { TurnView } from "../src/lib/diagnose-rules";
import { claudeSummary, openTurnIds, techSummary } from "../src/lib/diagnose-thread";
import { CAUSE_SYSTEMS, zoneStates, type DrawnSystem, type ZoneState } from "../src/lib/diagnose-zones";
import { buildGeometry } from "../src/lib/unit-3d/build";
import { supersampling } from "../src/lib/unit-3d/edges";
import { GENERATOR_ZONES, anchorAt, layoutFor, worldBounds, worldPoint, zonesOf } from "../src/lib/unit-3d/layout";
import { crossRing, loft, sweep, type CP } from "../src/lib/unit-3d/geo";
import { archSpan } from "../src/lib/unit-3d/shells";
import { FLAG_COLOURS, LINE_COLOURS, METER_LIT, MUTED_COLOURS, PLATE, calloutItems, calloutMark, contrast, isLit, modeByDefault, phantomPaint, unitSummary, zoneLook } from "../src/lib/unit-3d/look";
import { UNKNOWN_PAINT, paintFromText, unitPaint } from "../src/lib/unit-paint";
import { UNIT_LINES, bodyFor, displacementOf, linesNamed, specForUnit, type UnitFacts, type UnitLine, type UnitSpec } from "../src/lib/unit-vehicle";

const DRAWN = CAUSE_SYSTEMS.filter((system): system is DrawnSystem => system !== "other");

const facts = (more: Partial<UnitFacts>): UnitFacts => ({
  numberBrands: [],
  descriptions: [],
  numberTitles: [],
  manualBrands: [],
  manualTitles: [],
  label: null,
  ...more,
});

const specOf = (brand: string, description: string) => specForUnit(facts({ numberBrands: brand ? [brand] : [], descriptions: [description] }))!;

describe("the unit's paint, from the model description", () => {
  test("Polaris's colour names, as the model list writes them", () => {
    const cases: [string, string][] = [
      ["RZR XP 1000 EPS INDY RED", "indy-red"],
      ["SPM XP 850, PNTD RED", "painted-red"],
      ["RANGER 570 EFI SOLAR RED", "solar-red"],
      ["RANGER XP 1000 EPS SAGE GREEN", "sage-green"],
      ["SPORTSMAN 570 TOURING 570 S. GREEN (POLA", "sage-green"],
      ["SPORTSMAN 570 EPS POLARIS PURSUIT CAMO", "polaris-pursuit-camo"],
      ["RANGER CREW 570-6 EPS PPC", "polaris-pursuit-camo"],
      ["RZR PRO R 4 BOOST ULTIMATE - ONYX BLACK", "onyx-black"],
      ["RZR XP 1000 EPS TITANIUM MATTE METALLIC", "titanium"],
      ["SPORTSMAN ETX VELOCITY BLUE", "velocity-blue"],
      ["RGR CREW XP 1000 NS TRAIL BOSS - GHOST GRAY", "ghost-gray"],
      ["SPORTSMAN TOURING 570 EPS BRIGHT WHITE", "bright-white"],
      ["RZR XP 1000 EPS WHITE LIGHTNING", "white-lightning"],
      ["OUTLAW 50 LIME SQUEEZE", "lime-squeeze"],
      ["GENERAL XP 1000 ULTIMATE - AVALANCHE GRAY", "avalanche-gray"],
    ];
    for (const [text, key] of cases) assert.equal(paintFromText(text)?.key, key, text);
  });

  test("two-tones: the main colour and the accent", () => {
    const hawkeye = paintFromText("HAWKEYE, 4X4, RED/BLACK")!;
    assert.equal(hawkeye.key, "red+black");
    assert.ok(hawkeye.accent);
    assert.equal(paintFromText("SPM 800HO,SAGE GRN/BLK")?.key, "sage-green+black");
    assert.equal(paintFromText("ACE 150 EFI, WHITE LIGHTNING/SKY BLUE")?.key, "white-lightning+sky-blue");
    assert.equal(paintFromText("OUTLAW 50, AVALANCHE GREY/LIME SQUEEZE")?.key, "avalanche-gray+lime-squeeze");
    assert.equal(paintFromText("RZR 200 EFI - WHITE LIGHTNING / INDY RED")?.key, "white-lightning+indy-red");
    assert.equal(paintFromText("OUTLAW 70 EFI, BRIGHT WHITE/PINK POWER")?.key, "bright-white+pink-power");
    // "W/O ENGINE" and "W/STARTER" aren't two-tones.
    assert.equal(paintFromText("6X6,(W/O ENGINE)"), null);
    assert.equal(paintFromText("P4100-GENERATOR W/STARTER,CSA"), null);
  });

  test("a description the list cut off at 40 characters still names its colour", () => {
    assert.equal(paintFromText("RZR PRO R 4 BOOST ULTIMATE - STEALTH GRA")?.key, "stealth-gray");
    assert.equal(paintFromText("GENERAL XP 4 1000 PREMIUM - AVALANCHE GR")?.key, "avalanche-gray");
    assert.equal(paintFromText("SPORTSMAN 850 HIGH LIFTER - MATTE TITANI")?.key, "titanium");
    assert.equal(paintFromText("RGR CREW XP 1000 NS ULT - LT - HAVASU RE")?.key, "havasu-red");
    // A short description isn't cut: SAND (CA) is sand, not the start of SAND CAMO.
    assert.equal(paintFromText("RGR CREW XP 1000 NORTHSTAR SAND (CA)")?.key, "sand-dune");
    assert.equal(paintFromText("4X4,700 EFI, CREW, BROWN")?.key, "brown");
  });

  test("the real list's shortened and run-together colours, and words that only look like colours", () => {
    const cases: [string, string | null][] = [
      ["RANGER XP 1000 NS ED ULTIMATE - STLTH GR", "stealth-gray"],
      ["RANGER CREW XP 1000 NS ED PREM - STLTH G", "stealth-gray"],
      ["SPRTSMN 570 EPS TURF - STH GRY NON MTLC", "stealth-gray"],
      ["SPM 570 SGREY", "stealth-gray"],
      ["GEN-22,1K,XP,TLD LE,INRED,EVAP", "indy-red"],
      ["SPORTSMAN XP 1000 HUNT EDN POLARIS PUR C", "polaris-pursuit-camo"],
      ["SPORTSMAN 850 PREMIUM LE MATTE N. BLUEEV", "navy-blue"],
      ["RZR-21,1000S4,60,PS,M.NARA", "bronze-mist"],
      ["ATV-25,1000 SCRM,55,EU5P,L.LIM", "lime-squeeze"],
      ["RGR-12, 500 4X4 MAG METALLIC", "magnetic-gray"],
      ["RZR S 1000 GRNBLK", "green+black"],
      // RD COM is Ride Command: the colour is the Solar Red after it.
      ["GEN-18,1000,4P,RD COM,MT.S.RED", "solar-red"],
      // MAG is a Magnum here, not Magnetic Gray.
      ["MAG 330 4X4,BLUE", "blue"],
      // Cut off right after two letters: blue or black? Not known.
      ["RGR XD 1500 NS MOUNTAINEER ED - MATTE BL", null],
    ];
    for (const [text, key] of cases) assert.equal(paintFromText(text)?.key ?? null, key, text);
    // NON MTLC: not metallic.
    assert.equal(paintFromText("SPORTSMAN 570 - ORANGE RUST NON MTLC")?.finish, "matte");
    assert.equal(paintFromText("SPRTSMN 570EPS TURF-STH GRY N. MTLC PRE")?.finish, "gloss");
    // A generator's "50ST&CAN BL" (50 states and Canada) is no colour.
    assert.equal(unitPaint(["2000 WATT INVERTER GEN 50ST&CAN BL"], { generator: true }).known, false);
    assert.equal(specOf("GEN", "2000 WATT INVERTER GEN 50ST&CAN BL").paint.known, false);
    // And "1000S4" is a four-seat S 1000.
    assert.equal(specOf("RZR", "RZR-21,1000S4,60,PS,M.NARA").seats, 4);
  });

  test("finish and camouflage", () => {
    assert.equal(paintFromText("RZR XP 1000 EPS TITANIUM MATTE METALLIC")?.finish, "matte");
    assert.equal(paintFromText("RGR XP 1000 NS PREMIUM - SUNSET RED MTLC")?.finish, "metallic");
    assert.equal(paintFromText("SCRAMBLER XP 1000 HAVASU RED PEARL")?.finish, "pearl");
    assert.equal(paintFromText("RZR XP 1000 EPS INDY RED")?.finish, "gloss");
    assert.equal(paintFromText("SPORTSMAN 570 EPS POLARIS PURSUIT CAMO")?.camo, "pursuit");
    // Pursuit Camo wins over the other camo words beside it.
    assert.equal(paintFromText("SPORTSMAN 850 EPS BROWNING PPC LE")?.camo, "pursuit");
    assert.equal(paintFromText("SPORTSMAN 850 MOSSY OAK CAMO")?.camo, "other");
  });

  test("no colour named: a neutral gray", () => {
    assert.equal(paintFromText("SPORTSMAN 570 EPS HUNTER EDITION ZUG/LOF"), null);
    assert.deepEqual(unitPaint(["GENERATOR-P2000I", null, ""]), UNKNOWN_PAINT);
    assert.equal(UNKNOWN_PAINT.known, false);
    assert.match(UNKNOWN_PAINT.base, /^#[0-9a-f]{6}$/);
    // The first text that names one wins; the label is a fallback.
    assert.equal(unitPaint(["RANGER XP 1000 EPS", "2021 Ranger XP 1000 SAGE GREEN"]).key, "sage-green");
  });
});

describe("which machine: line, seats and size", () => {
  test("the real list's descriptions", () => {
    const cases: [string, string, Partial<UnitSpec>][] = [
      ["ATV", "SPM XP 850, PNTD RED", { line: "sportsman", seats: 1, size: "full", sixWheels: false }],
      ["ATV", "SPORTSMAN 570 EPS POLARIS PURSUIT CAMO", { line: "sportsman", seats: 1 }],
      ["ATV", "SPORTSMAN TOURING 570 EPS BRIGHT WHITE", { line: "sportsman", seats: 2 }],
      ["ATV", "SPORTSMAN X2 570 EPS GREEN TRACTOR", { line: "sportsman", seats: 2 }],
      ["ATV", "SPORTSMAN 6X6 570 - SAGE GREEN", { line: "sportsman", sixWheels: true }],
      ["ATV", "BIG BOSS 6X6 400L", { line: "sportsman", sixWheels: true }],
      ["ATV", "SPORTSMAN 110 EFI - VELOCITY BLUE", { line: "sportsman", size: "youth" }],
      ["ATV", "SCRAMBLER XP 1000 S - ORANGE MADNESS", { line: "scrambler", seats: 1, size: "full" }],
      ["ATV", "OUTLAW 70 EFI - VELOCITY BLUE", { line: "outlaw", size: "youth" }],
      ["ATV", "PHOENIX 200 - INDY RED", { line: "phoenix", size: "youth" }],
      ["RGR", "RANGER CREW XP 1000 NS ULT - SUNSET RED MTL", { line: "ranger", seats: 6, size: "full" }],
      ["RGR", "RANGER CREW 570-4 SAGE GREEN", { line: "ranger", seats: 4 }],
      ["RGR", "RANGER XP 1000 EPS SAGE GREEN", { line: "ranger", seats: 3, size: "full" }],
      ["RGR", "RANGER 570 SAGE GREEN", { line: "ranger", seats: 2, size: "mid" }],
      ["RGR", "RANGER 150 EFI - SAGE GREEN", { line: "ranger", size: "youth" }],
      ["RGR", "RANGER 6X6 SAGE GREEN", { line: "ranger", sixWheels: true }],
      ["RZR", "RZR XP 4 TURBO EPS GHOST GRAY", { line: "rzr", seats: 4, size: "full" }],
      ["RZR", "RZR XP 1000 EPS INDY RED", { line: "rzr", seats: 2, size: "full" }],
      ["RZR", "RZR PRO R 4 ULTIMATE INDY RED", { line: "rzr", seats: 4 }],
      ["RZR", "RZR XP TURBO S4 72 GHOST GRAY (LTN)", { line: "rzr", seats: 4 }],
      ["RZR", "RZR TRAIL ULTIMATE - GHOST GRAY", { line: "rzr", seats: 2, size: "mid" }],
      ["RZR", "RZR 200 EFI - INDY RED", { line: "rzr", size: "youth" }],
      ["GRL", "GENERAL XP 4 1000 PREMIUM EARTH BLUE", { line: "general", seats: 4 }],
      ["GRL", "GENERAL XP 1000 DELUXE NAVY BLUE (CA)", { line: "general", seats: 2 }],
      ["XXP", "XPEDITION XP 5 NORTHSTAR - MOSS GREEN", { line: "xpedition", seats: 5 }],
      ["XXP", "XPEDITION ADV NS SLATE GRAY", { line: "xpedition", seats: 3 }],
      ["GEN", "GENERATOR-P6500", { line: "generator", vehicle: "generator" }],
    ];
    for (const [brand, description, want] of cases) {
      const spec = specOf(brand, description);
      for (const [key, value] of Object.entries(want)) assert.equal(spec[key as keyof UnitSpec], value, `${description}: ${key}`);
    }
  });

  test("the description's words beat the brand code; the code decides when there are none", () => {
    // The first RZRs were listed under the Ranger's code.
    assert.equal(specOf("RGR", "RZR, 800 EFI, S. RED, LE").line, "rzr");
    // The ACE is a one-seat side-by-side, listed under ATV.
    const ace = specOf("ATV", "POLARIS ACE 570 HD SAGE GREEN");
    assert.equal(ace.line, "ace");
    assert.equal(ace.vehicle, "utv");
    assert.equal(ace.seats, 1);
    // The Xpedition 325 of 2000 was an ATV.
    assert.equal(specOf("ATV", "XPEDITION 325").line, "sportsman");
    // A Ranger edition named Trail Boss is still a Ranger.
    assert.equal(specOf("RGR", "RGR CREW XP 1000 TRAIL BOSS - GHOST GRAY").line, "ranger");
    // No line words: the brand code.
    assert.equal(specOf("GRL", "G22 1000 ABS").line, "general");
    assert.equal(specOf("RZR", "Z22 INT'L").line, "rzr");
  });

  test("then the manuals' titles and codes, then the unit's name, then the kind's usual line", () => {
    assert.equal(specForUnit(facts({ numberBrands: ["ATV"], numberTitles: ["2021-2026 Sportsman 450 / 570 1-Up"] }))!.line, "sportsman");
    assert.equal(specForUnit(facts({ numberBrands: ["ATV"], numberTitles: ["Sportsman / Scrambler 850 / 1000"] }))!.line, "sportsman");
    assert.equal(specForUnit(facts({ manualBrands: ["XXP"] }))!.line, "xpedition");
    assert.equal(specForUnit(facts({ manualTitles: ["2019 RZR XP 1000 Service Manual"] }))!.line, "rzr");
    assert.equal(specForUnit(facts({ label: "2022 Polaris Sportsman 850 (10 models)" }))!.line, "sportsman");
    assert.equal(specForUnit(facts({ label: "2021 RZR XP 4 1000" }))!.seats, 4);
    assert.equal(specForUnit(facts({ numberBrands: ["ATV"] }))!.line, "sportsman");
    assert.equal(specForUnit(facts({ numberBrands: ["RGR", "RZR"] }))!.line, "ranger");
    // Nothing known: no 3D unit (and no drawing).
    assert.equal(specForUnit(facts({ label: "X1" })), null);
    assert.equal(specForUnit(facts({})), null);
  });

  test("engine sizes and youth models", () => {
    assert.equal(displacementOf("ATV-19,RGR150,EFI,INDY"), 150);
    assert.equal(displacementOf("RZR-22,74,T,EU5,CRUISER BLACK"), null);
    assert.equal(displacementOf("RANGER 150 EFI"), 150);
    assert.equal(displacementOf("2003 TRAIL BOSS 330"), 330);
    assert.equal(displacementOf("SPORTSMAN 570-4X4"), 570);
    assert.equal(bodyFor("outlaw", "OUTLAW 525 S").size, "full");
    assert.equal(bodyFor("scrambler", "YOUTH SCRAMBLER 50").size, "youth");
    assert.deepEqual(linesNamed("2008 RANGER RZR Service Manual"), ["rzr", "ranger"]);
  });
});

// Every line in the shapes it comes in.
function variants(): UnitSpec[] {
  const base = { paint: UNKNOWN_PAINT, sixWheels: false };
  const out: UnitSpec[] = [];
  for (const line of UNIT_LINES) {
    const vehicle = line === "generator" ? "generator" : ["sportsman", "scrambler", "outlaw", "phoenix"].includes(line) ? "atv" : "utv";
    const seats = line === "rzr" || line === "general" ? [2, 4] : line === "ranger" ? [2, 3, 4, 6] : line === "xpedition" ? [3, 5] : line === "sportsman" ? [1, 2] : [line === "generator" ? 0 : 1];
    for (const n of seats) {
      for (const size of ["youth", "mid", "full"] as const) out.push({ ...base, vehicle, line, seats: n, size } as UnitSpec);
    }
  }
  out.push({ ...base, vehicle: "atv", line: "sportsman", seats: 1, size: "full", sixWheels: true });
  out.push({ ...base, vehicle: "utv", line: "ranger", seats: 3, size: "full", sixWheels: true });
  return out;
}

describe("the 3D models", () => {
  test("every line has every system's anchor, on the machine", () => {
    for (const spec of variants()) {
      const layout = layoutFor(spec);
      const zones = zonesOf(layout);
      const want = spec.line === "generator" ? GENERATOR_ZONES : DRAWN;
      assert.deepEqual([...zones].sort(), [...want].sort(), `${spec.line} ${spec.seats} ${spec.size}`);
      for (const zone of zones) {
        const point = layout.anchors[zone]!;
        assert.ok(point.every(Number.isFinite), `${spec.line} ${zone}`);
        for (let k = 0; k < 3; k++) {
          assert.ok(point[k] >= layout.bounds.min[k] - 0.15 && point[k] <= layout.bounds.max[k] + 0.15, `${spec.line} ${zone} axis ${k}: ${point[k]}`);
        }
        const scaled = anchorAt(layout, zone)!;
        assert.ok(Math.abs(scaled[1] - point[1] * layout.scale) < 1e-9);
      }
    }
  });

  test("each system's anchor sits on its own parts, and every system has parts", () => {
    const lines: UnitLine[] = [...UNIT_LINES];
    for (const line of lines) {
      const spec = variants().find((s) => s.line === line && s.size === "full")!;
      const layout = layoutFor(spec);
      const parts = buildGeometry(layout);
      const groups = new Set(parts.map((part) => part.group));
      for (const zone of zonesOf(layout)) {
        assert.ok(groups.has(zone), `${line}: no parts for ${zone}`);
        const box = new THREE.Box3();
        for (const part of parts.filter((p) => p.group === zone)) box.union(part.geometry.boundingBox!);
        // The shapes are on three.js's axes (mirrored): so is the anchor.
        const distance = box.distanceToPoint(new THREE.Vector3(...worldPoint(layout, layout.anchors[zone]!, false)));
        assert.ok(distance < 0.3, `${line}: ${zone}'s anchor is ${distance.toFixed(2)} m from its parts`);
      }
      for (const part of parts) part.geometry.dispose();
    }
  });

  test("lean enough for a bay tablet: few meshes, a modest triangle count", () => {
    for (const spec of variants().filter((s) => s.size === "full")) {
      const parts = buildGeometry(layoutFor(spec));
      const triangles = parts.reduce((sum, part) => sum + part.geometry.getAttribute("position").count / 3, 0);
      assert.ok(parts.length <= 70, `${spec.line} ${spec.seats}: ${parts.length} meshes`);
      assert.ok(triangles < 75_000, `${spec.line} ${spec.seats}: ${triangles} triangles`);
      // Merged geometry carries only what's drawn.
      for (const part of parts) assert.deepEqual(Object.keys(part.geometry.attributes).sort(), ["normal", "position", "uv"]);
      for (const part of parts) part.geometry.dispose();
    }
  });

  test("proportioned like the real thing", () => {
    const length = (spec: UnitSpec) => {
      const layout = layoutFor(spec);
      return (layout.bounds.max[0] - layout.bounds.min[0]) * layout.scale;
    };
    const rzr = specOf("RZR", "RZR XP 1000 EPS INDY RED");
    const rzr4 = specOf("RZR", "RZR XP 4 1000 EPS GHOST GRAY");
    const ranger = specOf("RGR", "RANGER XP 1000 EPS SAGE GREEN");
    const crew = specOf("RGR", "RANGER CREW XP 1000 SAGE GREEN");
    const sportsman = specOf("ATV", "SPORTSMAN 570 SAGE GREEN");
    const outlaw = specOf("ATV", "OUTLAW 110 EFI PINK POWER");
    // Lengths within 10% of Polaris's figures.
    for (const [spec, metres] of [
      [rzr, 3.0],
      [rzr4, 3.8],
      [ranger, 3.06],
      [crew, 3.9],
      [sportsman, 2.11],
    ] as const) {
      assert.ok(Math.abs(length(spec) - metres) / metres < 0.1, `${spec.line} ${spec.seats}: ${length(spec).toFixed(2)} m`);
    }
    assert.ok(length(outlaw) < length(sportsman) * 0.8);
    // The RZR is lower than the Ranger.
    assert.ok(layoutFor(rzr).bounds.max[1] < layoutFor(ranger).bounds.max[1]);
  });
});

describe("how a system looks for its causes (phantom view, service-manual colours)", () => {
  const state = (glow: ZoneState["glow"], muted = false) => ({ glow, muted });

  test("flagged parts are drawn opaque in flat colours with a dark outline: deep red high and confirmed, amber medium; low a red outline only; ruled out grey", () => {
    assert.deepEqual(zoneLook(state("confirmed")), { fill: FLAG_COLOURS.confirmed, outline: { colour: LINE_COLOURS.flag, weight: 2 }, badge: "check" });
    assert.deepEqual(zoneLook(state("high")), { fill: "#b3261e", outline: { colour: LINE_COLOURS.flag, weight: 2 }, badge: null });
    assert.deepEqual(zoneLook(state("medium")), { fill: "#e39b1b", outline: { colour: LINE_COLOURS.flag, weight: 2 }, badge: null });
    // Low: its own materials, a red outline only.
    assert.deepEqual(zoneLook(state("low")), { fill: null, outline: { colour: FLAG_COLOURS.low, weight: 2 }, badge: null });
    assert.deepEqual(zoneLook(state("ruled_out")), { fill: FLAG_COLOURS.ruledOut, outline: { colour: LINE_COLOURS.flag, weight: 1 }, badge: "cross" });
    assert.deepEqual(zoneLook(null), { fill: null, outline: null, badge: null });
    // Nothing in a look gives off light or moves.
    for (const glow of ["confirmed", "high", "medium", "low", "ruled_out", "none"] as const) {
      const look = zoneLook(state(glow)) as Record<string, unknown>;
      for (const key of ["pulse", "glow", "emissive", "halo"]) assert.ok(!(key in look), `${glow} ${key}`);
    }
  });

  test("once a cause is confirmed the other suspects are toned down; the one picked is outlined in the accent", () => {
    const muted = zoneLook(state("high", true));
    assert.equal(muted.fill, MUTED_COLOURS.high);
    assert.equal(muted.outline?.weight, 1);
    assert.equal(zoneLook(state("medium", true)).fill, MUTED_COLOURS.medium);
    assert.deepEqual(zoneLook(state("low", true)).outline, { colour: MUTED_COLOURS.low, weight: 1 });
    assert.deepEqual(zoneLook(state("medium"), { active: true }).outline, { colour: LINE_COLOURS.active, weight: 2 });
    assert.equal(zoneLook(state("medium"), { active: true }).fill, "#e39b1b");
    assert.equal(zoneLook(null, { active: true }).outline?.colour, LINE_COLOURS.active);
  });

  test("phantom by default once anything is flagged; the callouts are numbered by the list and the key follows them", () => {
    const states = [
      ...zoneStates([
        { system: "ignition", likelihood: "high", status: "open" },
        { system: "fuel", likelihood: "medium", status: "ruled_out" },
        { system: "exhaust", likelihood: "medium", status: "open" },
        { system: "ignition", likelihood: "low", status: "open" },
      ]).values(),
    ];
    assert.equal(modeByDefault(states), "phantom");
    assert.equal(modeByDefault(states.filter((s) => s.system === "fuel")), "solid");
    assert.equal(modeByDefault([]), "solid");
    assert.equal(isLit("low"), true);
    assert.equal(isLit("ruled_out"), false);
    const { numbered, ruledOut } = calloutItems(states);
    assert.deepEqual(
      numbered.map((s) => [s.system, s.rank]),
      [
        ["ignition", 1],
        ["exhaust", 3],
      ],
    );
    assert.deepEqual(ruledOut.map((s) => s.system), ["fuel"]);
    const summary = unitSummary("RZR", states);
    assert.match(summary, /Ignition \(high likelihood\)/);
    assert.match(summary, /ruled out: Fuel/);
    assert.match(unitSummary("RZR", []), /no systems highlighted/);
  });

  test("a callout's circle says its state in shape as well as colour", () => {
    assert.deepEqual(calloutMark("high", false), { fill: "#b3261e", ring: "#b3261e", text: "#ffffff" });
    assert.equal(calloutMark("medium", false).fill, "#e39b1b");
    // Low: an outlined circle (white inside), not a filled one.
    assert.deepEqual(calloutMark("low", false), { fill: "#ffffff", ring: "#c62d23", text: "#c62d23" });
    // Ruled out: a white circle with a cross, its grey ring dark enough to see.
    assert.deepEqual(calloutMark("ruled_out", false), { fill: "#ffffff", ring: "#6b7076", text: "#5f656b" });
    assert.equal(calloutMark("high", true).fill, MUTED_COLOURS.high);
    assert.deepEqual(METER_LIT, { high: 3, medium: 2, low: 1 });
  });

  test("every callout circle stands out from the plate (3:1), whatever its state; a picked one's ring too", () => {
    for (const glow of ["confirmed", "high", "medium", "low", "ruled_out"] as const) {
      for (const muted of [false, true]) {
        const mark = calloutMark(glow, muted);
        for (const plate of [PLATE.centre, PLATE.edge]) {
          assert.ok(contrast(mark.ring, plate) >= 3, `${glow}${muted ? " muted" : ""} ring ${mark.ring} on ${plate}: ${contrast(mark.ring, plate).toFixed(2)}`);
        }
        // Its number reads on its own fill.
        assert.ok(contrast(mark.text, mark.fill) >= 4.5, `${glow}${muted ? " muted" : ""} number ${mark.text} on ${mark.fill}: ${contrast(mark.text, mark.fill).toFixed(2)}`);
      }
    }
    for (const plate of [PLATE.centre, PLATE.edge]) assert.ok(contrast(LINE_COLOURS.picked, plate) >= 4.5, `picked ring on ${plate}`);
    // Before: an amber circle in an amber ring (1.9:1) and a pale muted one (1.2:1).
    assert.ok(contrast(FLAG_COLOURS.medium, PLATE.centre) < 3 && contrast(MUTED_COLOURS.high, PLATE.centre) < 3);
  });

  test("phantom view keeps the paint's colour, but a red body steps back so the deep red parts inside stand out; a dark one doesn't wash out", () => {
    const flag = FLAG_COLOURS.high;
    const hue = (hex: string) => {
      const c = new THREE.Color(hex);
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl);
      return hsl;
    };
    for (const red of ["#b4141c", "#a3262a", "#c8102e"]) {
      const body = phantomPaint(red);
      // Much greyer than the paint, still a hint of red.
      assert.ok(hue(body.colour).s < hue(red).s * 0.5, `${red} -> ${body.colour}`);
      assert.ok(hue(body.colour).s > 0.03, `${red} keeps a hint of its hue: ${body.colour}`);
      // And far from the flag's red (CIE76 colour difference): the flagged
      // part is the reddest thing there.
      assert.ok(deltaE(body.colour, flag) > 35, `${red}: body ${body.colour} vs flag: ${deltaE(body.colour, flag).toFixed(1)}`);
      assert.ok(deltaE(red, flag) < 25, `${red} itself is close to the flag`);
      assert.equal(body.opacity, 0.3);
    }
    // Other paints keep their colour; dark ones (and camo) are more solid.
    assert.deepEqual(phantomPaint("#8d9295"), { colour: "#8d9295", opacity: 0.3 });
    assert.equal(phantomPaint("#1f2a44").opacity, 0.44);
    assert.equal(phantomPaint("#4a5439").opacity, 0.44);
    assert.equal(phantomPaint("#ffffff", { camo: true }).opacity, 0.44);
  });
});

// CIE76: the distance between two sRGB colours in CIELAB.
function deltaE(a: string, b: string) {
  const lab = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const xyz = [(0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * bl, (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883];
    const f = xyz.map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116));
    return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
  };
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

describe("every machine the right way round, in proportion, lean to draw", () => {
  // three.js's axes are right-handed: with x forward and y up, the
  // machine's left is -z.
  const leftOf = (z: number) => -z;

  test("the driver's seat (steering) and the drive clutch are on the machine's left, as on every Polaris", () => {
    for (const spec of variants().filter((s) => s.size === "full" && s.line !== "generator")) {
      const layout = layoutFor(spec);
      const parts = buildGeometry(layout);
      const centre = (group: string, material?: string) => {
        const box = new THREE.Box3();
        for (const part of parts.filter((p) => p.group === group && (!material || p.material === material))) box.union(part.geometry.boundingBox!);
        return box.getCenter(new THREE.Vector3());
      };
      // The drive clutch's cover and its callout's point.
      assert.ok(leftOf(centre("drive_clutch").z) > 0.1, `${spec.line} ${spec.seats}: drive clutch at z ${centre("drive_clutch").z}`);
      assert.ok(leftOf(anchorAt(layout, "drive_clutch")![2]) > 0.1, `${spec.line}: drive clutch anchor`);
      // A side-by-side's steering wheel is in front of the left seat.
      if (spec.vehicle === "utv" && spec.line !== "ace") {
        assert.ok(leftOf(anchorAt(layout, "steering")![2]) > 0.2, `${spec.line} ${spec.seats}: steering anchor ${anchorAt(layout, "steering")}`);
        assert.ok(leftOf(centre("steering", "trim").z) > 0.15, `${spec.line} ${spec.seats}: steering wheel at z ${centre("steering", "trim").z}`);
      }
      for (const part of parts) part.geometry.dispose();
    }
    // The extent, mirrored with them.
    const generator = layoutFor(variants().find((s) => s.line === "generator")!);
    assert.deepEqual(worldBounds(generator).min[2], -generator.bounds.max[2] * generator.scale);
  });

  test("a wheels/tires flag points at one wheel (the front left), not all four", () => {
    for (const line of ["rzr", "ranger", "sportsman"] as const) {
      const spec = variants().find((s) => s.line === line && s.size === "full")!;
      const layout = layoutFor(spec);
      const parts = buildGeometry(layout);
      const box = new THREE.Box3();
      for (const part of parts.filter((p) => p.group === "wheels_tires")) box.union(part.geometry.boundingBox!);
      const size = box.getSize(new THREE.Vector3());
      // One tyre's width and diameter, at the front, on the left.
      assert.ok(size.z < layout.tireW * 1.6 && size.x < layout.tireR * 2.4, `${line}: ${JSON.stringify(size)}`);
      assert.ok(box.getCenter(new THREE.Vector3()).x > 0 && leftOf(box.getCenter(new THREE.Vector3()).z) > 0, line);
      // The others are still there, as plain running gear.
      assert.ok(parts.some((p) => p.group === "running"), line);
      for (const part of parts) part.geometry.dispose();
    }
  });

  test("youth units have their own proportions, not a shrunken adult's", () => {
    const rzr = layoutFor(specOf("RZR", "RZR XP 1000 EPS INDY RED"));
    const youth = layoutFor(specOf("RZR", "RZR 200 EFI - INDY RED"));
    const length = (l: ReturnType<typeof layoutFor>) => (l.nose - l.tail) * l.scale;
    const height = (l: ReturnType<typeof layoutFor>) => l.bounds.max[1] * l.scale;
    // RZR 200: 2.41 m long, 1.65 m wheelbase, 1.56 m tall (within 10%).
    assert.ok(Math.abs(length(youth) - 2.41) / 2.41 < 0.1, `length ${length(youth)}`);
    assert.ok(Math.abs(youth.wheelbase * youth.scale - 1.65) / 1.65 < 0.1, `wheelbase ${youth.wheelbase * youth.scale}`);
    assert.ok(Math.abs(height(youth) - 1.56) / 1.56 < 0.1, `height ${height(youth)}`);
    // Taller for its length, and a shorter wheelbase for it, than the adult's.
    assert.ok(height(youth) / length(youth) > height(rzr) / length(rzr) * 1.05);
    assert.ok(youth.wheelbase / (youth.nose - youth.tail) < rzr.wheelbase / (rzr.nose - rzr.tail));
    // A youth ATV is stubby: wide for its length.
    const outlaw = layoutFor(specOf("ATV", "OUTLAW 110 EFI PINK POWER"));
    const scrambler = layoutFor(specOf("ATV", "SCRAMBLER XP 1000 S - ORANGE MADNESS"));
    const stub = (l: ReturnType<typeof layoutFor>) => (l.track + l.rearTireW) / (l.nose - l.tail);
    assert.ok(stub(outlaw) > stub(scrambler) * 1.15, `${stub(outlaw)} vs ${stub(scrambler)}`);
  });

  test("the edge lines' target stays within the canvas's budget on every screen", () => {
    // A 1280 x 800 tablet at 1.5 in full screen: its own pixels, not 4x them.
    assert.equal(supersampling(1280, 737, 1.5), 1);
    assert.equal(supersampling(702, 439, 2), 1);
    // A desktop at 1x, a card: smoothed (twice the size), within budget.
    assert.equal(supersampling(470, 350, 1), 2);
    // A desktop at 1x, full screen: too many pixels to double.
    assert.equal(supersampling(1920, 1000, 1), 1);
    for (const [w, h, ratio] of [[1280, 737, 1.5], [702, 439, 2], [470, 350, 1], [1920, 1000, 1], [1180, 760, 1.2]] as const) {
      const ss = supersampling(w, h, ratio);
      assert.ok(w * h * ratio * ratio * ss * ss <= 2_400_000 * 1.0001 || ss === 1, `${w}x${h}@${ratio}`);
    }
  });
});

describe("the folded body panels", () => {
  // The signed volume of a closed surface: positive when it faces outward.
  const volumeOf = (geometry: THREE.BufferGeometry) => {
    const position = geometry.getAttribute("position");
    const index = geometry.index!.array;
    const p = (k: number) => new THREE.Vector3().fromBufferAttribute(position, index[k]);
    let volume = 0;
    for (let k = 0; k < index.length; k += 3) volume += p(k).dot(p(k + 1).cross(p(k + 2)));
    return volume / 6;
  };

  test("a hood lofted through cross-sections is a closed surface facing out, crisply folded at its creases", () => {
    const hood = (x: number, half: number, top: number): ReturnType<typeof crossRing> =>
      crossRing(x, [
        [0, top + 0.03],
        [half * 0.5, top + 0.01, true],
        [half - 0.04, top, true],
        [half, top - 0.05, true],
        [half, 0.5, true],
        [0, 0.5],
      ]);
    const rings = [hood(1.6, 0.2, 0.6), hood(1.2, 0.4, 0.78), hood(0.6, 0.46, 0.92)];
    // Each crease point doubled, the same count in every ring, symmetric.
    assert.ok(rings.every((ring) => ring.length === rings[0].length));
    assert.equal(rings[0].length, 6 + 4 + (6 + 4 - 2));
    for (const [x, y, z] of rings[1]) assert.ok(rings[1].some(([x2, y2, z2]) => x2 === x && y2 === y && Math.abs(z2 + z) < 1e-9), "mirrored");
    const geometry = loft(rings);
    const position = geometry.getAttribute("position");
    for (let i = 0; i < position.array.length; i++) assert.ok(Number.isFinite(position.array[i]), "finite");
    assert.ok(volumeOf(geometry) > 0, "faces outward");
    // The fold at a crease: the two copies of the point have different
    // normals (no rounding over the edge).
    const normal = geometry.getAttribute("normal");
    const n = (k: number) => new THREE.Vector3().fromBufferAttribute(normal, k);
    const crease = rings[0].length + 3; // the second ring's [half - 0.04, top] pair
    assert.ok(n(crease).dot(n(crease + 1)) < 0.99, `crease normals ${n(crease).toArray()} ${n(crease + 1).toArray()}`);
  });

  test("a fender swept over a wheel is closed, faces out, keeps its thickness round the mitred corners, and folds at them", () => {
    const profile: CP[] = [
      [0.03, 0.4],
      [0.03, 0.8, true],
      [0, 0.84, true],
      [-0.09, 0.84],
      [-0.09, 0.8],
      [0, 0.4],
    ];
    const path: CP[] = [
      [1.6, 0.6],
      [1.45, 0.8, true],
      [1.0, 0.92, true],
      [0.7, 0.7],
    ];
    const geometry = sweep(path, profile);
    assert.ok(volumeOf(geometry) > 0, "faces outward");
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // Over the top it's the profile's thickness above the path; it spans
    // the profile across.
    assert.ok(Math.abs(box.max.y - (0.92 + 0.03)) < 0.02, `top ${box.max.y}`);
    assert.ok(Math.abs(box.min.z - 0.4) < 1e-6 && Math.abs(box.max.z - 0.84) < 1e-6, `z ${box.min.z} ${box.max.z}`);
    // A profile that changes along the path (narrower at the nose).
    const tapered = sweep(path, (i) => profile.map(([o, z]) => [o, z === 0.84 && i === 0 ? 0.7 : z, profile.find((q) => q[0] === o && q[1] === z)?.[2]] as CP));
    tapered.computeBoundingBox();
    assert.ok(volumeOf(tapered) > 0);
  });

  test("an arch liner runs between where it rises above the panels and the panels' ends", () => {
    const [a0, a1] = archSpan(1.15, 0.38, 0.455, 0.44, 1.6, 0.6);
    assert.ok(a0 > 0 && a1 < Math.PI && a0 < a1, `${a0} ${a1}`);
    assert.ok(1.15 + Math.cos(a0) * 0.455 <= 1.6 && 1.15 + Math.cos(a1) * 0.455 >= 0.6);
    assert.ok(0.38 + Math.sin(a0) * 0.455 >= 0.44 - 1e-6);
  });
});

describe("the conversation folds", () => {
  const turn = (seq: number, status: TurnView["status"], techText: string, causes: string[] = [], questions: string[] = []): TurnView => ({
    id: `t${seq}`,
    seq,
    status,
    techText,
    userName: "Mike",
    createdAt: "",
    progress: [],
    error: null,
    reply:
      status === "done"
        ? {
            reply: "",
            likelyCauses: causes.map((title) => ({ title, likelihood: "high", why: "", status: "open", sources: [] })),
            nextChecks: [],
            safetyNotes: [],
            questions,
            partial: false,
            dropped: 0,
          }
        : null,
  });

  test("an earlier exchange in one line each: the tech's first line, Claude's count and top cause", () => {
    const opening = turn(1, "done", "Unit: 2019 RZR XP 1000\nComplaint: Misfires under load\nFault codes: P0300", ["Ignition coil breakdown", "Fouled plug"]);
    assert.equal(techSummary(opening), "Misfires under load (P0300)");
    assert.equal(claudeSummary(opening), "2 causes, top: Ignition coil breakdown");
    const answer = turn(2, "done", "> Did you check the coil resistance?\nPrimary 0.7 ohms, secondary 10k.", ["Fuel pump"], ["Fuel pressure?"]);
    assert.equal(techSummary(answer), "Primary 0.7 ohms, secondary 10k.");
    assert.equal(claudeSummary(answer), "1 cause, top: Fuel pump, asks a question");
    assert.equal(claudeSummary(turn(3, "done", "ok")), "no causes yet");
    assert.equal(claudeSummary(turn(3, "failed", "ok")), "didn't go through");
    assert.equal(claudeSummary(turn(3, "stopped", "ok")), "stopped");
    assert.equal(techSummary(turn(4, "done", "x".repeat(300))).length, 120);
  });

  test("the latest exchange stays open, and the last answer while a new message runs", () => {
    const turns = [turn(1, "done", "a", ["A"]), turn(2, "done", "b", ["B"]), turn(3, "running", "c")];
    assert.deepEqual([...openTurnIds(turns)].sort(), ["t2", "t3"]);
    assert.deepEqual([...openTurnIds(turns.slice(0, 2))], ["t2"]);
    assert.deepEqual([...openTurnIds([])], []);
  });
});
