// The LOC tab: the rules for a unit (stock #s kept as text, zeros and all,
// six digits or seven; the stock # a VIN gives; the model year in front of
// the model), where a free floor stands, the list's filters and totals, and
// what the NUSR says of a unit (src/lib/loc-rules.ts); reading the shop's
// LOC sheet, its WE OWN and "we owe on LOC" sections, its totals left out,
// a stock # Excel dropped a zero from and a free floor a year off
// (src/lib/loc-import-rules.ts); the workbook the tab downloads, read back
// in (src/lib/loc-export.ts); and the LOC itself (src/lib/loc.ts): adding,
// correcting, paying off, selling and removing units with the Activity log
// keeping each, importing (again, it adds nothing), the NUSR's sales beside
// the units, a trade-in logged with a NUSR sale going on the LOC without
// changing the sale's figures or anyone's bonus, and nothing reaching
// another shop.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { and, eq } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, customerVehicles, locUnits, shops, unitSales, users } from "../src/db/schema";
import { describeAuditEntry, areaOf } from "../src/lib/audit-log-rules";
import { createCustomer } from "../src/lib/customers";
import {
  addLocUnit,
  getLocUnit,
  importLocUnits,
  listLocUnits,
  locUnitForVin,
  markLocUnits,
  removeLocUnit,
  tradeInsForSale,
  updateLocUnit,
} from "../src/lib/loc";
import { locWorkbook } from "../src/lib/loc-export";
import { findLocHeader, locColumns, parseLocDate, planLocImport, type LocImportRow } from "../src/lib/loc-import-rules";
import {
  checkLocUnit,
  checkTradeIn,
  cleanStockNumber,
  daysInStock,
  floorDateLooksOff,
  floorStatus,
  floorStatusText,
  locBack,
  locFiltersSearch,
  locFiltersTitle,
  locTotals,
  locValues,
  nusrNews,
  nusrSaleFor,
  parseLocFilters,
  splitModelYear,
  stockFromVin,
  type LocFilters,
  type LocUnitFields,
  type NusrSaleSeen,
} from "../src/lib/loc-rules";
import { getSale, listSales, logSale, removeSale, updateSale, type SaleInput } from "../src/lib/nusr";
import { blankSaleValues, saleValues, type SaleValues } from "../src/lib/nusr-rules";
import { allows, can } from "../src/lib/permissions";
import { bonusSales } from "../src/lib/reports";
import type { CurrentUser } from "../src/lib/session";
import { writeXlsx } from "../src/lib/xlsx-write";
import { readXlsx } from "../src/lib/xlsx";

const TODAY = "2026-11-09";

// A unit as the form sends it.
const unitValues = (values: Record<string, string> = {}) => ({
  model: "RZR 900 50\" - Zenith Blue",
  unitYear: "2026",
  stockNumber: "168072",
  cost: "16164",
  freeFloorEnds: "2026-01-07",
  receivedOn: "",
  section: "loc",
  condition: "new",
  ...values,
});

const unitOf = (values: Record<string, string> = {}): LocUnitFields => {
  const checked = checkLocUnit(unitValues(values));
  assert.ok("unit" in checked, JSON.stringify(checked));
  return checked.unit;
};

describe("the rules for a unit", () => {
  test("a stock # is kept as text: its zero, six digits or seven, whatever's in front dropped", () => {
    assert.deepEqual(cleanStockNumber("099837"), { stockNumber: "099837" });
    assert.deepEqual(cleanStockNumber(" STK# 8071708 "), { stockNumber: "8071708" });
    assert.deepEqual(cleanStockNumber("#t1234"), { stockNumber: "T1234" });
    assert.deepEqual(cleanStockNumber("Stock # 000174"), { stockNumber: "000174" });
    assert.deepEqual(cleanStockNumber(98065), { stockNumber: "98065" });
    assert.deepEqual(cleanStockNumber("  "), { stockNumber: null });
    assert.ok("error" in cleanStockNumber("12*34"));
    assert.ok("error" in cleanStockNumber("x".repeat(21)));
  });

  test("a whole VIN gives the stock #: its last digits, six after a plant letter, seven after a plant digit", () => {
    assert.equal(stockFromVin("3NSXAW1R9TM204033"), "204033");
    assert.equal(stockFromVin("4XARRU997T8000256"), "8000256");
    assert.equal(stockFromVin("4XASEE575TM099837"), "099837");
    assert.equal(stockFromVin("5A4GFLT"), null);
    assert.equal(stockFromVin(null), null);
  });

  test("the sheet's model has the year in front", () => {
    assert.deepEqual(splitModelYear('2026 RZR 900 50" - Zenith Blue'), { unitYear: 2026, model: 'RZR 900 50" - Zenith Blue' });
    assert.deepEqual(splitModelYear(" 2027  Rngr 500 - Stealth Gray "), { unitYear: 2027, model: "Rngr 500 - Stealth Gray" });
    assert.deepEqual(splitModelYear("Rngr 500"), { unitYear: null, model: "Rngr 500" });
    assert.deepEqual(splitModelYear("1200 Hours special"), { unitYear: null, model: "1200 Hours special" });
  });

  test("a unit is checked as the form sends it", () => {
    const unit = unitOf({ cost: "31,861", stockNumber: "099837", notes: " line one\r\nline two " });
    assert.deepEqual(unit, {
      stockNumber: "099837",
      vin: null,
      unitYear: 2026,
      model: 'RZR 900 50" - Zenith Blue',
      category: null,
      condition: "new",
      cost: 3186100,
      freeFloorEnds: "2026-01-07",
      receivedOn: null,
      onLoc: true,
      paidOffOn: null,
      soldOn: null,
      notes: "line one\nline two",
    });
    assert.equal(unitOf({ cost: "16000+164" }).cost, 1616400);
    assert.deepEqual(checkLocUnit(unitValues({ model: " " })), { error: "Enter the model.", field: "model" });
    assert.deepEqual(checkLocUnit(unitValues({ cost: "" })), { error: "Enter what it cost.", field: "cost" });
    assert.deepEqual(checkLocUnit(unitValues({ cost: "-5" })), { error: "A cost can't be below nothing.", field: "cost" });
    assert.deepEqual(checkLocUnit(unitValues({ cost: "lots" })), { error: "The cost isn't an amount.", field: "cost" });
    assert.deepEqual(checkLocUnit(unitValues({ freeFloorEnds: "2026-02-30" })), { error: "Free Floor Ends isn't a date.", field: "freeFloorEnds" });
    assert.deepEqual(checkLocUnit(unitValues({ unitYear: "26" })), { error: "The year is a model year, 1950 to 2100.", field: "unitYear" });
    assert.deepEqual(checkLocUnit(unitValues({ receivedOn: "2026-05-01", soldOn: "2026-04-01" })), { error: "It can't have been sold before it came in.", field: "soldOn" });
    assert.deepEqual(checkLocUnit(unitValues({ section: "elsewhere" })), { error: "Say whether it's on the LOC or ours.", field: "section" });
    // Ours, it can carry the day it was paid off; on the LOC, it can't.
    assert.equal(unitOf({ section: "owned", paidOffOn: "2026-06-01" }).paidOffOn, "2026-06-01");
    assert.equal(unitOf({ section: "loc", paidOffOn: "2026-06-01" }).paidOffOn, null);
    // A whole VIN is checked; a serial is fine.
    assert.ok("error" in checkLocUnit(unitValues({ vin: "3NSXAW1R9TO204033" })));
    assert.equal(unitOf({ vin: "5a4 gflt" }).vin, "5A4GFLT");
  });

  test("a unit shown in the form reads back the same", () => {
    const unit = unitOf({ section: "owned", paidOffOn: "2026-06-01", receivedOn: "2026-01-02", soldOn: "2026-07-01", vin: "4XASEE575TM099837", category: "ATV", condition: "used", notes: "Scratch on the left fender" });
    assert.deepEqual(unitOf(locValues(unit)), unit);
  });

  test("a trade-in: all blank is none; one needs a model and a value; its stock # comes from its VIN", () => {
    assert.deepEqual(checkTradeIn(undefined), { tradeIn: null });
    assert.deepEqual(checkTradeIn({ tradeVin: " ", tradeModel: "", tradeValue: "" }), { tradeIn: null });
    assert.deepEqual(checkTradeIn({ tradeVin: "4xasee575tm099837", tradeYear: "2019", tradeModel: "Sportsman 570", tradeValue: "4,500" }), {
      tradeIn: { vin: "4XASEE575TM099837", unitYear: 2019, model: "Sportsman 570", stockNumber: "099837", cost: 450000 },
    });
    assert.deepEqual(checkTradeIn({ tradeModel: "Sportsman 570", tradeValue: "4500", tradeStockNumber: "t-1001" }), {
      tradeIn: { vin: null, unitYear: null, model: "Sportsman 570", stockNumber: "T-1001", cost: 450000 },
    });
    assert.deepEqual(checkTradeIn({ tradeVin: "4XASEE575TM099837", tradeValue: "4500" }), { error: "Enter the trade-in's model.", field: "tradeModel" });
    assert.deepEqual(checkTradeIn({ tradeModel: "Sportsman 570" }), { error: "Enter the trade-in's value: what it goes on the LOC at.", field: "tradeValue" });
    assert.deepEqual(checkTradeIn({ tradeModel: "Sportsman 570", tradeValue: "a lot" }), { error: "Trade-in: The cost isn't an amount.", field: "tradeValue" });
    assert.deepEqual(checkTradeIn({ tradeModel: "Sportsman 570", tradeValue: "4500", tradeYear: "19" }), { error: "Trade-in: The year is a model year, 1950 to 2100.", field: "tradeYear" });
    assert.equal((checkTradeIn({ tradeVin: "4XASEE57OTM099837", tradeModel: "Sportsman", tradeValue: "1" }) as { field: string }).field, "tradeVin");
  });
});

describe("free floor, the filters and the totals", () => {
  test("where a free floor stands: ended from the day after its last day, soon within 30 days", () => {
    assert.deepEqual(floorStatus("2026-11-08", TODAY), { state: "ended", days: 1 });
    assert.deepEqual(floorStatus("2026-11-09", TODAY), { state: "soon", days: 0 });
    assert.deepEqual(floorStatus("2026-12-09", TODAY), { state: "soon", days: 30 });
    assert.deepEqual(floorStatus("2026-12-10", TODAY), { state: "free", days: 31 });
    assert.deepEqual(floorStatus(null, TODAY), { state: "none", days: null });
    assert.equal(floorStatusText(floorStatus("2026-01-07", TODAY)), "Ended 306 days ago");
    assert.equal(floorStatusText(floorStatus("2026-11-09", TODAY)), "Ends today");
    assert.equal(floorStatusText(floorStatus("2026-11-10", TODAY)), "1 day left");
    assert.equal(floorStatusText(floorStatus(null, TODAY)), "");
    // A 2027 whose free floor ends in 2024: a slip in the year.
    assert.equal(floorDateLooksOff(2027, "2024-01-20"), true);
    assert.equal(floorDateLooksOff(2027, "2026-06-01"), false);
    assert.equal(floorDateLooksOff(null, "2024-01-20"), false);
  });

  test("days in stock: from the day it came in to the day it sold, or today", () => {
    assert.equal(daysInStock({ receivedOn: "2026-10-01", soldOn: null }, TODAY), 39);
    assert.equal(daysInStock({ receivedOn: "2026-10-01", soldOn: "2026-10-11" }, TODAY), 10);
    assert.equal(daysInStock({ receivedOn: null, soldOn: null }, TODAY), null);
  });

  test("the filters live in the address, and only what they can be gets through", () => {
    const filters = parseLocFilters({ show: "loc", floor: "ended", condition: "used", category: "UTV", year: "2027", q: "  rngr   blue " });
    assert.deepEqual(filters, { show: "loc", floor: "ended", condition: "used", category: "UTV", year: 2027, query: "rngr blue" });
    assert.equal(locFiltersSearch(filters), "?show=loc&floor=ended&condition=used&category=UTV&year=2027&q=rngr+blue");
    assert.deepEqual(parseLocFilters(Object.fromEntries(new URLSearchParams(locFiltersSearch(filters)))), filters);
    assert.deepEqual(parseLocFilters({ show: "everything", floor: "later", year: "27", condition: "x" }), { show: null, floor: null, condition: null, category: null, year: null, query: "" });
    assert.equal(locFiltersTitle(filters), "On the LOC · Free floor ended · Used · UTV · 2027 models · “rngr blue”");
    assert.equal(locFiltersTitle(parseLocFilters({})), "On the list");
    assert.equal(locBack("show=sold&evil=1&page=2"), "?show=sold");
    assert.equal(locBack(42), "");
  });

  test("the totals: what's on the LOC, what we own and both; free floors run out and running out; sold units still owed", () => {
    const units = [
      { ...unitOf({ section: "owned", cost: "100", freeFloorEnds: "2026-01-07" }), nusr: null },
      { ...unitOf({ section: "owned", cost: "200", freeFloorEnds: "2027-01-13" }), nusr: null },
      { ...unitOf({ section: "loc", cost: "1000", freeFloorEnds: "2026-11-27" }), nusr: null },
      { ...unitOf({ section: "loc", cost: "2000", freeFloorEnds: "2026-11-01" }), nusr: null },
      // Sold, still owed: in the LOC's total and past its free floor.
      { ...unitOf({ section: "loc", cost: "4000", freeFloorEnds: "2026-10-01", soldOn: "2026-11-02" }), nusr: null },
      // Sold and ours: off our hands, its free floor nothing to us.
      { ...unitOf({ section: "owned", cost: "8000", freeFloorEnds: "2026-10-01", soldOn: "2026-11-02" }), nusr: null },
    ];
    const totals = locTotals(units, TODAY);
    assert.deepEqual(totals.loc, { units: 3, cost: 700000 });
    assert.deepEqual(totals.owned, { units: 3, cost: 830000 });
    assert.deepEqual(totals.all, { units: 6, cost: 1530000 });
    assert.deepEqual(totals.ended, { units: 3, cost: 610000, loc: 2, owned: 1 });
    assert.deepEqual(totals.soon, { units: 1, cost: 100000 });
    assert.deepEqual(totals.soldOnLoc, { units: 1, cost: 400000 });
    assert.equal(totals.nusr, 0);
  });
});

describe("what the NUSR says of a unit", () => {
  const sale = (values: Partial<NusrSaleSeen>): NusrSaleSeen => ({
    id: randomUUID(),
    vin: "4XASEE575TM099837",
    soldOn: "2026-11-02",
    customerName: "Dana Whitfield",
    condition: "new",
    unitYear: 2026,
    paidOn: null,
    comsNumber: null,
    ...values,
  });
  const unit = (values: Partial<LocUnitFields> & { tradeSaleId?: string | null } = {}) => ({ ...unitOf({ stockNumber: "099837" }), tradeSaleId: null, ...values });

  test("by its VIN, or by its stock # at the end of a sale's VIN, the same year and new or used", () => {
    const sold = sale({});
    assert.equal(nusrSaleFor(unit(), [sold])?.id, sold.id);
    assert.equal(nusrSaleFor(unit({ vin: "4XASEE575TM099837", stockNumber: null }), [sold])?.id, sold.id);
    // A whole VIN of its own isn't another unit's.
    assert.equal(nusrSaleFor(unit({ vin: "4XASEE577TM099838" }), [sold]), null);
    // Seven digits, and five when Excel dropped the zero.
    const ranger = sale({ vin: "4XARRU997T8071708", unitYear: 2027 });
    assert.equal(nusrSaleFor(unit({ stockNumber: "8071708", unitYear: 2027 }), [ranger])?.id, ranger.id);
    assert.equal(nusrSaleFor(unit({ stockNumber: "98065" }), [sale({ vin: "4XASEE575TM098065" })])?.vin, "4XASEE575TM098065");
    // Not another model year's, not sold used for a new one, not four digits.
    assert.equal(nusrSaleFor(unit(), [sale({ unitYear: 2019 })]), null);
    assert.equal(nusrSaleFor(unit(), [sale({ condition: "used" })]), null);
    assert.equal(nusrSaleFor(unit({ stockNumber: "9837" }), [sold]), null);
  });

  test("on or after it came in: a trade-in doesn't find its own sale new, years ago, or the sale it came in on", () => {
    const soldNew = sale({ soldOn: "2019-06-01", unitYear: 2019 });
    const tradeIn = unit({ condition: "used", unitYear: 2019, vin: "4XASEE575TM099837", receivedOn: "2026-11-01" });
    assert.equal(nusrSaleFor(tradeIn, [soldNew, sale({ soldOn: "2019-06-01", condition: "used", unitYear: 2019 })]), null);
    const soldAgain = sale({ soldOn: "2026-12-01", condition: "used", unitYear: 2019 });
    assert.equal(nusrSaleFor(tradeIn, [soldNew, soldAgain])?.id, soldAgain.id);
    assert.equal(nusrSaleFor({ ...tradeIn, tradeSaleId: soldAgain.id }, [soldAgain]), null);
  });

  test("what's news: sold, or (sold and still owed) paid off", () => {
    const sold = sale({ paidOn: "2026-11-05", comsNumber: "4410" });
    assert.deepEqual(nusrNews({ soldOn: null, onLoc: true }, sold), { kind: "sold", sale: sold });
    assert.deepEqual(nusrNews({ soldOn: "2026-11-02", onLoc: true }, sold), { kind: "paid", sale: sold });
    assert.equal(nusrNews({ soldOn: "2026-11-02", onLoc: false }, sold), null);
    assert.equal(nusrNews({ soldOn: null, onLoc: true }, null), null);
  });
});

// The shop's LOC sheet as it's kept (made-up units, the sheet's layout):
// the headings, WE OWN on a row of its own, the units we own, its total
// (which stops short), "here down we owe on LOC" beside the first unit on
// the LOC, the units on it, and the lines about the totals.
const SHEET: string[][] = [
  ["Model", " Stock #", "Free Floor Ends", "Cost"],
  [],
  ["WE OWN"],
  [],
  [],
  ['2026 RZR 900 50" - Zenith Blue', "168072", "2026-01-07", "16164", "", "1", "not sold & accruing interest"],
  ["2026 Spm 570 Ult - Turbo Silver", "98065", "2026-07-01", "11544", "", "1"],
  ["2026 Spm 570 Trail - Sunset Red", "099837", "2026-08-08", "10233", "", "1"],
  ["2027 Rngr 1000 XP NSU - PPC", "8071708", "2027-02-26", "32215", "", "1"],
  [],
  ["", "", "", "21708"],
  [],
  ["2027 Rngr 1000XP NS Ult - Army Green", "8053120", "2026-11-27", "31861", "", "1", "here down we owe on LOC"],
  ["2027 Rng 1000 XP NS - Stealth Gray", "8058691", "2026-12-23", "28144", "", "1"],
  ["2027 Rngr 500 - Stealth Gray", "190700", "2024-01-20", "9944", "", "1"],
  ["2026 Rngr 570 - Zenith Blue", "182796", "", "13750", "", "1"],
  ["2026 Spm 110 - Blue", "097695", "2026-10-11", "", "", "1"],
  ["2026 Spm 110 - Blue", "8053120", "2026-10-12", "3764", "", "1"],
  [],
  ["this amt MUST always balance with", ">>>", "Total on Flooring", "83699", "", "9"],
  ["L/S account # 32400"],
  [],
  [],
  [],
  ["", "", "Grand Total", "105407"],
];

describe("reading the LOC sheet", () => {
  test("its headings, its sections, its totals left out, and what to look at", () => {
    const header = findLocHeader(SHEET);
    assert.equal(header, 0);
    const mapping = locColumns(SHEET[header]);
    assert.deepEqual(mapping, ["model", "stockNumber", "freeFloorEnds", "cost"]);
    const plan = planLocImport(SHEET, header, mapping, { section: "loc" });
    assert.deepEqual(
      plan.units.map((unit) => [unit.row, unit.onLoc ? "loc" : "owned", unit.unitYear, unit.model, unit.stockNumber, unit.freeFloorEnds, unit.cost, unit.category]),
      [
        [6, "owned", 2026, 'RZR 900 50" - Zenith Blue', "168072", "2026-01-07", 1616400, "RZR"],
        [7, "owned", 2026, "Spm 570 Ult - Turbo Silver", "098065", "2026-07-01", 1154400, "ATV"],
        [8, "owned", 2026, "Spm 570 Trail - Sunset Red", "099837", "2026-08-08", 1023300, "ATV"],
        [9, "owned", 2027, "Rngr 1000 XP NSU - PPC", "8071708", "2027-02-26", 3221500, "UTV"],
        [13, "loc", 2027, "Rngr 1000XP NS Ult - Army Green", "8053120", "2026-11-27", 3186100, "UTV"],
        [14, "loc", 2027, "Rng 1000 XP NS - Stealth Gray", "8058691", "2026-12-23", 2814400, "UTV"],
        [15, "loc", 2027, "Rngr 500 - Stealth Gray", "190700", "2024-01-20", 994400, "UTV"],
        [16, "loc", 2026, "Rngr 570 - Zenith Blue", "182796", null, 1375000, "UTV"],
      ],
    );
    // Every unit we own counted, where the sheet's own total stopped short.
    assert.deepEqual(plan.sections, { owned: { units: 4, cost: 7015600 }, loc: { units: 4, cost: 8369900 } });
    assert.equal(plan.rowsRead, 10);
    assert.deepEqual(plan.notes, [
      { row: 7, message: "Stock # 98065 read as 098065: Excel drops the leading zero from a number, and the sheet's other stock #s keep theirs.", skipped: false },
      { row: 15, message: "Free floor ends 1/20/2024, before a 2027 could have come in: check the year.", skipped: false },
      { row: 17, message: "No cost: row left out.", skipped: true },
      { row: 18, message: "Stock # 8053120 is on row 13 too: this row is left out.", skipped: true },
    ]);
    // The sheet's marks aren't anyone's notes.
    assert.ok(plan.units.every((unit) => unit.notes === null));
  });

  test("a notes column comes in, but not the sheet's mark in it", () => {
    const rows = SHEET.map((row) => [...row]);
    rows[0] = ["Model", " Stock #", "Free Floor Ends", "Cost", "", "", "Notes"];
    const plan = planLocImport(rows, 0, locColumns(rows[0]), { section: "loc" });
    assert.equal(plan.units[0].notes, "not sold & accruing interest");
    assert.equal(plan.units.find((unit) => unit.row === 13)?.notes, null);
  });

  test("a lender's list: no marks, so all of it on the LOC; its own headings; dates as it has them", () => {
    const rows = [
      ["Floor plan statement, 11/1/2026"],
      ["Stock No", "Description", "Serial Number", "Interest Begins", "Principal Balance"],
      ["204033", "2026 RZR XP 1000 Ultimate", "3NSXAW1R9TM204033", "1/7/2026", "$21,132.00"],
      ["8071708", "2027 Ranger 1000 XP NSU", "4XARRU997V8071708", "46407", "32,215.00"],
      ["", "Total", "", "", "53,347.00"],
    ];
    const header = findLocHeader(rows);
    assert.equal(header, 1);
    const mapping = locColumns(rows[header]);
    assert.deepEqual(mapping, ["stockNumber", "model", "vin", "freeFloorEnds", "cost"]);
    const plan = planLocImport(rows, header, mapping, { section: "loc" });
    assert.deepEqual(
      plan.units.map((unit) => [unit.stockNumber, unit.vin, unit.freeFloorEnds, unit.cost, unit.onLoc]),
      [
        ["204033", "3NSXAW1R9TM204033", "2026-01-07", 2113200, true],
        ["8071708", "4XARRU997V8071708", "2027-01-20", 3221500, true],
      ],
    );
    assert.deepEqual(plan.notes, []);
    // Picked as ours, units above any mark are ours.
    assert.ok(planLocImport(rows, header, mapping, { section: "owned" }).units.every((unit) => !unit.onLoc));
  });

  test("dates as sheets and lenders write them", () => {
    assert.equal(parseLocDate("1/7/2026"), "2026-01-07");
    assert.equal(parseLocDate("2026-01-07"), "2026-01-07");
    assert.equal(parseLocDate("07-Jan-26"), "2026-01-07");
    assert.equal(parseLocDate("46029"), "2026-01-07");
    assert.equal(parseLocDate("Total on Flooring"), null);
    assert.equal(parseLocDate("12345"), null);
  });

  test("the tab's own download comes back in as it went out", async () => {
    const plan = planLocImport(SHEET, 0, locColumns(SHEET[0]), { section: "loc" });
    const units = plan.units.map(({ row, ...unit }) => ({ ...unit, vin: unit.stockNumber === "168072" ? "3NSRZE997T7168072" : null, receivedOn: "2026-01-02", notes: row === 6 ? "Demo" : null, category: row === 9 ? "Crew UTV" : unit.category }));
    const sheets = await readXlsx(writeXlsx(locWorkbook(units, { title: "On the list", today: TODAY, grouped: true })));
    const rows = sheets[0].rows;
    const header = findLocHeader(rows);
    const again = planLocImport(rows, header, locColumns(rows[header]), { section: "loc" });
    const strip = (unit: LocImportRow): Omit<LocImportRow, "row"> => {
      const copy: Partial<LocImportRow> = { ...unit };
      delete copy.row;
      return copy as Omit<LocImportRow, "row">;
    };
    assert.deepEqual(again.units.map(strip), units);
    assert.deepEqual(again.sections, plan.sections);
  });
});

describe("the LOC workbook", () => {
  test("the sheet's sections, each total a live SUM over its rows and a blank row, the LOC's to balance with the books, and the totals at the top", () => {
    const owned = unitOf({ section: "owned", cost: "100", stockNumber: "000174" });
    const loc = [unitOf({ cost: "1000", stockNumber: "8071708" }), unitOf({ cost: "2000", stockNumber: "190700" })];
    const [sheet] = locWorkbook([owned, ...loc], { title: "On the list", today: TODAY, grouped: true });
    const text = (cell: unknown) => (cell && typeof cell === "object" && "value" in cell ? (cell as { value: unknown }).value : cell);
    const formula = (cell: unknown) => (cell && typeof cell === "object" && "formula" in cell ? (cell as { formula: string }).formula : null);
    const labels = sheet.rows.map((row) => text(row[0]));
    // Title, the three totals at the top, a blank row, then the headings.
    assert.deepEqual(labels.slice(0, 6), ["LOC: On the list, 11/9/2026", "We own", "On the LOC (balances with 32400)", "Grand Total", undefined, "Model"]);
    assert.equal(sheet.freeze?.rows, 6);
    // WE OWN, its unit (its stock # text, with its zero), a blank row, its total.
    assert.deepEqual(labels.slice(6, 10), ["WE OWN", "2026 RZR 900 50\" - Zenith Blue", undefined, "We own total"]);
    assert.equal(sheet.rows[7][1], "000174");
    assert.equal(formula(sheet.rows[9][3]), "SUM(D8:D9)");
    assert.equal(formula(sheet.rows[9][5]), "SUM(F8:F9)");
    assert.deepEqual(labels.slice(11, 16), ["ON THE LOC (we owe)", "2026 RZR 900 50\" - Zenith Blue", "2026 RZR 900 50\" - Zenith Blue", undefined, "Total on Flooring: must always balance with L/S account # 32400"]);
    assert.equal(formula(sheet.rows[15][3]), "SUM(D13:D15)");
    assert.equal(text(sheet.rows[15][3]), 3000);
    assert.equal(labels[17], "Grand Total");
    assert.equal(formula(sheet.rows[17][3]), "D10+D16");
    assert.equal(text(sheet.rows[17][3]), 3100);
    // The top's totals point at the ones below.
    assert.equal(formula(sheet.rows[3][3]), "D10+D16");
    assert.equal(formula(sheet.rows[2][5]), "F16");
  });
});

describe("the LOC", () => {
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

  const add = async (actor: CurrentUser, values: Record<string, string> = {}) => {
    const made = await addLocUnit(actor, unitValues(values));
    assert.ok("id" in made, JSON.stringify(made));
    return made.id;
  };

  const everything: LocFilters = { show: null, floor: null, condition: null, category: null, year: null, query: "" };
  const list = (actor: CurrentUser, filters: Partial<LocFilters> = {}) => listLocUnits(actor.shop.id, { ...everything, ...filters }, TODAY);

  // A sale as the NUSR's form sends it.
  const sale = (values: Partial<SaleValues>, extra: Partial<SaleInput> = {}): SaleInput => ({
    ...blankSaleValues({ soldOn: "2026-11-09", holdbackRateBp: 400, bonusRateBp: 1000 }),
    customerName: "Dana Whitfield",
    ...values,
    ...extra,
  });

  before(async () => {
    manager = await createManager(`lc${suffix}`);
    other = await createManager(`lx${suffix}`);
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  test("a unit is added, corrected and removed, and the Activity log says so in words", async () => {
    const id = await add(manager, { stockNumber: "099837", cost: "10233" });
    const unit = await getLocUnit(manager.shop.id, id);
    assert.equal(unit?.stockNumber, "099837");
    assert.equal(unit?.createdBy, "Morgan");
    const result = await updateLocUnit(manager, id, { ...locValues(unit!), cost: "10,500", section: "owned", paidOffOn: "2026-11-01", notes: "Paid off early" });
    assert.deepEqual(result, { ok: true });
    const history = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, id)).orderBy(auditLog.createdAt);
    assert.deepEqual(
      history.map((entry) => [entry.action, entry.targetType, areaOf(entry.targetType)]),
      [
        ["loc_unit.added", "loc_unit", "loc"],
        ["loc_unit.updated", "loc_unit", "loc"],
      ],
    );
    assert.equal(describeAuditEntry(history[0]).summary, 'Added 2026 RZR 900 50" - Zenith Blue (stock # 099837) to the LOC');
    const corrected = describeAuditEntry(history[1]);
    assert.equal(corrected.summary, 'Corrected 2026 RZR 900 50" - Zenith Blue (stock # 099837) on the LOC');
    assert.deepEqual(corrected.facts, [
      { label: "Cost", value: "$10,233.00 → $10,500.00" },
      { label: "On the LOC or ours", value: "On the LOC → We own" },
      { label: "Paid off", value: "blank → 11/1/2026" },
      { label: "Also changed", value: "notes" },
    ]);
    // Nothing changed: nothing written.
    assert.deepEqual(await updateLocUnit(manager, id, locValues((await getLocUnit(manager.shop.id, id))!)), { ok: true });
    assert.equal((await systemDb.select().from(auditLog).where(eq(auditLog.targetId, id))).length, 2);
    assert.deepEqual(await removeLocUnit(manager, id), { ok: true, label: '2026 RZR 900 50" - Zenith Blue, stock # 099837' });
    assert.equal(await getLocUnit(manager.shop.id, id), null);
    const [removed] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.action, "loc_unit.removed")));
    assert.equal(describeAuditEntry(removed).summary, 'Removed 2026 RZR 900 50" - Zenith Blue (stock # 099837) from the LOC');
  });

  test("a stock # is on the list once (without case); sold and paid off, it's free again", async () => {
    const shop = await createManager(`ls${suffix}`);
    const id = await add(shop, { stockNumber: "T1001" });
    assert.deepEqual(await addLocUnit(shop, unitValues({ stockNumber: "t1001", model: "Sportsman 570" })), {
      field: "stockNumber",
      error: 'Stock # T1001 is already on the LOC: 2026 RZR 900 50" - Zenith Blue.',
    });
    // Sold, it's still owed: still on the list.
    assert.deepEqual(await markLocUnits(shop, { ids: [id], mark: "sold", on: "2026-11-02" }), { marked: 1, skipped: 0, stillOwed: 1 });
    assert.ok("error" in (await addLocUnit(shop, unitValues({ stockNumber: "T1001" }))));
    // Paid off, it's gone from the list, and the stock # is free.
    assert.deepEqual(await markLocUnits(shop, { ids: [id], mark: "paid", on: "2026-11-05" }), { marked: 1, skipped: 0, stillOwed: 0 });
    await add(shop, { stockNumber: "T1001", model: "Sportsman 570" });
    // Another shop numbers its own units.
    await add(other, { stockNumber: "T1001" });
  });

  test("the list: the sheet's sections, its totals, and every filter", async () => {
    const shop = await createManager(`ll${suffix}`);
    const owned = await add(shop, { stockNumber: "168072", section: "owned", cost: "16164", freeFloorEnds: "2026-01-07", category: "RZR" });
    const ending = await add(shop, { stockNumber: "8053120", model: "Rngr 1000XP NS Ult - Army Green", unitYear: "2027", cost: "31861", freeFloorEnds: "2026-11-27", category: "UTV" });
    const ended = await add(shop, { stockNumber: "234940", model: "RZR PRO R Ult - Indy Red", cost: "40959", freeFloorEnds: "2026-10-28", category: "RZR", notes: "Customer deposit taken" });
    const used = await add(shop, { stockNumber: "T2001", model: "Sportsman 570", unitYear: "2019", cost: "4500", freeFloorEnds: "", section: "owned", condition: "used", category: "ATV", receivedOn: "2026-10-30" });
    const sold = await add(shop, { stockNumber: "190700", model: "Rngr 500 - Stealth Gray", unitYear: "2027", cost: "9944", freeFloorEnds: "2027-01-20", category: "UTV" });
    await markLocUnits(shop, { ids: [sold], mark: "sold", on: "2026-11-03" });
    const gone = await add(shop, { stockNumber: "098088", model: "Spm 110 - Velocity Blue", cost: "3764", section: "owned", category: "ATV" });
    await markLocUnits(shop, { ids: [gone], mark: "sold", on: "2026-11-04" });

    const all = await list(shop);
    // Ours first, then the LOC's, each by when its free floor ends.
    assert.deepEqual(all.units.map((unit) => unit.id), [owned, used, ended, ending, sold]);
    assert.deepEqual(all.totals.loc, { units: 3, cost: 8276400 });
    assert.deepEqual(all.totals.owned, { units: 2, cost: 2066400 });
    assert.deepEqual(all.totals.all, { units: 5, cost: 10342800 });
    assert.deepEqual(all.totals.soldOnLoc, { units: 1, cost: 994400 });
    assert.deepEqual(all.totals.ended, { units: 2, cost: 5712300, loc: 1, owned: 1 });
    assert.deepEqual(all.totals.soon, { units: 1, cost: 3186100 });

    const ids = async (filters: Partial<LocFilters>) => (await list(shop, filters)).units.map((unit) => unit.id);
    assert.deepEqual(await ids({ show: "loc" }), [ended, ending, sold]);
    assert.deepEqual(await ids({ show: "owned" }), [owned, used]);
    assert.deepEqual(await ids({ show: "sold" }), [gone, sold]);
    assert.deepEqual(await ids({ floor: "ended" }), [owned, ended]);
    assert.deepEqual(await ids({ floor: "soon" }), [ending]);
    assert.deepEqual(await ids({ floor: "free" }), [sold]);
    assert.deepEqual(await ids({ floor: "none" }), [used]);
    assert.deepEqual(await ids({ condition: "used" }), [used]);
    assert.deepEqual(await ids({ category: "rzr" }), [owned, ended]);
    assert.deepEqual(await ids({ year: 2027 }), [ending, sold]);
    assert.deepEqual(await ids({ query: "deposit indy" }), [ended]);
    assert.deepEqual(await ids({ query: "8053120" }), [ending]);
  });

  test("ticked units are marked paid off or sold; what doesn't fit is left as it was, and each is in the Activity log", async () => {
    const shop = await createManager(`lm${suffix}`);
    const a = await add(shop, { stockNumber: "1001" });
    const b = await add(shop, { stockNumber: "1002", section: "owned" });
    const c = await add(shop, { stockNumber: "1003", receivedOn: "2026-11-08" });
    assert.deepEqual(await markLocUnits(shop, { ids: [a, b], mark: "paid", on: "2026-11-05" }), { marked: 1, skipped: 1, stillOwed: 0 });
    const paid = await getLocUnit(shop.shop.id, a);
    assert.deepEqual([paid?.onLoc, paid?.paidOffOn], [false, "2026-11-05"]);
    // Sold before it came in: left as it was.
    assert.deepEqual(await markLocUnits(shop, { ids: [b, c], mark: "sold", on: "2026-11-06" }), { marked: 1, skipped: 1, stillOwed: 0 });
    assert.deepEqual(await markLocUnits(shop, { ids: [], mark: "paid", on: "2026-11-05" }), { error: "Tick the units the payoff covered." });
    assert.deepEqual(await markLocUnits(shop, { ids: [a], mark: "sold", on: "" }), { error: "Enter the day they sold.", field: "on" });
    assert.ok("error" in (await markLocUnits(shop, { ids: [a], mark: "lost", on: "2026-11-05" })));
    const [paidEntry] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, a), eq(auditLog.action, "loc_unit.paid_off")));
    assert.equal(describeAuditEntry(paidEntry).summary, 'Marked 2026 RZR 900 50" - Zenith Blue (stock # 1001) paid off the LOC: it\'s ours now');
    const [soldEntry] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, b), eq(auditLog.action, "loc_unit.sold")));
    assert.equal(describeAuditEntry(soldEntry).summary, 'Marked 2026 RZR 900 50" - Zenith Blue (stock # 1002) sold');
    // Another shop's units aren't touched.
    assert.deepEqual(await markLocUnits(other, { ids: [c], mark: "paid", on: "2026-11-05" }), { marked: 0, skipped: 1, stillOwed: 0 });
  });

  test("importing the sheet adds each unit once; again, it adds nothing", async () => {
    const shop = await createManager(`li${suffix}`);
    const plan = planLocImport(SHEET, 0, locColumns(SHEET[0]), { section: "loc" });
    const importId = randomUUID();
    const first = await importLocUnits(shop, { importId, fileName: "LOC June 2020.xlsx", units: plan.units });
    assert.ok("outcomes" in first, JSON.stringify(first));
    assert.ok(first.outcomes.every((outcome) => outcome.result === "added"));
    const all = await list(shop);
    assert.deepEqual(all.totals.owned, { units: 4, cost: 7015600 });
    assert.deepEqual(all.totals.loc, { units: 4, cost: 8369900 });
    assert.equal(all.units.find((unit) => unit.stockNumber === "098065")?.model, "Spm 570 Ult - Turbo Silver");
    const [entry] = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, importId));
    assert.equal(describeAuditEntry(entry).summary, "Imported units onto the LOC from LOC June 2020.xlsx");
    assert.deepEqual(entry.details, { fileName: "LOC June 2020.xlsx", added: 8, already: 0, failed: 0, cost: 15385500 });
    // Again: every stock # is on the list already.
    const again = await importLocUnits(shop, { importId: randomUUID(), fileName: "LOC June 2020.xlsx", units: plan.units });
    assert.ok("outcomes" in again && again.outcomes.every((outcome) => outcome.result === "already"));
    assert.equal((await list(shop)).units.length, 8);
    // The server checks every unit again, whatever the browser sent.
    const odd = await importLocUnits(shop, { importId: randomUUID(), fileName: "x", units: [{ row: 3, model: "", cost: 100 }, { row: 4, model: "Ranger 150", cost: 654200, onLoc: true }, null] });
    assert.ok("outcomes" in odd);
    assert.deepEqual(odd.outcomes.map((outcome) => outcome.result), ["failed", "added", "failed"]);
    assert.ok("error" in (await importLocUnits(shop, { importId: "nope", fileName: "x", units: plan.units })));
    assert.ok("error" in (await importLocUnits(shop, { importId: randomUUID(), fileName: "x", units: Array.from({ length: 501 }, () => plan.units[0]) })));
  });

  test("a unit the NUSR has sold is shown beside it, and marked sold on the sale's day", async () => {
    const shop = await createManager(`ln${suffix}`);
    const id = await add(shop, { stockNumber: "099837", model: "Spm 570 Trail - Sunset Red", cost: "10233" });
    const saleId = await logSale(shop, sale({ soldOn: "2026-11-02", unitModel: "Spm 570 Trail", unitYear: "2026", vin: "4XASEE575TM099837", salesPrice: "11999", dealerCost: "10233" }));
    assert.ok("id" in saleId);
    const listed = await list(shop, { show: "nusr" });
    assert.deepEqual(listed.units.map((unit) => [unit.id, unit.nusr?.kind, unit.nusr?.sale.id]), [[id, "sold", saleId.id]]);
    assert.equal(listed.totals.nusr, 1);
    // The NUSR's form, typing the VIN, says it's on the LOC.
    assert.deepEqual(await locUnitForVin(shop.shop.id, "4XASEE575TM099837"), { id, label: "2026 Spm 570 Trail - Sunset Red", stockNumber: "099837", onLoc: true, cost: 1023300 });
    await markLocUnits(shop, { ids: [id], mark: "sold", on: "2026-11-02" });
    assert.equal((await list(shop, { show: "nusr" })).units.length, 0);
    // Paid off in the NUSR: news again, until it's paid off here.
    await withShop(shop.shop.id, (tx) => tx.update(unitSales).set({ paidOn: "2026-11-05", comsNumber: "4410" }).where(eq(unitSales.id, saleId.id)));
    assert.deepEqual((await list(shop, { show: "nusr" })).units.map((unit) => unit.nusr?.kind), ["paid"]);
    await markLocUnits(shop, { ids: [id], mark: "paid", on: "2026-11-05" });
    assert.equal((await list(shop)).units.length, 0);
  });

  test("a trade-in logged with a sale goes on the LOC as ours, and the sale's figures and bonuses don't change", async () => {
    const shop = await createManager(`lt${suffix}`);
    const twin = await createManager(`lw${suffix}`);
    const customer = await createCustomer(shop, { name: "Dana Whitfield", phone: "814-555-0199", email: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", notes: "" });
    assert.ok("id" in customer);
    const deal = { soldOn: "2026-11-09", salesperson: "Sam Ortega", unitYear: "2027", unitModel: "Rngr 1000 XP NSU", vin: "4XARRU997V8071708", msrp: "38999", salesPrice: "36500", dealerCost: "32215", accPrice: "1200", accCost: "800", category: "UTV" };
    const trade = { tradeVin: "4XASEE575KM099837", tradeYear: "2019", tradeModel: "Sportsman 570", tradeValue: "4,500" };
    const withTrade = await logSale(shop, sale(deal, { customerId: customer.id, addVehicle: "on", tradeIn: trade }));
    assert.ok("id" in withTrade, JSON.stringify(withTrade));
    // The same deal, without the trade-in, in a shop of its own.
    const without = await logSale(twin, sale(deal));
    assert.ok("id" in without);

    // The sale's figures: the same, to the cent.
    const traded = await getSale(shop.shop.id, withTrade.id);
    const plain = await getSale(twin.shop.id, without.id);
    assert.ok(traded && plain);
    assert.deepEqual(traded.figures, plain.figures);
    for (const field of ["salesPrice", "dealerCost", "rebate", "bonusAdjustment"] as const) assert.equal(traded[field], plain[field], field);
    // The NUSR counts one unit sold, and its totals and the bonus report are the same.
    const year = { year: 2026, month: null, condition: null, unitType: null, category: null, salesperson: null, status: null, query: "" };
    const [tradedLog, plainLog] = [await listSales(shop.shop.id, year), await listSales(twin.shop.id, year)];
    assert.equal(tradedLog.total, 1);
    assert.deepEqual(tradedLog.totals, plainLog.totals);
    const [tradedBonuses, plainBonuses] = [await bonusSales(shop, { view: "month", on: "2026-11-09", by: "sold" }), await bonusSales(twin, { view: "month", on: "2026-11-09", by: "sold" })];
    assert.ok("sales" in tradedBonuses && "sales" in plainBonuses);
    assert.equal(tradedBonuses.sales.length, 1);
    assert.deepEqual(
      tradedBonuses.sales.map((each) => each.figures),
      plainBonuses.sales.map((each) => each.figures),
    );

    // The trade-in, on the LOC: ours, used, at its value, in on the day of the sale.
    const [tradeIn] = await tradeInsForSale(shop.shop.id, withTrade.id);
    assert.ok(tradeIn);
    assert.deepEqual(
      [tradeIn.model, tradeIn.unitYear, tradeIn.vin, tradeIn.stockNumber, tradeIn.cost, tradeIn.onLoc, tradeIn.condition, tradeIn.receivedOn, tradeIn.category, tradeIn.freeFloorEnds],
      ["Sportsman 570", 2019, "4XASEE575KM099837", "099837", 450000, false, "used", "2026-11-09", "ATV", null],
    );
    assert.deepEqual(tradeIn.trade, { soldOn: "2026-11-09", customerName: "Dana Whitfield", unit: "2027 Rngr 1000 XP NSU" });
    // Its own sale isn't news about it.
    assert.equal(tradeIn.nusr, null);
    assert.deepEqual((await list(shop)).totals.owned, { units: 1, cost: 450000 });
    // On the customer's record as sold to us, beside what they bought.
    const vehicles = await systemDb.select().from(customerVehicles).where(eq(customerVehicles.customerId, customer.id));
    assert.deepEqual(
      vehicles.map((vehicle) => [vehicle.relation, vehicle.vin, vehicle.relationDate]).sort(),
      [
        ["bought", "4XARRU997V8071708", "2026-11-09"],
        ["sold", "4XASEE575KM099837", "2026-11-09"],
      ],
    );
    // The Activity log has both, in words.
    const [logged] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, withTrade.id), eq(auditLog.action, "unit_sale.logged")));
    assert.deepEqual(describeAuditEntry(logged).facts.at(-1), { label: "Trade-in, onto the LOC", value: "2019 Sportsman 570 (stock # 099837)" });
    const [added] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, tradeIn.id), eq(auditLog.action, "loc_unit.added")));
    assert.equal(describeAuditEntry(added).summary, "Put the trade-in 2019 Sportsman 570 (stock # 099837) on the LOC, as ours");

    // Another trade-in added while correcting the sale; the figures still the same.
    const values = saleValues(traded);
    assert.deepEqual(await updateSale(shop, withTrade.id, { ...values, customerId: customer.id, tradeIn: { tradeModel: "Outlaw 110", tradeValue: "900", tradeStockNumber: "T-2" } }), { ok: true });
    assert.equal((await tradeInsForSale(shop.shop.id, withTrade.id)).length, 2);
    assert.deepEqual((await getSale(shop.shop.id, withTrade.id))?.figures, plain.figures);
  });

  test("a trade-in that can't go on the LOC stops the sale, so nothing's half done", async () => {
    const shop = await createManager(`lh${suffix}`);
    await add(shop, { stockNumber: "099837" });
    const taken = await logSale(shop, sale({ unitModel: "RZR XP 1000", salesPrice: "20000" }, { tradeIn: { tradeVin: "4XASEE575KM099837", tradeModel: "Sportsman 570", tradeValue: "4500" } }));
    assert.deepEqual(taken, { field: "tradeStockNumber", error: 'The trade-in\'s stock # 099837 is already on the LOC: 2026 RZR 900 50" - Zenith Blue. Give it a stock # of its own.' });
    const unfinished = await logSale(shop, sale({ unitModel: "RZR XP 1000", salesPrice: "20000" }, { tradeIn: { tradeVin: "4XASEE575KM099837", tradeValue: "4500" } }));
    assert.deepEqual(unfinished, { error: "Enter the trade-in's model.", field: "tradeModel" });
    const year = { year: 2026, month: null, condition: null, unitType: null, category: null, salesperson: null, status: null, query: "" };
    assert.equal((await listSales(shop.shop.id, year)).total, 0);
    assert.equal((await list(shop)).units.length, 1);
  });

  test("removing a sale keeps its trade-in on the LOC, no longer tied to it, and says so", async () => {
    const shop = await createManager(`lr${suffix}`);
    const logged = await logSale(shop, sale({ unitModel: "RZR XP 1000", salesPrice: "20000" }, { tradeIn: { tradeModel: "Sportsman 570", tradeYear: "2019", tradeValue: "4500", tradeStockNumber: "T-77" } }));
    assert.ok("id" in logged);
    const result = await removeSale(shop, logged.id);
    assert.deepEqual(result, { ok: true, label: "RZR XP 1000 to Dana Whitfield", tradeIns: ["2019 Sportsman 570, stock # T-77"] });
    const [unit] = (await list(shop)).units;
    assert.deepEqual([unit.model, unit.tradeSaleId, unit.trade], ["Sportsman 570", null, null]);
    const [entry] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, logged.id), eq(auditLog.action, "unit_sale.removed")));
    assert.deepEqual(describeAuditEntry(entry).facts.at(-1), { label: "Its trade-in, kept on the LOC", value: "2019 Sportsman 570, stock # T-77" });
  });

  test("another shop can't see, change, mark or remove a unit; the database won't move one", async () => {
    const mine = await add(manager, { stockNumber: "MINE1" });
    assert.equal(await getLocUnit(other.shop.id, mine), null);
    assert.ok((await list(other)).units.every((unit) => unit.id !== mine));
    assert.ok("error" in (await updateLocUnit(other, mine, unitValues({ stockNumber: "MINE1", cost: "1" }))));
    assert.ok("error" in (await removeLocUnit(other, mine)));
    assert.equal((await getLocUnit(manager.shop.id, mine))?.cost, 1616400);
    const seen = await withShop(other.shop.id, (tx) => tx.select({ shopId: locUnits.shopId }).from(locUnits));
    assert.ok(seen.every((row) => row.shopId === other.shop.id));
    await assert.rejects(
      withShop(manager.shop.id, (tx) => tx.update(locUnits).set({ shopId: other.shop.id }).where(eq(locUnits.id, mine))),
      (error: unknown) => /permission denied/.test(String((error as { cause?: unknown }).cause)),
    );
    // A trade-in can't be tied to another shop's sale.
    const theirSale = await logSale(other, sale({ unitModel: "Outlaw 70" }));
    assert.ok("id" in theirSale);
    await assert.rejects(withShop(manager.shop.id, (tx) => tx.update(locUnits).set({ tradeSaleId: theirSale.id }).where(eq(locUnits.id, mine))));
  });

  test("it's for managers and admins, signed in with a password", () => {
    assert.ok(can("manager", "sales.log") && can("admin", "sales.log"));
    assert.ok(!can("tech", "sales.log") && !can("service_writer", "sales.log") && !can("parts", "sales.log"));
    assert.equal(allows({ role: "manager", bay: { deviceId: "d" } }, "sales.log"), false);
  });
});
