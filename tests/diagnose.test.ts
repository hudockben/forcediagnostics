// Diagnose: the chat between a tech and Claude. Covers the rules (fault
// codes, citations, cost), the tools' limits (scope, shop, page range), the
// agent loop driven by a scripted stand-in for the Claude API (tool calls,
// web search blocks, the structured reply, append-only replay across
// messages, refusal, max_tokens, pause_turn, API errors, step limits, the
// time limit, usage and cost from usage.iterations, retries' cost), stuck
// turns, rate limits, and that conversations stay inside their shop.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { streamFromClaude } from "../src/lib/claude";
import { attemptCounters, diagnosisConversations, diagnosisTurns, shops, users } from "../src/db/schema";
import {
  STALE_AFTER_MS,
  getConversation,
  isProblem,
  listConversations,
  markCause,
  monthStats,
  prepareTurn,
  requestStop,
  runTurn,
  type TurnRequest,
} from "../src/lib/diagnose";
import {
  FAILURE_MESSAGES,
  apiErrorDetail,
  classifyError,
  echoableContent,
  runDiagnosisLoop,
  webPagesIn,
  type ClaudeStream,
  type RequestParams,
  type StreamNotice,
} from "../src/lib/diagnose-loop";
import {
  FALLBACK_BETA,
  SYSTEM_PROMPT,
  THINKING_BINDING_BETA,
  TOOL_CHANGES_BETA,
  TOOL_NAMES,
  buildRequest,
} from "../src/lib/diagnose-prompt";
import {
  DIAGNOSE_LIMITS,
  DIAGNOSE_MODEL,
  checkSources,
  emptyUsage,
  estimateCostCents,
  finalizeReply,
  normalizeFaultCodes,
  startMessage,
  textBlocks,
  type SeenSources,
  type StreamEvent,
} from "../src/lib/diagnose-rules";
import { findUnitManuals, readScopedPage, searchScopedPages, suggestUnits, unitVehicle } from "../src/lib/diagnose-tools";
import { finishCatalogImport, saveCatalogBatch } from "../src/lib/manual-catalog";
import { confirmManualUpload, finishManual, saveManualPages, startManualUpload, storageKeyFor } from "../src/lib/manuals";
import { can, needsPasswordSession } from "../src/lib/permissions";
import { ROLES } from "../src/lib/roles";
import type { CurrentUser } from "../src/lib/session";
import type { FileStorage } from "../src/lib/storage";

type Message = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
const shopIds: string[] = [];

async function createShop(code: string) {
  const [shop] = await systemDb
    .insert(shops)
    .values({ code, name: `Shop ${code}` })
    .returning({ id: shops.id, code: shops.code, name: shops.name });
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
  await saveManualPages(actor, {
    manualId: start.manualId,
    pages: pages.map((text, index) => ({ pageNumber: index + 1, text })),
  });
  const finished = await finishManual(actor, { manualId: start.manualId });
  assert.ok("added" in finished, JSON.stringify(finished));
  return start.manualId;
}

async function importModels(
  actor: CurrentUser,
  files: { fileName: string; brand: string; title?: string; models: [number | null, string, string | null][] }[],
) {
  const importId = randomUUID();
  const saved = await saveCatalogBatch(actor, {
    importId,
    files: files.map((file) => ({
      fileName: file.fileName,
      brand: file.brand,
      article: null,
      title: file.title ?? null,
      postedOn: null,
      modelYears: null,
      models: file.models,
    })),
  });
  assert.ok("saved" in saved, JSON.stringify(saved));
  await finishCatalogImport(actor, { importId, fileName: "manual-list - All.csv", leftOut: 0, rowsWithoutFile: 0 });
}

let adminA: CurrentUser;
let techA: CurrentUser;
let techA2: CurrentUser;
let managerA: CurrentUser;
let adminB: CurrentUser;
let techB: CurrentUser;
let rzrManual: string;
let rangerManual: string;
let sportsmanManual: string;
let otherShopManual: string;

const RZR_PAGES = [
  "Diagnostic trouble codes. P0300 random or multiple cylinder misfire detected. Check ignition coils, spark plugs and injectors.",
  "Ignition coil test. Primary resistance 0.6 to 0.8 ohms. Secondary resistance 9.5 to 10.5 k ohms. Spark plug torque 20 Nm.",
  "Fuel pressure test. Connect the gauge at the rail. Fuel pressure 58 psi with the engine running.",
];

before(async () => {
  const shopA = await createShop(`da${suffix}`);
  const shopB = await createShop(`db${suffix}`);
  adminA = await createUser(shopA, "admin", "Bea");
  techA = await createUser(shopA, "tech", "Mike");
  techA2 = await createUser(shopA, "tech", "Rae");
  managerA = await createUser(shopA, "manager", "Lou");
  adminB = await createUser(shopB, "admin", "Ola");
  techB = await createUser(shopB, "tech", "Ned");
  rzrManual = await addManual(adminA, "9928000.pdf", RZR_PAGES);
  rangerManual = await addManual(adminA, "9929000.pdf", [
    "Ranger trouble codes. P0300 misfire on the Ranger XP 1000.",
    "Ranger drive belt inspection.",
  ]);
  sportsmanManual = await addManual(adminA, "9921889.pdf", ["Sportsman drive belt removal."]);
  otherShopManual = await addManual(adminB, "9928000.pdf", ["P0300 misfire in the other shop's own copy. Secret page."]);
  await importModels(adminA, [
    { fileName: "9928000.pdf", brand: "RZR", models: [[2019, "Z19VDE99AM", "RZR XP 1000 EPS"]] },
    { fileName: "9929000.pdf", brand: "RGR", models: [[2020, "R20RRE99A9", "RANGER XP 1000 EPS"]] },
    // The model list abbreviates the name its manual's title spells out.
    {
      fileName: "9921889.pdf",
      brand: "ATV",
      title: "2009 SPORTSMAN XP 850 Service Manual",
      models: [[2009, "A09ZN85AL", "SPM XP 850, PNTD RED"]],
    },
    // Listed, but its PDF was never added to the library.
    { fileName: "9930000.pdf", brand: "GRL", models: [[2022, "G22GAD99A1", "GENERAL XP 1000 DELUXE"]] },
  ]);
  await importModels(adminB, [{ fileName: "9928000.pdf", brand: "RZR", models: [[2019, "Z19VDE99AM", "RZR XP 1000 EPS"]] }]);
});

after(async () => {
  for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
  await systemDb.$client.end();
});

// --- A scripted stand-in for the Claude API ---------------------------------

let ids = 0;
const nextId = (prefix: string) => `${prefix}_${(++ids).toString().padStart(4, "0")}`;

type Usage = Partial<Message["usage"]>;

function message(content: unknown[], stopReason: Message["stop_reason"], usage: Usage = {}): Message {
  return {
    id: nextId("msg"),
    type: "message",
    role: "assistant",
    model: DIAGNOSE_MODEL,
    content: content as Message["content"],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      server_tool_use: null,
      iterations: null,
      ...usage,
    },
  } as unknown as Message;
}

const thinking = () => ({ type: "thinking", thinking: "", signature: nextId("sig") });
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: nextId("toolu"), name, input });

function webSearch(query: string, results: { url: string; title: string }[]) {
  const id = nextId("srvtoolu");
  return [
    { type: "server_tool_use", id, name: "web_search", input: { query } },
    {
      type: "web_search_tool_result",
      tool_use_id: id,
      content: results.map((result) => ({ type: "web_search_result", ...result, encrypted_content: "enc", page_age: null })),
    },
  ];
}

// The JSON results of the tool calls answered in the last user message.
function lastToolResults(params: RequestParams) {
  const last = params.messages.at(-1)!;
  const content = Array.isArray(last.content) ? last.content : [];
  return content.flatMap((block) =>
    block.type === "tool_result" && typeof block.content === "string" ? [JSON.parse(block.content)] : [],
  );
}

type Step = (params: RequestParams, notice: (notice: StreamNotice) => void) => Message | Promise<Message>;

function fakeClaude(steps: Step[]) {
  const requests: RequestParams[] = [];
  const client: ClaudeStream = async (params, { signal, onNotice }) => {
    requests.push(JSON.parse(JSON.stringify(params)));
    if (signal.aborted) throw new Anthropic.APIUserAbortError();
    const step = steps[requests.length - 1];
    if (!step) throw new Error(`No scripted response for request ${requests.length}`);
    return step(params, onNotice);
  };
  return { client, requests };
}

async function startTurn(user: CurrentUser, request: TurnRequest, steps: Step[]) {
  const prepared = await prepareTurn(user, request);
  if (isProblem(prepared)) throw new Error(prepared.error);
  const fake = fakeClaude(steps);
  const events: StreamEvent[] = [];
  const outcome = await runTurn(prepared, { client: fake.client, emit: (event) => events.push(event) });
  return { ...outcome, requests: fake.requests, events, prepared };
}

const toolName = (tool: unknown) => (tool as { name?: string }).name;

const submit = (input: Record<string, unknown>) =>
  toolUse(TOOL_NAMES.submit, {
    reply: "Here's where I'd start.",
    likely_causes: [],
    next_checks: [],
    safety_notes: [],
    questions_for_tech: [],
    ...input,
  });

// --- Rules ---------------------------------------------------------------------

describe("Diagnose rules", () => {
  test("fault codes are upper-cased, split and kept once", () => {
    assert.deepEqual(normalizeFaultCodes("p0300, p0301 c1234; P0300\nspn 520207 fmi 4"), [
      "P0300",
      "P0301",
      "C1234",
      "SPN 520207 FMI 4",
    ]);
    assert.deepEqual(normalizeFaultCodes("  "), []);
    assert.deepEqual(normalizeFaultCodes("<p0171>, 'p0172'"), ["P0171", "P0172"]);
    assert.equal(normalizeFaultCodes(Array.from({ length: 20 }, (_, i) => `P01${String(i).padStart(2, "0")}`).join(",")).length, 12);
  });

  test("the quick form's first message reads like a tech wrote it", () => {
    assert.equal(
      startMessage({
        unit: "2019 RZR XP 1000 EPS — Z19VDE99AM",
        complaint: "misfire under load",
        faultCodes: ["P0300"],
        checked: "plugs",
      }),
      "Unit: 2019 RZR XP 1000 EPS — Z19VDE99AM\nComplaint: misfire under load\nFault codes: P0300\nAlready checked: plugs",
    );
  });

  test("cost: Opus 5.5 prices, cache reads at $0.20, 5-minute writes 1.25x and 1-hour writes 2x, web searches", () => {
    const usage = {
      ...emptyUsage(),
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
      webSearches: 10,
    };
    // $4 + $20 + $0.20 + $5 + $8 + 10 x $0.01 = $37.30
    assert.equal(Math.round(estimateCostCents(usage) * 100) / 100, 3730);
    assert.equal(estimateCostCents({ ...emptyUsage(), inputTokens: 2500 }), 1);
    // The comparison model is priced as itself.
    assert.equal(estimateCostCents({ ...emptyUsage(), outputTokens: 1_000_000 }, "claude-sonnet-5-5"), 1000);
  });

  test("text from Claude is split into paragraphs and lists, never HTML", () => {
    assert.deepEqual(textBlocks("First <b>bold</b>.\n\n- one\n- two\n1. a\n2. b"), [
      { kind: "paragraph", text: "First <b>bold</b>." },
      { kind: "list", ordered: false, items: ["one", "two"] },
      { kind: "list", ordered: true, items: ["a", "b"] },
    ]);
  });

  test("Diagnose is for techs, managers and admins, on bay tablets too", () => {
    for (const role of ROLES) assert.equal(can(role, "diagnostics.work"), ["tech", "manager", "admin"].includes(role), role);
    assert.equal(needsPasswordSession("diagnostics.work"), false);
  });
});

describe("citations", () => {
  const manualId = randomUUID();
  const seen: SeenSources = {
    pages: [{ manualId, page: 142, title: "2019 RZR XP 1000 Service Manual" }],
    urls: [{ url: "https://forum.example.com/t/rzr-decel-pop/", title: "Decel pop on XP 1000" }],
  };

  test("only pages and web pages the tools returned are kept, with the tools' titles", () => {
    const checked = checkSources(
      [
        { type: "manual", manual_id: manualId.toUpperCase(), page: 142 },
        { type: "manual", manual_id: manualId, page: 143 },
        { type: "manual", manual_id: "not-an-id", page: 1 },
        { type: "web", url: "https://forum.example.com/t/rzr-decel-pop#post-4", title: "Made-up title" },
        { type: "web", url: "https://made-up.example.com/bulletin", title: "TSB 99-1" },
        { type: "web", url: "javascript:alert(1)", title: "x" },
        { type: "general" },
        { type: "general" },
        { type: "nonsense" },
      ],
      seen,
    );
    assert.deepEqual(checked.sources, [
      { type: "manual", manualId, page: 142, title: "2019 RZR XP 1000 Service Manual" },
      { type: "web", url: "https://forum.example.com/t/rzr-decel-pop/", title: "Decel pop on XP 1000" },
      { type: "general" },
    ]);
    assert.equal(checked.dropped, 5);
  });

  test("a cause left with no citation falls back to general knowledge; a spec without a manual page is flagged", () => {
    const reply = finalizeReply(
      {
        reply: "Check the coils.",
        likely_causes: [
          { title: "Coil", likelihood: "high", why: "fits", status: "open", sources: [{ type: "manual", manual_id: manualId, page: 9 }] },
          { title: "Plugs", likelihood: "extreme", why: "", status: "maybe", sources: [{ type: "manual", manual_id: manualId, page: 142 }] },
          { title: "", likelihood: "low", why: "", status: "open", sources: [] },
        ],
        next_checks: [
          { action: "Measure primary resistance", expected: "0.6-0.8 ohms", sources: [{ type: "manual", manual_id: manualId, page: 142 }] },
          { action: "Check the gap", expected: "0.9 mm", sources: [{ type: "general" }] },
          { action: "Look at the connector", expected: "", sources: [] },
        ],
        safety_notes: ["Fuel is under pressure.", 7],
        questions_for_tech: ["Hours on it?"],
      },
      seen,
    );
    assert.deepEqual(reply.likelyCauses.map((cause) => [cause.title, cause.likelihood, cause.status, cause.sources[0].type]), [
      ["Coil", "high", "open", "general"],
      ["Plugs", "medium", "open", "manual"],
    ]);
    assert.deepEqual(reply.nextChecks.map((check) => check.unverifiedSpec), [false, true, false]);
    assert.deepEqual(reply.safetyNotes, ["Fuel is under pressure."]);
    assert.equal(reply.dropped, 1);
  });

  test("web pages come from search result blocks and from citations", () => {
    const urls = webPagesIn([
      ...webSearch("rzr misfire", [{ url: "https://a.example.com/1", title: "A" }]),
      {
        type: "text",
        text: "x",
        citations: [{ type: "web_search_result_location", url: "https://b.example.com/2", title: "B", cited_text: "", encrypted_index: "" }],
      },
    ]);
    assert.deepEqual(urls, [
      { url: "https://a.example.com/1", title: "A" },
      { url: "https://b.example.com/2", title: "B" },
    ]);
  });

  test("after a refusal fallback, the declined part's thinking and tool calls aren't echoed back", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "a" },
      { type: "text", text: "Partial", citations: null },
      { type: "tool_use", id: "t1", name: "search_manual_pages", input: {} },
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "r" } },
      { type: "web_search_tool_result", tool_use_id: "s2", content: [] },
      { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" }, trigger: null },
      { type: "thinking", thinking: "", signature: "b" },
      { type: "tool_use", id: "t2", name: "submit_diagnosis", input: {} },
    ] as unknown as Message["content"];
    assert.deepEqual(
      echoableContent(content).map((block) => ("id" in block ? block.id : block.type)),
      ["text", "s2", "web_search_tool_result", "fallback", "thinking", "t2"],
    );
    const plain = [{ type: "text", text: "x", citations: null }] as unknown as Message["content"];
    assert.equal(echoableContent(plain), plain);
  });
});

// --- Tools -----------------------------------------------------------------------

describe("Claude's tools", () => {
  test("find_unit_manuals finds the unit by model number and narrows to its manuals", async () => {
    const lookup = await findUnitManuals(techA.shop.id, { model_number: " z19vde99am " });
    assert.deepEqual(lookup.scope?.manualIds, [rzrManual]);
    assert.equal(lookup.scope?.label, "2019 RZR XP 1000 EPS — Z19VDE99AM");
    assert.equal(lookup.result.narrowed, true);
    // The start of a model number, and a year and model name, work too.
    assert.deepEqual((await findUnitManuals(techA.shop.id, { model_number: "Z19VDE" })).scope?.manualIds, [rzrManual]);
    assert.deepEqual(
      (await findUnitManuals(techA.shop.id, { description: "Ranger XP 1000", year: 2020 })).scope?.manualIds,
      [rangerManual],
    );
    assert.equal((await findUnitManuals(techA.shop.id, { description: "XP 1000" })).scope?.manualIds.length, 2);
    // Another shop finds only its own copy.
    assert.deepEqual((await findUnitManuals(techB.shop.id, { model_number: "Z19VDE99AM" })).scope?.manualIds, [otherShopManual]);
  });

  test("find_unit_manuals finds a model by the name its manual's title gives it", async () => {
    const lookup = await findUnitManuals(techA.shop.id, { description: "Sportsman XP 850", year: 2009 });
    assert.deepEqual(lookup.scope?.manualIds, [sportsmanManual]);
    assert.equal(lookup.scope?.label, "2009 SPM XP 850, PNTD RED — A09ZN85AL");
    assert.deepEqual((await findUnitManuals(techA.shop.id, { description: "sportsman" })).scope?.manualIds, [sportsmanManual]);
    // The year is still the model's own, and every word has to match.
    assert.equal((await findUnitManuals(techA.shop.id, { description: "Sportsman XP 850", year: 2010 })).scope, null);
    assert.equal((await findUnitManuals(techA.shop.id, { description: "Sportsman XP 1000" })).result.found, false);
  });

  test("find_unit_manuals by name keeps every matching model's manuals, not just the newest models'", async () => {
    // A newer manual whose title names two lines and lists hundreds of
    // models, and an older one found only by its models' descriptions.
    const shop = await createShop(`dc${suffix}`);
    const admin = await createUser(shop, "admin", "Cy");
    const newer = await addManual(admin, "9925000.pdf", ["Scrambler 1000 clutch."]);
    const older = await addManual(admin, "9926000.pdf", ["Scrambler 850 clutch."]);
    const colors = ["RED", "BLUE", "GREEN", "WHITE", "BLACK"];
    const newerModels = Array.from({ length: 201 }, (_, i): [number, string, string] => [
      2021 + (i % 5),
      `A${21 + (i % 5)}SCR${String(i).padStart(3, "0")}`,
      `SCRAMBLER 1000 S, ${colors[Math.floor(i / 5) % 5]}`,
    ]);
    await importModels(admin, [
      { fileName: "9925000.pdf", brand: "ATV", title: "2021-2025 Scrambler 850 / 1000 Service Manual", models: newerModels },
      { fileName: "9926000.pdf", brand: "ATV", models: [[2012, "A12SCR850", "SCRAMBLER 850 H.O."]] },
    ]);
    const lookup = await findUnitManuals(shop.id, { description: "Scrambler 850" });
    assert.deepEqual(lookup.scope?.manualIds.toSorted(), [newer, older].toSorted());
    assert.equal(lookup.scope?.label, "Scrambler 850 (202 models)");
    assert.equal(lookup.result.models_found, 202);
    assert.equal(lookup.result.manuals_found, 2);
    // Claude is shown the newest few.
    const shown = lookup.result.models as { year: number }[];
    assert.equal(shown.length, 10);
    assert.ok(shown.every((model) => model.year === 2025));

    // A year in the name too is the model's year: it isn't repeated in the
    // label, and the title doesn't have to have it.
    const byYear = await findUnitManuals(shop.id, { description: "2021 Scrambler", year: 2021 });
    assert.deepEqual(byYear.scope?.manualIds, [newer]);
    assert.equal(byYear.scope?.label, "2021 Scrambler (41 models)");
    const notInTitle = await findUnitManuals(shop.id, { description: "2023 Scrambler 1000", year: 2023 });
    assert.deepEqual(notInTitle.scope?.manualIds, [newer]);
    assert.equal(notInTitle.scope?.label, "2023 Scrambler 1000 (40 models)");
  });

  test("find_unit_manuals with a year takes the model named so over its manual's other models", async () => {
    const shop = await createShop(`dt${suffix}`);
    const admin = await createUser(shop, "admin", "Di");
    const rzr = await addManual(admin, "9927000.pdf", ["RZR S 1000 clutch."]);
    const r900 = await addManual(admin, "9927001.pdf", ["Ranger 900 clutch."]);
    const r1000 = await addManual(admin, "9927002.pdf", ["Ranger XP 1000 clutch."]);
    await importModels(admin, [
      {
        fileName: "9927000.pdf",
        brand: "RZR",
        title: "2017-2020 RZR 900 / S 900 / S 1000 / S4 1000",
        models: [
          [2018, "Z18VBE99BW", "RZR S 1000 EPS"],
          [2018, "Z18VCE87A2", "RZR 900 EPS"],
          [2018, "Z18VFE99AK", "RZR XP 4 1000"],
        ],
      },
      { fileName: "9927001.pdf", brand: "RGR", title: "2018-2019 RANGER 900 / 1000", models: [[2019, "R19RRE99A1", "RANGER XP 900 EPS"]] },
      { fileName: "9927002.pdf", brand: "RGR", title: "2018-2019 RANGER XP 1000 (DOHC)", models: [[2019, "R19RSE99A1", "RANGER XP 1000 EPS"]] },
    ]);
    // The one model is the unit, not every model the title covers.
    const one = await findUnitManuals(shop.id, { description: "RZR S 1000", year: 2018 });
    assert.equal(one.result.models_found, 1);
    assert.deepEqual(one.scope?.manualIds, [rzr]);
    assert.equal(one.scope?.label, "2018 RZR S 1000 EPS — Z18VBE99BW");
    // A year in the name with none given is the year.
    const named = await findUnitManuals(shop.id, { description: "2018 RZR S 1000" });
    assert.equal(named.result.models_found, 1);
    assert.deepEqual(named.scope?.manualIds, [rzr]);
    // The make in the name changes nothing.
    const make = await findUnitManuals(shop.id, { description: "2018 Polaris RZR S 1000" });
    assert.equal(make.result.models_found, 1);
    assert.deepEqual(make.scope?.manualIds, [rzr]);
    // A title naming two sizes doesn't bring the other size's manual in.
    const ranger = await findUnitManuals(shop.id, { description: "Ranger XP 1000", year: 2019 });
    assert.deepEqual(ranger.scope?.manualIds, [r1000]);
    assert.ok(!ranger.scope?.manualIds.includes(r900));
  });

  test("find_unit_manuals says so when nothing matches, and leaves the scope", async () => {
    const lookup = await findUnitManuals(techA.shop.id, { model_number: "X99ZZZ00" });
    assert.equal(lookup.scope, null);
    assert.equal(lookup.result.found, false);
    assert.match(String(lookup.result.message), /model number/);
    assert.equal((await findUnitManuals(techA.shop.id, {})).result.found, false);
  });

  test("a model number that's listed but has no manual is reported as that model, not as unknown", async () => {
    const lookup = await findUnitManuals(techA.shop.id, { model_number: "g22gad99a1" });
    assert.equal(lookup.scope, null);
    assert.deepEqual(lookup.listed, { year: 2022, number: "G22GAD99A1", description: "GENERAL XP 1000 DELUXE" });
    assert.equal(lookup.result.found, true);
    assert.equal(lookup.result.narrowed, false);
    assert.equal(lookup.result.manuals_found, 0);
    assert.match(String(lookup.result.message), /G22GAD99A1 \(2022 GENERAL XP 1000 DELUXE\) is in the shop's model list, but the shop has no manual for it/);
    assert.ok(!/Ask the tech for the model number/.test(String(lookup.result.message)));
    // Another shop's list doesn't have it.
    assert.equal((await findUnitManuals(techB.shop.id, { model_number: "G22GAD99A1" })).listed, undefined);
  });

  test("the unit's drawing comes from the model list's brand, then its manuals, then its name", async () => {
    const shopId = techA.shop.id;
    // RZR, RGR and GRL are all side-by-sides; a listed model with no manual
    // still has its brand.
    assert.equal(await unitVehicle(shopId, { modelNumber: "Z19VDE99AM", manualIds: null, label: null }), "utv");
    assert.equal(await unitVehicle(shopId, { modelNumber: "g22gad99a1", manualIds: null, label: null }), "utv");
    assert.equal(await unitVehicle(shopId, { modelNumber: null, manualIds: [rangerManual], label: "Ranger" }), "utv");
    // Not in the list: the words in the name decide.
    assert.equal(await unitVehicle(shopId, { modelNumber: "A21SXZ85A1", manualIds: null, label: "2021 SPORTSMAN 850" }), "atv");
    assert.equal(await unitVehicle(shopId, { modelNumber: "X1", manualIds: null, label: "X1" }), null);
    assert.equal(await unitVehicle(shopId, { modelNumber: null, manualIds: null, label: null }), null);
    // Another shop's list doesn't count.
    assert.equal(await unitVehicle(techB.shop.id, { modelNumber: "G22GAD99A1", manualIds: null, label: null }), null);
  });

  test("the 2009-2010 RZR 170, which the model list has only under ATV, gets the side-by-side drawing", async () => {
    const shop = await createShop(`dv${suffix}`);
    const admin = await createUser(shop, "admin", "Vi");
    await addManual(admin, "9922134.pdf", ["RZR 170 clutch."]);
    await addManual(admin, "9922351.pdf", ["RZR 170 wiring."]);
    await addManual(admin, "9921480.pdf", ["Sportsman 500 clutch."]);
    // As Polaris lists them; A10VA17AA has no year or name.
    await importModels(admin, [
      { fileName: "9922134.pdf", brand: "ATV", title: "2009 RZR 170 Service Manual", models: [[2009, "A09VA17AA", "RZR 170, RED"], [2009, "R09VA17AA", "RZR 170"]] },
      {
        fileName: "9922351.pdf",
        brand: "ATV",
        title: "2010 RANGER RZR 170 Service Manual - 11x17 Wire Diagram",
        models: [[2010, "R10VA17AA", "RANGER RZR 170 Indy Red"], [null, "A10VA17AA", null]],
      },
      { fileName: "9921480.pdf", brand: "ATV", title: "2009 Sportsman 500 H.O. Service Manual", models: [[2009, "A09MH50AA", "SPORTSMAN 500 H.O."]] },
    ]);
    // Through find_unit_manuals, as a diagnosis gets its unit.
    const drawing = async (input: Record<string, unknown>) => {
      const lookup = await findUnitManuals(shop.id, input);
      assert.ok(lookup.scope, JSON.stringify(input));
      const { scope } = lookup;
      return unitVehicle(shop.id, { modelNumber: scope.unit?.number ?? null, manualIds: scope.manualIds, label: scope.label });
    };
    assert.equal(await drawing({ model_number: "A09VA17AA" }), "utv");
    assert.equal(await drawing({ model_number: "R10VA17AA" }), "utv");
    assert.equal(await drawing({ model_number: "A10VA17AA" }), "utv");
    assert.equal(await drawing({ description: "RZR 170", year: 2009 }), "utv");
    assert.equal(await drawing({ model_number: "A09MH50AA" }), "atv");
  });

  test("model number suggestions come from the shop's list", async () => {
    const byNumber = await suggestUnits(techA.shop.id, "z19v");
    assert.deepEqual(byNumber.map((unit) => unit.label), ["2019 RZR XP 1000 EPS — Z19VDE99AM"]);
    assert.equal(byNumber[0].manuals, 1);
    assert.deepEqual((await suggestUnits(techA.shop.id, "ranger xp")).map((unit) => unit.modelNumber), ["R20RRE99A9"]);
    assert.deepEqual(await suggestUnits(techA.shop.id, "%"), []);
  });

  test("search stays inside the scope and the shop", async () => {
    const scoped = await searchScopedPages(techA.shop.id, { manualIds: [rzrManual], label: "RZR" }, "P0300");
    assert.deepEqual(scoped.hits.map((hit) => [hit.manualId, hit.pageNumber]), [[rzrManual, 1]]);
    const everything = await searchScopedPages(techA.shop.id, { manualIds: null, label: null }, "P0300");
    assert.deepEqual(new Set(everything.hits.map((hit) => hit.manualId)), new Set([rzrManual, rangerManual]));
    assert.ok(everything.hits.length <= DIAGNOSE_LIMITS.searchHits);
    // Shop B's copy never shows, even when its ID is put in the scope.
    const sneaky = await searchScopedPages(techA.shop.id, { manualIds: [otherShopManual], label: "x" }, "P0300");
    assert.deepEqual(sneaky.hits, []);
    assert.deepEqual((await searchScopedPages(techA.shop.id, { manualIds: null, label: null }, "  ")).hits, []);
  });

  test("a page is read only from a ready manual of the shop, in the scope, within its pages", async () => {
    const scope = { manualIds: [rzrManual], label: "2019 RZR" };
    const read = await readScopedPage(techA.shop.id, scope, { manual_id: rzrManual, page: 2 });
    assert.ok(read.ok);
    assert.match(String(read.result.text), /0\.6 to 0\.8 ohms/);
    const outOfScope = await readScopedPage(techA.shop.id, scope, { manual_id: rangerManual, page: 1 });
    assert.ok(!outOfScope.ok && /isn't one of the manuals/.test(String(outOfScope.result.error)));
    const otherShop = await readScopedPage(techA.shop.id, { manualIds: null, label: null }, { manual_id: otherShopManual, page: 1 });
    assert.ok(!otherShop.ok && /no such manual/.test(String(otherShop.result.error)));
    const pastEnd = await readScopedPage(techA.shop.id, scope, { manual_id: rzrManual, page: 4 });
    assert.ok(!pastEnd.ok && /past the end/.test(String(pastEnd.result.error)));
    for (const page of [0, -1, 1.5, "2"]) {
      const bad = await readScopedPage(techA.shop.id, scope, { manual_id: rzrManual, page });
      assert.equal(bad.ok, page === "2", String(page));
    }
    assert.ok(!(await readScopedPage(techA.shop.id, scope, { manual_id: "../etc", page: 1 })).ok);
  });

  test("long pages are cut to the cap", async () => {
    const long = await addManual(adminA, "long.pdf", ["x".repeat(DIAGNOSE_LIMITS.pageTextCharacters + 500)]);
    const read = await readScopedPage(techA.shop.id, { manualIds: null, label: null }, { manual_id: long, page: 1 });
    assert.ok(read.ok);
    assert.equal(String(read.result.text).length, DIAGNOSE_LIMITS.pageTextCharacters);
    assert.ok(read.result.note);
  });
});

// --- The request ------------------------------------------------------------------

describe("the request to Claude", () => {
  test("model, adaptive thinking at high effort, fallbacks, caching, auto tool choice, no sampling settings", () => {
    const params = buildRequest({ messages: [{ role: "user", content: "hi" }], webSearch: true });
    assert.equal(params.model, "claude-opus-5-5");
    // Earlier thinking that no longer matches the conversation (after a
    // prompt edit) is dropped, not a 400; the field needs its beta header.
    assert.deepEqual(params.thinking, { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    assert.deepEqual(params.output_config, { effort: "high" });
    assert.deepEqual(params.betas, [THINKING_BINDING_BETA, FALLBACK_BETA]);
    assert.equal(params.fallbacks, "default");
    assert.deepEqual(params.tool_choice, { type: "auto" });
    assert.deepEqual(params.cache_control, { type: "ephemeral", ttl: "1h" });
    assert.deepEqual(params.system, [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } }]);
    for (const key of ["temperature", "top_p", "top_k"]) assert.ok(!(key in params), key);
    const names = (params.tools ?? []).map(toolName);
    assert.deepEqual(names, ["find_unit_manuals", "read_manual_page", "search_manual_pages", "submit_diagnosis", "web_search"]);
    const web = params.tools!.at(-1) as Anthropic.Beta.Messages.BetaWebSearchTool20260209;
    assert.equal(web.type, "web_search_20260209");
    assert.equal(web.max_uses, DIAGNOSE_LIMITS.webSearches);
    assert.ok(!names.includes("code_execution"));
    for (const tool of params.tools!.slice(0, 4) as Anthropic.Beta.Messages.BetaTool[]) {
      assert.equal(tool.strict, true);
      assert.equal(tool.eager_input_streaming, true);
      assert.equal((tool.input_schema as { additionalProperties?: boolean }).additionalProperties, false);
    }
    // The prompt has nothing that changes between requests, and gives the
    // per-message web search budget.
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(SYSTEM_PROMPT));
    assert.match(SYSTEM_PROMPT, /at most 5 web searches for each message/);
    assert.deepEqual(buildRequest({ messages: [], webSearch: false }).tools!.map(toolName).at(-1), "submit_diagnosis");
    // With fallbacks off, the binding field still goes with its header.
    process.env.DIAGNOSE_REFUSAL_FALLBACK = "off";
    try {
      const plain = buildRequest({ messages: [], webSearch: false });
      assert.deepEqual(plain.betas, [THINKING_BINDING_BETA]);
      assert.ok(!("fallbacks" in plain));
      assert.deepEqual(plain.thinking, params.thinking);
    } finally {
      delete process.env.DIAGNOSE_REFUSAL_FALLBACK;
    }
  });
});

// --- The loop, end to end -----------------------------------------------------

describe("a conversation", () => {
  const forum = { url: "https://www.rzrforums.example.com/threads/xp-1000-misfire.123/", title: "XP 1000 misfire under load" };
  let conversationId = "";
  let turn1Requests: RequestParams[] = [];
  let turn1Appended: MessageParam[] = [];

  test("turn 1: unit lookup, search, page read, web search, then a structured reply with checked citations", async () => {
    const steps: Step[] = [
      () => message([thinking(), toolUse(TOOL_NAMES.findUnit, { model_number: "Z19VDE99AM" })], "tool_use"),
      (params) => {
        assert.equal(lastToolResults(params)[0].narrowed, true);
        return message([thinking(), toolUse(TOOL_NAMES.search, { query: "P0300" })], "tool_use");
      },
      (params) => {
        const [found] = lastToolResults(params);
        assert.equal(found.results[0].manual_id, rzrManual);
        return message([toolUse(TOOL_NAMES.read, { manual_id: rzrManual, page: 2 })], "tool_use");
      },
      (params, notice) => {
        assert.match(lastToolResults(params)[0].text, /Primary resistance/);
        notice({ type: "writing" });
        notice({ type: "reply", text: "P0300 on this unit" });
        return message(
          [
            thinking(),
            ...webSearch("RZR XP 1000 misfire under load", [forum]),
            { type: "text", text: "Forum posts point at coils.", citations: [{ type: "web_search_result_location", url: forum.url, title: forum.title, cited_text: "coil", encrypted_index: "x" }] },
            submit({
              reply: "P0300 on this unit usually comes down to ignition. Start with the coils.",
              likely_causes: [
                {
                  title: "Ignition coil failing under load",
                  likelihood: "high",
                  why: "Misfire under load with P0300; the manual's coil test is quick.",
                  status: "open",
                  sources: [
                    { type: "manual", manual_id: rzrManual, page: 2 },
                    { type: "web", url: forum.url, title: forum.title },
                  ],
                },
                {
                  title: "Fouled spark plugs",
                  likelihood: "medium",
                  why: "Common on these.",
                  status: "open",
                  // Never returned by a tool: dropped.
                  sources: [{ type: "manual", manual_id: rzrManual, page: 3 }],
                },
              ],
              next_checks: [
                {
                  action: "Measure coil primary resistance",
                  expected: "0.6 to 0.8 ohms",
                  sources: [{ type: "manual", manual_id: rzrManual, page: 2 }],
                },
                {
                  action: "Look up the service bulletin",
                  expected: "",
                  sources: [{ type: "web", url: "https://polaris.example.com/tsb-made-up", title: "TSB" }],
                },
              ],
              safety_notes: ["Let the exhaust cool first."],
              questions_for_tech: ["How many hours on it?"],
            }),
          ],
          "tool_use",
          { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 }, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 } },
        );
      },
    ];
    const run = await startTurn(techA, { start: { message: "2019 RZR XP 1000 Z19VDE99AM, misfire under load, p0300" } }, steps);
    conversationId = run.conversation.id;
    turn1Requests = run.requests;
    assert.equal(run.turn.status, "done", run.turn.error ?? "");
    const reply = run.turn.reply!;
    assert.equal(reply.reply, "P0300 on this unit usually comes down to ignition. Start with the coils.");
    assert.deepEqual(reply.likelyCauses[0].sources.map((source) => source.type), ["manual", "web"]);
    assert.deepEqual(reply.likelyCauses[1].sources, [{ type: "general" }]);
    assert.deepEqual(reply.nextChecks[0].sources[0], { type: "manual", manualId: rzrManual, page: 2, title: "9928000" });
    assert.deepEqual(reply.nextChecks[1].sources, []);
    assert.equal(reply.dropped, 2);
    assert.deepEqual(reply.questions, ["How many hours on it?"]);
    // The unit lookup set the conversation's scope.
    assert.equal(run.conversation.unit, "2019 RZR XP 1000 EPS — Z19VDE99AM");
    assert.deepEqual(run.conversation.scope.manuals.map((manual) => manual.id), [rzrManual]);
    // Progress the tech saw.
    const labels = run.events.flatMap((event) => (event.type === "progress" ? [event.step.label] : []));
    assert.deepEqual(labels, [
      "Thinking it over",
      "Using 1 manual for 2019 RZR XP 1000 EPS — Z19VDE99AM",
      "Searching your manuals: P0300",
      "Reading page 2 — 9928000",
      "Writing the answer",
      "Searching the web: RZR XP 1000 misfire under load",
    ]);
    assert.ok(run.events.some((event) => event.type === "reply" && event.text === "P0300 on this unit"));
    assert.ok(run.events.some((event) => event.type === "scope" && event.vehicle === "utv"));
    assert.equal(run.conversation.vehicle, "utv");
    assert.equal(run.events.at(-1)?.type, "end");
    // Usage and cost add up over the four requests.
    const [row] = await systemDb.select().from(diagnosisTurns).where(eq(diagnosisTurns.id, run.turn.id));
    assert.equal(row.usage?.requests, 4);
    assert.equal(row.usage?.inputTokens, 4000);
    assert.equal(row.usage?.cacheWrite1hTokens, 400);
    assert.equal(row.usage?.cacheWrite5mTokens, 100);
    assert.equal(row.webSearches, 1);
    assert.ok(Math.abs(row.costCents - estimateCostCents(row.usage!)) < 1e-9);
    assert.equal(row.costCents, row.usage!.costCents);
    assert.ok(row.costCents > 0);
    // The estimate is kept for the month's figures, not shown per message:
    // the field is null (pages from before showed "≈ $NaN" without it).
    assert.equal(run.turn.costCents, null);
    assert.ok(run.events.every((event) => !("turn" in event) || event.turn.costCents === null));
    const reloaded = await getConversation(techA, run.conversation.id);
    assert.ok(reloaded?.turns.every((turn) => turn.costCents === null));
    // The stored history is the tech's message, the app's note, then each
    // of Claude's responses as it came back and the tool results.
    turn1Appended = row.history as MessageParam[];
    assert.deepEqual(turn1Appended.map((m) => m.role), ["user", "system", "assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user"]);
    assert.match(JSON.stringify(turn1Appended[1]), /No unit has been picked yet/);
    // Every request was the one before plus what came after it.
    for (let i = 1; i < run.requests.length; i++) {
      const before = run.requests[i - 1].messages;
      assert.deepEqual(run.requests[i].messages.slice(0, before.length), before);
    }
    const [conversation] = await systemDb.select().from(diagnosisConversations).where(eq(diagnosisConversations.id, conversationId));
    assert.equal(conversation.techMessages, 1);
    assert.deepEqual(conversation.pendingNotes, []);
  });

  test("turn 2: the tech's 'Ruled out' reaches Claude, and the request starts with turn 1's exact blocks", async () => {
    const detail = await getConversation(techA, conversationId);
    const turnId = detail!.turns[0].id;
    const marked = await markCause(techA2, { conversationId, turnId, index: 1, verdict: "ruled_out" });
    assert.ok("feedback" in marked);
    assert.equal(marked.feedback.at(-1)?.sentInSeq, null);

    const steps: Step[] = [
      (params) => {
        const messages = params.messages;
        // Turn 1's messages, byte for byte as stored and sent before.
        assert.deepEqual(messages.slice(0, turn1Appended.length), turn1Appended);
        assert.deepEqual(
          messages.slice(0, turn1Requests.at(-1)!.messages.length),
          turn1Requests.at(-1)!.messages,
        );
        const opening = messages.slice(turn1Appended.length);
        assert.deepEqual(opening[0], { role: "user", content: [{ type: "text", text: "Checked plugs, still misfires. Now it pops on decel." }] });
        assert.equal(opening[1].role, "system");
        assert.match(JSON.stringify(opening[1]), /Fouled spark plugs.*ruled out/);
        return message([toolUse(TOOL_NAMES.search, { query: "coil resistance" })], "tool_use");
      },
      () =>
        message(
          [
            submit({
              reply: "With the plugs ruled out, the coil is the best bet.",
              likely_causes: [
                { title: "Ignition coil failing under load", likelihood: "high", why: "Still fits.", status: "open", sources: [{ type: "manual", manual_id: rzrManual, page: 2 }, { type: "web", url: forum.url, title: "x" }] },
                { title: "Fouled spark plugs", likelihood: "low", why: "The tech checked them.", status: "ruled_out", sources: [{ type: "general" }] },
              ],
              next_checks: [{ action: "Swap coils between cylinders", expected: "", sources: [{ type: "general" }] }],
            }),
          ],
          "tool_use",
          { cache_read_input_tokens: 9000 },
        ),
    ];
    const run = await startTurn(techA, { conversationId, text: "Checked plugs, still misfires. Now it pops on decel." }, steps);
    assert.equal(run.turn.status, "done", run.turn.error ?? "");
    // Turn 1's page and web page still count as seen in turn 2.
    assert.deepEqual(run.turn.reply!.likelyCauses[0].sources.map((source) => source.type), ["manual", "web"]);
    assert.equal(run.turn.reply!.likelyCauses[1].status, "ruled_out");
    assert.equal(run.turn.reply!.dropped, 0);
    const [conversation] = await systemDb.select().from(diagnosisConversations).where(eq(diagnosisConversations.id, conversationId));
    assert.equal(conversation.techMessages, 2);
    assert.equal(conversation.feedback.at(-1)?.sentInSeq, 2);
    assert.equal(conversation.contextTokens, 10_000);
  });

  test("'This was it' records the outcome for accuracy figures", async () => {
    const detail = await getConversation(techA, conversationId);
    const last = detail!.turns.at(-1)!;
    const result = await markCause(techA, { conversationId, turnId: last.id, index: 0, verdict: "confirmed" });
    assert.ok("outcome" in result);
    assert.deepEqual(result.outcome, { title: "Ignition coil failing under load", seq: 2 });
    assert.equal(result.status, "solved");
    const stats = await monthStats(managerA.shop.id);
    assert.ok(stats.solved >= 1 && stats.solvedTopCause >= 1 && stats.messages >= 2 && stats.costCents > 0);
    const undone = await markCause(techA, { conversationId, turnId: last.id, index: 0, verdict: "open" });
    assert.ok("outcome" in undone && undone.outcome === null && undone.status === "open");
    assert.ok("error" in (await markCause(techA, { conversationId, turnId: last.id, index: 9, verdict: "confirmed" })));
  });

  test("a refused message fails, isn't kept in the history, and can be retried", async () => {
    const refused = await startTurn(techA, { conversationId, text: "Next?" }, [
      () => message([], "refusal"),
    ]);
    assert.equal(refused.turn.status, "failed");
    assert.equal(refused.turn.error, FAILURE_MESSAGES.refusal);
    const [row] = await systemDb.select().from(diagnosisTurns).where(eq(diagnosisTurns.id, refused.turn.id));
    assert.equal(row.history, null);
    // Retrying sends the same text after turn 2, without the refused attempt.
    const retried = await startTurn(techA, { conversationId, retryTurnId: refused.turn.id }, [
      (params) => {
        const users = params.messages.filter((m) => m.role === "user" && JSON.stringify(m).includes("Next?"));
        assert.equal(users.length, 1);
        return message([submit({ reply: "Swap the coils." })], "tool_use");
      },
    ]);
    assert.equal(retried.turn.id, refused.turn.id);
    assert.equal(retried.turn.status, "done");
    const [again] = await systemDb.select().from(diagnosisTurns).where(eq(diagnosisTurns.id, refused.turn.id));
    assert.equal(again.attempts, 2);
    // Only the last message can be retried, and only when it failed.
    const problem = await prepareTurn(techA, { conversationId, retryTurnId: refused.turn.id });
    assert.ok(isProblem(problem) && problem.status === 409);
  });

  test("a response cut off at max_tokens is asked for again with more room, then fails", async () => {
    const recovered = await startTurn(techA, { conversationId, text: "And the decel pop?" }, [
      () => message([thinking(), { type: "tool_use", id: "cut", name: TOOL_NAMES.submit, input: { reply: "Partial" } }], "max_tokens"),
      (params) => {
        assert.equal(params.max_tokens, 64_000);
        // The cut-off response was never added to the history.
        assert.ok(!JSON.stringify(params.messages).includes('"cut"'));
        return message([submit({ reply: "Likely an exhaust leak." })], "tool_use");
      },
    ]);
    assert.equal(recovered.turn.status, "done");
    assert.equal(recovered.requests[0].max_tokens, 32_000);
    const failed = await startTurn(techA, { conversationId, text: "More?" }, [
      () => message([], "max_tokens"),
      () => message([], "max_tokens"),
    ]);
    assert.equal(failed.turn.status, "failed");
    assert.equal(failed.turn.error, FAILURE_MESSAGES.max_tokens);
  });

  test("a paused web search is sent back as it was and carries on", async () => {
    const paused = webSearch("decel pop xp 1000", [{ url: "https://pop.example.com/a", title: "Pop" }]);
    const run = await startTurn(techA, { conversationId, text: "What about the pop?" }, [
      () => message([thinking(), paused[0]], "pause_turn"),
      (params) => {
        const last = params.messages.at(-1)!;
        assert.equal(last.role, "assistant");
        assert.deepEqual((last.content as unknown[]).at(-1), paused[0]);
        return message(
          [paused[1], submit({ reply: "Check for an exhaust leak.", likely_causes: [{ title: "Exhaust leak", likelihood: "medium", why: "Pop on decel.", status: "open", sources: [{ type: "web", url: "https://pop.example.com/a", title: "Pop" }] }] })],
          "tool_use",
        );
      },
    ]);
    assert.equal(run.turn.status, "done");
    assert.equal(run.turn.reply!.likelyCauses[0].sources[0].type, "web");
  });

  test("API errors end the message with a plain-language reason", async () => {
    const limited = await startTurn(techA, { conversationId, text: "Hello?" }, [
      () => {
        throw new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, undefined, new Headers());
      },
    ]);
    assert.equal(limited.turn.status, "failed");
    assert.equal(limited.turn.error, FAILURE_MESSAGES.rate_limited);
    const auth = await startTurn(techA, { conversationId, retryTurnId: limited.turn.id }, [
      () => {
        throw new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "bad key" } }, undefined, new Headers());
      },
    ]);
    // What the API said is shown after the plain message, for a person to act on.
    assert.equal(auth.turn.error, `${FAILURE_MESSAGES.setup} Anthropic said: 401 · bad key`);
    const down = await startTurn(techA, { conversationId, retryTurnId: limited.turn.id }, [
      () => {
        throw new Anthropic.InternalServerError(529, { type: "error", error: { type: "overloaded_error", message: "busy" } }, undefined, new Headers());
      },
    ]);
    assert.equal(down.turn.error, FAILURE_MESSAGES.overloaded);
  });

  test("a reply without submit_diagnosis gets one nudge, then its text is used", async () => {
    const run = await startTurn(techA, { conversationId, text: "Plain answer please" }, [
      () => message([{ type: "text", text: "Swap coil 1 and 2.", citations: null }], "end_turn"),
      (params) => {
        assert.match(JSON.stringify(params.messages.at(-1)), /submit_diagnosis/);
        return message([{ type: "text", text: "Swap coil 1 and 2, then see if the misfire moves.", citations: null }], "end_turn");
      },
    ]);
    assert.equal(run.turn.status, "done");
    assert.equal(run.turn.reply!.partial, true);
    assert.equal(run.turn.reply!.reply, "Swap coil 1 and 2, then see if the misfire moves.");
    // The causes carry over from the last full reply.
    assert.equal(run.turn.reply!.likelyCauses[0].title, "Exhaust leak");
  });

  test("a runaway tool loop is stopped by the step limit, with every tool call answered", async () => {
    const steps: Step[] = Array.from({ length: DIAGNOSE_LIMITS.modelRequests }, () => () =>
      message([toolUse(TOOL_NAMES.search, { query: "misfire" })], "tool_use"),
    );
    const run = await startTurn(techA, { conversationId, text: "Keep looking" }, steps);
    assert.equal(run.requests.length, DIAGNOSE_LIMITS.modelRequests);
    assert.equal(run.turn.status, "done");
    assert.equal(run.turn.reply!.partial, true);
    // The request before the last one told Claude to wrap up.
    assert.match(JSON.stringify(run.requests.at(-1)!.messages.at(-1)), /last step for this message/);
    const [row] = await systemDb.select().from(diagnosisTurns).where(eq(diagnosisTurns.id, run.turn.id));
    const history = row.history as MessageParam[];
    assert.match(JSON.stringify(history.at(-1)), /out of steps/);
    // The next message still works on top of it.
    const next = await startTurn(techA, { conversationId, text: "OK, what now?" }, [() => message([submit({ reply: "Swap coils." })], "tool_use")]);
    assert.equal(next.turn.status, "done");
  });

  test("per-message tool caps: page reads past the limit get a limit message, not the page", async () => {
    const reads = Array.from({ length: DIAGNOSE_LIMITS.pageReads + 2 }, () => toolUse(TOOL_NAMES.read, { manual_id: rzrManual, page: 1 }));
    const run = await startTurn(techA, { conversationId, text: "Read everything" }, [
      () => message(reads, "tool_use"),
      (params) => {
        const results = (params.messages.at(-1)!.content as Anthropic.Beta.Messages.BetaToolResultBlockParam[]).filter((b) => b.type === "tool_result");
        assert.equal(results.length, reads.length);
        assert.equal(results.filter((result) => result.is_error).length, 2);
        assert.match(String(results.at(-1)!.content), /Limit reached/);
        return message([submit({ reply: "Done." })], "tool_use");
      },
    ]);
    assert.equal(run.turn.status, "done");
  });

  test("the loop on its own: web searches past the message's allowance get a note", async () => {
    const fake = fakeClaude([
      () => message([toolUse(TOOL_NAMES.search, { query: "a" })], "tool_use", { server_tool_use: { web_search_requests: 5, web_fetch_requests: 0 } }),
      (params) => {
        assert.match(JSON.stringify(params.messages.at(-1)), /web searches this message allows/);
        return message([submit({ reply: "ok" })], "tool_use");
      },
    ]);
    const result = await runDiagnosisLoop({
      client: fake.client,
      history: [],
      opening: [{ role: "user", content: "hi" }],
      webSearch: true,
      tools: async () => ({ result: { results: [] } }),
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      softDeadline: Date.now() + 60_000,
      onProgress: () => {},
    });
    assert.equal(result.status, "done");
  });
});

// --- The loop: time limit, usage, errors -------------------------------------------

// The loop on its own, with the given client and a scripted search tool.
function loopWith(client: ClaudeStream, extra: Partial<Parameters<typeof runDiagnosisLoop>[0]> = {}) {
  return runDiagnosisLoop({
    client,
    history: [],
    opening: [{ role: "user", content: "hi" }],
    webSearch: true,
    tools: async () => ({ result: { results: [] } }),
    signal: new AbortController().signal,
    deadline: Date.now() + 200_000,
    softDeadline: Date.now() + 200_000,
    onProgress: () => {},
    ...extra,
  });
}

const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const midStreamError = (type: "overloaded_error" | "rate_limit_error") =>
  new Anthropic.APIError(undefined, { type: "error", error: { type, message: "x" } }, undefined, new Headers(), type);

describe("the loop: time limit, usage and errors", () => {
  test("the deadline cuts off a request that's still streaming (real SDK), keeping what earlier requests used", async () => {
    // A stand-in API: the first request gets a whole tool call, the second
    // starts (message_start with its prompt's counts) and then streams text
    // forever.
    let calls = 0;
    const open = new Set<ServerResponse>();
    const server = createServer((req, res) => {
      req.resume();
      calls += 1;
      open.add(res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const start = (usage: Record<string, number>) =>
        sse("message_start", {
          message: { id: `msg_${calls}`, type: "message", role: "assistant", model: DIAGNOSE_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { output_tokens: 1, cache_creation_input_tokens: 0, ...usage } },
        });
      if (calls === 1) {
        res.end(
          start({ input_tokens: 1000, cache_read_input_tokens: 0 }) +
            sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: TOOL_NAMES.search, input: {} } }) +
            sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"P0300"}' } }) +
            sse("content_block_stop", { index: 0 }) +
            sse("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 100 } }) +
            sse("message_stop", {}),
        );
        return;
      }
      res.write(start({ input_tokens: 300, cache_read_input_tokens: 9000 }));
      res.write(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
      const timer = setInterval(() => res.write(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } })), 200);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-key";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const started = Date.now();
      const result = await loopWith(streamFromClaude, { deadline: started + 5600 });
      const took = Date.now() - started;
      assert.equal(result.status, "failed");
      assert.ok(result.status === "failed" && result.reason === "timeout", JSON.stringify(result));
      assert.ok(took >= 5400 && took < 9000, `took ${took} ms`);
      assert.equal(calls, 2);
      // The finished request and the cut-off one's prompt are both counted.
      assert.equal(result.usage.requests, 2);
      assert.equal(result.usage.inputTokens, 1300);
      assert.equal(result.usage.cacheReadTokens, 9000);
      assert.ok(result.usage.costCents > 0);
    } finally {
      for (const res of open) res.destroy();
      server.close();
    }
  });

  test("a scripted request that never finishes is cut off at the deadline as a timeout, not a stop", async () => {
    const result = await loopWith(
      async (_params, { signal }) =>
        new Promise<Message>((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Anthropic.APIUserAbortError(), { partialMessage: message([], null, { input_tokens: 400 }) })),
          ),
        ),
      { deadline: Date.now() + 5300 },
    );
    assert.ok(result.status === "failed" && result.reason === "timeout", JSON.stringify(result));
    assert.equal(result.usage.inputTokens, 400);
  });

  test("max_tokens with too little time left for the bigger retry fails at once", async () => {
    const fake = fakeClaude([() => message([], "max_tokens"), () => message([submit({})], "tool_use")]);
    const result = await loopWith(fake.client, { deadline: Date.now() + 60_000 });
    assert.ok(result.status === "failed" && result.reason === "max_tokens");
    assert.equal(fake.requests.length, 1);
  });

  test("usage comes from usage.iterations: context from the last step, each step priced as the model that ran it", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const step = (type: string, model: string | null, input: number, cacheRead: number, write: number, output: number) => ({
      type,
      model,
      input_tokens: input,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: write,
      cache_creation: null,
      output_tokens: output,
    });
    const fake = fakeClaude([
      // A web search in the request: two sampling steps, which the top-level
      // counts add together.
      () => ({
        ...message([toolUse(TOOL_NAMES.search, { query: "a" })], "tool_use", {
          input_tokens: 300,
          cache_read_input_tokens: 102_000,
          cache_creation_input_tokens: 4000,
          output_tokens: 900,
          server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
          iterations: [step("message", null, 100, 50_000, 1000, 400), step("message", null, 200, 52_000, 3000, 500)],
        } as Usage),
        input_transformations: [
          { type: "thinking_dropped", path: "messages.2.content.0", reason: "prefix_binding_mismatch" },
          { type: "thinking_dropped", path: "messages.4.content.0", reason: "model_binding_mismatch" },
        ],
      }) as Message,
      // A refusal fallback: the top level covers only the fallback model's
      // attempt; the declined attempt was billed too.
      () => ({
        ...message([submit({})], "tool_use", {
          input_tokens: 1000,
          output_tokens: 2000,
          iterations: [step("message", "claude-opus-5-5", 1000, 0, 0, 500), step("fallback_message", "claude-opus-5", 1000, 0, 0, 2000)],
        } as Usage),
        model: "claude-opus-5",
      }) as Message,
    ]);
    const result = await loopWith(fake.client);
    assert.equal(result.status, "done");
    const usage = result.usage;
    assert.equal(usage.inputTokens, 300 + 2000);
    assert.equal(usage.outputTokens, 900 + 2500);
    assert.equal(usage.cacheReadTokens, 102_000);
    assert.equal(usage.cacheWrite1hTokens, 4000);
    assert.equal(usage.webSearches, 1);
    // The fallback attempt's prompt: the last step of the last request.
    assert.equal(usage.contextTokens, 1000);
    assert.deepEqual(usage.servedBy, ["claude-opus-5"]);
    // Opus 5.5: (300 x $4 + 900 x $20 + 102,000 x $0.20 + 4,000 x $4 x 2) / 1M + one search,
    // then the declined attempt (1,000 x $4 + 500 x $20) / 1M, then Opus 5 (1,000 x $5 + 2,000 x $25) / 1M.
    const expected = (71_600 / 1e6 + 0.01 + 14_000 / 1e6 + 55_000 / 1e6) * 100;
    assert.ok(Math.abs(usage.costCents - expected) < 1e-9, `${usage.costCents} vs ${expected}`);
    // A history edit is logged; the model switch isn't.
    assert.equal(warn.mock.callCount(), 1);
    assert.match(JSON.stringify(warn.mock.calls[0].arguments), /messages\.2\.content\.0/);
  });

  test("the context size for the length limit is the last step's prompt, not the top-level sum", async () => {
    const fake = fakeClaude([
      () =>
        message([submit({})], "tool_use", {
          input_tokens: 50,
          cache_read_input_tokens: 300_000,
          cache_creation_input_tokens: 0,
          iterations: [
            { type: "message", model: null, input_tokens: 20, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0, cache_creation: null, output_tokens: 10 },
            { type: "message", model: null, input_tokens: 30, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0, cache_creation: null, output_tokens: 10 },
          ],
        } as Usage),
    ]);
    const result = await loopWith(fake.client);
    assert.equal(result.usage.contextTokens, 150_030);
    assert.ok(result.usage.contextTokens < DIAGNOSE_LIMITS.contextTokens);
  });

  test("errors sent part way through a stream are sorted by type; 402 is billing, not the API key", () => {
    assert.equal(classifyError(midStreamError("overloaded_error")), "overloaded");
    assert.equal(classifyError(midStreamError("rate_limit_error")), "rate_limited");
    const billing = Anthropic.APIError.generate(402, { type: "error", error: { type: "billing_error", message: "no credit" } }, undefined, new Headers());
    assert.equal(classifyError(billing), "billing");
    assert.match(FAILURE_MESSAGES.billing, /plan and credits in the Claude Console/);
    assert.ok(!/ANTHROPIC_API_KEY/.test(FAILURE_MESSAGES.billing));
    assert.equal(classifyError(new Anthropic.APIUserAbortError()), "stopped");
  });

  test("a request the API turns down says what the API said, with its request id", () => {
    const rejected = Anthropic.APIError.generate(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "block_binding: Extra inputs are not permitted" } },
      undefined,
      new Headers({ "request-id": "req_011abc" }),
    );
    assert.equal(classifyError(rejected), "bad_request");
    assert.equal(
      apiErrorDetail(rejected),
      "400 · invalid_request_error · block_binding: Extra inputs are not permitted · request req_011abc",
    );
    assert.equal(apiErrorDetail(new Anthropic.APIUserAbortError()), null);
    assert.equal(apiErrorDetail(new Error("not from the API")), null);
  });

  test("an overload part way through a stream is tried once more, then ends the message", async () => {
    const recovered = fakeClaude([
      () => {
        throw midStreamError("overloaded_error");
      },
      () => message([submit({})], "tool_use"),
    ]);
    assert.equal((await loopWith(recovered.client)).status, "done");
    assert.equal(recovered.requests.length, 2);
    const twice = fakeClaude([
      () => {
        throw midStreamError("overloaded_error");
      },
      () => {
        throw midStreamError("overloaded_error");
      },
    ]);
    const failed = await loopWith(twice.client);
    assert.ok(failed.status === "failed" && failed.reason === "overloaded");
    assert.equal(twice.requests.length, 2);
  });

  test("a retried message adds every attempt's cost: the turn, the conversation and the month", async () => {
    const statsBefore = await monthStats(techA.shop.id);
    const failed = await startTurn(techA, { start: { message: "Flaky one" } }, [
      () =>
        message([toolUse(TOOL_NAMES.search, { query: "misfire" })], "tool_use", {
          output_tokens: 5000,
          server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
        }),
      () => message([], "refusal"),
    ]);
    assert.equal(failed.turn.status, "failed");
    const [first] = await systemDb.select().from(diagnosisTurns).where(eq(diagnosisTurns.id, failed.turn.id));
    assert.ok(first.costCents > 0);
    assert.equal(first.webSearches, 2);

    const retried = await startTurn(techA, { conversationId: failed.conversation.id, retryTurnId: failed.turn.id }, [
      () => message([submit({})], "tool_use"),
    ]);
    assert.equal(retried.turn.status, "done");
    const [row] = await systemDb.select().from(diagnosisTurns).where(eq(diagnosisTurns.id, failed.turn.id));
    const second = estimateCostCents({ ...emptyUsage(), inputTokens: 1000, outputTokens: 200 });
    assert.ok(Math.abs(row.costCents - (first.costCents + second)) < 1e-9, `${row.costCents} vs ${first.costCents} + ${second}`);
    assert.equal(retried.turn.costCents, null);
    assert.equal(row.webSearches, 2);
    assert.equal(row.usage?.requests, 3);
    assert.equal(row.usage?.inputTokens, 3000);
    const [conversation] = await systemDb
      .select()
      .from(diagnosisConversations)
      .where(eq(diagnosisConversations.id, failed.conversation.id));
    assert.ok(Math.abs(conversation.costCents - row.costCents) < 1e-9);
    const statsAfter = await monthStats(techA.shop.id);
    assert.ok(Math.abs(statsAfter.costCents - statsBefore.costCents - row.costCents) < 1e-6);
    assert.equal(statsAfter.webSearches - statsBefore.webSearches, 2);
  });

  test("starting from a listed model number with no manual tells Claude what the unit is", async () => {
    const run = await startTurn(techA, { start: { modelNumber: "g22gad99a1", complaint: "Won't idle" } }, [
      (params) => {
        assert.match(
          JSON.stringify(params.messages[1]),
          /model number G22GAD99A1, a 2022 GENERAL XP 1000 DELUXE\. It's in the shop's model list, but the shop has no manual for it/,
        );
        return message([submit({})], "tool_use");
      },
    ]);
    assert.equal(run.conversation.unit, "2022 GENERAL XP 1000 DELUXE — G22GAD99A1");
    assert.equal(run.conversation.scope.label, null);
    // No manual, but the model list says it's a General: the side-by-side
    // drawing.
    assert.equal(run.conversation.vehicle, "utv");
  });
});

// --- Limits, stuck turns, web search switch, shops -----------------------------------

describe("limits and housekeeping", () => {
  test("a turn whose server died is marked failed when the conversation is opened", async () => {
    const run = await startTurn(techA, { start: { complaint: "No start", modelNumber: "R20RRE99A9" } }, [
      (params) => {
        assert.match(JSON.stringify(params.messages[1]), /The tech picked the unit: 2020 RANGER XP 1000 EPS — R20RRE99A9/);
        return message([submit({ reply: "Check the battery." })], "tool_use");
      },
    ]);
    assert.deepEqual(run.conversation.scope.manuals.map((manual) => manual.id), [rangerManual]);
    const id = run.conversation.id;
    const [stuck] = await systemDb
      .insert(diagnosisTurns)
      .values({
        conversationId: id,
        shopId: techA.shop.id,
        seq: 2,
        userId: techA.id,
        techText: "Lost",
        heartbeatAt: new Date(Date.now() - STALE_AFTER_MS - 5000),
      })
      .returning();
    const detail = await getConversation(techA, id);
    const shown = detail!.turns.find((turn) => turn.id === stuck.id)!;
    assert.equal(shown.status, "failed");
    assert.match(shown.error ?? "", /stopped part way/);

    // A running turn that's still alive blocks a new message, and can be stopped.
    const [alive] = await systemDb
      .insert(diagnosisTurns)
      .values({ conversationId: id, shopId: techA.shop.id, seq: 3, userId: techA.id, techText: "Working" })
      .returning();
    const blocked = await prepareTurn(techA, { conversationId: id, text: "Another" });
    assert.ok(isProblem(blocked) && blocked.status === 409);
    assert.equal(await requestStop(techA, alive.id), true);
    assert.equal(await requestStop(techB, alive.id), false);
    await systemDb.update(diagnosisTurns).set({ status: "stopped" }).where(eq(diagnosisTurns.id, alive.id));
    const list = await listConversations(techA.shop.id);
    assert.ok(list.some((item) => item.id === id && item.lastTurn === "stopped"));
  });

  test("Stop ends a running message as stopped", async () => {
    const prepared = await prepareTurn(techA, { start: { message: "Stop me" } });
    assert.ok(!isProblem(prepared));
    const outcome = await runTurn(prepared, {
      // The heartbeat notices the stop and aborts the stream, which the SDK
      // reports as APIUserAbortError; this stands in for that.
      client: async () => {
        await requestStop(techA, prepared.turn.id);
        throw new Anthropic.APIUserAbortError();
      },
      emit: () => {},
    });
    assert.equal(outcome.turn.status, "stopped");
    assert.equal(outcome.turn.costCents, null);
  });

  test("messages are limited per tech per hour and per shop per day", async () => {
    const tech = await createUser(techA.shop, "tech", "Busy");
    await systemDb.insert(attemptCounters).values({
      key: `diagnose:user:${tech.id}`,
      count: DIAGNOSE_LIMITS.messagesPerUserPerHour,
      windowStartedAt: Date.now(),
      lastAttemptAt: Date.now(),
    });
    const mine = await prepareTurn(tech, { start: { message: "hi" } });
    assert.ok(isProblem(mine) && mine.status === 429 && /in the last hour/.test(mine.error), JSON.stringify(mine));

    const other = await createUser(techB.shop, "tech", "Other");
    await systemDb.insert(attemptCounters).values({
      key: `diagnose:shop:${other.shop.id}`,
      count: DIAGNOSE_LIMITS.messagesPerShopPerDay,
      windowStartedAt: Date.now(),
      lastAttemptAt: Date.now(),
    });
    const shop = await prepareTurn(other, { start: { message: "hi" } });
    assert.ok(isProblem(shop) && shop.status === 429 && /today/.test(shop.error), JSON.stringify(shop));
    // The tech's own allowance was given back.
    const [counter] = await systemDb.select().from(attemptCounters).where(eq(attemptCounters.key, `diagnose:user:${other.id}`));
    assert.equal(counter.count, 0);
    await systemDb.delete(attemptCounters).where(eq(attemptCounters.key, `diagnose:shop:${other.shop.id}`));
  });

  test("a full conversation takes no more messages", async () => {
    const run = await startTurn(techA, { start: { message: "Fill me" } }, [() => message([submit({})], "tool_use")]);
    await systemDb
      .update(diagnosisConversations)
      .set({ techMessages: DIAGNOSE_LIMITS.techMessages })
      .where(eq(diagnosisConversations.id, run.conversation.id));
    const full = await prepareTurn(techA, { conversationId: run.conversation.id, text: "One more" });
    assert.ok(isProblem(full) && full.status === 409 && /Start a new diagnosis/.test(full.error));
    await systemDb
      .update(diagnosisConversations)
      .set({ techMessages: 1, contextTokens: DIAGNOSE_LIMITS.contextTokens })
      .where(eq(diagnosisConversations.id, run.conversation.id));
    const long = await prepareTurn(techA, { conversationId: run.conversation.id, text: "One more" });
    assert.ok(isProblem(long) && /too long/.test(long.error));
  });

  test("turning web search off later removes it with a tool_removal message, keeping the tool list", async () => {
    const run = await startTurn(techA, { start: { message: "Web on" } }, [() => message([submit({})], "tool_use")]);
    const id = run.conversation.id;
    process.env.DIAGNOSE_WEB_SEARCH = "off";
    try {
      const off = await startTurn(techA, { conversationId: id, text: "Web off now" }, [
        (params) => {
          assert.equal(toolName(params.tools!.at(-1)), "web_search");
          assert.deepEqual(params.betas, [THINKING_BINDING_BETA, FALLBACK_BETA, TOOL_CHANGES_BETA]);
          assert.match(JSON.stringify(params.messages.at(-1)), /"tool_removal".*"web_search"/);
          return message([submit({})], "tool_use");
        },
      ]);
      assert.equal(off.turn.status, "done");
      const later = await startTurn(techA, { conversationId: id, text: "Still off" }, [
        (params) => {
          // Sent once; it stays in the history.
          assert.equal(JSON.stringify(params.messages).match(/tool_removal/g)?.length, 1);
          return message([submit({})], "tool_use");
        },
      ]);
      assert.equal(later.turn.status, "done");
      const fresh = await startTurn(techA, { start: { message: "New one" } }, [
        (params) => {
          assert.ok(!params.tools!.some((tool) => toolName(tool) === "web_search"));
          return message([submit({})], "tool_use");
        },
      ]);
      assert.equal(fresh.turn.status, "done");
    } finally {
      delete process.env.DIAGNOSE_WEB_SEARCH;
    }
  });

  test("a start with nothing to say is refused before anything is counted", async () => {
    const empty = await prepareTurn(techA, { start: { modelNumber: "Z19VDE99AM" } });
    assert.ok(isProblem(empty) && empty.status === 400);
  });
});

describe("Diagnose and shops", () => {
  test("conversations and turns stay inside their shop", async () => {
    const run = await startTurn(techA, { start: { message: "Shop A's" } }, [() => message([submit({})], "tool_use")]);
    const id = run.conversation.id;
    assert.equal(await getConversation(techB, id), null);
    assert.ok(!(await listConversations(techB.shop.id)).some((item) => item.id === id));
    const prepared = await prepareTurn(techB, { conversationId: id, text: "Sneaky" });
    assert.ok(isProblem(prepared) && prepared.status === 404);
    assert.ok("error" in (await markCause(techB, { conversationId: id, turnId: run.turn.id, index: 0, verdict: "confirmed" })));

    await withShop(techB.shop.id, async (tx) => {
      assert.equal((await tx.select().from(diagnosisConversations)).every((row) => row.shopId === techB.shop.id), true);
      assert.equal((await tx.select().from(diagnosisTurns)).every((row) => row.shopId === techB.shop.id), true);
      const changed = await tx.update(diagnosisTurns).set({ status: "failed" }).where(eq(diagnosisTurns.id, run.turn.id)).returning();
      assert.equal(changed.length, 0);
    });
    await assert.rejects(
      withShop(techB.shop.id, (tx) =>
        tx.insert(diagnosisConversations).values({ shopId: techA.shop.id, userId: techA.id, title: "x", webSearch: false }),
      ),
      (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501",
    );
    // A turn can't point at another shop's conversation.
    await assert.rejects(
      withShop(techB.shop.id, (tx) =>
        tx.insert(diagnosisTurns).values({ conversationId: id, shopId: techB.shop.id, seq: 9, userId: techB.id, techText: "x" }),
      ),
    );
  });

  test("app_user can't delete, or change who sent what", async () => {
    const run = await startTurn(techA, { start: { message: "Keep me" } }, [() => message([submit({})], "tool_use")]);
    for (const statement of [
      sql`delete from diagnosis_turns where id = ${run.turn.id}`,
      sql`delete from diagnosis_conversations where id = ${run.conversation.id}`,
      sql`update diagnosis_turns set tech_text = 'changed' where id = ${run.turn.id}`,
      sql`update diagnosis_turns set user_id = ${techA2.id} where id = ${run.turn.id}`,
      sql`update diagnosis_conversations set shop_id = ${techB.shop.id} where id = ${run.conversation.id}`,
    ]) {
      await assert.rejects(
        withShop(techA.shop.id, (tx) => tx.execute(statement)),
        (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501",
      );
    }
  });
});
