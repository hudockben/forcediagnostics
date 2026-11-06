// Reports (the Reports tab): the salesmen's bonuses by week, month,
// quarter and year (src/lib/report-rules.ts): the periods (weeks Monday to
// Sunday, over a month's or a year's end; quarters and years the
// calendar's), what's before and after them and their breakdown; what the
// address says; each salesman's bonuses (a sale's Sales Bonus and Holdback
// Bonus) in each period, however their name's capitalised, by the day each
// sale was sold or funded; the download (src/lib/report-export.ts); and the
// sales the server adds up (src/lib/reports.ts), only the shop's own, and
// only for those who can open the NUSR. Made-up sales only. The database
// tests need DATABASE_URL pointing at a disposable Postgres database; run
// with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { eq } from "drizzle-orm";

import { systemDb } from "../src/db";
import { shops, users } from "../src/db/schema";
import { logSale } from "../src/lib/nusr";
import { blankSaleValues, withFigures, type FiguredSale, type SaleFields, type SaleValues } from "../src/lib/nusr-rules";
import { bonusWorkbook } from "../src/lib/report-export";
import {
  NO_SALESMAN,
  bonusTable,
  bonusesFileName,
  overviewPeriods,
  parseReportParams,
  periodOf,
  periodSales,
  reportDays,
  reportSearch,
  saleDay,
  shiftPeriod,
  subPeriods,
  type ReportParams,
} from "../src/lib/report-rules";
import { bonusSales } from "../src/lib/reports";
import type { CurrentUser } from "../src/lib/session";
import type { Cell, Sheet } from "../src/lib/xlsx-write";

describe("periods", () => {
  test("a week runs Monday to Sunday, over a month's or a year's end too", () => {
    for (const day of ["2026-08-17", "2026-08-21", "2026-08-23"]) {
      const week = periodOf("week", day);
      assert.deepEqual([week.start, week.end, week.label, week.short], ["2026-08-17", "2026-08-23", "Aug 17 – 23, 2026", "Week of Aug 17"], day);
    }
    assert.equal(periodOf("week", "2026-10-29").label, "Oct 26 – Nov 1, 2026");
    const newYear = periodOf("week", "2026-01-01");
    assert.deepEqual([newYear.start, newYear.end, newYear.label], ["2025-12-29", "2026-01-04", "Dec 29, 2025 – Jan 4, 2026"]);
  });

  test("months, quarters and years are the calendar's", () => {
    assert.deepEqual(
      [periodOf("month", "2028-02-10").start, periodOf("month", "2028-02-10").end, periodOf("month", "2028-02-10").label],
      ["2028-02-01", "2028-02-29", "February 2028"],
    );
    const q3 = periodOf("quarter", "2026-08-21");
    assert.deepEqual([q3.start, q3.end, q3.label, q3.short], ["2026-07-01", "2026-09-30", "Q3 2026 (Jul – Sep)", "Q3"]);
    assert.equal(periodOf("quarter", "2026-12-31").short, "Q4");
    assert.equal(periodOf("quarter", "2026-01-01").start, "2026-01-01");
    assert.deepEqual([periodOf("year", "2026-08-21").start, periodOf("year", "2026-08-21").end, periodOf("year", "2026-08-21").label], ["2026-01-01", "2026-12-31", "2026"]);
  });

  test("the period before and after, over a year's end", () => {
    assert.equal(shiftPeriod(periodOf("week", "2026-08-21"), -1), "2026-08-10");
    assert.equal(shiftPeriod(periodOf("week", "2026-12-30"), 1), "2027-01-04");
    assert.equal(shiftPeriod(periodOf("month", "2026-01-15"), -1), "2025-12-01");
    assert.equal(shiftPeriod(periodOf("month", "2026-12-15"), 1), "2027-01-01");
    assert.equal(shiftPeriod(periodOf("quarter", "2026-02-15"), -1), "2025-10-01");
    assert.equal(shiftPeriod(periodOf("year", "2026-02-15"), 1), "2027-01-01");
  });

  test("a week's breakdown by day, a month's by week cut at its ends, a quarter's and a year's by month", () => {
    assert.deepEqual(
      subPeriods(periodOf("week", "2026-08-21")).map((span) => span.label),
      ["Mon 8/17", "Tue 8/18", "Wed 8/19", "Thu 8/20", "Fri 8/21", "Sat 8/22", "Sun 8/23"],
    );
    const august = subPeriods(periodOf("month", "2026-08-21"));
    assert.deepEqual(
      august.map((span) => span.label),
      ["Aug 1 – 2", "Aug 3 – 9", "Aug 10 – 16", "Aug 17 – 23", "Aug 24 – 30", "Aug 31"],
    );
    assert.deepEqual([august[0].start, august[0].end, august.at(-1)!.start, august.at(-1)!.end], ["2026-08-01", "2026-08-02", "2026-08-31", "2026-08-31"]);
    assert.deepEqual(
      subPeriods(periodOf("quarter", "2026-08-21")).map((span) => [span.label, span.start, span.end]),
      [
        ["Jul", "2026-07-01", "2026-07-31"],
        ["Aug", "2026-08-01", "2026-08-31"],
        ["Sep", "2026-09-01", "2026-09-30"],
      ],
    );
    assert.equal(subPeriods(periodOf("year", "2026-08-21")).length, 12);
    assert.equal(subPeriods(periodOf("year", "2028-08-21"))[1].end, "2028-02-29");
  });
});

describe("what the address says", () => {
  const today = "2026-11-06";

  test("the overview as of today, unless a period, another day or funding is asked for", () => {
    assert.deepEqual(parseReportParams({}, today), { view: "overview", on: today, by: "sold" });
    assert.deepEqual(parseReportParams({ view: "month", on: "2026-08-21", by: "funded" }, today), { view: "month", on: "2026-08-21", by: "funded" });
    assert.deepEqual(parseReportParams({ view: "decade", on: "2026-02-30", by: "paid" }, today), { view: "overview", on: today, by: "sold" });
    assert.deepEqual(parseReportParams({ view: ["week", "month"], on: [" 2026-08-21 "] }, today), { view: "week", on: "2026-08-21", by: "sold" });
  });

  test("written back without what's as it is by default", () => {
    assert.equal(reportSearch({ view: "overview", on: today, by: "sold" }, today), "");
    assert.equal(reportSearch({ view: "quarter", on: "2026-08-21", by: "funded" }, today), "?view=quarter&on=2026-08-21&by=funded");
    const params: ReportParams = { view: "week", on: "2026-01-01", by: "sold" };
    assert.deepEqual(parseReportParams(Object.fromEntries(new URLSearchParams(reportSearch(params, today))), today), params);
  });

  test("the days a report's sales come from: every period it shows", () => {
    assert.deepEqual(reportDays({ view: "overview", on: "2026-01-01", by: "sold" }), { from: "2025-12-29", to: "2026-12-31" });
    assert.deepEqual(reportDays({ view: "month", on: "2026-08-21", by: "sold" }), { from: "2026-08-01", to: "2026-08-31" });
    assert.deepEqual(
      overviewPeriods("2026-08-21").map((period) => period.kind),
      ["week", "month", "quarter", "year"],
    );
  });

  test("the download's name", () => {
    assert.equal(bonusesFileName({ view: "month", on: "2026-08-21", by: "sold" }, today), "Bonuses August 2026 2026-11-06.xlsx");
    assert.equal(bonusesFileName({ view: "quarter", on: "2026-08-21", by: "funded" }, today), "Bonuses Q3 2026 Jul – Sep by funding 2026-11-06.xlsx");
    assert.equal(bonusesFileName({ view: "overview", on: "2026-08-21", by: "sold" }, today), "Bonuses as of 2026-08-21 2026-11-06.xlsx");
  });
});

// --- Bonuses --------------------------------------------------------------------

const BLANK: SaleFields = {
  soldOn: "2026-08-21",
  salesperson: null,
  customerName: "Dana Quillfeather",
  customerAddress: null,
  customerPhone: null,
  unitYear: 2026,
  unitModel: "Rngr 570",
  condition: "new",
  unitType: "whole_good",
  vin: null,
  category: "UTV",
  notes: null,
  financeCompany: null,
  fundingReceivedOn: null,
  paidOn: null,
  comsNumber: null,
  msrp: null,
  salesPrice: null,
  dealerCost: null,
  unitLabor: null,
  rebate: null,
  accPrice: null,
  accCost: null,
  accLabor: null,
  escPrice: null,
  escCost: null,
  rewards: null,
  amountFinanced: null,
  downPayment: null,
  bonusAdjustment: null,
  holdbackRateBp: 400,
  bonusRateBp: 1000,
};
let count = 0;
// A sale with a profit and a holdback: $1,000 of unit profit on a $10,000
// MSRP (a $400 holdback) is $1,400 of total profit, a $140 bonus: a $100
// Sales Bonus and a $40 Holdback Bonus.
const sale = (fields: Partial<SaleFields>): FiguredSale & { id: string } => ({
  ...withFigures({ ...BLANK, msrp: 1_000_000, salesPrice: 1_000_000, dealerCost: 900_000, ...fields }),
  id: `sale-${++count}`,
});

const SALES = [
  sale({ soldOn: "2026-08-17", salesperson: "Lee Brandvold", fundingReceivedOn: "2026-08-25" }),
  sale({ soldOn: "2026-08-21", salesperson: "Sam Ortiz" }),
  sale({ soldOn: "2026-08-21", salesperson: "sam  ortiz", fundingReceivedOn: "2026-09-02" }),
  sale({ soldOn: "2026-08-03", salesperson: "Sam Ortiz", bonusAdjustment: -5_000 }),
  // A deal sold at a loss: its bonus goes below nothing, as the NUSR has it.
  sale({ soldOn: "2026-07-14", salesperson: "Lee Brandvold", salesPrice: 800_000 }),
  sale({ soldOn: "2026-02-02", salesperson: null }),
  sale({ soldOn: "2025-12-30", salesperson: "Lee Brandvold" }),
];

describe("bonuses", () => {
  test("each salesman's week, month, quarter and year, however their name's capitalised, the most paid first", () => {
    const table = bonusTable(SALES, saleDay("sold"), overviewPeriods("2026-08-21"));
    assert.deepEqual(
      table.rows.map((row) => [row.label, ...row.cells.map((cell) => [cell.units, cell.total])]),
      [
        // Two at $140 that week, then one at $140 less a $50 adjustment.
        ["Sam Ortiz", [2, 28000], [3, 37000], [3, 37000], [3, 37000]],
        // $140 that week; in July a unit sold at a loss pays -$60.
        ["Lee Brandvold", [1, 14000], [1, 14000], [2, 8000], [2, 8000]],
        // Sales with no salesman come last, whatever they paid.
        [NO_SALESMAN, [0, 0], [0, 0], [0, 0], [1, 14000]],
      ],
    );
    assert.deepEqual(
      table.totals.map((cell) => [cell.units, cell.salesBonus, cell.holdbackBonus, cell.total]),
      [
        [3, 30000, 12000, 42000],
        [4, 35000, 16000, 51000],
        [5, 25000, 20000, 45000],
        [6, 35000, 24000, 59000],
      ],
    );
  });

  test("the sale at a loss: its Sales Bonus below nothing, its Holdback Bonus still paid", () => {
    // Sold $1,000 under cost with a $400 holdback: -$600 of total profit,
    // -$60 of bonus, as the NUSR works it out: -$100 of Sales Bonus and $40
    // of Holdback Bonus.
    const july = bonusTable(SALES, saleDay("sold"), [periodOf("month", "2026-07-14")]);
    assert.deepEqual(
      july.rows.map((row) => [row.label, row.cells[0].totalProfit, row.cells[0].salesBonus, row.cells[0].holdbackBonus, row.cells[0].total]),
      [["Lee Brandvold", -60_000, -10_000, 4_000, -6_000]],
    );
  });

  test("by funding: a sale counts the day its funding came in, and not at all before", () => {
    const august = bonusTable(SALES, saleDay("funded"), [periodOf("month", "2026-08-21")]);
    assert.deepEqual(
      august.rows.map((row) => [row.label, row.cells[0].units]),
      [["Lee Brandvold", 1]],
    );
    const september = bonusTable(SALES, saleDay("funded"), [periodOf("month", "2026-09-01")]);
    assert.deepEqual(
      september.rows.map((row) => [row.label, row.cells[0].units]),
      [["sam ortiz", 1]],
    );
  });

  test("a period's sales, each salesman's together in the table's order, by day", () => {
    const period = periodOf("month", "2026-08-21");
    const table = bonusTable(SALES, saleDay("sold"), [period]);
    assert.deepEqual(
      periodSales(SALES, saleDay("sold"), period, table.rows).map((one) => [one.salesperson, one.soldOn]),
      [
        ["Sam Ortiz", "2026-08-03"],
        ["Sam Ortiz", "2026-08-21"],
        ["sam  ortiz", "2026-08-21"],
        ["Lee Brandvold", "2026-08-17"],
      ],
    );
  });
});

// --- The download ---------------------------------------------------------------

const valueOf = (cell: Cell | undefined) => (cell !== null && typeof cell === "object" && !(cell instanceof Date) ? cell.value : cell);
const formulaOf = (cell: Cell | undefined) => (cell !== null && typeof cell === "object" && !(cell instanceof Date) && "formula" in cell ? cell.formula : null);
const values = (sheet: Sheet) => sheet.rows.map((row) => row.map(valueOf));

describe("the download", () => {
  const options = { generatedAt: new Date("2026-11-06T20:00:00Z"), timeZone: "America/New_York" };

  test("a month: each salesman's split and TOTAL, its weeks, and the sales", () => {
    const [bonuses, sales] = bonusWorkbook({ view: "month", on: "2026-08-21", by: "sold" }, SALES, options);
    assert.deepEqual([bonuses.name, sales.name], ["Bonuses", "Sales"]);
    const rows = values(bonuses);
    assert.equal(rows[0][0], "Salesman bonuses · August 2026");
    assert.match(String(rows[1][0]), /^Downloaded November 6, 2026 at 3:00 PM\. Each sale counted by its date sold/);
    assert.deepEqual(rows.slice(3, 7), [
      ["Salesman", "Units", "Total profit", "Sales bonus", "Holdback bonus", "Total bonus"],
      ["Sam Ortiz", 3, 4200, 250, 120, 370],
      ["Lee Brandvold", 1, 1400, 100, 40, 140],
      ["TOTAL", 4, 5600, 350, 160, 510],
    ]);
    assert.equal(formulaOf(bonuses.rows[6][5]), "SUM(F5:F6)");
    const weeks = rows.findIndex((row) => row[0] === "By week");
    assert.deepEqual(rows[weeks + 1], ["Salesman", "Aug 1 – 2", "Aug 3 – 9", "Aug 10 – 16", "Aug 17 – 23", "Aug 24 – 30", "Aug 31", "Total"]);
    assert.deepEqual(rows[weeks + 2], ["Sam Ortiz", 0, 90, 0, 280, 0, 0, 370]);
    assert.deepEqual(rows[weeks + 4], ["TOTAL", 0, 90, 0, 420, 0, 0, 510]);
    const listed = values(sales);
    assert.deepEqual(listed[0], ["Date sold", "Salesman", "Customer", "Unit", "VIN", "New/Used", "Total profit", "Sales bonus", "Holdback bonus", "Total bonus"]);
    assert.equal(listed.length, 6);
    assert.deepEqual(listed[5].slice(6), [5600, 350, 160, 510]);
    assert.equal(formulaOf(sales.rows[5][9]), "SUM(J2:J5)");
  });

  test("the overview: the four periods side by side, then each with its split", () => {
    const [bonuses, sales] = bonusWorkbook({ view: "overview", on: "2026-08-21", by: "sold" }, SALES, options);
    const rows = values(bonuses);
    assert.equal(rows[0][0], "Salesman bonuses as of August 21, 2026: the week, month, quarter and year");
    assert.deepEqual(rows[3], ["Salesman", "Week: Aug 17 – 23, 2026", "Month: August 2026", "Quarter: Q3 2026 (Jul – Sep)", "Year: 2026"]);
    assert.deepEqual(rows[4], ["Sam Ortiz", 280, 370, 370, 370]);
    assert.deepEqual(rows.slice(5, 8), [
      ["Lee Brandvold", 140, 140, 80, 80],
      [NO_SALESMAN, 0, 0, 0, 140],
      ["TOTAL", 420, 510, 450, 590],
    ]);
    assert.deepEqual(
      rows.filter((row) => row.length === 1 && /^(Week|Month|Quarter|Year): /.test(String(row[0]))).map((row) => row[0]),
      ["Week: Aug 17 – 23, 2026", "Month: August 2026", "Quarter: Q3 2026 (Jul – Sep)", "Year: 2026"],
    );
    // Every sale it read, the oldest first.
    assert.equal(values(sales).length, SALES.length + 2);
  });

  test("nothing to show: the tables are there, with nothing in them", () => {
    const [bonuses, sales] = bonusWorkbook({ view: "week", on: "2026-03-02", by: "sold" }, SALES, options);
    assert.deepEqual(values(bonuses)[4], ["TOTAL", 0, 0, 0, 0, 0]);
    assert.equal(formulaOf(bonuses.rows[4][1]), null);
    assert.equal(values(sales).length, 2);
  });
});

// --- On the server --------------------------------------------------------------

describe("the sales a report adds up", () => {
  const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
  const shopIds: string[] = [];
  let manager: CurrentUser;
  let other: CurrentUser;
  let writer: CurrentUser;

  async function person(code: string, role: "manager" | "service_writer", shop?: CurrentUser["shop"]): Promise<CurrentUser> {
    const created = shop ?? (await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name }))[0];
    if (!shop) shopIds.push(created.id);
    const id = randomUUID();
    await systemDb.insert(users).values({ id, shopId: created.id, role, name: "Morgan", username: `${created.code}.${role}`, displayUsername: role, email: `${randomUUID()}@no-email.invalid` });
    return { id, name: "Morgan", username: role, role, shop: created, bay: null };
  }

  async function sell(actor: CurrentUser, values: Partial<SaleValues>) {
    const result = await logSale(actor, { ...blankSaleValues({ soldOn: "2026-08-21", holdbackRateBp: 400, bonusRateBp: 1000 }), customerName: "Dana Quillfeather", ...values });
    assert.ok("id" in result, JSON.stringify(result));
    return result.id;
  }

  before(async () => {
    manager = await person(`rp${suffix}`, "manager");
    other = await person(`rq${suffix}`, "manager");
    writer = await person("", "service_writer", manager.shop);
    await sell(manager, { soldOn: "2026-08-18", salesperson: "Sam Ortiz", msrp: "10000", salesPrice: "10000", dealerCost: "9000", fundingReceivedOn: "2026-09-01" });
    await sell(manager, { soldOn: "2026-08-20", salesperson: "Lee Brandvold", msrp: "10000", salesPrice: "10000", dealerCost: "9000" });
    await sell(manager, { soldOn: "2026-06-30", salesperson: "Lee Brandvold", msrp: "10000", salesPrice: "10000", dealerCost: "9000" });
    // Another shop's sale that week.
    await sell(other, { soldOn: "2026-08-19", salesperson: "Sam Ortiz", msrp: "10000", salesPrice: "10000", dealerCost: "9000" });
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  test("the shop's own sales of the days the report covers, by the day they were sold", async () => {
    const week = await bonusSales(manager, { view: "week", on: "2026-08-21", by: "sold" });
    assert.ok("sales" in week);
    assert.deepEqual(
      week.sales.map((one) => [one.soldOn, one.salesperson, one.figures.salesBonus + one.figures.holdbackBonus]),
      [
        ["2026-08-18", "Sam Ortiz", 14000],
        ["2026-08-20", "Lee Brandvold", 14000],
      ],
    );
    const overview = await bonusSales(manager, { view: "overview", on: "2026-08-21", by: "sold" });
    assert.ok("sales" in overview);
    assert.equal(overview.sales.length, 3);
  });

  test("by funding: the sales funded in those days, and how many sold then aren't yet", async () => {
    const august = await bonusSales(manager, { view: "month", on: "2026-08-21", by: "funded" });
    assert.ok("sales" in august);
    assert.deepEqual([august.sales.length, august.unfunded], [0, 1]);
    const september = await bonusSales(manager, { view: "month", on: "2026-09-10", by: "funded" });
    assert.ok("sales" in september);
    assert.deepEqual(
      september.sales.map((one) => one.salesperson),
      ["Sam Ortiz"],
    );
  });

  test("only for those who can open the NUSR, signed in with a password", async () => {
    const params: ReportParams = { view: "overview", on: "2026-08-21", by: "sold" };
    assert.ok("error" in (await bonusSales(writer, params)));
    assert.ok("error" in (await bonusSales({ ...manager, bay: { deviceId: "d", deviceName: "Bay 1", sessionId: "s" } }, params)));
    const elsewhere = await bonusSales(other, params);
    assert.ok("sales" in elsewhere);
    assert.equal(elsewhere.sales.length, 1);
  });
});
