// Diagnose's part sheet: the part names for each system (the reviewed list
// and the parts the causes name, those first), how a part's pages rank
// (cited pages, then the service procedure in the unit's own manual, a
// contents page last), which pages have its drawings (an exploded view
// first, then its procedure page and the pages cited for it) and which of
// the drawings found on them the sheet shows, the search of the
// conversation's manuals, and reading a
// page once with a scripted stand-in for the Claude API (checked against
// the page, saved, read once by two devices at once, the shop's daily
// allowance, no API key, failures tried again later, the real SDK's
// request), all inside the shop.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { attemptCounters, diagnosisConversations, diagnosisTurns, manualPageFacts, shops, users } from "../src/db/schema";
import { askClaude } from "../src/lib/claude";
import { partPageCard, partSheet } from "../src/lib/diagnose-part-sheet";
import {
  MAX_PARTS,
  MIN_CALLOUTS,
  PART_NAMES,
  aboutPart,
  calloutNumbers,
  cardOf,
  cardSettled,
  causesIn,
  VIEW_SCORE,
  drawingLabel,
  drawingPages,
  drawingScore,
  drawingsOf,
  isContentsPage,
  isDrawnSystem,
  isHeadingLine,
  largePage,
  mentionsPart,
  numberedSteps,
  otherPages,
  panelDrawings,
  partLibraryHref,
  partNames,
  partOfCause,
  partSearchText,
  rankPages,
  samePage,
  type DrawingPage,
  type PageCandidate,
  type PartCard,
  type PartPage,
  type PartSheet,
} from "../src/lib/diagnose-parts";
import type { DiagnosisReply } from "../src/lib/diagnose-rules";
import { CAUSE_SYSTEMS, type DrawnSystem } from "../src/lib/diagnose-zones";
import { partViewHeading, searchDrawingPages } from "../src/lib/library";
import { finishCatalogImport, saveCatalogBatch } from "../src/lib/manual-catalog";
import { PAGE_FACTS_LIMITS, readPageFacts, savedPageFacts } from "../src/lib/manual-facts";
import { FACTS_NUDGE, FACTS_TOOL_NAME, PAGE_FACTS_MODEL, type FactsState, type PageAsk, type PageFacts, type PageRef } from "../src/lib/manual-facts-rules";
import { confirmManualUpload, finishManual, saveManualPages, startManualUpload, storageKeyFor } from "../src/lib/manuals";
import type { CurrentUser } from "../src/lib/session";
import type { FileStorage } from "../src/lib/storage";

type Message = Anthropic.Messages.Message;
type Params = Anthropic.Messages.MessageCreateParamsNonStreaming;

// --- Realistic pages ---------------------------------------------------------------

// A chapter's contents: it names every part and shows none.
const CONTENTS = `CHAPTER 10
ELECTRICAL
GENERAL INFORMATION . . . . . . . . . . . . . . . . 10.2
BATTERY SERVICE . . . . . . . . . . . . . . . . . . 10.40
STARTER SOLENOID SERVICE . . . . . . . . . . . . . . 10.62
STARTER MOTOR SERVICE . . . . . . . . . . . . . . . 10.64
STATOR TEST . . . . . . . . . . . . . . . . . . . . 10.70`;
const WIRING = `STARTING SYSTEM WIRING DIAGRAM
Battery
Starter Solenoid
Starter Motor
RD/WH
BK
ECU
Key Switch
10.60`;
const SOLENOID = `ELECTRICAL
STARTER SOLENOID SERVICE
STARTER SOLENOID REPLACEMENT
1. Raise dump bed.
2. Remove battery access panel.
3. Disconnect battery positive (+) and negative (-) cables.
4. Remove the cable fasteners from the starter solenoid terminals.
5. Remove the two fasteners securing the starter solenoid to the frame.
6. Remove the starter solenoid.
7. Installation is performed by reversing the removal procedure.
TORQUE
Starter Solenoid Fastener:
97 in-lbs (11 N·m)
TORQUE
Starter Solenoid Cable Fastener:
35 in-lbs (4 N·m)
TORQUE
Battery Terminal Fastener (Positive):
106 in-lbs (12 N·m)
Battery Terminal Fastener (Negative):
62 in-lbs (7 N·m)
10.62`;
const STARTER = `STARTER MOTOR SERVICE
STARTER MOTOR REMOVAL
1. Disconnect battery negative (-) cable.
2. Remove the starter cable nut and the cable.
3. Remove the two starter mounting bolts.
4. Remove the starter motor from the engine.
TORQUE
Starter Motor Mounting Bolts:
8 ft-lbs (11 N·m)
TORQUE
Starter Cable Nut:
4 ft-lbs (5 N·m)
10.64`;
const TROUBLESHOOTING = `STARTING SYSTEM TROUBLESHOOTING
Starter motor does not turn: check battery voltage, the starter solenoid and the key switch.
Starter motor turns slowly: check the battery and the starter motor cables.`;
const BATTERY = `BATTERY SERVICE
BATTERY REMOVAL
1. Raise dump bed.
2. Remove battery access panel.
3. Disconnect battery negative (-) cable first.
4. Disconnect battery positive (+) cable.
5. Remove the battery hold-down strap and lift the battery out.
Battery voltage fully charged: 12.6 V`;
// A page that's all diagram: a page number and a callout letter.
const DIAGRAM_ONLY = "10.66\nA";
// The starter motor's exploded view: its heading and the callout numbers
// around the drawing (a few side by side on a line), as a text layer gives
// them.
const STARTER_EXPLODED = `STARTER MOTOR EXPLODED VIEW\n1\n2\n3\n4 5\n6\n7\n8\n10.65`;
// A drawing with no heading, only its callouts and the part's name.
const STARTER_CALLOUTS = `Starter Motor\n1 2\n3\n4\n5\n6\n7\n10.67`;
const RZR_PAGES = [CONTENTS, WIRING, SOLENOID, STARTER, TROUBLESHOOTING, BATTERY, DIAGRAM_ONLY, STARTER_EXPLODED, STARTER_CALLOUTS];
// A General's manual as a real one has it: many transmission procedure
// pages that name it again and again, with a photo's callouts (lines of
// only a number) and a figure's "TOP VIEW", around the one exploded view,
// which names it in its heading and its parts list.
const GEARBOX_PROCEDURE = (n: number) => `TRANSMISSION REMOVAL ${n}
1. Remove the transmission skid plate and the transmission guard.
2. Disconnect the transmission shift linkage at the transmission.
3. Support the transmission with a jack.
4. Remove the transmission mounting bolts and lower the transmission.
1
2
3
TOP VIEW
9.${10 + n}`;
const GEARBOX_EXPLODED = `TRANSMISSION EXPLODED VIEW
1
2
3
4 5
6
7
8
9
10
1 Transmission case  2 Input shaft  3 Bearing  4 Seal  5 Gear
9.40`;
// Views headed with the part's own name, in capitals and in title case
// (pages 22 and 23): searched for, they rank with the exploded view, not
// with the procedures' "TOP VIEW".
const GEARBOX_VIEW = `TRANSMISSION VIEW
1
2
3
4 5
6
7
8
1 Transmission case  2 Shift drum
9.42`;
const GEARBOX_TITLED = GEARBOX_VIEW.replace("TRANSMISSION VIEW", "Transmission View").replace("9.42", "9.43");
const GEARBOX_PAGES = [...Array.from({ length: 20 }, (_, i) => GEARBOX_PROCEDURE(i + 1)), GEARBOX_EXPLODED, GEARBOX_VIEW, GEARBOX_TITLED];

// Another line's manual with its own starter-solenoid page.
const RANGER_SOLENOID = `STARTER SOLENOID SERVICE
STARTER SOLENOID REPLACEMENT
1. Remove the seat.
2. Disconnect battery negative (-) cable.
3. Remove the starter solenoid.
TORQUE
Starter Solenoid Fastener:
84 in-lbs (9.5 N·m)`;

// --- Shops, people, manuals ----------------------------------------------------------

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
const shopIds: string[] = [];

async function createShop(code: string) {
  const [shop] = await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name });
  shopIds.push(shop.id);
  return shop;
}

async function createUser(shop: CurrentUser["shop"], role: CurrentUser["role"], name: string): Promise<CurrentUser> {
  const id = randomUUID();
  const username = `${name.toLowerCase()}${randomUUID().slice(0, 4)}`;
  await systemDb.insert(users).values({
    id,
    shopId: shop.id,
    role,
    name,
    username: `${shop.code}.${username}`,
    displayUsername: username,
    email: `${randomUUID()}@no-email.invalid`,
  });
  return { id, name, username, role, shop, bay: null };
}

async function addManual(actor: CurrentUser, fileName: string, pages: string[]) {
  const objects = new Map<string, number>();
  const storage: FileStorage = {
    uploadUrl: async (key) => `https://storage.test/${key}`,
    downloadUrl: async (key) => `https://storage.test/${key}`,
    size: async (key) => objects.get(key) ?? null,
  };
  const sizeBytes = 1000 + pages.join("").length;
  const sha256 = createHash("sha256").update(randomUUID()).digest("hex");
  const start = await startManualUpload(actor, { fileName, sizeBytes, sha256 }, storage);
  assert.ok("next" in start, JSON.stringify(start));
  objects.set(storageKeyFor(actor.shop.id, start.manualId), sizeBytes);
  await confirmManualUpload(actor, { manualId: start.manualId, pageCount: pages.length }, storage);
  await saveManualPages(actor, { manualId: start.manualId, pages: pages.map((text, index) => ({ pageNumber: index + 1, text })) });
  const finished = await finishManual(actor, { manualId: start.manualId });
  assert.ok("added" in finished, JSON.stringify(finished));
  return start.manualId;
}

async function importModels(actor: CurrentUser, files: { fileName: string; brand: string; title: string; models: [number, string, string][] }[]) {
  const importId = randomUUID();
  const saved = await saveCatalogBatch(actor, {
    importId,
    files: files.map((file) => ({ ...file, article: null, postedOn: null, modelYears: null })),
  });
  assert.ok("saved" in saved, JSON.stringify(saved));
  await finishCatalogImport(actor, { importId, fileName: "manual-list - All.csv", leftOut: 0, rowsWithoutFile: 0 });
}

let techA: CurrentUser;
let techB: CurrentUser;
let rzr: string;
let ranger: string;
let otherShopRzr: string;
let rzrTitle: string;

const page = (manualId: string, number: number): PageRef => ({ manualId, page: number });

// A conversation with one finished reply, as Diagnose saves it.
async function conversation(
  user: CurrentUser,
  unit: { modelNumber: string | null; label: string | null; scope: string[] | null },
  reply: Pick<DiagnosisReply, "likelyCauses" | "nextChecks"> | null,
) {
  const [row] = await systemDb
    .insert(diagnosisConversations)
    .values({
      shopId: user.shop.id,
      userId: user.id,
      title: "Won't crank",
      unitModelNumber: unit.modelNumber,
      unitLabel: unit.label,
      scopeManualIds: unit.scope,
      webSearch: false,
    })
    .returning({ id: diagnosisConversations.id });
  if (reply) {
    await systemDb.insert(diagnosisTurns).values({
      conversationId: row.id,
      shopId: user.shop.id,
      seq: 1,
      userId: user.id,
      techText: "Clicks but won't crank",
      status: "done",
      reply: { reply: "Start at the solenoid.", safetyNotes: [], questions: [], partial: false, dropped: 0, ...reply },
    });
  }
  return row.id;
}

const manualSource = (manualId: string, number: number) => ({ type: "manual" as const, manualId, page: number, title: rzrTitle });

let unitConversation: string;
let gearbox: string;
let gearboxElsewhere: string;
let gearboxConversation: string;

before(async () => {
  const shopA = await createShop(`pa${suffix}`);
  const shopB = await createShop(`pb${suffix}`);
  const adminA = await createUser(shopA, "admin", "Bea");
  techA = await createUser(shopA, "tech", "Mike");
  const adminB = await createUser(shopB, "admin", "Ola");
  techB = await createUser(shopB, "tech", "Ned");
  rzr = await addManual(adminA, "9928000.pdf", RZR_PAGES);
  ranger = await addManual(adminA, "9929000.pdf", ["2020 Ranger XP 1000 Service Manual", RANGER_SOLENOID]);
  otherShopRzr = await addManual(adminB, "9928000.pdf", RZR_PAGES);
  await importModels(adminA, [
    { fileName: "9928000.pdf", brand: "RZR", title: "2019 RZR XP 1000 Service Manual", models: [[2019, "Z19VDE99AM", "RZR XP 1000 EPS"]] },
    { fileName: "9929000.pdf", brand: "RGR", title: "2020 Ranger XP 1000 Service Manual", models: [[2020, "R20RRE99A9", "RANGER XP 1000 EPS"]] },
  ]);
  rzrTitle = "2019 RZR XP 1000 Service Manual";
  // The unit's own manual and another line's, so both are searched.
  unitConversation = await conversation(
    techA,
    { modelNumber: "Z19VDE99AM", label: "2019 RZR XP 1000 EPS — Z19VDE99AM", scope: [rzr, ranger] },
    {
      likelyCauses: [
        { title: "Starter solenoid failing", system: "charging_starting", likelihood: "high", why: "It clicks.", status: "open", sources: [manualSource(rzr, 3)] },
        { title: "Weak battery", system: "charging_starting", likelihood: "medium", why: "Slow to crank before.", status: "open", sources: [manualSource(rzr, 6)] },
        { title: "Ignition coil breaking down", system: "ignition", likelihood: "low", why: "Unlikely.", status: "open", sources: [] },
      ],
      nextChecks: [
        { tier: "test", action: "Check for 12 V at the solenoid's small terminal with the key on START.", causes: [1], expected: "12 V", sources: [manualSource(rzr, 5)], unverifiedSpec: false },
      ],
    },
  );
  // A General's manual (its transmission pages), and another manual in the
  // same shop, outside the conversation, with an exploded view of its own.
  gearbox = await addManual(adminA, "9931000.pdf", GEARBOX_PAGES);
  gearboxElsewhere = await addManual(adminA, "9932000.pdf", [GEARBOX_EXPLODED, GEARBOX_EXPLODED.replace("9.40", "9.41")]);
  gearboxConversation = await conversation(techA, { modelNumber: null, label: "General 4 1000", scope: [gearbox] }, null);
});

after(async () => {
  for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
  await systemDb.$client.end();
});

// --- A scripted stand-in for the Claude API ---------------------------------------

let ids = 0;
function message(content: unknown[], stopReason: Message["stop_reason"] = "tool_use"): Message {
  return {
    id: `msg_${++ids}`,
    type: "message",
    role: "assistant",
    model: PAGE_FACTS_MODEL,
    content: content as Message["content"],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1400, output_tokens: 350, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null, server_tool_use: null, service_tier: null },
  } as unknown as Message;
}
const recorded = (input: Record<string, unknown>) =>
  message([{ type: "tool_use", id: `toolu_${++ids}`, name: FACTS_TOOL_NAME, input: { title: "", tools: [], ...input } }]);

type Script = Message | Error | ((params: Params) => Message);

function fakeClaude(script: Script[], { delayMs = 0 } = {}) {
  const calls: Params[] = [];
  const ask: PageAsk = async (params) => {
    calls.push(JSON.parse(JSON.stringify(params)));
    const step = script[calls.length - 1];
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (!step) throw new Error(`No scripted response for request ${calls.length}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(params) : step;
  };
  return { ask, calls };
}

// The starter solenoid page as Claude reads it, with a tool whose part
// number the page doesn't print (its steps and TORQUE boxes are read on the
// page, never on the card).
const SOLENOID_READING = {
  title: "STARTER SOLENOID REPLACEMENT",
  tools: ["Battery Terminal Wrench PU-50964"],
};

const shopKey = (user: CurrentUser) => `page-facts:shop:${user.shop.id}`;

async function savedRow(ref: PageRef) {
  const [row] = await systemDb
    .select()
    .from(manualPageFacts)
    .where(and(eq(manualPageFacts.manualId, ref.manualId), eq(manualPageFacts.pageNumber, ref.page)));
  return row;
}

async function forget(ref: PageRef) {
  await systemDb.delete(manualPageFacts).where(and(eq(manualPageFacts.manualId, ref.manualId), eq(manualPageFacts.pageNumber, ref.page)));
}

// --- Part names -----------------------------------------------------------------------

describe("part names", () => {
  test("a cause's title names its part: one on the list, a part noun, or its own words", () => {
    const cases: [string, DrawnSystem, string | null][] = [
      ["Starter solenoid failing", "charging_starting", "Starter solenoid"],
      ["Weak battery", "charging_starting", "Battery"],
      ["Corroded battery terminals", "charging_starting", "Battery cables"],
      ["Fouled or worn spark plugs", "ignition", "Spark plug"],
      ["Ignition coil breaking down under load", "ignition", "Ignition coil"],
      ["Exhaust leak at the header gasket", "exhaust", "Exhaust gasket"],
      ["Stretched or glazed drive belt", "drive_clutch", "Drive belt"],
      ["Clogged air filter", "air_intake", "Air filter"],
      ["Bad gear position switch", "transmission", "Gear position switch"],
      ["Water in the speedometer connector", "electrical", "Speedometer connector"],
      ["Loose ECU ground", "electrical", "Ground wires"],
      ["Failing ECU", "electrical", "ECU"],
      ["Low fuel pressure", "fuel", "Fuel pressure"],
      ["Lean condition", "fuel", null],
      ["Worn front CV boot (torn)", "front_drive", "CV boot"],
      // A fault word before the part doesn't start its name.
      ["Failed fuel pump relay", "fuel", "Fuel pump relay"],
      ["Torn CV boot", "front_drive", "CV boot"],
      ["Blown EFI fuse", "electrical", "EFI fuse"],
      ["Split intake boot", "air_intake", "Intake boot"],
      // A word left over that isn't a part on its own isn't one.
      ["Air pocket in the cooling system", "cooling", null],
      ["Low compression", "engine", null],
      // A part whose name starts with a word that can say what's wrong.
      ["Clogged air filter", "air_intake", "Air filter"],
      ["Coolant leak at the water pump", "cooling", "Water pump"],
    ];
    for (const [title, system, part] of cases) assert.equal(partOfCause(title, system), part, title);
  });

  test("every listed part's own name finds that part, so a cause naming it isn't listed twice", () => {
    for (const [system, parts] of Object.entries(PART_NAMES) as [DrawnSystem, (typeof PART_NAMES)[DrawnSystem]][]) {
      for (const part of parts) assert.equal(partOfCause(part.name, system), part.name, `${system}: ${part.name}`);
    }
  });

  test("every system drawn on the unit has its parts, once each, at most a chip row's worth", () => {
    for (const system of CAUSE_SYSTEMS.filter(isDrawnSystem)) {
      for (const vehicle of ["utv", "atv", "generator", null] as const) {
        const names = partNames(system, { vehicle });
        assert.ok(names.length > 0 && names.length <= MAX_PARTS, `${system} ${vehicle}`);
        assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length, `${system} ${vehicle}`);
      }
    }
    assert.equal(isDrawnSystem("other"), false);
    assert.equal(isDrawnSystem("nonsense"), false);
  });

  test("the causes' parts come first, the confirmed one first, then the system's list", () => {
    const causes = [
      { title: "Weak battery", system: "charging_starting", status: "open" as const },
      { title: "Ignition coil breaking down", system: "ignition", status: "open" as const },
      { title: "Starter solenoid failing", system: "charging_starting", status: "confirmed" as const },
      // Saved before causes carried a system: worked out from its words.
      { title: "Bad stator", status: "ruled_out" as const },
    ];
    const names = partNames("charging_starting", { vehicle: "utv", causes });
    assert.deepEqual(names.slice(0, 3), ["Starter solenoid", "Battery", "Stator"]);
    assert.ok(names.includes("Starter motor") && names.includes("Regulator/rectifier"));
    // The kind of unit picks what's on it: no recoil starter on a side-by-side.
    assert.ok(!names.includes("Recoil starter"));
    assert.ok(partNames("charging_starting", { vehicle: "generator" }).includes("Recoil starter"));
    assert.ok(partNames("fuel", { vehicle: "generator" }).includes("Carburetor"));
    assert.ok(!partNames("fuel", { vehicle: "utv" }).includes("Carburetor"));
    assert.deepEqual(
      causesIn(causes, "charging_starting").map((cause) => cause.title),
      ["Starter solenoid failing", "Weak battery", "Bad stator"],
    );
  });

  test("what's searched for a part", () => {
    assert.equal(partSearchText("Regulator/rectifier"), "Regulator rectifier");
    assert.equal(partSearchText("Piston and rings"), "Piston rings");
    assert.equal(partSearchText("T-MAP sensor"), "T-MAP sensor");
  });
});

// --- Ranking ---------------------------------------------------------------------------

const candidate = (text: string, extra: Partial<PageCandidate> = {}): PageCandidate => ({
  manualId: "00000000-0000-4000-8000-000000000001",
  page: RZR_PAGES.indexOf(text) + 1 || 99,
  title: "2019 RZR XP 1000 Service Manual",
  text,
  rank: 0.1,
  own: true,
  cited: null,
  ...extra,
});

describe("ranking a part's pages", () => {
  test("what a page is: a contents page, numbered steps, the part on it", () => {
    assert.ok(isContentsPage(CONTENTS));
    assert.ok(!isContentsPage(SOLENOID));
    assert.equal(numberedSteps(SOLENOID), 7);
    assert.equal(numberedSteps(TROUBLESHOOTING), 0);
    assert.ok(mentionsPart(SOLENOID, "Starter solenoid"));
    assert.ok(mentionsPart(WIRING, "Starter solenoid"));
    assert.ok(!mentionsPart(BATTERY, "Starter solenoid"));
  });

  test("the part's service procedure beats its wiring diagram, a troubleshooting chart and the contents", () => {
    const pages = [CONTENTS, WIRING, TROUBLESHOOTING, SOLENOID, STARTER].map((text) => candidate(text, { rank: text === CONTENTS ? 0.9 : 0.2 }));
    assert.equal(rankPages(pages, "Starter solenoid")[0].text, SOLENOID);
    assert.equal(rankPages(pages, "Starter motor")[0].text, STARTER);
    assert.notEqual(rankPages(pages, "Starter solenoid").at(-1)?.text, SOLENOID);
    assert.ok(!rankPages(pages, "Starter solenoid", 3).some((page) => page.text === CONTENTS));
  });

  test("a contents page comes last, after a page with only some of the part's words; alone, it's a page that only names the part", () => {
    // At its best: in the unit's own manual, search's top rank, another cause citing it.
    const contents = candidate(CONTENTS, { rank: 1, own: true, cited: "system" });
    const words = candidate(BATTERY, { rank: 0, own: false, manualId: "00000000-0000-4000-8000-000000000002" });
    assert.deepEqual(rankPages([contents, words], "Starter solenoid").map((page) => page.text), [BATTERY, CONTENTS]);
    assert.deepEqual(rankPages([contents], "Starter solenoid").map((page) => page.text), [CONTENTS]);
    assert.ok(!aboutPart(contents, "Starter solenoid"));
  });

  test("a page about the part beats another part's procedure that names it on the way", () => {
    const cargo = `BODY\nCARGO BOX\nCargo box latch\nCargo box hinge pin\nTailgate\nGas assist shock\n11.20`;
    const battery = `BATTERY LOCATION\nBattery\nBattery hold-down strap\nPositive (+) cable\nNegative (-) cable\n10.38`;
    // The solenoid procedure's step 1 raises the cargo box and step 2 opens the battery's panel.
    const raising = SOLENOID.replace("Raise dump bed.", "Raise the rear cargo box.");
    assert.equal(rankPages([candidate(raising, { page: 3 }), candidate(cargo, { page: 20 })], "Cargo box")[0].text, cargo);
    assert.equal(rankPages([candidate(SOLENOID), candidate(battery, { page: 38 })], "Battery")[0].text, battery);
    // Another cause in the system citing the procedure doesn't make it the battery's.
    assert.equal(rankPages([candidate(SOLENOID, { cited: "system" }), candidate(battery, { page: 38 })], "Battery")[0].text, battery);
    // A contents page's lines aren't headings.
    assert.ok(!aboutPart(candidate(CONTENTS), "Starter solenoid"));
    assert.ok(aboutPart(candidate(cargo), "Cargo box") && aboutPart(candidate(battery), "Battery"));
    assert.ok(!aboutPart(candidate(raising), "Cargo box") && !aboutPart(candidate(SOLENOID), "Battery"));
    assert.ok(aboutPart(candidate(SOLENOID), "Starter solenoid") && aboutPart(candidate(TROUBLESHOOTING, { cited: "part" }), "Battery"));
  });

  test("the unit's own manual over another line's same procedure", () => {
    const pages = [candidate(RANGER_SOLENOID, { own: false, manualId: "00000000-0000-4000-8000-000000000002", rank: 0.5 }), candidate(SOLENOID, { rank: 0.2 })];
    assert.equal(rankPages(pages, "Starter solenoid")[0].text, SOLENOID);
  });

  test("a page a cause cites for the part comes first; the system's other cited pages next when the part is on them", () => {
    const pages = [candidate(SOLENOID), candidate(TROUBLESHOOTING, { cited: "part" }), candidate(BATTERY, { cited: "system" })];
    assert.equal(rankPages(pages, "Starter solenoid")[0].text, TROUBLESHOOTING);
    // The battery page doesn't have the starter solenoid on it.
    assert.equal(rankPages(pages, "Starter solenoid")[1].text, SOLENOID);
    assert.equal(rankPages(pages, "Battery")[0].text, TROUBLESHOOTING, "cited for the part asked about");
    assert.equal(rankPages([candidate(SOLENOID), candidate(BATTERY, { cited: "system" })], "Battery")[0].text, BATTERY);
  });

  test("each page once, at most the number asked for", () => {
    const pages = [candidate(SOLENOID), candidate(SOLENOID, { cited: "part" }), candidate(STARTER), candidate(WIRING), candidate(BATTERY), candidate(TROUBLESHOOTING)];
    const ranked = rankPages(pages, "Starter solenoid", 4);
    assert.equal(ranked.length, 4);
    assert.equal(new Set(ranked.map((page) => `${page.manualId}:${page.page}`)).size, 4);
  });
});

describe("a part's drawings", () => {
  const otherManual = "00000000-0000-4000-8000-000000000002";
  const asPage = (page: PageCandidate, extra: Partial<PartPage> = {}): PartPage => ({ manualId: page.manualId, page: page.page, title: page.title, cited: page.cited !== null, about: aboutPart(page, "Starter motor"), ...extra });

  test("callout numbers: lines of nothing but numbers counting up from 1; not steps, page numbers or a table's values", () => {
    assert.equal(calloutNumbers(STARTER_EXPLODED), 8);
    assert.equal(calloutNumbers(STARTER_CALLOUTS), 7);
    assert.equal(calloutNumbers("1A\n2\n3B\n(4)"), 3);
    assert.equal(calloutNumbers(SOLENOID), 0);
    assert.equal(calloutNumbers(STARTER), 0);
    assert.equal(calloutNumbers("Ring end gap\n25\n30\n35\n40\n45\n50"), 0);
    assert.ok(MIN_CALLOUTS > 3);
  });

  test("how much a page looks like the part's drawing: a view's heading naming it, a view's heading on a page naming it, callouts alone; none for a page without the part, a contents page or a procedure", () => {
    const legend = `EXPLODED VIEW\nStarter Assembly\nStarter motor housing\nBrush plate\n11.20`;
    const view = drawingScore(STARTER_EXPLODED, "Starter motor");
    assert.ok(view > drawingScore(legend, "Starter motor"), "the heading naming the part first");
    assert.ok(drawingScore(legend, "Starter motor") > drawingScore(STARTER_CALLOUTS, "Starter motor"));
    assert.ok(drawingScore(STARTER_CALLOUTS, "Starter motor") > 0);
    // "<part> VIEW" is a view's heading too, and callouts add to a heading.
    assert.ok(drawingScore("TRANSMISSION VIEW\nTransmission\n7.40", "Transmission") > drawingScore(legend, "Starter motor"));
    assert.ok(drawingScore(`${STARTER_EXPLODED}\n`, "Starter motor") === view && view > drawingScore("STARTER MOTOR EXPLODED VIEW\n10.65", "Starter motor"));
    for (const [text, part] of [
      [STARTER_EXPLODED, "Starter solenoid"],
      [CONTENTS + "\nSTARTER MOTOR EXPLODED VIEW . . . . . . . . . 10.65", "Starter motor"],
      [STARTER, "Starter motor"],
      [SOLENOID, "Starter solenoid"],
      [`Starter motor\nTop view of the starter`, "Starter motor"],
    ]) assert.equal(drawingScore(text, part), 0, text.slice(0, 30));
  });

  test("only a heading is a view's heading: a step or a note that points to a view isn't, and callouts alone are a page of callouts, never an exploded view", () => {
    const removal = `TRANSMISSION REMOVAL\n1. Remove the skid plate.\n2. Disconnect the shift linkage.\nRefer to the exploded view on page 8.12 for the transmission.\n8.10`;
    assert.equal(drawingScore(removal, "Transmission"), 0);
    for (const line of [
      "2. Refer to the exploded view of the transmission.",
      "REFER TO THE TRANSMISSION EXPLODED VIEW ON PAGE 8.12.",
      "See the assembly view for the transmission",
      "The transmission parts view shows every seal and the order they go in",
    ]) assert.equal(drawingScore(`TRANSMISSION SERVICE\n${line}\n8.11`, "Transmission"), 0, line);
    for (const heading of ["TRANSMISSION EXPLODED VIEW", "Transmission Exploded View", "Exploded View of the Transmission", "ASSEMBLY VIEW"]) {
      assert.ok(drawingScore(`${heading}\nTransmission case\n8.12`, "Transmission") >= VIEW_SCORE, heading);
      assert.equal(isHeadingLine(heading), true, heading);
    }
    for (const line of ["Refer to the exploded view", "1. EXPLODED VIEW", "Remove the transmission.", "TOP"]) assert.equal(isHeadingLine(line), false, line);
    // A procedure page with a photo's callouts 1 to 6: a page of callouts, not a view.
    const photo = `TRANSMISSION REMOVAL\n1. Remove the transmission skid plate.\n2. Remove the transmission.\n1\n2\n3\n4\n5\n6\n8.13`;
    const score = drawingScore(photo, "Transmission");
    assert.ok(score > 0 && score < VIEW_SCORE, String(score));
    const asCandidate = (text: string, page: number): PageCandidate => ({ manualId: "00000000-0000-4000-8000-000000000003", page, title: "General Service Manual", text, rank: 0.2, own: true, cited: null });
    const procedure = asCandidate(photo, 13);
    const other = asCandidate(photo.replace("8.13", "8.14"), 14);
    const best: PartPage = { manualId: procedure.manualId, page: 13, title: procedure.title, cited: false, about: true };
    // The sheet's best page stays its procedure page; another such page is a page of callouts, after the views.
    const view = asCandidate("TRANSMISSION EXPLODED VIEW\nTransmission case\n8.12", 12);
    assert.deepEqual(
      drawingPages([procedure, other, view, asCandidate(removal, 10)], [best], "Transmission").map((page) => [page.page, page.kind]),
      [
        [12, "exploded"],
        [14, "callouts"],
        [13, "procedure"],
      ],
    );
    assert.equal(drawingLabel({ manualId: best.manualId, page: 14, title: best.title, kind: "callouts", area: null, aspect: 1 }), "Drawing");
    // With nothing to crop, only an exploded view is shown as its page.
    const whole = (kind: DrawingPage["kind"], page: number) => ({ manualId: best.manualId, page, title: best.title, kind, area: null, aspect: 0.77 });
    assert.deepEqual(panelDrawings([whole("callouts", 14), whole("procedure", 13), whole("exploded", 12)], null).map((drawing) => drawing.page), [12]);
  });

  test("the pages for a part's drawings: its exploded views, the heading naming it and the unit's own manual first, then its procedure page, then pages cited for it; never one that only names it, each once, at most four", () => {
    const exploded = candidate(STARTER_EXPLODED, { rank: 0.05 });
    const callouts = candidate(STARTER_CALLOUTS, { rank: 0.5 });
    const elsewhere = candidate(STARTER_EXPLODED, { manualId: otherManual, own: false, rank: 0.9 });
    const procedure = asPage(candidate(STARTER));
    const cited = asPage(candidate(TROUBLESHOOTING), { cited: true, about: true });
    const named = asPage(candidate(SOLENOID), { cited: true, about: false });
    const drawings = drawingPages([callouts, elsewhere, exploded, candidate(SOLENOID)], [procedure, named, cited], "Starter motor");
    assert.deepEqual(
      drawings.map((page) => [page.manualId === otherManual ? "other" : "own", page.page, page.kind]),
      [
        ["own", 8, "exploded"],
        ["other", 8, "exploded"],
        ["own", 9, "callouts"],
        ["own", 4, "procedure"],
      ],
    );
    // With room, the pages cited for it follow; the procedure page once even when it's also a view.
    const fewer = drawingPages([exploded], [procedure, named, cited], "Starter motor");
    assert.deepEqual(fewer.map((page) => [page.page, page.kind]), [[8, "exploded"], [4, "procedure"], [5, "cited"]]);
    const same = drawingPages([exploded], [asPage(exploded)], "Starter motor");
    assert.deepEqual(same.map((page) => [page.page, page.kind]), [[8, "exploded"]]);
    // A best page that isn't about the part (it only names it) isn't its procedure.
    assert.deepEqual(drawingPages([], [named], "Starter motor"), []);
    assert.equal(drawingPages([exploded, callouts], [procedure], "Starter motor", 1).length, 1);
  });

  test("the drawings found on those pages: each page's figures, largest first, or the page itself; a page that couldn't be looked at left out; the sheet shows the cropped ones and an exploded view with nothing to crop unless it's the page drawn large", () => {
    const manualId = "00000000-0000-4000-8000-000000000001";
    const of = (page: number, kind: DrawingPage["kind"]): DrawingPage => ({ manualId, page, title: "2019 RZR XP 1000 Service Manual", cited: false, about: true, kind });
    const big = { left: 0.1, top: 0.4, right: 0.6, bottom: 0.9 };
    const small = { left: 0.6, top: 0.1, right: 0.9, bottom: 0.3 };
    const aspect = 612 / 792;
    const found = drawingsOf([
      { page: of(8, "exploded"), figures: { figures: [big, small], wholePage: false, aspect } },
      { page: of(10, "exploded"), figures: { figures: [], wholePage: false, aspect } },
      { page: of(11, "exploded"), figures: null },
      { page: of(4, "procedure"), figures: { figures: [], wholePage: true, aspect } },
    ]);
    assert.deepEqual(
      found.map((drawing) => [drawing.page, drawing.area === null ? "page" : drawing.area === big ? "big" : "small"]),
      [
        [8, "big"],
        [8, "small"],
        [10, "page"],
        [4, "page"],
      ],
    );
    assert.ok(Math.abs(found[0].aspect - (0.5 * aspect) / 0.5) < 1e-9 && found[2].aspect === aspect);
    assert.deepEqual(panelDrawings(found, { manualId, page: 4 }).map((drawing) => drawing.page), [8, 8, 10]);
    assert.deepEqual(panelDrawings(found, { manualId: manualId.toUpperCase(), page: 10 }).map((drawing) => drawing.page), [8, 8]);
    assert.equal(drawingsOf(Array.from({ length: 5 }, (_, i) => ({ page: of(i + 1, "exploded"), figures: { figures: [big, small], wholePage: false, aspect } }))).length, 8);
  });
});

describe("the sheet on the screen", () => {
  const manualId = "0f6e3a52-58c4-4c39-9d4e-6f7b3c0d9a11";
  const page = (n: number, cited = false): PartPage => ({ manualId, page: n, title: "2021 Ranger XD 1500 Service Manual", cited, about: true });
  const pages = [page(10, true), page(11), page(4)];

  test("the large page: the one picked among the part's pages, else the best; the others under it", () => {
    assert.equal(largePage({ pages }, null), pages[0]);
    assert.equal(largePage({ pages }, { manualId: manualId.toUpperCase(), page: 11 }), pages[1], "the manual's id in any case");
    // A page that isn't the part's (picked for another part) isn't drawn large.
    assert.equal(largePage({ pages }, { manualId, page: 99 }), pages[0]);
    assert.equal(largePage({ pages: [] }, null), null);
    assert.deepEqual(otherPages({ pages }, pages[1]), [pages[0], pages[2]]);
    assert.ok(samePage({ manualId, page: 4 }, { manualId: manualId.toUpperCase(), page: 4 }) && !samePage({ manualId, page: 4 }, { manualId, page: 5 }));
  });

  test("the card the sheet brings is only the large page's; settled cards aren't asked for again", () => {
    const facts = { page: { manualId, page: 10 }, state: { status: "unread" } as const };
    assert.deepEqual(cardOf({ facts }, pages[0]), { status: "unread" });
    assert.equal(cardOf({ facts }, pages[1]), null);
    assert.equal(cardOf({ facts: null }, pages[0]), null);
    const ready: FactsState = { status: "ready", facts: { title: "", tools: [], readOnPage: true, torqueOnPage: false } };
    assert.ok(cardSettled(ready) && cardSettled({ status: "empty" }));
    // No key, the day's readings used, a failed read: not asked again now.
    for (const reason of ["setup", "limit", "error"] as const) assert.ok(cardSettled({ status: "unavailable", reason }));
    assert.ok(!cardSettled({ status: "unread" }) && !cardSettled({ status: "reading" }));
  });

  test("a part with no page: the Library's search for it", () => {
    assert.equal(partLibraryHref("Starter solenoid"), "/library?q=Starter%20solenoid");
    assert.equal(partLibraryHref("  Regulator/rectifier "), "/library?q=Regulator%2Frectifier");
  });
});

// --- The sheet ------------------------------------------------------------------------

const sheetOf = (result: PartSheet | { error: string }) => {
  assert.ok(!("error" in result), JSON.stringify(result));
  return result as PartSheet;
};
const cardIn = (result: PartCard | { error: string }) => {
  assert.ok(!("error" in result), JSON.stringify(result));
  return result as PartCard;
};

describe("the part sheet", () => {
  beforeEach(async () => {
    await systemDb.delete(manualPageFacts).where(sql`${manualPageFacts.shopId} in (${sql.join(shopIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await systemDb.delete(attemptCounters).where(eq(attemptCounters.key, shopKey(techA)));
  });

  test("a system's sheet: the causes' parts first, the part's cited page large, other pages after, the card not read yet", async () => {
    const sheet = sheetOf(await partSheet(techA, { conversationId: unitConversation, system: "charging_starting" }));
    assert.deepEqual(sheet.parts.slice(0, 3), ["Starter solenoid", "Battery", "Starter motor"]);
    assert.equal(sheet.part, "Starter solenoid");
    assert.deepEqual(sheet.pages[0], { manualId: rzr, page: 3, title: rzrTitle, cited: true, about: true });
    // The check for the solenoid cites the troubleshooting page.
    assert.ok(sheet.pages.some((p) => p.manualId === rzr && p.page === 5 && p.cited));
    // The other line's starter-solenoid procedure is found too, after the unit's own.
    assert.ok(sheet.pages.some((p) => p.manualId === ranger && p.page === 2 && !p.cited));
    assert.ok(!sheet.pages.some((p) => p.page === 1 && p.manualId === rzr), "never the contents");
    assert.ok(sheet.pages.length <= 4);
    assert.equal(sheet.noManual, false);
    assert.deepEqual(sheet.facts, { page: page(rzr, 3), state: { status: "unread" } });
  });

  test("another part: found by search, its service procedure first", async () => {
    const sheet = sheetOf(await partSheet(techA, { conversationId: unitConversation, system: "charging_starting", part: "Starter motor" }));
    assert.equal(sheet.part, "Starter motor");
    assert.deepEqual(sheet.pages[0], { manualId: rzr, page: 4, title: rzrTitle, cited: false, about: true });
    const battery = sheetOf(await partSheet(techA, { conversationId: unitConversation, system: "charging_starting", part: "Battery" }));
    assert.deepEqual(battery.pages[0], { manualId: rzr, page: 6, title: rzrTitle, cited: true, about: true });
  });

  test("a part's drawings: its exploded views in the manuals searched first, then its procedure page and the pages cited for it", async () => {
    const motor = sheetOf(await partSheet(techA, { conversationId: unitConversation, system: "charging_starting", part: "Starter motor" }));
    assert.deepEqual(
      motor.drawings.map((page) => [page.manualId === rzr ? "rzr" : page.manualId, page.page, page.kind]),
      [
        ["rzr", 8, "exploded"],
        ["rzr", 9, "callouts"],
        ["rzr", 4, "procedure"],
      ],
    );
    assert.equal(motor.drawings[0].title, rzrTitle);
    // The procedure page is still the one drawn large.
    assert.equal(motor.pages[0].page, 4);
    // The starter solenoid has no exploded view: its procedure page, then the page its check cites.
    const solenoid = sheetOf(await partSheet(techA, { conversationId: unitConversation, system: "charging_starting" }));
    assert.deepEqual(solenoid.drawings.map((page) => [page.page, page.kind]), [[3, "procedure"], [5, "cited"]]);
    // A part no page is about has no drawings from a page that only names it.
    const frame = sheetOf(await partSheet(techA, { conversationId: unitConversation, system: "body_frame", part: "Frame" }));
    assert.deepEqual(frame.drawings, []);
    // Another shop's copy of the manual is never searched.
    assert.ok(!motor.drawings.some((page) => page.manualId === otherShopRzr));
  });

  test("a part's exploded view among many procedure pages that name the part more often, in the conversation's manuals only", async () => {
    const sheet = sheetOf(await partSheet(techA, { conversationId: gearboxConversation, system: "transmission", part: "Transmission" }));
    // The views first (the exploded view, and the views headed TRANSMISSION
    // VIEW and Transmission View), though twenty procedure pages rank
    // higher in the search (and have callouts and a "TOP VIEW").
    const views = sheet.drawings.slice(0, 3);
    assert.deepEqual(
      views.map((page) => [page.manualId, page.page, page.kind]).sort((a, b) => Number(a[1]) - Number(b[1])),
      [
        [gearbox, 21, "exploded"],
        [gearbox, 22, "exploded"],
        [gearbox, 23, "exploded"],
      ],
      JSON.stringify(sheet.drawings),
    );
    assert.equal(sheet.drawings.filter((page) => page.kind === "exploded").length, 3);
    // The procedure page after them, as a procedure; never the other manual in the shop.
    assert.equal(sheet.drawings.find((page) => page.page === sheet.pages[0]?.page)?.kind ?? "procedure", "procedure");
    assert.ok(!sheet.drawings.some((page) => page.manualId === gearboxElsewhere), JSON.stringify(sheet.drawings));
    // Straight from the search: the views first, at most the limit, all from the manuals asked for.
    const hits = await searchDrawingPages(techA.shop.id, "transmission", [gearbox], 12, 20_000);
    assert.equal(hits.length, 12);
    assert.deepEqual(
      hits
        .slice(0, 3)
        .map((hit) => [hit.manualId, hit.pageNumber])
        .sort((a, b) => Number(a[1]) - Number(b[1])),
      [
        [gearbox, 21],
        [gearbox, 22],
        [gearbox, 23],
      ],
      JSON.stringify(hits.map((hit) => hit.pageNumber)),
    );
    assert.ok(hits.every((hit) => hit.manualId === gearbox));
    assert.deepEqual(await searchDrawingPages(techB.shop.id, "transmission", [gearbox], 12, 20_000), []);
  });

  test("a view's heading naming the part, as the search finds it (in Postgres): in capitals or title case, plural or not, every word of the part on it; not a figure's TOP VIEW or a sentence", async () => {
    const named = async (query: string, text: string) => {
      const pattern = partViewHeading(query);
      assert.ok(pattern, query);
      const { rows } = await systemDb.execute<{ named: boolean }>(sql`select ${text} ~ ${pattern} as named`);
      return rows[0].named;
    };
    assert.equal(await named("transmission", "TRANSMISSION VIEW\n1\n2"), true);
    assert.equal(await named("transmission", "9.42\nTransmission View"), true);
    assert.equal(await named("Transmission", "TRANSMISSIONS VIEW"), true);
    assert.equal(await named("Valves", "VALVE TRAIN VIEW"), true);
    assert.equal(await named("Regulator rectifier", "REGULATOR / RECTIFIER VIEW"), true);
    assert.equal(await named("Regulator rectifier", "REGULATOR VIEW"), false);
    assert.equal(await named("transmission", "TRANSMISSION REMOVAL\nTOP VIEW"), false);
    assert.equal(await named("transmission", "Refer to the transmission view."), false);
    assert.equal(await named("transmission", "transmission view"), false);
    // Nothing of the search is read as the pattern's own.
    assert.equal(partViewHeading('"(.*)" ['), null);
    assert.equal(await named("a.b (c*)", "A B C VIEW"), true);
    assert.equal(await named("a.b (c*)", "A B VIEW"), false);
  });

  test("a part no page is about: the pages that name it, without a card", async () => {
    // The frame is only named in a step of the solenoid's procedure.
    const sheet = sheetOf(await partSheet(techA, { conversationId: unitConversation, system: "body_frame", part: "Frame" }));
    assert.ok(sheet.pages.length > 0 && sheet.pages.every((p) => !p.about), JSON.stringify(sheet.pages));
    assert.equal(sheet.facts, null);
  });

  test("a system with no causes still has its parts and pages", async () => {
    const sheet = sheetOf(await partSheet(techA, { conversationId: unitConversation, system: "cooling" }));
    assert.equal(sheet.parts[0], "Radiator");
    assert.deepEqual(sheet.pages, []);
    assert.equal(sheet.facts, null);
    assert.equal(sheet.noManual, false);
  });

  test("asking with the page reads it once: checked against the page, saved, the same card from then on", async () => {
    const claude = fakeClaude([recorded(SOLENOID_READING)]);
    const first = cardIn(await partPageCard(techA, { conversationId: unitConversation, page: page(rzr, 3) }, { ask: claude.ask }));
    assert.equal(claude.calls.length, 1);
    assert.equal(claude.calls[0].model, PAGE_FACTS_MODEL);
    assert.match(JSON.stringify(claude.calls[0].messages), /STARTER SOLENOID REPLACEMENT/);
    assert.equal(first.state.status, "ready");
    const facts = first.state.status === "ready" ? first.state.facts : null;
    // The title, no tool (its number isn't on the page), and the line saying
    // the page has its steps and torque specs.
    assert.deepEqual(facts, { title: "STARTER SOLENOID REPLACEMENT", tools: [], readOnPage: true, torqueOnPage: true });
    const row = await savedRow(page(rzr, 3));
    assert.equal(row.status, "ready");
    assert.equal(row.dropped, 1);
    assert.equal(row.inputTokens, 1400);
    assert.equal(row.outputTokens, 350);
    assert.ok(row.costCents > 0 && row.costCents < 2, String(row.costCents));
    assert.equal(row.shopId, techA.shop.id);

    // Opened again, with or without the page: no more requests.
    const again = cardIn(await partPageCard(techA, { conversationId: unitConversation, page: page(rzr, 3) }, { ask: claude.ask }));
    const opened = sheetOf(await partSheet(techA, { conversationId: unitConversation, system: "charging_starting" }));
    assert.equal(claude.calls.length, 1);
    assert.deepEqual(again, first);
    assert.deepEqual(opened.facts, first);
  });

  test("only a page of the conversation's manuals, or one it cites, can be read; only in the shop", async () => {
    const claude = fakeClaude([]);
    const otherShop = await partPageCard(techA, { conversationId: unitConversation, page: page(otherShopRzr, 3) }, { ask: claude.ask });
    assert.ok("error" in otherShop);
    const pastTheEnd = await partPageCard(techA, { conversationId: unitConversation, page: page(rzr, 40) }, { ask: claude.ask });
    assert.ok("error" in pastTheEnd);
    for (const bad of [{ manualId: "not-a-uuid", page: 1 }, { manualId: rzr, page: 0 }, { manualId: rzr, page: 1.5 }, null]) {
      assert.ok("error" in (await partPageCard(techA, { conversationId: unitConversation, page: bad }, { ask: claude.ask })));
    }
    assert.equal(claude.calls.length, 0);
    // Another shop's tech can't open this shop's diagnosis at all.
    assert.ok("error" in (await partSheet(techB, { conversationId: unitConversation, system: "charging_starting" })));
    assert.ok("error" in (await partPageCard(techB, { conversationId: unitConversation, page: page(rzr, 3) }, { ask: claude.ask })));
    assert.ok("error" in (await partSheet(techA, { conversationId: unitConversation, system: "other" })));
    assert.ok("error" in (await partSheet(techA, { conversationId: "nope", system: "charging_starting" })));
  });

  test("a conversation narrowed to one manual can't read another of the shop's", async () => {
    const narrowed = await conversation(techA, { modelNumber: "Z19VDE99AM", label: "2019 RZR XP 1000 EPS", scope: [rzr] }, null);
    const claude = fakeClaude([]);
    const result = await partPageCard(techA, { conversationId: narrowed, page: page(ranger, 2) }, { ask: claude.ask });
    assert.ok("error" in result);
    const sheet = sheetOf(await partSheet(techA, { conversationId: narrowed, system: "charging_starting" }));
    assert.deepEqual(sheet.pages[0], { manualId: rzr, page: 3, title: rzrTitle, cited: false, about: true });
    assert.ok(!sheet.pages.some((p) => p.manualId === ranger));
  });

  test("no unit, no manual: the sheet says so, with only the pages the causes cite", async () => {
    const whole = await conversation(techA, { modelNumber: null, label: null, scope: null }, {
      likelyCauses: [{ title: "Starter solenoid failing", system: "charging_starting", likelihood: "high", why: "", status: "open", sources: [manualSource(rzr, 3)] }],
      nextChecks: [],
    });
    const sheet = sheetOf(await partSheet(techA, { conversationId: whole, system: "charging_starting" }));
    assert.equal(sheet.noManual, true);
    assert.deepEqual(sheet.pages.map((p) => p.page), [3]);
    const motor = sheetOf(await partSheet(techA, { conversationId: whole, system: "charging_starting", part: "Starter motor" }));
    assert.deepEqual(motor.pages, []);
    assert.equal(motor.facts, null);
    // A page it cites can still be read.
    const claude = fakeClaude([recorded(SOLENOID_READING)]);
    const read = cardIn(await partPageCard(techA, { conversationId: whole, page: page(rzr, 3) }, { ask: claude.ask }));
    assert.equal(read.state.status, "ready");
    // A unit listed by model number with no scope of its own searches the unit's manuals.
    const byNumber = await conversation(techA, { modelNumber: "Z19VDE99AM", label: "2019 RZR XP 1000 EPS", scope: null }, null);
    const unitSheet = sheetOf(await partSheet(techA, { conversationId: byNumber, system: "charging_starting", part: "Starter motor" }));
    assert.equal(unitSheet.noManual, false);
    assert.equal(unitSheet.pages[0].page, 4);
  });
});

// --- Reading a page once --------------------------------------------------------------

describe("reading a page once", () => {
  beforeEach(async () => {
    await systemDb.delete(manualPageFacts).where(sql`${manualPageFacts.shopId} in (${sql.join(shopIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await systemDb.delete(attemptCounters).where(eq(attemptCounters.key, shopKey(techA)));
  });

  const starter = () => page(rzr, 4);
  const STARTER_READING = { title: "STARTER MOTOR REMOVAL", tools: [] };

  test("two devices opening the same page at once: one request, the other told it's being read, then both have the card", async () => {
    const claude = fakeClaude([recorded(STARTER_READING), recorded(STARTER_READING)], { delayMs: 300 });
    const [one, two] = await Promise.all([readPageFacts(techA.shop.id, starter(), { ask: claude.ask }), readPageFacts(techA.shop.id, starter(), { ask: claude.ask })]);
    // A read under way is never taken over while its route may still be running.
    assert.ok(PAGE_FACTS_LIMITS.staleAfterMs > 150_000);
    assert.equal(claude.calls.length, 1);
    const statuses = [one?.status, two?.status].sort();
    assert.deepEqual(statuses, ["reading", "ready"]);
    assert.equal((await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }))?.status, "ready");
    assert.equal(claude.calls.length, 1);
    // Only the read counts against the shop's allowance.
    const [counter] = await systemDb.select().from(attemptCounters).where(eq(attemptCounters.key, shopKey(techA)));
    assert.equal(counter.count, 1);
  });

  test("a card saved in an earlier shape (steps, cautions, a torque list, notes) is read without error, as these rules allow it", async () => {
    // As an earlier version saved it, with fields the card no longer has.
    const old = {
      title: "STARTER MOTOR REMOVAL",
      steps: [
        { n: 1, text: "Disconnect battery negative (-) cable." },
        { n: 4, text: "Torque the starter mounting bolts to 8 ft-lbs (11 N·m)." },
      ],
      torques: [{ item: "Starter Motor Mounting Bolts", value: "8 ft-lbs (11 N·m)" }],
      tools: [],
      cautions: [],
      notes: ["Starter Cable Nut: 4 ft-lbs (5 N·m)"],
      moreTorques: false,
    };
    const save = (status: "ready" | "empty", facts: unknown) =>
      withShop(techA.shop.id, (tx) => tx.insert(manualPageFacts).values({ manualId: rzr, shopId: techA.shop.id, pageNumber: 4, status, facts: facts as PageFacts }));
    await save("ready", old);
    const claude = fakeClaude([]);
    const card: FactsState = { status: "ready", facts: { title: "STARTER MOTOR REMOVAL", tools: [], readOnPage: true, torqueOnPage: true } };
    assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }), card);
    assert.deepEqual(await savedPageFacts(techA.shop.id, starter()), card);
    // A card that had only torques and notes, or one saved as having nothing
    // for a card: the line saying the page has its steps and torque specs.
    for (const [status, facts] of [
      ["ready", { title: "", steps: [], torques: old.torques, tools: [], cautions: [], notes: old.notes }],
      ["empty", { title: "", steps: [], tools: [], cautions: [], torqueOnPage: false }],
    ] as const) {
      await forget(starter());
      await save(status, facts);
      assert.deepEqual(await savedPageFacts(techA.shop.id, starter()), { status: "ready", facts: { title: "", tools: [], readOnPage: true, torqueOnPage: true } });
    }
    // Nothing read again for either.
    assert.equal(claude.calls.length, 0);
  });

  test("past the shop's daily readings: the page isn't claimed or read", async () => {
    await systemDb.insert(attemptCounters).values({ key: shopKey(techA), count: PAGE_FACTS_LIMITS.perShopPerDay, windowStartedAt: Date.now(), lastAttemptAt: Date.now() });
    const claude = fakeClaude([recorded(STARTER_READING)]);
    assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }), { status: "unavailable", reason: "limit" });
    assert.equal(claude.calls.length, 0);
    assert.equal(await savedRow(starter()), undefined);
    assert.deepEqual(await savedPageFacts(techA.shop.id, starter()), { status: "unread" });
  });

  test("without an API key: not readable, nothing saved, readable once there is one", async () => {
    assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: null }), { status: "unavailable", reason: "setup" });
    assert.equal(await savedRow(starter()), undefined);
    const claude = fakeClaude([recorded(STARTER_READING)]);
    assert.equal((await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }))?.status, "ready");
  });

  test("an API error: the page isn't readable for a while, not asked again on every open, then tried again", async () => {
    const claude = fakeClaude([
      new Anthropic.InternalServerError(529, { type: "error", error: { type: "overloaded_error", message: "busy" } }, undefined, new Headers()),
      recorded(STARTER_READING),
    ]);
    assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }), { status: "unavailable", reason: "error" });
    let row = await savedRow(starter());
    assert.equal(row.status, "failed");
    assert.match(row.error ?? "", /overloaded/);
    assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }), { status: "unavailable", reason: "error" });
    assert.deepEqual(await savedPageFacts(techA.shop.id, starter()), { status: "unavailable", reason: "error" });
    assert.equal(claude.calls.length, 1);
    // A while later it's read again.
    await systemDb
      .update(manualPageFacts)
      .set({ attemptedAt: new Date(Date.now() - PAGE_FACTS_LIMITS.retryAfterMs - 1000) })
      .where(and(eq(manualPageFacts.manualId, rzr), eq(manualPageFacts.pageNumber, 4)));
    assert.deepEqual(await savedPageFacts(techA.shop.id, starter()), { status: "unread" });
    assert.equal((await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }))?.status, "ready");
    row = await savedRow(starter());
    // The overload wasn't the page's: only the read that went through counts.
    assert.equal(row.attempts, 1);
    assert.equal(row.error, null);
  });

  test("a bad API key is reported as setup", async () => {
    const claude = fakeClaude([new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined, new Headers())]);
    assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }), { status: "unavailable", reason: "setup" });
  });

  test("a read whose server went away is taken over after a while", async () => {
    await withShop(techA.shop.id, (tx) =>
      tx.insert(manualPageFacts).values({ manualId: rzr, shopId: techA.shop.id, pageNumber: 4, status: "reading", attemptedAt: new Date(Date.now() - 10_000) }),
    );
    const claude = fakeClaude([recorded(STARTER_READING)]);
    assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }), { status: "reading" });
    assert.equal(claude.calls.length, 0);
    await systemDb
      .update(manualPageFacts)
      .set({ attemptedAt: new Date(Date.now() - PAGE_FACTS_LIMITS.staleAfterMs - 1000) })
      .where(and(eq(manualPageFacts.manualId, rzr), eq(manualPageFacts.pageNumber, 4)));
    assert.equal((await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }))?.status, "ready");
    assert.equal(claude.calls.length, 1);
  });

  test("an answer without the tool is asked once more; a refusal or a cut-off answer is a failed read", async () => {
    const claude = fakeClaude([message([{ type: "text", text: "This page covers the starter motor." }], "end_turn"), recorded(STARTER_READING)]);
    assert.equal((await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }))?.status, "ready");
    assert.equal(claude.calls.length, 2);
    const resent = claude.calls[1].messages;
    assert.equal(resent.length, 3);
    assert.equal(resent[1].role, "assistant");
    assert.match(JSON.stringify(resent[2]), new RegExp(FACTS_NUDGE.slice(0, 30)));
    // Both requests' tokens are counted.
    assert.equal((await savedRow(starter())).inputTokens, 2800);

    for (const [reply, problem] of [
      [message([], "refusal"), "refusal"],
      [message([{ type: "tool_use", id: "toolu_cut", name: FACTS_TOOL_NAME, input: { title: "STARTER" } }], "max_tokens"), "max_tokens"],
    ] as const) {
      await forget(starter());
      const once = fakeClaude([reply, recorded(STARTER_READING)]);
      assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: once.ask }), { status: "unavailable", reason: "error" });
      assert.equal((await savedRow(starter())).error, problem);
      // It would go the same way again: not asked again, even a while later.
      await systemDb
        .update(manualPageFacts)
        .set({ attemptedAt: new Date(Date.now() - PAGE_FACTS_LIMITS.retryAfterMs - 1000) })
        .where(and(eq(manualPageFacts.manualId, rzr), eq(manualPageFacts.pageNumber, 4)));
      assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: once.ask }), { status: "unavailable", reason: "error" });
      assert.deepEqual(await savedPageFacts(techA.shop.id, starter()), { status: "unavailable", reason: "error" });
      assert.equal(once.calls.length, 1);
    }
  });

  // A while later: the failed read's wait is over.
  const later = () =>
    systemDb
      .update(manualPageFacts)
      .set({ attemptedAt: new Date(Date.now() - PAGE_FACTS_LIMITS.retryAfterMs - 1000) })
      .where(and(eq(manualPageFacts.manualId, rzr), eq(manualPageFacts.pageNumber, 4)));
  const apiError = (status: number, type: string) => Anthropic.APIError.generate(status, { type: "error", error: { type, message: type } }, undefined, new Headers());

  test("a read that fails because of the page is tried three times in all, then no more; the service's failures between don't count", async () => {
    const noCall = () => message([{ type: "text", text: "This page covers the starter motor." }], "end_turn");
    const claude = fakeClaude([
      apiError(400, "invalid_request_error"),
      apiError(529, "overloaded_error"),
      // No tool call, even after the nudge: two requests, one read.
      noCall(),
      noCall(),
      apiError(429, "rate_limit_error"),
      apiError(413, "request_too_large"),
    ]);
    const counted: number[] = [];
    for (let i = 0; i < 6; i++) {
      assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }), { status: "unavailable", reason: "error" });
      counted.push((await savedRow(starter())).attempts);
      await later();
    }
    assert.deepEqual(counted, [1, 1, 2, 2, 3, 3]);
    // The sixth open asked nothing: the page's three reads are used up.
    assert.equal(claude.calls.length, 6);
    assert.match((await savedRow(starter())).error ?? "", /too_long/);
    assert.deepEqual(await savedPageFacts(techA.shop.id, starter()), { status: "unavailable", reason: "error" });
  });

  test("a read that fails because of the service is tried again after the wait however often, so the card comes back with it", async () => {
    const failures: [Error, "error" | "setup"][] = [
      [apiError(529, "overloaded_error"), "error"],
      [apiError(500, "api_error"), "error"],
      [apiError(429, "rate_limit_error"), "error"],
      [apiError(402, "billing_error"), "error"],
      // Out of credit, as the API has also said it: a 400.
      [
        Anthropic.APIError.generate(
          400,
          { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } },
          undefined,
          new Headers(),
        ),
        "error",
      ],
      [apiError(401, "authentication_error"), "setup"],
      [apiError(403, "permission_error"), "setup"],
      [new Anthropic.APIConnectionTimeoutError(), "error"],
      [new Anthropic.APIConnectionError({ message: "Connection error." }), "error"],
    ];
    assert.ok(failures.length > PAGE_FACTS_LIMITS.maxAttempts);
    const claude = fakeClaude([...failures.map(([error]) => error), recorded(STARTER_READING)]);
    for (const [error, reason] of failures) {
      assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }), { status: "unavailable", reason }, error.message);
      assert.equal((await savedRow(starter())).attempts, 0, error.message);
      // Not asked again before the wait is over.
      const asked = claude.calls.length;
      assert.deepEqual(await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }), { status: "unavailable", reason: "error" });
      assert.equal(claude.calls.length, asked);
      await later();
      assert.deepEqual(await savedPageFacts(techA.shop.id, starter()), { status: "unread" }, error.message);
    }
    assert.equal((await readPageFacts(techA.shop.id, starter(), { ask: claude.ask }))?.status, "ready");
    assert.equal(claude.calls.length, failures.length + 1);
    const row = await savedRow(starter());
    assert.equal(row.attempts, 1);
    assert.equal(row.error, null);
  });

  test("a page with nothing for a card is saved as such and not read again; a page with hardly any text isn't read at all", async () => {
    const wiring = page(rzr, 2);
    const claude = fakeClaude([recorded({ title: "STARTING SYSTEM WIRING DIAGRAM" })]);
    assert.deepEqual(await readPageFacts(techA.shop.id, wiring, { ask: claude.ask }), { status: "empty" });
    assert.equal((await savedRow(wiring)).status, "empty");
    assert.deepEqual(await readPageFacts(techA.shop.id, wiring, { ask: claude.ask }), { status: "empty" });
    assert.equal(claude.calls.length, 1);

    const diagram = page(rzr, 7);
    assert.deepEqual(await savedPageFacts(techA.shop.id, diagram), { status: "empty" });
    assert.deepEqual(await readPageFacts(techA.shop.id, diagram, { ask: claude.ask }), { status: "empty" });
    assert.equal(claude.calls.length, 1);
    assert.equal(await savedRow(diagram), undefined);
  });

  test("another shop never sees this shop's readings or pages", async () => {
    const claude = fakeClaude([recorded(STARTER_READING)]);
    await readPageFacts(techA.shop.id, starter(), { ask: claude.ask });
    const seen = await withShop(techB.shop.id, (tx) => tx.select().from(manualPageFacts));
    assert.deepEqual(seen, []);
    assert.equal(await readPageFacts(techB.shop.id, starter(), { ask: claude.ask }), null);
    assert.equal(await savedPageFacts(techB.shop.id, starter()), null);
    // Its own copy of the same manual is its own page, read on its own.
    const own = fakeClaude([recorded(STARTER_READING)]);
    assert.equal((await readPageFacts(techB.shop.id, page(otherShopRzr, 4), { ask: own.ask }))?.status, "ready");
    assert.equal(own.calls.length, 1);
    // A reading can't be saved under another shop's ID, nor a page that isn't there.
    await assert.rejects(
      withShop(techB.shop.id, (tx) => tx.insert(manualPageFacts).values({ manualId: rzr, shopId: techA.shop.id, pageNumber: 5, status: "reading" })),
    );
    await assert.rejects(
      withShop(techA.shop.id, (tx) => tx.insert(manualPageFacts).values({ manualId: rzr, shopId: techA.shop.id, pageNumber: 40, status: "reading" })),
    );
    // app_user can't delete a reading.
    await assert.rejects(withShop(techA.shop.id, (tx) => tx.delete(manualPageFacts)));
  });

  test("the real SDK sends the plain request: the model, no thinking, the strict tool, nothing forced, not streamed", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(recorded(STARTER_READING)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-key";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const state = await readPageFacts(techA.shop.id, starter(), { ask: askClaude });
      assert.equal(state?.status, "ready");
      assert.equal(bodies.length, 1);
      const body = bodies[0];
      assert.equal(body.model, "claude-sonnet-5-5");
      assert.deepEqual(body.thinking, { type: "between_tools" });
      assert.equal(body.tool_choice, undefined);
      assert.equal(body.stream, undefined);
      const tools = body.tools as { name: string; strict: boolean }[];
      assert.deepEqual(tools.map((tool) => [tool.name, tool.strict]), [[FACTS_TOOL_NAME, true]]);
    } finally {
      server.close();
    }
  });
});
