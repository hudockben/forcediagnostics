// Reports > Diagnosis times (src/lib/diagnosis-times-rules.ts): how long
// diagnoses take, from their clocks. What the address says; the unit as the
// shop groups jobs ("RZR 1000"); the fault codes a diagnosis started with;
// typical, plan for, fastest and slowest; the solved ones grouped by what
// was wrong, fault code, unit and tech; the download
// (src/lib/diagnosis-times-export.ts); and the diagnoses the server reads
// (src/lib/diagnosis-times.ts): those whose clock ended in the period, by
// the shop's day, with the time on their clocks and each person's part,
// only the shop's own, and only for managers and admins. Made-up diagnoses
// only. The database tests need DATABASE_URL pointing at a disposable
// Postgres database; run with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { eq } from "drizzle-orm";

import { systemDb } from "../src/db";
import { diagnosisConversations, diagnosisTimeSpans, diagnosisTurns, shops, users } from "../src/db/schema";
import type { ClockStop } from "../src/lib/diagnose-clock-rules";
import { getConversation } from "../src/lib/diagnose";
import { conversationEstimate, diagnosisTimes, estimateForStart } from "../src/lib/diagnosis-times";
import { timesWorkbook } from "../src/lib/diagnosis-times-export";
import {
  NO_UNIT,
  estimateBasis,
  estimateFrom,
  fixOf,
  openingCodes,
  splitCodes,
  parseTimesParams,
  peopleOf,
  timeStats,
  timesFileName,
  timesSearch,
  timesSummary,
  typicalTimes,
  unitGroup,
  type FinishedDiagnosis,
  type PastJob,
  type TimesParams,
} from "../src/lib/diagnosis-times-rules";
import type { CurrentUser } from "../src/lib/session";
import type { Cell } from "../src/lib/xlsx-write";

const MIN = 60;

describe("what the address says", () => {
  const today = "2026-11-09";

  test("this month, grouped by what was wrong, unless another period, day or grouping is asked for", () => {
    assert.deepEqual(parseTimesParams({}, today), { view: "month", on: today, group: "fix" });
    assert.deepEqual(parseTimesParams({ view: "quarter", on: "2026-08-21", group: "code" }, today), { view: "quarter", on: "2026-08-21", group: "code" });
    assert.deepEqual(parseTimesParams({ view: "decade", on: "2026-02-30", group: "colour" }, today), { view: "month", on: today, group: "fix" });
    assert.deepEqual(parseTimesParams({ view: ["year", "week"], group: [" tech "] }, today), { view: "year", on: today, group: "tech" });
  });

  test("written back without what's as it is by default", () => {
    assert.equal(timesSearch({ view: "month", on: today, group: "fix" }, today), "");
    assert.equal(timesSearch({ view: "year", on: "2026-08-21", group: "unit" }, today), "?view=year&on=2026-08-21&group=unit");
    const params: TimesParams = { view: "week", on: "2026-01-01", group: "tech" };
    assert.deepEqual(parseTimesParams(Object.fromEntries(new URLSearchParams(timesSearch(params, today))), today), params);
  });

  test("the download's name", () => {
    assert.equal(timesFileName({ view: "month", on: "2026-10-21", group: "fix" }, today), "Diagnosis times October 2026 2026-11-09.xlsx");
    assert.equal(timesFileName({ view: "quarter", on: "2026-08-21", group: "code" }, today), "Diagnosis times Q3 2026 Jul – Sep 2026-11-09.xlsx");
  });
});

describe("what each diagnosis is grouped under", () => {
  test("the unit as the shop groups jobs: its line and engine size", () => {
    const cases: [string | null, string][] = [
      ["2019 RZR XP 1000 EPS — Z19VDE99AM", "RZR 1000"],
      ["2025 Ranger Crew XP 1000 (50 models)", "Ranger 1000"],
      ["Ranger XD 1500 Northstar (5 models)", "Ranger 1500"],
      ["2025 RANGER 570 SP (12 models)", "Ranger 570"],
      ["2023 SPORTSMAN 570 EPS — A23SEE57A1", "Sportsman 570"],
      ["2022 GENERAL XP 1000 DELUXE — G22GAD99A1", "General 1000"],
      // A Ranger edition, not a Trail Boss ATV; the first RZRs were Rangers.
      ["RGR CREW XP 1000 TRAIL BOSS - GHOST GRAY", "Ranger 1000"],
      ["2008 RANGER RZR 800", "RZR 800"],
      ["2019 Ranger", "Ranger"],
      // Not one of Polaris's lines: the name, without its year.
      ["2021 Honda Pioneer 1000-5", "Honda Pioneer 1000-5"],
      ["Z19VDE99AM", "Z19VDE99AM"],
      [null, NO_UNIT],
      ["  ", NO_UNIT],
    ];
    for (const [label, group] of cases) assert.equal(unitGroup(label), group, String(label));
  });

  test("the fault codes from the quick form's opening, once each", () => {
    assert.deepEqual(openingCodes("Unit: 2019 RZR XP 1000 EPS\nComplaint: Misfires\nFault codes: P0300, P0301, P0300\nAlready checked: plugs"), ["P0300", "P0301"]);
    assert.deepEqual(openingCodes("Misfires under load, P0300"), []);
    assert.deepEqual(openingCodes(null), []);
  });
});

describe("typical times", () => {
  test("typical is the middle one, plan for what 4 in 5 were done within", () => {
    assert.deepEqual(timeStats([2400, 600, 6000, 1200, 1800]), {
      count: 5,
      typical: 1800,
      planFor: 2400,
      fastest: 600,
      slowest: 6000,
      average: 2400,
      total: 12000,
    });
    // An even number: the two in the middle's average; plan for, the longer.
    assert.deepEqual([timeStats([600, 1200]).typical, timeStats([600, 1200]).planFor], [900, 1200]);
    const ten = timeStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => n * MIN));
    assert.deepEqual([ten.typical, ten.planFor], [5.5 * MIN, 8 * MIN]);
    assert.deepEqual(timeStats([900]), { count: 1, typical: 900, planFor: 900, fastest: 900, slowest: 900, average: 900, total: 900 });
    assert.equal(timeStats([]).count, 0);
  });

  const diagnosis = (input: Partial<FinishedDiagnosis> & { seconds: number }): FinishedDiagnosis => ({
    id: randomUUID(),
    title: "A diagnosis",
    unit: "2019 RZR XP 1000 EPS — Z19VDE99AM",
    startedBy: "Mike",
    startedAt: "2026-10-01T14:00:00.000Z",
    finishedAt: "2026-10-01T15:00:00.000Z",
    finishedOn: "2026-10-01",
    solved: true,
    fix: "Fouled plug",
    system: "ignition",
    codes: [],
    people: [{ id: "mike", name: "Mike", seconds: input.seconds }],
    ...input,
  });
  const fixtures = [
    diagnosis({ seconds: 40 * MIN, codes: ["P0300", "P0301"] }),
    diagnosis({ seconds: 60 * MIN, codes: ["P0300"], unit: "2020 RANGER XP 1000 EPS — R20RRE99A9" }),
    diagnosis({
      seconds: 90 * MIN,
      system: "fuel",
      fix: "Weak fuel pump",
      people: [
        { id: "rae", name: "Rae", seconds: 60 * MIN },
        { id: "mike", name: "Mike", seconds: 30 * MIN },
      ],
    }),
    diagnosis({ seconds: 20 * MIN, unit: null }),
    // Ended without a cause: in the list and the totals, not the typical times.
    diagnosis({ seconds: 5 * MIN, solved: false, fix: null, system: null, codes: ["P0300"] }),
  ];
  const rows = (by: Parameters<typeof typicalTimes>[1]) => typicalTimes(fixtures, by).map((group) => [group.label, group.stats.count, group.stats.typical / MIN]);

  test("by what was wrong, fault code, unit and tech: the most often seen first, what no diagnosis named last", () => {
    assert.deepEqual(rows("fix"), [
      ["Ignition", 3, 40],
      ["Fuel", 1, 90],
    ]);
    // A diagnosis with two codes counts under each.
    assert.deepEqual(rows("code"), [
      ["P0300", 2, 50],
      ["P0301", 1, 40],
      ["No fault codes", 2, 55],
    ]);
    assert.deepEqual(rows("unit"), [
      ["RZR 1000", 2, 65],
      ["Ranger 1000", 1, 60],
      [NO_UNIT, 1, 20],
    ]);
    // Each person's own part of each diagnosis.
    assert.deepEqual(rows("tech"), [
      ["Mike", 4, 35],
      ["Rae", 1, 60],
    ]);
  });

  test("the period at a glance, and what a diagnosis's row says", () => {
    const summary = timesSummary(fixtures);
    assert.deepEqual([summary.finished, summary.solved, summary.seconds / MIN, summary.solving.typical / MIN, summary.solving.planFor / MIN], [5, 4, 215, 50, 90]);
    assert.equal(peopleOf(fixtures[2]), "Rae, Mike");
    assert.equal(fixOf(fixtures[2]), "Weak fuel pump (Fuel)");
    assert.equal(fixOf(fixtures[4]), "Ended, no cause confirmed");
  });

  test("the download: the times by every grouping, and the diagnoses in decimal hours with a live total", () => {
    const sheets = timesWorkbook(
      { view: "month", on: "2026-10-21", group: "fix" },
      { diagnoses: fixtures, open: { count: 2, seconds: 45 * MIN } },
      { generatedAt: new Date("2026-11-09T15:00:00Z"), timeZone: "America/New_York" },
    );
    assert.deepEqual(sheets.map((sheet) => sheet.name), ["Times", "Diagnoses"]);
    const value = (cell: Cell | undefined) => (cell !== null && typeof cell === "object" && !(cell instanceof Date) ? cell.value : cell);
    const [times, list] = sheets;
    assert.equal(value(times.rows[0][0]), "Diagnosis times · October 2026");
    const labelled = (label: string) => times.rows.find((row) => value(row[0]) === label)!.slice(1).map(value);
    assert.deepEqual(labelled("Finished"), [5]);
    assert.deepEqual(labelled("Hours on the clock"), [3.58]);
    assert.deepEqual(labelled("Still open (started in the period)"), [2, 0.75]);
    // Every grouping, each with its head and its rows.
    for (const heading of ["By what was wrong", "By fault code", "By unit", "By tech"]) assert.ok(times.rows.some((row) => value(row[0]) === heading), heading);
    assert.deepEqual(labelled("P0300"), [2, 0.83, 1, 0.67, 1, 0.83, 1.67]);
    assert.deepEqual(list.rows[0].map(value), ["Finished", "Diagnosis", "Unit", "Unit group", "Fault codes", "Started by", "Worked on by", "Solved", "What was wrong", "System", "Hours"]);
    assert.deepEqual(list.rows[3].slice(3).map(value), ["RZR 1000", "", "Mike", "Rae, Mike", "Yes", "Weak fuel pump", "Fuel", 1.5]);
    const total = list.rows.at(-1)!;
    assert.equal(value(total[0]), "TOTAL: 5 diagnoses");
    assert.deepEqual(total.at(-1), { formula: "SUM(K2:K6)", value: 3.58, style: "totalHours" });
  });
});

describe("an estimate for the next one", () => {
  const RZR = "2019 RZR XP 1000 EPS — Z19VDE99AM";
  const job = (unit: string | null, codes: string[], minutes: number): PastJob => ({ unit, codes, seconds: minutes * MIN });
  const past = [
    job(RZR, ["P0300"], 40),
    job("2021 RZR XP 1000 — Z21VDE99A2", ["P0300", "P0301"], 50),
    job(RZR, ["p0300"], 90),
    job(RZR, ["P0420"], 30),
    job("2020 RANGER 570 — R20RAE57A1", ["P0300"], 20),
    job("Ranger 570", ["P0300"], 30),
    job(RZR, [], 70),
  ];
  const minutes = (estimate: ReturnType<typeof estimateFrom>) =>
    estimate && { ...estimate, typical: estimate.typical / MIN, planFor: estimate.planFor / MIN };

  test("the same unit with one of the codes first, then the codes, then the unit: the closest with three or more", () => {
    assert.deepEqual(minutes(estimateFrom(past, { unit: RZR, codes: ["P0300", "P0302"] })), { count: 3, typical: 50, planFor: 90, unit: "RZR 1000", codes: ["P0300"] });
    // One RZR 1000 with P0420, one P0420 anywhere: every RZR 1000.
    assert.deepEqual(minutes(estimateFrom(past, { unit: "RZR XP 1000", codes: ["P0420"] })), { count: 5, typical: 50, planFor: 70, unit: "RZR 1000", codes: [] });
    // Two Ranger 570s with P0300: the code's five go first.
    assert.deepEqual(minutes(estimateFrom(past, { unit: "2022 RANGER 570 EPS", codes: ["P0300"] })), { count: 5, typical: 40, planFor: 50, unit: null, codes: ["P0300"] });
    assert.deepEqual(minutes(estimateFrom(past, { unit: null, codes: ["P0301", "P0300"] })), { count: 5, typical: 40, planFor: 50, unit: null, codes: ["P0301", "P0300"] });
  });

  test("two will do when nothing closer has three; fewer, and there isn't one", () => {
    assert.deepEqual(minutes(estimateFrom(past, { unit: "Ranger 570", codes: [] })), { count: 2, typical: 25, planFor: 30, unit: "Ranger 570", codes: [] });
    assert.equal(estimateFrom(past, { unit: "2023 SPORTSMAN 570", codes: ["P0171"] }), null);
    assert.equal(estimateFrom(past.slice(0, 1), { unit: RZR, codes: ["P0300"] }), null);
    assert.equal(estimateFrom(past, { unit: null, codes: [] }), null);
    assert.equal(estimateFrom([], { unit: RZR, codes: ["P0300"] }), null);
  });

  test("what it's from, in words", () => {
    assert.equal(estimateBasis({ count: 4, unit: "RZR 1000", codes: ["P0300"] }), "4 solved RZR 1000 diagnoses with P0300");
    assert.equal(estimateBasis({ count: 2, unit: null, codes: ["P0300", "P0301"] }), "2 solved diagnoses with P0300 or P0301");
    assert.equal(estimateBasis({ count: 3, unit: null, codes: ["P0300", "P0301", "P0302"] }), "3 solved diagnoses with P0300, P0301 or P0302");
    assert.equal(estimateBasis({ count: 5, unit: "Ranger 570", codes: [] }), "5 solved Ranger 570 diagnoses");
    assert.deepEqual(splitCodes("P0300, P0301,P0300"), ["P0300", "P0301"]);
    assert.deepEqual(splitCodes(null), []);
  });
});

// --- On the server ----------------------------------------------------------------

describe("the diagnoses the server reads", () => {
  const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
  const shopIds: string[] = [];
  let manager: CurrentUser;
  let mike: CurrentUser;
  let rae: CurrentUser;
  let writer: CurrentUser;
  let otherManager: CurrentUser;
  const ids: Record<string, string> = {};

  async function createShop(code: string) {
    const [shop] = await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name });
    shopIds.push(shop.id);
    return shop;
  }

  async function createUser(shop: CurrentUser["shop"], role: CurrentUser["role"], name: string): Promise<CurrentUser> {
    const id = randomUUID();
    const username = `${name.toLowerCase()}${randomUUID().slice(0, 4)}`;
    await systemDb.insert(users).values({ id, shopId: shop.id, role, name, username: `${shop.code}.${username}`, displayUsername: username, email: `${randomUUID()}@no-email.invalid` });
    return { id, name, username, role, shop, bay: null };
  }

  // A diagnosis with its opening message, the cause confirmed (if any) and
  // its clock's stretches, each from a moment for so many minutes.
  async function addDiagnosis(
    key: string,
    starter: CurrentUser,
    input: {
      title: string;
      unit?: string;
      opening?: string;
      createdAt: string;
      fix?: { title: string; system?: string };
      spans: { user: CurrentUser; from: string; minutes: number; stop: ClockStop | null }[];
    },
  ) {
    const [conversation] = await systemDb
      .insert(diagnosisConversations)
      .values({
        shopId: starter.shop.id,
        userId: starter.id,
        title: input.title,
        unitLabel: input.unit ?? null,
        webSearch: true,
        status: input.fix ? "solved" : "open",
        outcome: input.fix ? { title: input.fix.title, likelihood: "high", rank: 2, seq: 1, userId: starter.id, at: input.createdAt } : null,
        createdAt: new Date(input.createdAt),
      })
      .returning({ id: diagnosisConversations.id });
    const cause = (title: string, system?: string) => ({ title, ...(system ? { system } : {}), likelihood: "high", why: "Fits.", status: "open", sources: [] });
    await systemDb.insert(diagnosisTurns).values({
      conversationId: conversation.id,
      shopId: starter.shop.id,
      seq: 1,
      userId: starter.id,
      techText: input.opening ?? input.title,
      status: "done",
      reply: { reply: "", likelyCauses: [cause("Something else", "engine"), cause(input.fix?.title ?? "Unconfirmed", input.fix?.system)], nextChecks: [], safetyNotes: [], questions: [], partial: false, dropped: 0 } as never,
    });
    if (input.spans.length > 0) {
      await systemDb.insert(diagnosisTimeSpans).values(
        input.spans.map((span, index) => ({
          shopId: starter.shop.id,
          conversationId: conversation.id,
          seq: index + 1,
          userId: span.user.id,
          startedAt: new Date(span.from),
          endedAt: new Date(Date.parse(span.from) + span.minutes * 60_000),
          stop: span.stop,
        })),
      );
    }
    ids[key] = conversation.id;
  }

  before(async () => {
    const shop = await createShop(`dt${suffix}`);
    manager = await createUser(shop, "manager", "Lou");
    mike = await createUser(shop, "tech", "Mike");
    rae = await createUser(shop, "tech", "Rae");
    writer = await createUser(shop, "service_writer", "Sam");
    otherManager = await createUser(await createShop(`du${suffix}`), "manager", "Ola");

    await addDiagnosis("misfire", mike, {
      title: "2019 RZR XP 1000 EPS — Misfires under load",
      unit: "2019 RZR XP 1000 EPS — Z19VDE99AM",
      opening: "Unit: 2019 RZR XP 1000 EPS — Z19VDE99AM\nComplaint: Misfires under load\nFault codes: P0300, P0301",
      createdAt: "2026-10-15T13:00:00Z",
      fix: { title: "Fouled plug", system: "ignition" },
      spans: [
        { user: mike, from: "2026-10-15T13:00:00Z", minutes: 40, stop: "idle" },
        { user: rae, from: "2026-10-15T15:00:00Z", minutes: 20, stop: "solved" },
      ],
    });
    // Ended on the evening of October 31st in the shop, November 1st in UTC;
    // its cause from before causes carried a system.
    await addDiagnosis("winch", rae, {
      title: "Sportsman 570 — Winch clicks but won't pull",
      unit: "2022 SPORTSMAN 570 — A22SEE57A1",
      createdAt: "2026-10-31T23:00:00Z",
      fix: { title: "Corroded battery terminals" },
      spans: [{ user: rae, from: "2026-11-01T01:35:00Z", minutes: 25, stop: "solved" }],
    });
    await addDiagnosis("belt", mike, {
      title: "Ranger — Belt squeal",
      unit: "2021 RANGER CREW XP 1000 — R21RSU99A1",
      createdAt: "2026-10-20T14:00:00Z",
      spans: [{ user: mike, from: "2026-10-20T14:00:00Z", minutes: 10, stop: "end" }],
    });
    // Ended on the evening of September 30th in the shop.
    await addDiagnosis("lookup", mike, {
      title: "Where's the cab filter?",
      createdAt: "2026-10-01T03:00:00Z",
      spans: [{ user: mike, from: "2026-10-01T03:00:00Z", minutes: 30, stop: "end" }],
    });
    // Still open: started in October, 30 minutes so far.
    await addDiagnosis("open", rae, {
      title: "Speedo drops out",
      createdAt: "2026-10-10T14:00:00Z",
      spans: [
        { user: rae, from: "2026-10-10T14:00:00Z", minutes: 20, stop: "pause" },
        { user: rae, from: "2026-10-11T14:00:00Z", minutes: 10, stop: "idle" },
      ],
    });
    // Solved in October, then reopened and ended in November: November's.
    await addDiagnosis("reopened", mike, {
      title: "Fan won't come on",
      createdAt: "2026-10-25T14:00:00Z",
      fix: { title: "Fan relay", system: "cooling" },
      spans: [
        { user: mike, from: "2026-10-25T14:00:00Z", minutes: 15, stop: "solved" },
        { user: mike, from: "2026-11-02T14:00:00Z", minutes: 15, stop: "solved" },
      ],
    });
    // From before the clock: solved in October, but no time.
    await addDiagnosis("before", mike, { title: "Old one", createdAt: "2026-10-05T14:00:00Z", fix: { title: "Battery", system: "charging_starting" }, spans: [] });
    await addDiagnosis("theirs", otherManager, {
      title: "Other shop's misfire",
      createdAt: "2026-10-15T13:00:00Z",
      fix: { title: "Coil", system: "ignition" },
      spans: [{ user: otherManager, from: "2026-10-15T13:00:00Z", minutes: 99, stop: "solved" }],
    });
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  const october: TimesParams = { view: "month", on: "2026-10-21", group: "fix" };

  test("those whose clock ended in the period, by the shop's day, newest first, with each person's part", async () => {
    const result = await diagnosisTimes(manager, october);
    assert.ok("diagnoses" in result, JSON.stringify(result));
    const key = (id: string) => Object.entries(ids).find(([, value]) => value === id)?.[0];
    assert.deepEqual(result.diagnoses.map((diagnosis) => key(diagnosis.id)), ["winch", "belt", "misfire"]);
    const [winch, belt, misfire] = result.diagnoses;
    assert.deepEqual(
      { ...misfire, id: "", startedAt: "", finishedAt: "" },
      {
        id: "",
        title: "2019 RZR XP 1000 EPS — Misfires under load",
        unit: "2019 RZR XP 1000 EPS — Z19VDE99AM",
        startedBy: "Mike",
        startedAt: "",
        finishedAt: "",
        finishedOn: "2026-10-15",
        solved: true,
        fix: "Fouled plug",
        system: "ignition",
        codes: ["P0300", "P0301"],
        seconds: 60 * MIN,
        people: [
          { id: mike.id, name: "Mike", seconds: 40 * MIN },
          { id: rae.id, name: "Rae", seconds: 20 * MIN },
        ],
      },
    );
    assert.equal(misfire.finishedAt, "2026-10-15T15:20:00.000Z");
    // October 31st in the shop; its system worked out from its words.
    assert.deepEqual([winch.finishedOn, winch.system, winch.seconds], ["2026-10-31", "charging_starting", 25 * MIN]);
    assert.deepEqual([belt.solved, belt.fix, belt.system, belt.seconds], [false, null, null, 10 * MIN]);
    // Started in October and not ended: the speedo, with 30 minutes so far.
    assert.deepEqual(result.open, { count: 1, seconds: 30 * MIN });
  });

  test("September has the evening of the 30th; November the one reopened and ended again", async () => {
    const september = await diagnosisTimes(manager, { ...october, on: "2026-09-10" });
    assert.ok("diagnoses" in september);
    assert.deepEqual(september.diagnoses.map((diagnosis) => [diagnosis.id, diagnosis.finishedOn]), [[ids.lookup, "2026-09-30"]]);
    const november = await diagnosisTimes(manager, { ...october, on: "2026-11-09" });
    assert.ok("diagnoses" in november);
    assert.deepEqual(november.diagnoses.map((diagnosis) => [diagnosis.id, diagnosis.seconds]), [[ids.reopened, 30 * MIN]]);
    // The year has every one with a clock, and only this shop's.
    const year = await diagnosisTimes(manager, { ...october, view: "year" });
    assert.ok("diagnoses" in year);
    assert.deepEqual(new Set(year.diagnoses.map((diagnosis) => diagnosis.id)), new Set([ids.winch, ids.belt, ids.misfire, ids.lookup, ids.reopened]));
  });

  test("only the shop's own, and only for managers and admins (a bay tablet's PIN is enough)", async () => {
    const theirs = await diagnosisTimes(otherManager, october);
    assert.ok("diagnoses" in theirs);
    assert.deepEqual(theirs.diagnoses.map((diagnosis) => diagnosis.id), [ids.theirs]);
    assert.ok("error" in (await diagnosisTimes(mike, october)));
    assert.ok("error" in (await diagnosisTimes(writer, october)));
    const onTablet = await diagnosisTimes({ ...manager, bay: { deviceId: "tablet", deviceName: "Bay 1", sessionId: "pin" } }, october);
    assert.ok("diagnoses" in onTablet && onTablet.diagnoses.length === 3);
  });

  describe("estimates", () => {
    const RZR = "2019 RZR XP 1000 EPS — Z19VDE99AM";
    let eve: CurrentUser;
    let elsewhere: CurrentUser;
    // Days before now, so the last year holds them whenever the tests run.
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const job = (
      key: string,
      who: CurrentUser,
      unit: string | undefined,
      codes: string,
      minutes: number,
      { daysAgo = 10, stop = "solved" as ClockStop | null, solved = true } = {},
    ) =>
      addDiagnosis(key, who, {
        title: `${unit ?? "No unit"} — ${key}`,
        unit,
        opening: `Complaint: Runs rough${codes ? `\nFault codes: ${codes}` : ""}`,
        createdAt: ago(daysAgo),
        fix: solved ? { title: "Fouled plug", system: "ignition" } : undefined,
        spans: [{ user: who, from: ago(daysAgo), minutes, stop }],
      });

    before(async () => {
      eve = await createUser(await createShop(`de${suffix}`), "tech", "Eve");
      elsewhere = await createUser(await createShop(`df${suffix}`), "tech", "Ned");
      await job("e1", eve, RZR, "P0300", 40);
      await job("e2", eve, "2021 RZR XP 1000 — Z21VDE99A2", "P0300, P0301", 50);
      await job("e3", eve, RZR, "P0300", 90);
      await job("e4", eve, RZR, "P0420", 30);
      await job("e5", eve, "2020 RANGER 570 — R20RAE57A1", "P0300", 20);
      await job("e6", eve, "2021 RANGER 570 SP (12 models)", "P0300", 30);
      await job("e7", eve, RZR, "", 70);
      // Not counted: ended without a cause; more than a year ago; solved,
      // but its clock opened again; the one being estimated; another shop's.
      await job("e8", eve, RZR, "P0300", 5, { stop: "end", solved: false });
      await job("e9", eve, RZR, "P0300", 500, { daysAgo: 400 });
      await job("e10", eve, RZR, "P0300", 300, { stop: null });
      await job("target", eve, RZR, "P0300", 15, { stop: null, solved: false });
      await job("e-theirs", elsewhere, RZR, "P0300", 999);
    });

    test("a diagnosis's own: its unit with one of its codes, from the shop's solved ones of the last year, never itself", async () => {
      const expected = { count: 3, typical: 50 * MIN, planFor: 90 * MIN, unit: "RZR 1000", codes: ["P0300"] };
      assert.deepEqual(await conversationEstimate(eve.shop.id, { id: ids.target, unitLabel: RZR }), expected);
      // On the diagnosis, beside its clock.
      assert.deepEqual((await getConversation(eve, ids.target))!.conversation.estimate, expected);
      // One started with no codes, on a unit nothing else was.
      assert.equal(await conversationEstimate(eve.shop.id, { id: ids.e7, unitLabel: "2023 SPORTSMAN 570" }), null);
    });

    test("one about to start: the unit and codes as the quick form has them", async () => {
      const shop = eve.shop.id;
      const minutes = (estimate: Awaited<ReturnType<typeof estimateForStart>>) =>
        estimate && [estimate.count, estimate.typical / MIN, estimate.planFor / MIN, estimate.unit, estimate.codes];
      // P0420 on a RZR 1000: only one before, so every RZR 1000.
      assert.deepEqual(minutes(await estimateForStart(shop, { unit: RZR, codes: "p0420" })), [5, 50, 70, "RZR 1000", []]);
      assert.deepEqual(minutes(await estimateForStart(shop, { unit: "", codes: "P0300" })), [5, 40, 50, null, ["P0300"]]);
      assert.deepEqual(minutes(await estimateForStart(shop, { unit: "2022 RANGER 570 EPS", codes: "P0300" })), [5, 40, 50, null, ["P0300"]]);
      assert.deepEqual(minutes(await estimateForStart(shop, { unit: "Ranger 570", codes: "" })), [2, 25, 30, "Ranger 570", []]);
      assert.equal(await estimateForStart(shop, { unit: "2023 SPORTSMAN 570", codes: "" }), null);
      assert.equal(await estimateForStart(shop, { unit: "  ", codes: "" }), null);
      // Another shop's one RZR 1000 isn't enough, and this shop's never count there.
      assert.equal(await estimateForStart(elsewhere.shop.id, { unit: RZR, codes: "P0300" }), null);
    });
  });
});
