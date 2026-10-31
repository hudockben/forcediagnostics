// NUSR's download end to end, as src/app/(app)/nusr/export/route.ts puts
// it together: the sales the log's filters find in the database, the
// oldest first and only the shop's own, and every year's months for the
// Comparison, written as a workbook and read back as Excel reads it; and
// who may download it. Made-up sales only.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { eq } from "drizzle-orm";

import { systemDb } from "../src/db";
import { shops, users } from "../src/db/schema";
import { findSales, logSale, unitsByMonth, type SaleInput } from "../src/lib/nusr";
import { nusrWorkbook } from "../src/lib/nusr-export";
import { filtersTitle, parseSaleFilters } from "../src/lib/nusr-rules";
import { allows } from "../src/lib/permissions";
import { ROLES } from "../src/lib/roles";
import type { CurrentUser } from "../src/lib/session";
import { readXlsx } from "../src/lib/xlsx";
import { writeXlsx } from "../src/lib/xlsx-write";

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
const shopIds: string[] = [];

async function createManager(code: string): Promise<CurrentUser> {
  const [shop] = await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name });
  shopIds.push(shop.id);
  const id = randomUUID();
  await systemDb.insert(users).values({
    id,
    shopId: shop.id,
    role: "manager",
    name: "Tamsin",
    username: `${code}.tamsin`,
    displayUsername: "tamsin",
    email: `${randomUUID()}@no-email.invalid`,
  });
  return { id, name: "Tamsin", username: "tamsin", role: "manager", shop, bay: null };
}

// What the form sends for a sale with nothing filled in.
const FORM: SaleInput = {
  soldOn: "",
  salesperson: "",
  customerName: "",
  customerAddress: "",
  customerPhone: "",
  unitYear: "",
  unitModel: "",
  condition: "new",
  unitType: "whole_good",
  vin: "",
  category: "",
  notes: "",
  financeCompany: "",
  fundingReceivedOn: "",
  paidOn: "",
  comsNumber: "",
  msrp: "",
  salesPrice: "",
  dealerCost: "",
  unitLabor: "",
  rebate: "",
  accPrice: "",
  accCost: "",
  accLabor: "",
  escPrice: "",
  escCost: "",
  rewards: "",
  amountFinanced: "",
  downPayment: "",
  bonusAdjustment: "",
  holdbackRateBp: "4",
  bonusRateBp: "10",
};

async function log(actor: CurrentUser, fields: Partial<SaleInput>) {
  const logged = await logSale(actor, { ...FORM, ...fields });
  assert.ok("id" in logged, JSON.stringify(logged));
}

// The download as the route makes it, read back sheet by sheet.
async function download(actor: CurrentUser, params: Record<string, string>) {
  const filters = parseSaleFilters(params, 2026);
  const title = filtersTitle(filters);
  const sales = await findSales(actor.shop.id, filters, "oldest");
  const comparison = await unitsByMonth(actor.shop.id);
  const bytes = writeXlsx(nusrWorkbook(sales, { title, comparison, generatedAt: new Date("2026-10-31T16:00:00Z") }), { title: `NUSR ${title}` });
  const sheets = await readXlsx(bytes);
  assert.deepEqual(
    sheets.map((sheet) => sheet.name),
    ["NUSR", "Summary", "Comparison"],
  );
  return { title, nusr: sheets[0].rows, summary: sheets[1].rows, comparison: sheets[2].rows };
}

let manager: CurrentUser;
let elsewhere: CurrentUser;

before(async () => {
  manager = await createManager(`nd${suffix}`);
  elsewhere = await createManager(`ne${suffix}`);
  // Logged out of order, as the shop catches up on them.
  await log(manager, {
    soldOn: "2026-03-14",
    salesperson: "Sam Ortiz",
    customerName: "Dana Quillfeather",
    customerPhone: "814-555-0101",
    unitYear: "2026",
    unitModel: "Rngr 570 NS",
    vin: "4XARAA578TE000001",
    category: "UTV",
    msrp: "15,999.00",
    salesPrice: "14,500",
    dealerCost: "12,750.25",
    unitLabor: "150",
    rebate: "300",
    accPrice: "1,200",
    accCost: "800",
    accLabor: "100",
    escPrice: "999",
    escCost: "450",
    rewards: "25",
    bonusAdjustment: "(50)",
    financeCompany: "Keystone Credit",
    amountFinanced: "10000",
    downPayment: "2000",
    fundingReceivedOn: "2026-03-20",
    comsNumber: "C-1001",
  });
  await log(manager, { soldOn: "2026-10-30", customerName: "Walt Brennigan", unitModel: "6.5 x 14 Trailer", unitType: "trailer", category: "Trailer", salesPrice: "1899", dealerCost: "1400" });
  await log(manager, { soldOn: "2026-02-01", customerName: "Rhett Carver", unitModel: "Spmn 570 EPS", condition: "used", unitType: "trade", salesPrice: "6000", dealerCost: "4500" });
  await log(manager, { soldOn: "2025-11-20", customerName: "Lee Brandt", msrp: "9,999.99", salesPrice: "9500", dealerCost: "8000" });
  await log(elsewhere, { soldOn: "2026-03-14", customerName: "Ines Otherton", salesPrice: "5000", dealerCost: "4000" });
});

after(async () => {
  for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
  await systemDb.$client.end();
});

describe("the download", () => {
  test("the year asked for, the oldest first, only the shop's own, as Excel reads it", async () => {
    const { title, nusr } = await download(manager, { year: "2026" });
    assert.equal(title, "2026");
    assert.equal(nusr[0][1], "Date");
    assert.deepEqual(
      nusr.slice(1, 4).map((row) => [row[1], row[3], row[10]]),
      [
        ["2026-02-01", "Rhett Carver", "Trade"],
        ["2026-03-14", "Dana Quillfeather", "15999"],
        ["2026-10-30", "Walt Brennigan", "Trailer"],
      ],
    );
    // The Ranger as typed and as worked out: Unit Profit, Holdback, TOTAL
    // PROFIT and the bonuses, the funding date, the rates.
    const ranger = nusr[2];
    assert.deepEqual([ranger[5], ranger[8], ranger[9], ranger[16], ranger[26], ranger[27], ranger[29], ranger[30], ranger[31]], [
      "(814) 555-0101",
      "N",
      "4XARAA578TE000001",
      "1899.75",
      "639.96",
      "3413.71",
      "341.37",
      "64",
      "227.37",
    ]);
    assert.deepEqual([ranger[35], ranger[39], ranger[40], ranger[41], ranger[42]], ["2026-03-20", "New whole good", "0.04", "0.1", "-50"]);
    // A blank row, then the totals of the three.
    assert.deepEqual(nusr[4], []);
    assert.deepEqual(nusr[5].slice(1, 3), ["3", "TOTAL"]);
    assert.equal(nusr[5][11], "22399");
    assert.equal(nusr[6][2], "AVG TOTAL");
    // Nothing from 2025, or from the other shop.
    const everything = nusr.flat().join("\n");
    assert.ok(!everything.includes("Lee Brandt"));
    assert.ok(!everything.includes("Ines Otherton"));
  });

  test("every year's months in the Comparison, whatever the period, and the shop's own only", async () => {
    const { comparison } = await download(manager, { year: "2026", month: "3" });
    assert.deepEqual(comparison[0], ["Month", "2025", "2025 to 2026", "2026"]);
    assert.deepEqual(comparison[2], ["February", "0", "1", "1"]);
    assert.deepEqual(comparison[3], ["March", "0", "1", "1"]);
    assert.deepEqual(comparison[10], ["October", "0", "1", "1"]);
    // November 2026 hasn't come yet.
    assert.deepEqual(comparison[11], ["November", "1"]);
    assert.deepEqual(comparison[13], ["Total", "1", "2", "3"]);
    const other = await download(elsewhere, { year: "all" });
    assert.deepEqual(other.comparison[0], ["Month", "2026"]);
    assert.deepEqual(other.comparison[13], ["Total", "1"]);
  });

  test("a month, filtered as the log is, with its Summary", async () => {
    const { title, nusr, summary } = await download(manager, { year: "2026", month: "3", condition: "new" });
    assert.equal(title, "March 2026 · New");
    assert.deepEqual(
      nusr.slice(1, 3).map((row) => row[3] ?? ""),
      ["Dana Quillfeather", ""],
    );
    assert.deepEqual(summary[0], ["NUSR March 2026 · New"]);
    const totals = summary.findIndex((row) => row[0] === "Totals");
    assert.deepEqual(summary[totals + 1].slice(0, 4), ["TOTAL", "1", "1", "0"]);
  });

  test("only managers and admins may download it, and not on a bay tablet's PIN", () => {
    // The route checks allows(user, "sales.log"). It can't be called from a
    // test: src/lib/session.ts needs next/navigation, which loads only inside
    // Next itself.
    assert.deepEqual(
      ROLES.filter((role) => allows({ role, bay: null }, "sales.log")),
      ["manager", "admin"],
    );
    assert.equal(allows({ ...manager, role: "service_writer" }, "sales.log"), false);
    const onTablet = { ...manager, bay: { deviceId: randomUUID(), deviceName: "Bay 1", sessionId: randomUUID() } };
    assert.equal(allows(onTablet, "sales.log"), false);
    assert.equal(allows({ ...onTablet, role: "admin" }, "sales.log"), false);
  });
});
