// NUSR, the unit sales log: reading what's typed (amounts, sums, rates,
// VINs), the figures worked out the way the shop's spreadsheet worked them
// out, totals, filters and the form's values
// (src/lib/nusr-rules.ts); and the log itself (src/lib/nusr.ts): logging,
// correcting and removing sales with the Activity log keeping each change,
// the customer and vehicle on file a sale fills in and adds to, filters and
// totals, a VIN read against the model list, a customer with sales kept, and
// nothing reaching another shop.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, customerVehicles, customers, shops, unitSales, users } from "../src/db/schema";
import { describeAuditEntry } from "../src/lib/audit-log-rules";
import { createCustomer, removeCustomer } from "../src/lib/customers";
import { finishCatalogImport, saveCatalogBatch } from "../src/lib/manual-catalog";
import {
  customerForSale,
  decodeSaleVin,
  getSale,
  listSales,
  logSale,
  markPaid,
  removeSale,
  saleSuggestions,
  salesForCustomer,
  searchSaleBuyers,
  splitAddress,
  unitsByMonth,
  updateSale,
  type SaleInput,
} from "../src/lib/nusr";
import {
  blankSaleValues,
  checkSale,
  earlierSale,
  filtersNarrowing,
  filtersSearch,
  filtersTitle,
  formatDay,
  formatMoney,
  formatPct,
  guessCategory,
  guessUnitType,
  logSearch,
  monthlyComparison,
  parseMoney,
  parseRate,
  parseSaleFilters,
  perUnit,
  readSaleValues,
  saleFigures,
  saleTotals,
  saleValues,
  shopToday,
  shopYear,
  totalsBy,
  withFigures,
  type SaleFields,
  type SaleValues,
} from "../src/lib/nusr-rules";
import { ADMIN_SECTIONS, allows, can, needsPasswordSession } from "../src/lib/permissions";
import { ROLES } from "../src/lib/roles";
import type { CurrentUser } from "../src/lib/session";

// A sale as the form sends it: everything typed, the rest blank.
function typed(values: Partial<SaleValues>): SaleValues {
  return { ...blankSaleValues({ soldOn: "2026-01-02", holdbackRateBp: 400, bonusRateBp: 1000 }), customerName: "Dana Pellerin", ...values };
}

const checked = (values: Partial<SaleValues>) => {
  const result = checkSale(typed(values));
  assert.ok("sale" in result, JSON.stringify(result));
  return result.sale;
};

describe("reading what's typed", () => {
  test("amounts: as typed or as a spreadsheet shows them, sums too, in cents", () => {
    assert.deepEqual(parseMoney("38500.25"), { cents: 3850025 });
    assert.deepEqual(parseMoney(" $38,500.25 "), { cents: 3850025 });
    assert.deepEqual(parseMoney("-96.25"), { cents: -9625 });
    assert.deepEqual(parseMoney("(96.25)"), { cents: -9625 });
    assert.deepEqual(parseMoney("1250.00+89.99+45.51+300"), { cents: 168550 });
    assert.deepEqual(parseMoney("=980.40-300"), { cents: 68040 });
    assert.deepEqual(parseMoney("278.486"), { cents: 27849 });
    assert.deepEqual(parseMoney(".5"), { cents: 50 });
    assert.deepEqual(parseMoney(""), { cents: null });
    assert.deepEqual(parseMoney("-"), { cents: null });
    for (const bad of ["abc", "5-", "1..2", "12,34", "1e5", "Trade", "N/A"]) assert.ok("error" in parseMoney(bad), bad);
    assert.ok("error" in parseMoney("99999999999"));
  });

  test("rates in percent, as basis points", () => {
    assert.deepEqual(parseRate("4"), { bp: 400 });
    assert.deepEqual(parseRate("4.5%"), { bp: 450 });
    assert.deepEqual(parseRate(""), { bp: null });
    assert.ok("error" in parseRate("4.567"));
    assert.ok("error" in parseRate("101"));
  });

  test("a sale is checked as the form sends it", () => {
    const sale = checked({ vin: " 3nsgzw999-tm100042 ", customerPhone: "304.555.0163", salesPrice: "38,500.25", holdbackRateBp: "", bonusRateBp: "" });
    assert.equal(sale.vin, "3NSGZW999TM100042");
    assert.equal(sale.customerPhone, "(304) 555-0163");
    assert.equal(sale.salesPrice, 3850025);
    // A blank holdback rate is none; a blank bonus rate the usual 10%.
    assert.deepEqual([sale.holdbackRateBp, sale.bonusRateBp], [0, 1000]);
    // A phone number that isn't one stays as typed.
    assert.equal(checked({ customerPhone: "call his wife" }).customerPhone, "call his wife");
    assert.deepEqual(checkSale(typed({ customerName: " " })), { error: "Enter the customer's name.", field: "customerName" });
    assert.deepEqual(checkSale(typed({ soldOn: "2026-02-30" })), { error: "Enter the date it was sold.", field: "soldOn" });
    assert.ok("error" in checkSale(typed({ vin: "3NSGZW99OTM100042" })), "an O in a whole VIN");
    assert.equal(checked({ vin: "5a4gflt" }).vin, "5A4GFLT");
    assert.ok("error" in checkSale(typed({ unitType: "lease" })));
    assert.deepEqual(checkSale(typed({ dealerCost: "lots" })), { error: "Dealer Cost isn't an amount.", field: "dealerCost" });
    assert.deepEqual(checkSale(typed({ paidOn: "N/A" })), { error: "Date Paid isn't a date.", field: "paidOn" });
    assert.deepEqual(checkSale(typed({ vin: "3NSGZW99OTM100042" })), { error: "A VIN never has I, O or Q in it (they'd pass for 1 and 0). Check those characters.", field: "vin" });
    assert.ok("error" in checkSale(typed({ unitYear: "26" })));
  });

  test("a sale shown in the form reads back the same", () => {
    const sale = checked({ msrp: "38999", salesPrice: "36750.30", accCost: "1250.00+89.99", rebate: "-100", fundingReceivedOn: "2026-01-02", notes: "Line one\nline two", unitYear: "2026" });
    assert.deepEqual(checked(saleValues(sale)), sale);
  });

  test("categories and the kind of deal from the model, as the shop writes it", () => {
    assert.equal(guessCategory("Rngr 570 NS"), "UTV");
    assert.equal(guessCategory("Rng 1000 XP NS - Stealth Gray"), "UTV");
    assert.equal(guessCategory("Xpedition ADV 5P NS"), "UTV");
    assert.equal(guessCategory("General XP 1000 Prem"), "UTV");
    assert.equal(guessCategory("Spmn 570 EPS X2"), "ATV");
    assert.equal(guessCategory("Sportsman 6x6 570"), "ATV");
    assert.equal(guessCategory("RZR 1000 XP"), "RZR");
    assert.equal(guessCategory("6.5 x 16 Trailer"), "Trailer");
    assert.equal(guessCategory("5x10 Trailer"), "Trailer");
    assert.equal(guessCategory("Wolverine RMAX2"), "UTV");
    assert.equal(guessCategory("Slingshot SL"), null);
    assert.equal(guessUnitType({ condition: "new", category: null, model: "Rngr 570" }), "whole_good");
    assert.equal(guessUnitType({ condition: "used", category: "UTV", model: "Rngr 570" }), "trade");
    assert.equal(guessUnitType({ condition: "new", category: "Trailer", model: null }), "trailer");
    assert.equal(guessUnitType({ condition: "new", category: null, model: "7x16 trailer" }), "trailer");
  });

  test("another sale of the VIN: a trade coming back, logged twice, or sold again since", () => {
    assert.equal(earlierSale(null, "2026-10-31"), null);
    assert.equal(earlierSale({ soldOn: "2025-03-01" }, "2026-10-31"), "trade");
    assert.equal(earlierSale({ soldOn: "2026-10-31" }, "2026-10-31"), "twice");
    assert.equal(earlierSale({ soldOn: "2026-05-01" }, "2025-03-01"), "again");
    assert.equal(earlierSale({ soldOn: "2026-05-01" }, ""), "twice");
  });
});

describe("the figures", () => {
  // A made-up sale through the spreadsheet's formulas: MSRP (K) 38,999,
  // Sales Price (L) 36,750.30, Dealer Cost (M) 35,410, Acc. Sales Price (S)
  // 3,200, Acc. Cost (T) 3,315.40, holdback 4%, bonus 10%. The sheet would
  // show Unit Profit 1,340.30, Acc. Profit -115.40, Holdback 1,559.96,
  // TOTAL PROFIT 2,784.86, PROFIT % 6.97%, TOTAL BONUS 278.49, Holdback
  // Bonus 156.00 and Sales Bonus 122.49 (278.486, 155.996 and 122.49
  // unrounded).
  test("as the spreadsheet's formulas worked them out", () => {
    const sale = checked({ msrp: "38999", salesPrice: "36750.30", dealerCost: "35410", accPrice: "3200", accCost: "3315.40", holdbackRateBp: "4", bonusRateBp: "10" });
    const figures = saleFigures(sale);
    assert.equal(figures.unitProfit, 134030);
    const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);
    near(figures.unitProfitPct, 1340.3 / 36750.3);
    assert.equal(figures.accProfit, -11540);
    near(figures.accProfitPct, -115.4 / 3200);
    assert.equal(figures.holdback, 155996);
    assert.equal(figures.totalProfit, 278486);
    assert.equal(figures.profitPct?.toFixed(4), "0.0697");
    assert.equal(figures.totalBonus, 27849);
    assert.equal(figures.holdbackBonus, 15600);
    assert.equal(figures.salesBonus, 12249);
    assert.equal(figures.gross, 3995030);
    assert.equal(figures.discount, 224870);
  });

  test("labor, rebate, ESC and rewards; no holdback without an MSRP; nothing to divide by", () => {
    const figures = saleFigures(
      checked({ salesPrice: "13250.40", dealerCost: "11500", unitLabor: "100", rebate: "1000", escPrice: "900", escCost: "450", rewards: "200", accLabor: "55", holdbackRateBp: "4" }),
    );
    assert.equal(figures.unitProfit, 265040);
    assert.equal(figures.accProfit, -5500);
    assert.equal(figures.accProfitPct, null);
    assert.equal(figures.escProfit, 45000);
    assert.equal(figures.holdback, 0);
    assert.equal(figures.totalProfit, 265040 - 5500 + 45000 + 20000);
    assert.equal(saleFigures(checked({})).profitPct, null);
  });

  test("a bonus adjustment comes off (or onto) the sales bonus; a loss makes a negative bonus", () => {
    const figures = saleFigures(checked({ salesPrice: "10000", dealerCost: "9000", bonusAdjustment: "-100" }));
    assert.deepEqual([figures.totalBonus, figures.holdbackBonus, figures.salesBonus], [10000, 0, 0]);
    const loss = saleFigures(checked({ salesPrice: "9970", dealerCost: "10000" }));
    assert.deepEqual([loss.totalProfit, loss.totalBonus], [-3000, -300]);
  });

  test("half a cent rounds away from zero, both ways", () => {
    assert.equal(saleFigures(checked({ salesPrice: "100.05", bonusRateBp: "10" })).totalBonus, 1001);
    assert.equal(saleFigures(checked({ dealerCost: "100.05", bonusRateBp: "10" })).totalBonus, -1001);
    // A unit's average too (two trades lost $0.51 and $0.50), as the
    // download's AVG TOTAL shows it.
    assert.deepEqual([perUnit(-101, 2), perUnit(101, 2), perUnit(5, 0)], [-51, 51, null]);
  });

  test("percentages as Excel shows them: the decimal rounded half away from zero", () => {
    // $698.50 on $10,000 is 6.985%, a hair under in binary.
    assert.equal(formatPct(saleFigures(checked({ salesPrice: "10000", dealerCost: "9301.50" })).unitProfitPct), "6.99%");
    assert.deepEqual([formatPct(-0.06985), formatPct(0.0697), formatPct(null)], ["-6.99%", "6.97%", "—"]);
  });

  test("totals and percentages of the totals, by salesman and month", () => {
    const sales = [
      withFigures(checked({ salesperson: "Sam Ortega", salesPrice: "1000", dealerCost: "900", soldOn: "2026-01-05" })),
      withFigures(checked({ salesperson: "SAM ORTEGA ", condition: "used", unitType: "trade", salesPrice: "500", dealerCost: "450", soldOn: "2026-02-05" })),
      withFigures(checked({ salesperson: "Lee Brandvold", salesPrice: "2000", dealerCost: "1700", accPrice: "100", accCost: "50", soldOn: "2026-02-07" })),
    ];
    const totals = saleTotals(sales);
    assert.deepEqual([totals.units, totals.newUnits, totals.usedUnits], [3, 2, 1]);
    assert.equal(totals.amounts.salesPrice, 350000);
    assert.equal(totals.figures.unitProfit, 45000);
    assert.equal(totals.figures.totalProfit, 50000);
    assert.equal(totals.unitProfitPct, 45000 / 350000);
    assert.equal(totals.profitPct, 50000 / 360000);
    // A salesman however his name's capitalised, under the spelling met first.
    const bySalesman = Object.fromEntries(totalsBy(sales, (sale) => sale.salesperson ?? "").map((row) => [row.key, row.totals.units]));
    assert.deepEqual(bySalesman, { "Sam Ortega": 2, "Lee Brandvold": 1 });
    const comparison = monthlyComparison([
      { year: 2025, month: 1, units: 14 },
      { year: 2026, month: 1, units: 26 },
      { year: 2026, month: 2, units: 26 },
    ]);
    assert.deepEqual(comparison.years, [2025, 2026]);
    assert.deepEqual(comparison.months[0].units, { 2025: 14, 2026: 26 });
    assert.deepEqual(comparison.months[1].units, { 2025: 0, 2026: 26 });
    assert.deepEqual(comparison.totals, { 2025: 14, 2026: 52 });
  });

  test("the form's figures as it's typed, and what doesn't read", () => {
    const { sale, problems } = readSaleValues(typed({ salesPrice: "100", dealerCost: "lots", holdbackRateBp: "" }));
    assert.equal(sale.salesPrice, 10000);
    assert.equal(sale.dealerCost, null);
    assert.equal(sale.holdbackRateBp, 0);
    assert.deepEqual(problems, { dealerCost: "Dealer Cost isn't an amount." });
  });
});

describe("the log's filters and dates", () => {
  test("from the address, and back", () => {
    const filters = parseSaleFilters({ year: "2025", month: "10", condition: "used", type: "trade", category: "UTV", salesperson: "Sam Ortega", status: "funding", q: " rngr  570 " }, 2026);
    assert.deepEqual(filters, { year: 2025, month: 10, condition: "used", unitType: "trade", category: "UTV", salesperson: "Sam Ortega", status: "funding", query: "rngr 570" });
    assert.equal(filtersSearch(filters, 2026), "?year=2025&month=10&condition=used&type=trade&category=UTV&salesperson=Sam+Ortega&status=funding&q=rngr+570");
    assert.equal(filtersTitle(filters), "October 2025 · Used · Trade · UTV · Sam Ortega · Awaiting funding · “rngr 570”");
    // This year unless another or every year is asked for; nothing odd gets in.
    const plain = parseSaleFilters({ year: "1999", month: "13", status: "sold", type: "lease" }, 2026);
    assert.deepEqual([plain.year, plain.month, plain.status, plain.unitType], [2026, null, null, null]);
    assert.equal(filtersSearch(plain, 2026), "");
    const every = parseSaleFilters({ year: "all", month: "3" }, 2026);
    assert.deepEqual([every.year, every.month], [null, null]);
    assert.equal(filtersSearch(every, 2026), "?year=all");
    assert.equal(filtersTitle(every), "All years");
  });

  test("the log opens on the shop's year, which on New Year's Eve evening is still the old one", () => {
    const evening = new Date("2027-01-01T01:30:00Z");
    assert.deepEqual([shopToday(evening), shopYear(evening)], ["2026-12-31", 2026]);
  });

  test("a back link brings back the log as it was, and nothing else", () => {
    assert.equal(logSearch("year=2025&q=pine&page=3&columns=all&evil=%3Cx%3E", 2026), "?year=2025&q=pine&columns=all&page=3");
    assert.equal(logSearch("?year=2026&page=1", 2026), "");
    assert.equal(logSearch(42, 2026), "");
    assert.equal(logSearch("page=0&columns=some", 2026), "");
  });

  test("filters are cut on a whole character, and say what narrows the log", () => {
    const cut = parseSaleFilters({ category: `${"a".repeat(29)}😀`, salesperson: "Sam Ortega", condition: "used" }, 2026);
    assert.equal(cut.category, "a".repeat(29));
    assert.equal(filtersNarrowing(cut), `Used · ${"a".repeat(29)} · Sam Ortega`);
    assert.equal(filtersNarrowing(parseSaleFilters({}, 2026)), "");
  });

  test("dates as the spreadsheet wrote them", () => {
    assert.equal(formatDay("2026-01-02"), "1/2/2026");
    assert.equal(formatDay(null), "");
  });

  test("an address split as far as its commas tell", () => {
    assert.deepEqual(splitAddress("77 Foxglove Rd, Elmwood, PA 15999"), { addressLine1: "77 Foxglove Rd", addressLine2: "", city: "Elmwood", state: "PA", postalCode: "15999" });
    assert.deepEqual(splitAddress("301 Birch Hill Rd, Stonebridge, PA"), { addressLine1: "301 Birch Hill Rd", addressLine2: "", city: "Stonebridge", state: "PA", postalCode: "" });
    assert.deepEqual(splitAddress("9 Thistledown Rd Wrenford"), { addressLine1: "9 Thistledown Rd Wrenford", addressLine2: "", city: "", state: "", postalCode: "" });
    assert.deepEqual(splitAddress("4410 Rt 99, Ashford"), { addressLine1: "4410 Rt 99", addressLine2: "", city: "Ashford", state: "", postalCode: "" });
  });

  test("it's its own tab, for managers and admins, signed in with a password", () => {
    assert.deepEqual(
      ROLES.filter((role) => can(role, "sales.log")),
      ["manager", "admin"],
    );
    assert.ok(needsPasswordSession("sales.log"));
    assert.equal(allows({ role: "manager", bay: { deviceId: "d", deviceName: "Bay 1", sessionId: "s" } }, "sales.log"), false);
    assert.ok(!ADMIN_SECTIONS.some((section) => section.capability === "sales.log"));
  });
});

describe("the log", () => {
  const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
  const shopIds: string[] = [];
  let manager: CurrentUser;
  let other: CurrentUser;

  async function createManager(code: string): Promise<CurrentUser> {
    const [shop] = await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name });
    shopIds.push(shop.id);
    const id = randomUUID();
    await systemDb.insert(users).values({ id, shopId: shop.id, role: "manager", name: "Morgan", username: `${code}.morgan`, displayUsername: "morgan", email: `${randomUUID()}@no-email.invalid` });
    return { id, name: "Morgan", username: "morgan", role: "manager", shop, bay: null };
  }

  const input = (values: Partial<SaleValues>, extra: Partial<SaleInput> = {}): SaleInput => ({ ...typed(values), ...extra });

  async function log(actor: CurrentUser, values: Partial<SaleValues>, extra: Partial<SaleInput> = {}) {
    const result = await logSale(actor, input(values, extra));
    assert.ok("id" in result, JSON.stringify(result));
    return result.id;
  }

  before(async () => {
    manager = await createManager(`nu${suffix}`);
    other = await createManager(`no${suffix}`);
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  test("a sale is logged with its figures, and the Activity log says so", async () => {
    const id = await log(manager, {
      soldOn: "2026-01-02",
      salesperson: "Lee Brandvold",
      customerName: "Ridgeback Drilling Co.",
      customerAddress: "9 Thistledown Rd, Wrenford, PA",
      customerPhone: "304-555-0163",
      unitYear: "2026",
      unitModel: "Xpedition ADV 5P NS",
      vin: "3NSGZW999TM100042",
      msrp: "38999",
      salesPrice: "36750.30",
      dealerCost: "35410",
      accPrice: "3200",
      accCost: "1250.00+89.99+45.51+300+1629.90",
      financeCompany: "Lakeside Credit",
      amountFinanced: "34000",
      comsNumber: "TST1001",
      category: "UTV",
    });
    const sale = await getSale(manager.shop.id, id);
    assert.ok(sale);
    assert.equal(sale.accCost, 331540);
    assert.equal(sale.figures.totalProfit, 278486);
    assert.equal(sale.createdBy, "Morgan");
    assert.equal(sale.customerId, null);
    const [entry] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.action, "unit_sale.logged")));
    assert.equal(entry.targetType, "unit_sale");
    assert.equal(describeAuditEntry(entry).summary, "Logged the sale of 2026 Xpedition ADV 5P NS to Ridgeback Drilling Co.");
    // The same unit can't be logged as sold twice on one day.
    const again = await logSale(manager, input({ soldOn: "2026-01-02", vin: "3NSGZW999TM100042" }));
    assert.deepEqual(again, { field: "vin", error: "The unit with VIN 3NSGZW999TM100042 is already in the NUSR as sold on 2026-01-02." });
  });

  test("a customer on file fills it in; a new buyer and the unit are added to Customers", async () => {
    const made = await createCustomer(manager, { name: "Casey Lindqvist", phone: "724-555-0118", email: "", addressLine1: "301 Birch Hill Rd", addressLine2: "", city: "Stonebridge", state: "PA", postalCode: "15998", notes: "" });
    assert.ok("id" in made);
    const details = await customerForSale(manager.shop.id, made.id);
    assert.deepEqual([details?.name, details?.phone, details?.address], ["Casey Lindqvist", "(724) 555-0118", "301 Birch Hill Rd, Stonebridge, PA 15998"]);
    const id = await log(manager, { soldOn: "2026-10-15", customerName: "Casey Lindqvist", unitModel: "Rngr 570 NS", unitYear: "2026", vin: "3NSMAU576TE100318" }, { customerId: made.id, addVehicle: "on" });
    assert.equal((await getSale(manager.shop.id, id))?.customerId, made.id);
    const [vehicle] = await systemDb.select().from(customerVehicles).where(eq(customerVehicles.customerId, made.id));
    assert.deepEqual([vehicle.relation, vehicle.relationDate, vehicle.vin, vehicle.model, vehicle.year], ["bought", "2026-10-15", "3NSMAU576TE100318", "Rngr 570 NS", 2026]);
    // Not twice.
    await log(manager, { soldOn: "2026-10-16", customerName: "Casey Lindqvist", vin: "3NSMAU576TE100318" }, { customerId: made.id, addVehicle: "on" });
    assert.equal((await systemDb.select().from(customerVehicles).where(eq(customerVehicles.customerId, made.id))).length, 1);
    assert.equal((await salesForCustomer(manager.shop.id, made.id)).length, 2);

    // Someone who isn't on file yet.
    const newId = await log(manager, { soldOn: "2026-10-20", customerName: "Maplewick Orchards", customerAddress: "62 Wrenfield Road, Cedar Falls, PA", customerPhone: "724-555-0187" }, { addCustomer: "on" });
    const sale = await getSale(manager.shop.id, newId);
    assert.ok(sale?.customerId);
    const [customer] = await systemDb.select().from(customers).where(eq(customers.id, sale.customerId));
    assert.deepEqual([customer.name, customer.phone, customer.addressLine1, customer.city, customer.state], ["Maplewick Orchards", "(724) 555-0187", "62 Wrenfield Road", "Cedar Falls", "PA"]);
    const [created] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, customer.id), eq(auditLog.action, "customer.created")));
    assert.equal(describeAuditEntry(created).summary, "Added the customer Maplewick Orchards from the NUSR");

    // A customer with sales logged stays on file.
    const removed = await removeCustomer(manager, made.id);
    assert.ok("error" in removed && /2 sales in the NUSR are for Casey Lindqvist/.test(removed.error), JSON.stringify(removed));
    // Someone who can't open the NUSR is told who can change them.
    const writer = await removeCustomer({ ...manager, role: "service_writer" }, made.id);
    assert.ok("error" in writer && /ask a manager or an admin to change the customer on those sales in the NUSR first/.test(writer.error), JSON.stringify(writer));
    // Another shop's customer can't be picked.
    const theirs = await createCustomer(other, { name: "Elsewhere", phone: "", email: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", notes: "" });
    assert.ok("id" in theirs);
    assert.deepEqual(await logSale(manager, input({}, { customerId: theirs.id })), { error: "That customer isn't in this shop." });
    assert.equal(await customerForSale(manager.shop.id, theirs.id), null);
  });

  test("a correction is logged with what changed, from what to what", async () => {
    const id = await log(manager, { soldOn: "2026-03-01", customerName: "Robin Achterberg", unitModel: "Rng 570 NS", vin: "3NSMAU578TE100577", salesPrice: "18450", dealerCost: "17620", customerPhone: "814-555-0129" });
    const before = await getSale(manager.shop.id, id);
    assert.ok(before);
    const values = saleValues(before);
    const result = await updateSale(manager, id, { ...values, salesPrice: "18200", customerPhone: "814-555-0130", paidOn: "2026-03-05", holdbackRateBp: "5" });
    assert.deepEqual(result, { ok: true });
    const after = await getSale(manager.shop.id, id);
    assert.equal(after?.salesPrice, 1820000);
    const [entry] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.action, "unit_sale.updated")));
    const details = entry.details as { fields: string[]; changes: Record<string, unknown> };
    assert.deepEqual(details.fields.sort(), ["customerPhone", "holdbackRateBp", "paidOn", "salesPrice"]);
    assert.deepEqual(details.changes.salesPrice, { from: "$18,450.00", to: "$18,200.00" });
    assert.deepEqual(details.changes.paidOn, { from: null, to: "2026-03-05" });
    // Contact details by name only.
    assert.equal(details.changes.customerPhone, undefined);
    const words = describeAuditEntry(entry);
    assert.equal(words.summary, "Corrected the sale of Rng 570 NS to Robin Achterberg");
    assert.ok(words.facts.some((fact) => fact.label === "Sales Price" && fact.value === "$18,450.00 → $18,200.00"));
    assert.ok(words.facts.some((fact) => fact.label === "Date Paid" && fact.value === "blank → 3/5/2026"));
    assert.ok(words.facts.some((fact) => fact.label === "Also changed" && fact.value === "phone"));
    // Saving it unchanged logs nothing.
    assert.deepEqual(await updateSale(manager, id, saleValues((await getSale(manager.shop.id, id))!)), { ok: true });
    assert.equal((await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.action, "unit_sale.updated")))).length, 1);
  });

  test("removed, with what it was kept", async () => {
    const id = await log(manager, { soldOn: "2026-03-02", customerName: "Removed Later", unitModel: "Spmn 570", salesPrice: "9000", dealerCost: "8000" });
    const result = await removeSale(manager, id);
    assert.deepEqual(result, { ok: true, label: "Spmn 570 to Removed Later", tradeIns: [] });
    assert.equal(await getSale(manager.shop.id, id), null);
    const [entry] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.action, "unit_sale.removed")));
    assert.equal((entry.details as { totalProfit: number }).totalProfit, 100000);
    assert.deepEqual(await removeSale(manager, id), { error: "That sale isn't in this shop's NUSR." });
  });

  test("filters, search, totals and what's still to do", async () => {
    const shop = await createManager(`nf${suffix}`);
    await log(shop, { soldOn: "2025-12-30", salesperson: "Sam Ortega", customerName: "Jamie Okafor", unitModel: "Rngr 1000 XP", vin: "4XARRU997T8000256", salesPrice: "27450", dealerCost: "26480", category: "UTV", paidOn: "2025-12-31" });
    await log(shop, { soldOn: "2026-10-14", salesperson: "sam ortega", customerName: "Terry Voss", customerPhone: "724-555-0142", unitModel: "Spmn 570 Premium", condition: "used", unitType: "trade", salesPrice: "8500", dealerCost: "7700", category: "ATV" });
    await log(shop, { soldOn: "2026-10-28", salesperson: "Lee Brandvold", customerName: "Avery Quinlan", unitModel: "RZR 1000 XP", msrp: "21999", salesPrice: "18900", dealerCost: "20650", rebate: "2400", financeCompany: "Lakeside Credit", amountFinanced: "18875.40", category: "RZR" });
    const at = (filters: Partial<Parameters<typeof listSales>[1]>) =>
      listSales(shop.shop.id, { year: 2026, month: null, condition: null, unitType: null, category: null, salesperson: null, status: null, query: "", ...filters });
    assert.equal((await at({})).total, 2);
    assert.equal((await at({ year: null })).total, 3);
    assert.equal((await at({ month: 10, condition: "used" })).total, 1);
    assert.equal((await at({ unitType: "trade" })).total, 1);
    assert.equal((await at({ category: "rzr" })).total, 1);
    // A salesman however his name's written.
    assert.equal((await at({ year: null, salesperson: "Sam Ortega" })).total, 2);
    assert.equal((await at({ status: "funding" })).items[0].customerName, "Avery Quinlan");
    assert.deepEqual((await at({ year: null, status: "unpaid" })).items.map((sale) => sale.customerName), ["Avery Quinlan"]);
    assert.equal((await at({ query: "7245550142" })).items[0].customerName, "Terry Voss");
    assert.equal((await at({ query: "voss premium" })).total, 1);
    const all = await at({ year: null });
    assert.deepEqual(all.items.map((sale) => sale.soldOn), ["2026-10-28", "2026-10-14", "2025-12-30"]);
    assert.equal(all.totals.units, 3);
    assert.equal(all.totals.figures.unitProfit, 97000 + 80000 + 65000);
    const comparison = await unitsByMonth(shop.shop.id);
    assert.deepEqual(comparison.years, [2025, 2026]);
    assert.equal(comparison.months[9].units[2026], 2);
    const suggestions = await saleSuggestions(shop.shop.id);
    assert.equal(suggestions.salespeople[0], "Lee Brandvold");
    assert.deepEqual(suggestions.financeCompanies, ["Lakeside Credit"]);
    assert.equal(suggestions.latest?.holdbackRateBp, 400);
    // Another shop sees none of it.
    assert.equal((await listSales(other.shop.id, { year: null, month: null, condition: null, unitType: null, category: null, salesperson: null, status: null, query: "" })).items.some((sale) => sale.customerName === "Terry Voss"), false);
  });

  test("a VIN is read against the model list, and the units on file", async () => {
    const importId = randomUUID();
    const saved = await saveCatalogBatch(manager, {
      importId,
      files: [
        { fileName: "9941234.pdf", brand: "RGR", article: null, title: "2026 Ranger 570 Owner's Manual", postedOn: null, modelYears: null, models: [[2026, "R26MAU57A1", "RANGER 570 NORTHSTAR - SAGE GREEN"], [2026, "R26MAU57B1", "RANGER 570 NORTHSTAR - NAVY BLUE"]] },
      ],
    });
    assert.ok("saved" in saved, JSON.stringify(saved));
    await finishCatalogImport(manager, { importId, fileName: "manual-list - All.csv", leftOut: 0, rowsWithoutFile: 0 });
    const decoded = await decodeSaleVin(manager.shop.id, "3NSMAU578TE100577");
    assert.ok(decoded);
    assert.deepEqual([decoded.year, decoded.model, decoded.modelNumber, decoded.category], [2026, "RANGER 570 NORTHSTAR", null, "UTV"]);
    // A trailer's VIN: the year only.
    const trailer = await decodeSaleVin(manager.shop.id, "5A4GJLT24S2000913");
    assert.deepEqual([trailer?.year, trailer?.model], [2025, null]);
    // The unit on a customer's record (Casey Lindqvist bought it above).
    assert.equal((await decodeSaleVin(manager.shop.id, "3NSMAU576TE100318"))?.onFile?.customerName, "Casey Lindqvist");
    assert.equal(await decodeSaleVin(manager.shop.id, "not a vin"), null);
  });

  test("a VIN brings in this unit's earlier sale, and the last of its model and year with its prices", async () => {
    const shop = await createManager(`nv${suffix}`);
    const first = await log(shop, {
      soldOn: "2026-10-01",
      customerName: "Harper Quill",
      unitYear: "2026",
      unitModel: "Rngr 570 NS",
      vin: "3NSMAU576TE300101",
      category: "UTV",
      msrp: "18999",
      salesPrice: "18200",
      dealerCost: "17650",
      rebate: "500",
    });
    // Another unit of the same model and year (characters 4-8 and 10).
    const other = await decodeSaleVin(shop.shop.id, "3NSMAU571TE300202");
    assert.equal(other?.sold, null);
    assert.deepEqual(other?.sameModel, { soldOn: "2026-10-01", model: "Rngr 570 NS", category: "UTV", msrp: 1899900, dealerCost: 1765000, rebate: 50000 });
    // A year earlier is another model year.
    assert.equal((await decodeSaleVin(shop.shop.id, "3NSMAU579SE300303"))?.sameModel, null);
    // The unit itself: in the NUSR already (back as a trade, or logged twice),
    // but not when it's the sale being corrected.
    const again = await decodeSaleVin(shop.shop.id, "3NSMAU576TE300101");
    assert.deepEqual(again?.sold, { id: first, soldOn: "2026-10-01", condition: "new", unitType: "whole_good", year: 2026, model: "Rngr 570 NS", category: "UTV", customerName: "Harper Quill" });
    assert.equal(again?.sameModel, null);
    assert.equal((await decodeSaleVin(shop.shop.id, "3NSMAU576TE300101", first))?.sold, null);
    // Sold again, used, the next spring: correcting the first sale, the
    // other is a resale, not a second entry.
    const resale = await log(shop, { soldOn: "2027-05-01", customerName: "Second Owner", condition: "used", unitType: "trade", vin: "3NSMAU576TE300101" });
    const fromFirst = await decodeSaleVin(shop.shop.id, "3NSMAU576TE300101", first);
    assert.equal(fromFirst?.sold?.id, resale);
    assert.equal(earlierSale(fromFirst?.sold ?? null, "2026-10-01"), "again");
    assert.equal(earlierSale((await decodeSaleVin(shop.shop.id, "3NSMAU576TE300101", resale))?.sold ?? null, "2027-05-01"), "trade");
  });

  test("the customer box finds past buyers who aren't on file, and a customer on file once", async () => {
    const shop = await createManager(`nb${suffix}`);
    await log(shop, { soldOn: "2026-10-02", customerName: "Rowan Ellery", customerPhone: "724-555-0191", customerAddress: "12 Foxglove Rd, Elmwood, PA" });
    await log(shop, { soldOn: "2025-06-02", customerName: "Rowan Ellery", customerPhone: "724-555-0191", customerAddress: "an older address" });
    const found = await searchSaleBuyers(shop.shop.id, "rowan");
    assert.deepEqual(found, [
      { kind: "buyer", id: "buyer:rowan ellery|(724) 555-0191", name: "Rowan Ellery", phone: "(724) 555-0191", address: "12 Foxglove Rd, Elmwood, PA", detail: "Bought 10/2/2026 · (724) 555-0191" },
    ]);
    assert.equal((await searchSaleBuyers(shop.shop.id, "5550191")).length, 1);
    // On file with the same name and phone: they're that customer.
    const made = await createCustomer(shop, { name: "Rowan Ellery", phone: "(724) 555-0191", email: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", notes: "" });
    assert.ok("id" in made);
    assert.deepEqual(
      (await searchSaleBuyers(shop.shop.id, "rowan")).map((choice) => [choice.kind, choice.id]),
      [["customer", made.id]],
    );
    // Another shop's buyers are never offered.
    assert.deepEqual(await searchSaleBuyers(other.shop.id, "rowan"), []);
  });

  test("the COMS #s offered are the ones entered last; the year-by-year counts follow the filters", async () => {
    const shop = await createManager(`nc${suffix}`);
    await log(shop, { soldOn: "2026-09-01", customerName: "Paid First", paidOn: "2026-09-20", comsNumber: "TST2001" });
    await log(shop, { soldOn: "2026-08-01", customerName: "Paid Last", paidOn: "2026-10-05", comsNumber: "TST2002" });
    await log(shop, { soldOn: "2026-10-20", customerName: "Not Paid Yet", condition: "used", unitType: "trade" });
    assert.deepEqual((await saleSuggestions(shop.shop.id)).comsNumbers, ["TST2002", "TST2001"]);
    const filters = { year: 2026, month: 10, condition: "used" as const, unitType: null, category: null, salesperson: null, status: null, query: "" };
    const used = await unitsByMonth(shop.shop.id, filters);
    assert.deepEqual([used.totals[2026], used.months[9].units[2026]], [1, 1]);
    assert.equal((await unitsByMonth(shop.shop.id)).totals[2026], 3);
  });

  test("units paid off together: one Date Paid and COMS #, new unpaid units of this shop only, each in the Activity log", async () => {
    const shop = await createManager(`np${suffix}`);
    const first = await log(shop, { soldOn: "2026-10-01", customerName: "Unit One" });
    const second = await log(shop, { soldOn: "2026-10-03", customerName: "Unit Two", comsNumber: "TST0999" });
    const used = await log(shop, { soldOn: "2026-10-04", customerName: "A Trade", condition: "used", unitType: "trade" });
    const paid = await log(shop, { soldOn: "2026-10-05", customerName: "Paid Already", paidOn: "2026-10-06", comsNumber: "TST1000" });
    const theirs = await log(other, { soldOn: "2026-10-06", customerName: "Kept Elsewhere" });
    const result = await markPaid(shop, { ids: [first, second, used, paid, theirs, "not an id", first], paidOn: "2026-10-30", comsNumber: " TST3001 " });
    assert.deepEqual(result, { marked: 2, skipped: 3 });
    const after = await Promise.all([first, second, used, paid].map((id) => getSale(shop.shop.id, id)));
    assert.deepEqual(
      after.map((sale) => [sale?.paidOn, sale?.comsNumber]),
      [
        ["2026-10-30", "TST3001"],
        ["2026-10-30", "TST3001"],
        [null, null],
        ["2026-10-06", "TST1000"],
      ],
    );
    assert.equal((await getSale(other.shop.id, theirs))?.paidOn, null);
    const [entry] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, second), eq(auditLog.action, "unit_sale.updated")));
    const details = entry.details as { fields: string[]; changes: Record<string, unknown> };
    assert.deepEqual(details.fields.sort(), ["comsNumber", "paidOn"]);
    assert.deepEqual(details.changes.paidOn, { from: null, to: "2026-10-30" });
    assert.deepEqual(details.changes.comsNumber, { from: "TST0999", to: "TST3001" });
    // No COMS # given: the one a unit has stays.
    const third = await log(shop, { soldOn: "2026-10-07", customerName: "Unit Three", comsNumber: "TST0777" });
    assert.deepEqual(await markPaid(shop, { ids: [third], paidOn: "2026-10-31", comsNumber: "" }), { marked: 1, skipped: 0 });
    assert.equal((await getSale(shop.shop.id, third))?.comsNumber, "TST0777");
    assert.deepEqual(await markPaid(shop, { ids: [], paidOn: "2026-10-31", comsNumber: "" }), { error: "Tick the units the payment paid off." });
    assert.deepEqual(await markPaid(shop, { ids: [first], paidOn: "10/31/2026", comsNumber: "" }), { error: "Enter the date they were paid off.", field: "paidOn" });
    // A COMS # pasted with a NUL in it is cleaned as the sale form cleans it.
    const fourth = await log(shop, { soldOn: "2026-10-08", customerName: "Unit Four" });
    assert.deepEqual(await markPaid(shop, { ids: [fourth], paidOn: "2026-10-31", comsNumber: "TST\u00003002" }), { marked: 1, skipped: 0 });
    assert.equal((await getSale(shop.shop.id, fourth))?.comsNumber, "TST3002");
  });

  test("app_user can't move a sale to another shop, or change who logged it", async () => {
    const id = await log(manager, { soldOn: "2026-04-01", customerName: "Kept Here" });
    for (const statement of [
      sql`update unit_sales set shop_id = ${other.shop.id} where id = ${id}`,
      sql`update unit_sales set created_by_user_id = null where id = ${id}`,
      sql`update unit_sales set import_ref = 'x' where id = ${id}`,
    ]) {
      await assert.rejects(
        withShop(manager.shop.id, (tx) => tx.execute(statement)),
        (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501",
      );
    }
    // Another shop can't see, change or remove it.
    assert.equal(await getSale(other.shop.id, id), null);
    assert.ok("error" in (await updateSale(other, id, typed({}))));
    assert.ok("error" in (await removeSale(other, id)));
    const gone = await withShop(other.shop.id, (tx) => tx.delete(unitSales).where(eq(unitSales.id, id)).returning());
    assert.equal(gone.length, 0);
    assert.ok(await getSale(manager.shop.id, id));
  });

  test("the values a sale shows are its own", async () => {
    const id = await log(manager, { soldOn: "2026-05-01", customerName: "Round Trip", msrp: "100", salesPrice: "90", holdbackRateBp: "4.5", bonusRateBp: "12", bonusAdjustment: "-25", fundingReceivedOn: "2026-05-03" });
    const sale = await getSale(manager.shop.id, id);
    assert.ok(sale);
    const fields: SaleFields = sale;
    assert.deepEqual(checkSale(saleValues(fields)), { sale: Object.fromEntries(Object.keys(saleValues(fields)).map((key) => [key, fields[key as keyof SaleFields]])) });
    // Holdback 4.50, total profit 94.50; bonuses 11.34 and 0.54 at 12%.
    assert.equal(formatMoney(sale.figures.salesBonus), "-$14.20");
  });
});
