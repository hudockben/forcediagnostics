// Diagnose's unit graphic: the systems Claude tags causes with (the tool
// schema and the reply checks), working the system out for replies saved
// before causes carried one, how each system glows, which drawing a unit
// gets, the drawings themselves (every system in its place, small enough),
// and where the labels go. Pure: no database.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type Anthropic from "@anthropic-ai/sdk";

import { buildRequest, TOOL_NAMES } from "../src/lib/diagnose-prompt";
import {
  activityCounts,
  addQuote,
  chatNews,
  emptySeen,
  finalizeReply,
  openingRows,
  partialReply,
  quoteQuestion,
  startMessage,
  type ProgressStep,
} from "../src/lib/diagnose-rules";
import {
  CAUSE_SYSTEMS,
  causeSystem,
  glowFor,
  inferSystem,
  isCauseSystem,
  listedSystem,
  shownStatus,
  zoneStates,
  type CauseLikelihood,
  type CauseState,
  type CauseSystem,
  type DrawnSystem,
} from "../src/lib/diagnose-zones";
import { calloutWidth, layoutCallouts, leaderCrossings, segmentHitsRect, segmentsOf, type Callout } from "../src/lib/unit-graphic/callouts";
import { baseWithout, drawingFor, type Path } from "../src/lib/unit-graphic/drawing";
import { sceneFor, type Scene } from "../src/lib/unit-graphic/scene";
import { UNIT_GRAPHIC_CSS } from "../src/lib/unit-graphic/style";
import { chooseVehicle, vehicleForUnit } from "../src/lib/unit-vehicle";

const DRAWN = CAUSE_SYSTEMS.filter((system): system is DrawnSystem => system !== "other");

describe("the systems causes are tagged with", () => {
  test("one short fixed list, with other", () => {
    assert.ok(CAUSE_SYSTEMS.length <= 18, `${CAUSE_SYSTEMS.length}`);
    assert.equal(new Set(CAUSE_SYSTEMS).size, CAUSE_SYSTEMS.length);
    assert.ok(CAUSE_SYSTEMS.includes("other"));
    assert.ok(isCauseSystem("ignition") && !isCauseSystem("Ignition") && !isCauseSystem(undefined));
  });

  test("submit_diagnosis requires a system on each cause, from the list, and stays strict", () => {
    const params = buildRequest({ messages: [], webSearch: true });
    const submit = params.tools!.find((tool) => (tool as { name?: string }).name === TOOL_NAMES.submit) as Anthropic.Beta.Messages.BetaTool;
    assert.equal(submit.strict, true);
    type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; enum?: string[]; description?: string };
    const item = (submit.input_schema as Schema).properties!.likely_causes.items!;
    assert.deepEqual(item.properties!.system.enum, [...CAUSE_SYSTEMS]);
    assert.equal(item.properties!.system.type, "string");
    assert.ok(item.properties!.system.description!.length < 120, "one short line");
    assert.ok(item.required!.includes("system"));
    // Strict tools: every property required, no extra ones, all the way down.
    const strictEverywhere = (schema: Schema): void => {
      if (schema.type === "object" && schema.properties && schema !== submit.input_schema) {
        assert.equal(schema.additionalProperties, false);
      }
      if (schema.items) strictEverywhere(schema.items);
      for (const child of Object.values(schema.properties ?? {})) strictEverywhere(child);
    };
    strictEverywhere(submit.input_schema as Schema);
    assert.deepEqual([...item.required!].sort(), Object.keys(item.properties!).sort());
    // The same bytes on every request (the cached prefix).
    assert.equal(JSON.stringify(buildRequest({ messages: [], webSearch: true }).tools), JSON.stringify(params.tools));
  });

  test("the reply keeps a listed system; a missing or unlisted one is worked out from the cause's words", () => {
    // The tools stream their input, so the API doesn't hold Claude to the
    // enum: a reply can come without the system, or with one not listed.
    const cause = (title: string, system: unknown, why = "") => ({ title, system, likelihood: "high", why, status: "open", sources: [{ type: "general" }] });
    const reply = finalizeReply(
      {
        reply: "x",
        likely_causes: [
          cause("Ignition coil breaking down", "ignition"),
          cause("Ignition coil breaking down", "exhaust"),
          cause("Belt", "Drive clutch"),
          cause("Stator", " CHARGING / STARTING "),
          cause("Ignition coil breaking down", undefined),
          cause("Plugged spark arrestor", "flux capacitor"),
          cause("Something odd", 7, "the AWD coil reads open"),
          cause("Something odd", null),
          cause("Something odd", "other"),
        ],
        next_checks: [],
      },
      emptySeen(),
    );
    assert.deepEqual(
      reply.likelyCauses.map((c) => c.system),
      ["ignition", "exhaust", "drive_clutch", "charging_starting", "ignition", "exhaust", "front_drive", "other", "other"],
    );
    assert.equal(listedSystem("wheels / tires"), "wheels_tires");
    assert.equal(listedSystem("warp drive"), null);
    // A partial reply carries the last causes' systems over as they were.
    assert.deepEqual(partialReply("", reply).likelyCauses.map((c) => c.system), reply.likelyCauses.map((c) => c.system));
  });
});

describe("replies saved before causes carried a system", () => {
  test("the system is worked out from the cause's words", () => {
    const cases: [string, string, CauseSystem][] = [
      ["Ignition coil breaking down under load", "", "ignition"],
      ["Fouled or worn spark plugs", "", "ignition"],
      ["Exhaust leak at the header gasket", "Popping on deceleration", "exhaust"],
      ["Low fuel pressure", "", "fuel"],
      ["Clogged fuel injector", "", "fuel"],
      ["Worn drive belt", "", "drive_clutch"],
      ["Sticking primary clutch", "", "drive_clutch"],
      ["Failed stator", "", "charging_starting"],
      ["Weak battery", "", "charging_starting"],
      ["Starter relay sticking", "", "charging_starting"],
      ["Bad voltage regulator", "", "charging_starting"],
      ["Thermostat stuck closed", "", "cooling"],
      ["Engine overheating from low coolant", "", "cooling"],
      ["Dirty air filter", "", "air_intake"],
      ["Vacuum leak at the throttle body boot", "", "air_intake"],
      ["Rear axle CV joint", "", "rear_drive"],
      ["Front gearcase not engaging AWD", "", "front_drive"],
      ["Torn CV boot", "", "front_drive"],
      ["Shift linkage out of adjustment", "", "transmission"],
      ["Worn brake pads", "", "brakes"],
      ["EPS fault", "", "steering"],
      ["Bent tie rod", "", "steering"],
      ["Blown rear shock", "", "suspension"],
      ["Weak coil spring", "", "suspension"],
      ["Loose lug nuts", "", "wheels_tires"],
      ["Corroded ground at the harness", "", "electrical"],
      ["Faulty TPS", "", "electrical"],
      ["Cracked frame weld", "", "body_frame"],
      ["Low compression on cylinder 2", "", "engine"],
      ["Something odd", "the coil looks burnt", "ignition"],
      ["Something odd", "no idea", "other"],
      // A specific part beats a generic word in another system.
      ["Clogged spark arrestor", "", "exhaust"],
      ["Spark arrestor plugged with carbon", "", "exhaust"],
      ["Plugged spark arrestor screen", "", "exhaust"],
      ["AWD coil open circuit", "", "front_drive"],
      ["Front gearcase coil (AWD) failed", "", "front_drive"],
      ["Front differential coil not engaging AWD", "", "front_drive"],
      ["Hilliard clutch worn", "", "front_drive"],
      ["EBS engine braking not engaging", "", "drive_clutch"],
      ["Throttle return spring weak", "", "air_intake"],
      ["Coolant temperature sensor reading high", "", "electrical"],
      ["Gas cap vent blocked", "", "fuel"],
      ["Radiator fan relay sticking", "", "cooling"],
      ["Coil-over spring sagging", "", "suspension"],
      ["Rear diff output seal leaking", "", "rear_drive"],
    ];
    for (const [title, why, expected] of cases) assert.equal(inferSystem(title, why), expected, `${title} / ${why}`);
  });

  test("a stored system wins; without one, the words decide", () => {
    assert.equal(causeSystem({ system: "exhaust", title: "Ignition coil", why: "" }), "exhaust");
    assert.equal(causeSystem({ title: "Ignition coil", why: "" }), "ignition");
    assert.equal(causeSystem({ system: "warp drive", title: "Ignition coil" }), "ignition");
    assert.equal(causeSystem({ system: "Exhaust", title: "Ignition coil" }), "exhaust");
  });
});

describe("how a system glows", () => {
  const c = (likelihood: "high" | "medium" | "low", status: "open" | "ruled_out" | "confirmed") => ({ likelihood, status });

  test("confirmed wins, then the likeliest open cause; only ruled out dims; none is plain", () => {
    assert.equal(glowFor([]), "none");
    assert.equal(glowFor([c("low", "open"), c("high", "confirmed")]), "confirmed");
    assert.equal(glowFor([c("low", "open"), c("high", "open")]), "high");
    assert.equal(glowFor([c("medium", "open"), c("high", "ruled_out")]), "medium");
    assert.equal(glowFor([c("low", "open")]), "low");
    assert.equal(glowFor([c("high", "ruled_out"), c("low", "ruled_out")]), "ruled_out");
  });

  test("each system gets its causes' glow and their places in the list", () => {
    const states = zoneStates([
      { system: "ignition", likelihood: "high", status: "open" },
      { system: "exhaust", likelihood: "medium", status: "open" },
      { system: "ignition", likelihood: "low", status: "ruled_out" },
      { system: "fuel", likelihood: "low", status: "ruled_out" },
    ]);
    assert.deepEqual([...states.keys()], ["ignition", "exhaust", "fuel"]);
    assert.deepEqual(states.get("ignition"), { system: "ignition", glow: "high", causes: [0, 2], muted: false });
    assert.equal(states.get("exhaust")!.glow, "medium");
    assert.equal(states.get("fuel")!.glow, "ruled_out");
    assert.equal(states.get("engine"), undefined);
  });

  test("once a cause is confirmed, the other systems still open step back (muted)", () => {
    const states = zoneStates([
      { system: "drive_clutch", likelihood: "high", status: "confirmed" },
      { system: "cooling", likelihood: "high", status: "open" },
      { system: "fuel", likelihood: "medium", status: "open" },
      { system: "exhaust", likelihood: "low", status: "open" },
      { system: "charging_starting", likelihood: "low", status: "ruled_out" },
    ]);
    assert.deepEqual(
      [...states.values()].map((state) => [state.system, state.glow, state.muted]),
      [
        ["drive_clutch", "confirmed", false],
        ["cooling", "high", true],
        ["fuel", "medium", true],
        ["exhaust", "low", true],
        ["charging_starting", "ruled_out", false],
      ],
    );
    // In the drawing: only the confirmed one glows.
    const scene = sceneFor("utv", [...states.values()]);
    assert.deepEqual(scene.zones.filter((zone) => zone.halo).map((zone) => zone.system), ["drive_clutch"]);
    assert.ok(zoneStates([{ system: "cooling", likelihood: "high", status: "open" }]).get("cooling")!.muted === false);
  });

  test("the tech's press shows until Claude has heard it, then Claude's word does", () => {
    const cause = { title: "Spark plugs", status: "open" as const };
    assert.equal(shownStatus(cause, []), "open");
    assert.equal(shownStatus(cause, [{ title: "spark plugs", verdict: "ruled_out", sentInSeq: null }]), "ruled_out");
    assert.equal(shownStatus(cause, [{ title: "Spark plugs", verdict: "confirmed", sentInSeq: null }]), "confirmed");
    assert.equal(shownStatus(cause, [{ title: "Spark plugs", verdict: "ruled_out", sentInSeq: 2 }]), "open");
    assert.equal(shownStatus({ ...cause, status: "ruled_out" }, [{ title: "Spark plugs", verdict: "open", sentInSeq: null }]), "open");
    // "This was it" stands while it's the conversation's outcome, even if a
    // later reply still lists the cause as open.
    assert.equal(shownStatus(cause, [{ title: "Spark plugs", verdict: "confirmed", sentInSeq: 2 }], "Spark plugs"), "confirmed");
    assert.equal(shownStatus(cause, [], "Ignition coil"), "open");
    assert.equal(shownStatus(cause, [{ title: "Spark plugs", verdict: "open", sentInSeq: null }], "Spark plugs"), "open");
  });
});

describe("which drawing a unit gets", () => {
  test("the model list's brand codes, when they agree", () => {
    for (const code of ["RZR", "RGR", "GRL", "XXP"]) assert.equal(chooseVehicle({ brands: [code], label: null }), "utv", code);
    assert.equal(chooseVehicle({ brands: ["ATV"], label: null }), "atv");
    assert.equal(chooseVehicle({ brands: ["GEN"], label: null }), "generator");
    assert.equal(chooseVehicle({ brands: ["RZR", "RGR"], label: null }), "utv");
    assert.equal(chooseVehicle({ brands: ["rzr"], label: "Sportsman" }), "utv");
  });

  test("the model number's brands first, then the manuals' brands, then the name", () => {
    assert.equal(vehicleForUnit({ numberBrands: ["RZR"], manualBrands: ["ATV"], label: "Sportsman" }), "utv");
    // The model number's brands don't decide it: the manuals' do.
    assert.equal(vehicleForUnit({ numberBrands: ["RZR", "ATV"], manualBrands: ["RZR"], label: "Sportsman" }), "utv");
    assert.equal(vehicleForUnit({ numberBrands: ["SNO"], manualBrands: ["GEN"], label: null }), "generator");
    // Neither does: the name.
    assert.equal(vehicleForUnit({ numberBrands: ["SNO"], manualBrands: [], label: "2021 Ranger 1000" }), "utv");
    assert.equal(vehicleForUnit({ numberBrands: [], manualBrands: [], label: "Honda Pioneer" }), null);
  });

  test("a side-by-side the model list has only under ATV (the 2009-2010 RZR 170) goes by its name", () => {
    // As Polaris lists them: A09VA17AA and R10VA17AA under ATV alone.
    assert.equal(vehicleForUnit({ numberBrands: ["ATV"], manualBrands: [], label: "2009 RZR 170, RED — A09VA17AA" }), "utv");
    assert.equal(vehicleForUnit({ numberBrands: ["ATV"], manualBrands: [], label: "2010 RANGER RZR 170 Indy Red — R10VA17AA" }), "utv");
    // Found by name: its manuals are listed under ATV.
    assert.equal(vehicleForUnit({ numberBrands: [], manualBrands: ["ATV"], label: "2009 RZR 170 (3 models)" }), "utv");
    // Listed without a name (A10VA17AA): its manuals' titles in the list.
    const titles = ["2010 RANGER RZR 170 Service Manual - 11x17 Wire Diagram"];
    assert.equal(vehicleForUnit({ numberBrands: ["ATV"], numberTitles: titles, manualBrands: [], label: "A10VA17AA" }), "utv");
    // ATVs stay ATVs: the 2000-2002 Xpedition was one, and Polaris lists the
    // ACE as one.
    assert.equal(vehicleForUnit({ numberBrands: ["ATV"], manualBrands: [], label: "2001 XPEDITION 425 DESERT DUNE — A01CK42AA" }), "atv");
    assert.equal(vehicleForUnit({ numberBrands: ["ATV"], manualBrands: [], label: "2015 SPORTSMAN ACE SAGE GREEN — A15DAA32AA" }), "atv");
    assert.equal(vehicleForUnit({ numberBrands: ["ATV"], numberTitles: ["2021 Sportsman 570 Service Manual"], manualBrands: [], label: "A21SEE57F1" }), "atv");
  });

  test("otherwise the words in the unit's name", () => {
    assert.equal(chooseVehicle({ brands: ["RZR", "ATV"], label: "2021 SPORTSMAN 570" }), "atv");
    assert.equal(chooseVehicle({ brands: ["SNO"], label: "2019 RZR XP 1000 EPS — Z19VDE99AM" }), "utv");
    for (const label of ["Ranger 1000", "GENERAL XP", "Xpedition ADV", "UTVs (side-by-sides)"]) {
      assert.equal(chooseVehicle({ brands: [], label }), "utv", label);
    }
    for (const label of ["Sportsman 850", "SCRAMBLER XP 1000 S", "ATVs"]) assert.equal(chooseVehicle({ brands: [], label }), "atv", label);
    assert.equal(chooseVehicle({ brands: [], label: "Generators" }), "generator");
    assert.equal(chooseVehicle({ brands: [], label: "Z19VDE99AM" }), null);
    assert.equal(chooseVehicle({ brands: [], label: null }), null);
  });
});

// Realistic sets of causes, as Claude lists them.
type C = [CauseSystem, CauseLikelihood, CauseState];
const SETS: Record<string, C[]> = {
  misfire: [["ignition", "high", "open"], ["exhaust", "medium", "open"], ["ignition", "low", "ruled_out"], ["fuel", "low", "open"]],
  overheat: [["cooling", "high", "open"], ["drive_clutch", "high", "open"], ["fuel", "medium", "open"], ["electrical", "low", "open"], ["exhaust", "low", "open"], ["charging_starting", "low", "ruled_out"]],
  drivetrain: [["drive_clutch", "high", "open"], ["transmission", "medium", "open"], ["rear_drive", "medium", "open"], ["front_drive", "low", "open"], ["suspension", "low", "ruled_out"]],
  nostart: [["charging_starting", "high", "open"], ["electrical", "medium", "open"], ["fuel", "medium", "open"], ["air_intake", "low", "open"], ["cooling", "low", "open"], ["engine", "low", "open"]],
  chassis: [["brakes", "high", "open"], ["steering", "medium", "open"], ["suspension", "medium", "open"], ["wheels_tires", "low", "open"], ["body_frame", "low", "open"], ["front_drive", "low", "open"]],
  solved: [["drive_clutch", "high", "confirmed"], ["cooling", "high", "open"], ["fuel", "medium", "open"], ["charging_starting", "low", "ruled_out"]],
};
const statesOf = (set: C[]) => [...zoneStates(set.map(([system, likelihood, status]) => ({ system, likelihood, status }))).values()];

// About what the component renders for a scene (unit-graphic.tsx): the same
// elements and attributes, rounded the same way.
function markupOf(scene: Scene) {
  const path = (p: Path, extra = "") =>
    p.c.startsWith("t")
      ? `<path class="${p.c}" d="${p.d}" stroke-width="${p.w}"></path><path class="tc" d="${p.d}" stroke-width="1.23"></path>`
      : `<path class="${p.c}" d="${p.d}"${p.eo ? ' fill-rule="evenodd"' : ""}${extra}></path>`;
  const { view, drawing } = scene;
  const zones = scene.zones
    .map(
      (zone) =>
        `<g class="ug-z" data-zone="${zone.system}" data-glow="${zone.glow}" data-muted="${zone.muted}" data-active="false" role="button" tabindex="0" aria-pressed="false" aria-label="${zone.system}: 2 causes, medium likelihood. Show in the list.">${zone.halo ? '<g class="h" filter="url(#R1abcdefghij-glow)">' : ""}${zone.paths.map((p) => `<path class="c ${p.c}" d="${p.d}"${p.c === "t" ? ` stroke-width="${p.w}"` : ""}></path>`).join("")}${zone.halo ? "</g>" : ""}</g>`,
    )
    .join("");
  const callouts = scene.callouts
    .map(
      (c: Callout) =>
        `<g data-leader="${c.zone}" data-glow="high" data-muted="false"><path class="l n" d="M${c.leader.map(([x, y]) => `${x} ${y}`).join("L")}"></path><circle cx="${c.leader[0][0]}" cy="${c.leader[0][1]}" r="3.54" fill="var(--g)"></circle></g>` +
        `<g class="ug-co" data-callout="${c.zone}" data-glow="high" data-muted="false" data-active="false" data-focus="false"><rect x="${c.hit.x}" y="${c.hit.y}" width="${c.hit.w}" height="${c.hit.h}" fill="transparent"></rect><rect class="p" x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${c.h / 2}"></rect><g data-meter="2"><path class="m" d="M-119.38 97.04h3.29v9.1h-3.29zM-114.28 97.04h3.29v9.1h-3.29z"></path><path class="m0" d="M-109.19 97.04h3.29v9.1h-3.29z"></path></g><text x="${c.x + 28.44}" y="${c.y + 12.64}">${c.text}</text></g>`,
    )
    .join("");
  return `<svg class="ug block h-auto w-full select-none" viewBox="${view.x} ${view.y} ${view.w} ${view.h}" data-vehicle="${drawing.vehicle}" role="group" aria-label="Side-by-side systems" style="--hatch:url(#R1abcdefghij-hatch)"><style>${UNIT_GRAPHIC_CSS}</style><defs>${"x".repeat(1100)}</defs><g role="img" aria-label="${"x".repeat(220)}"><path d="${drawing.grid}"></path><path d="${drawing.ground}"></path><path d="${drawing.ground}"></path>${scene.base.map((p) => path(p)).join("")}</g>${zones}<g class="ug-ld" aria-hidden="true">${callouts}</g></svg>`;
}

describe("the drawings", () => {
  test("the side-by-side and the ATV have every system, each its own region with a label point on it", () => {
    for (const vehicle of ["utv", "atv"] as const) {
      const drawing = drawingFor(vehicle);
      const { x, y, w, h } = drawing.box;
      for (const system of DRAWN) {
        const zone = drawing.zones[system];
        assert.ok(zone && zone.paths.length > 0, `${vehicle} ${system}`);
        const [ax, ay] = zone.anchor;
        assert.ok(ax > x && ax < x + w && ay > y && ay < y + h, `${vehicle} ${system} anchor ${zone.anchor}`);
      }
      // No two systems point their labels at the same spot.
      const spots = DRAWN.map((system) => drawing.zones[system]!.anchor.map((n) => Math.round(n / 4)).join(","));
      assert.equal(new Set(spots).size, spots.length, `${vehicle} anchors`);
    }
  });

  test("the generator has only the systems a generator has", () => {
    const drawing = drawingFor("generator");
    for (const system of ["engine", "fuel", "air_intake", "ignition", "exhaust", "cooling", "charging_starting", "electrical", "wheels_tires", "body_frame"] as const) {
      assert.ok(drawing.zones[system], system);
    }
    for (const system of ["drive_clutch", "transmission", "front_drive", "rear_drive", "brakes", "steering", "suspension"] as const) {
      assert.equal(drawing.zones[system], undefined, system);
    }
  });

  test("each drawing is well under 40 KB of SVG, lit or not: a lit system is drawn once, not over a copy", () => {
    for (const vehicle of ["utv", "atv", "generator"] as const) {
      const unlit = Buffer.byteLength(markupOf(sceneFor(vehicle, [])));
      assert.ok(unlit < 35_000, `${vehicle} unlit: ${unlit} bytes`);
      for (const [name, set] of Object.entries(SETS)) {
        const bytes = Buffer.byteLength(markupOf(sceneFor(vehicle, statesOf(set))));
        assert.ok(bytes < 38_500, `${vehicle} ${name}: ${bytes} bytes`);
      }
    }
    // The lit systems are left out of the line-work, and drawn once over it.
    const drawing = drawingFor("utv");
    const length = (paths: Path[]) => paths.reduce((sum, p) => sum + p.d.length, 0);
    const scene = sceneFor("utv", statesOf(SETS.overheat));
    const lit = scene.zones.map((zone) => zone.system);
    assert.equal(
      length(baseWithout(drawing, lit)) + lit.reduce((sum, zone) => sum + length(drawing.zones[zone]!.paths), 0),
      length(drawing.base),
    );
    assert.equal(baseWithout(drawing, []), drawing.base);
  });

  test("the same drawing every time (cached, and built the same way)", () => {
    assert.equal(drawingFor("utv"), drawingFor("utv"));
    assert.ok(drawingFor("utv").base.every((path) => /^M[-\d.]/.test(path.d)));
    // And the same layout at any width: nothing depends on the screen.
    assert.deepEqual(sceneFor("utv", statesOf(SETS.overheat)), sceneFor("utv", statesOf(SETS.overheat)));
  });

  test("only the likeliest systems glow; medium is hatched and low an outline (in the styles)", () => {
    const scene = sceneFor("utv", statesOf(SETS.overheat));
    assert.deepEqual(
      scene.zones.filter((zone) => zone.halo).map((zone) => zone.system),
      ["cooling", "drive_clutch"],
    );
    assert.match(UNIT_GRAPHIC_CSS, /\[data-glow=medium\] \.c\.f\{fill:var\(--hatch/);
    assert.match(UNIT_GRAPHIC_CSS, /\[data-glow=low\]\{[^}]*--a:/);
    assert.match(UNIT_GRAPHIC_CSS, /prefers-reduced-motion:no-preference\)\{\.ug-z\[data-glow=high\] \.h\{animation/);
  });
});

describe("labels for the lit systems", () => {
  const apart = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6;

  function checkLayout(callouts: Callout[], drawingBox: { x: number; y: number; w: number; h: number }, label: string) {
    for (const a of callouts) {
      assert.ok(a.x >= drawingBox.x - 0.01 && a.x + a.w <= drawingBox.x + drawingBox.w + 0.01, `${label} ${a.zone} x ${a.x}`);
      assert.ok(a.y + a.h <= drawingBox.y + 0.01 || a.y >= drawingBox.y + drawingBox.h - 0.01, `${label} ${a.zone} sits over the drawing`);
      assert.deepEqual(a.leader[0], a.anchor.map((n) => Math.round(n * 100) / 100), `${label} ${a.zone} leader starts at its part`);
      // The leader ends on its own label's inner edge.
      const [ex, ey] = a.leader.at(-1)!;
      assert.ok(ex >= a.x - 0.01 && ex <= a.x + a.w + 0.01 && (Math.abs(ey - a.y) < 0.02 || Math.abs(ey - (a.y + a.h)) < 0.02), `${label} ${a.zone} leader end`);
      for (const b of callouts) {
        if (a === b) continue;
        assert.ok(apart(a, b), `${label}: ${a.zone} overlaps ${b.zone}`);
        // Taps: neighbours' targets never overlap.
        assert.ok(apart(a.hit, b.hit), `${label}: ${a.zone}'s tap target overlaps ${b.zone}'s`);
        // No leader runs through another label.
        for (const segment of segmentsOf(a.leader)) assert.ok(!segmentHitsRect(segment, b), `${label}: ${a.zone}'s leader runs through ${b.zone}`);
      }
      assert.ok(a.hit.x <= a.x && a.hit.y <= a.y && a.hit.x + a.hit.w >= a.x + a.w && a.hit.y + a.hit.h >= a.y + a.h, `${label} ${a.zone} hit`);
    }
  }

  test("labels don't overlap, stay inside the drawing's width, and no leader runs through another label", () => {
    for (const vehicle of ["utv", "atv", "generator"] as const) {
      const drawing = drawingFor(vehicle);
      const sets: [string, C[]][] = [
        ...Object.entries(SETS),
        ["every system", DRAWN.filter((system) => drawing.zones[system]).map((system, i): C => [system, (["high", "medium", "low"] as const)[i % 3], "open"])],
      ];
      for (const [name, set] of sets) {
        const scene = sceneFor(vehicle, statesOf(set));
        checkLayout(scene.callouts, drawing.box, `${vehicle} ${name}`);
        // The view holds every label and its tap target.
        assert.ok(scene.view.y <= Math.min(...scene.callouts.map((c) => c.hit.y)) + 0.02, `${vehicle} ${name} view top`);
        assert.ok(scene.view.y + scene.view.h >= Math.max(...scene.callouts.map((c) => c.hit.y + c.hit.h)) - 0.02, `${vehicle} ${name} view bottom`);
      }
    }
    // A made-up crowd: every system, long names, a small font.
    const drawing = drawingFor("utv");
    const items = DRAWN.map((system) => ({ zone: system, anchor: drawing.zones[system]!.anchor, text: `${system} system`, rank: system.length % 5 }));
    const { callouts } = layoutCallouts(items, drawing.box, 13);
    assert.equal(callouts.length, items.length);
    checkLayout(callouts, drawing.box, "crowd");
    for (const a of callouts) assert.ok(Math.abs(a.w - calloutWidth(a.text, 13)) < 0.01);
  });

  test("in a realistic diagnosis the leaders don't cross, and labels mostly fit one row above and one below", () => {
    for (const vehicle of ["utv", "atv"] as const) {
      for (const [name, set] of Object.entries(SETS)) {
        const scene = sceneFor(vehicle, statesOf(set));
        assert.equal(leaderCrossings(scene.callouts), 0, `${vehicle} ${name}`);
        assert.ok(scene.callouts.every((c) => c.row <= 1), `${vehicle} ${name} rows`);
      }
    }
    // Five systems on a side-by-side: one row each side.
    assert.ok(sceneFor("utv", statesOf(SETS.overheat)).callouts.every((c) => c.row === 0));
  });

  test("ruled-out systems get a cross on the drawing, not a label; the likeliest get the nearest rows", () => {
    const scene = sceneFor("utv", statesOf(SETS.overheat));
    assert.deepEqual(scene.marks.map((mark) => mark.system), ["charging_starting"]);
    assert.ok(!scene.callouts.some((c) => c.zone === "charging_starting"));
    // A crowd: the high ones are in the rows next to the drawing.
    const crowd = sceneFor("utv", statesOf(DRAWN.map((system, i): C => [system, i < 3 ? "high" : "low", "open"])));
    for (const c of crowd.callouts) if (["engine", "fuel", "air_intake"].includes(c.zone)) assert.equal(c.row, 0, c.zone);
  });

  test("no lit systems, no labels, and the drawing keeps its size", () => {
    const drawing = drawingFor("atv");
    const { callouts, box } = layoutCallouts([], drawing.box, 12);
    assert.equal(callouts.length, 0);
    assert.deepEqual(box, drawing.box);
  });
});

describe("the thread", () => {
  test("the quick form's first message reads back as labelled rows", () => {
    const text = startMessage({ unit: "2019 RZR XP 1000 EPS — Z19VDE99AM", complaint: "Misfires under load", faultCodes: ["P0300", "P0301"], checked: "Battery tested good" });
    assert.deepEqual(openingRows(text), {
      rows: [
        { label: "Unit", value: "2019 RZR XP 1000 EPS — Z19VDE99AM" },
        { label: "Complaint", value: "Misfires under load" },
        { label: "Fault codes", value: "P0300, P0301" },
        { label: "Already checked", value: "Battery tested good" },
      ],
      more: "",
    });
    assert.deepEqual(openingRows("Unit: 2020 Ranger\nCarrying on from an earlier diagnosis."), {
      rows: [{ label: "Unit", value: "2020 Ranger" }],
      more: "Carrying on from an earlier diagnosis.",
    });
    assert.equal(openingRows("2019 RZR, misfire under load. Unit: unknown"), null);
  });

  test("a tapped question goes into the reply box: above what's typed, or as a block of its own after earlier quotes", () => {
    assert.equal(addQuote("", "How many hours?"), "> How many hours?\n");
    // Typed first: that's the answer, so the quote goes above it.
    assert.equal(addQuote("About 300  \n", "How many hours?"), "> How many hours?\nAbout 300");
    // After a quote and its answer, a new block.
    assert.equal(addQuote("> How many hours?\nAbout 300", "Does it misfire cold?"), "> How many hours?\nAbout 300\n\n> Does it misfire cold?\n");
    // Two quotes in a row don't run together.
    assert.equal(addQuote("> How many hours?\n", "Does it misfire cold?"), "> How many hours?\n\n> Does it misfire cold?\n");
  });

  test("a question goes into the reply box as a short quote", () => {
    assert.equal(quoteQuestion("How many hours are on it?"), "> How many hours are on it?\n");
    const long = quoteQuestion(`Does it ${"really ".repeat(40)}misfire cold?`);
    assert.ok(long.startsWith("> Does it really") && long.endsWith("…\n") && long.length <= 2 + 140 + 1);
    assert.equal(quoteQuestion("Two\nlines"), "> Two lines\n");
  });

  test("on a tablet, the chat tab says how the last message ended: a reply, stopped, or not sent", () => {
    assert.deepEqual([chatNews("done").badge, chatNews("done").text], ["New reply", "Claude replied."]);
    // Stopped by the tech isn't a failure.
    assert.deepEqual([chatNews("stopped").badge, chatNews("stopped").text], ["Stopped", "Your message was stopped."]);
    assert.deepEqual([chatNews("failed").badge, chatNews("failed").text], ["Not sent", "Your last message didn't go through."]);
  });

  test("what Claude looked at is counted for the activity chips", () => {
    const step = (kind: ProgressStep["kind"]): ProgressStep => ({ kind, label: kind, at: "" });
    assert.deepEqual(activityCounts([step("search"), step("thinking"), step("search"), step("read"), step("web"), step("writing")]), {
      searches: 2,
      pages: 1,
      web: 1,
    });
  });
});
