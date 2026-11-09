// Unit List (the Unit List tab): reading Polaris's whole goods invoices as
// OCR or a PDF's own text gives them (src/lib/unit-list-rules.ts): several
// invoices in one scan, the parts and rebate invoices among them left out;
// each unit's model number, description, cost, VIN and engine number; the
// VIN put right from the model number and the check digit (a character a
// scanner's streak took out, OCR's slips, a misread model number), and
// what's left unsure; the models' names, a unit as typed, and the list's
// groups and totals; and on the server (src/lib/unit-list.ts): looking
// units up (the shop's names for a model, the last list price, on the list
// already, sold in the NUSR), adding them, the list by its filters, a unit
// sold in the NUSR counting as sold, correcting and removing one, the
// Activity log, and all of it kept to the shop (by the database too) and
// to sales.log. Made-up invoices, customers and VINs only.
// The database tests need DATABASE_URL pointing at a disposable Postgres
// database; run with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { and, asc, eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, manualCatalogDocuments, shops, stockUnits, users } from "../src/db/schema";
import { describeAuditEntry } from "../src/lib/audit-log-rules";
import { logSale } from "../src/lib/nusr";
import { blankSaleValues, type SaleValues } from "../src/lib/nusr-rules";
import type { InvoicePage, InvoiceWord } from "../src/lib/rebate-rules";
import type { CurrentUser } from "../src/lib/session";
import { addStockUnits, getStockUnit, listStockUnits, lookUpUnits, removeStockUnit, updateStockUnit } from "../src/lib/unit-list";
import {
  NO_TABLE,
  checkUnit,
  daysInStock,
  descriptionYear,
  groupUnits,
  invoiceAddsUp,
  invoiceKind,
  modelFromDescription,
  modelNumberByVin,
  paintOf,
  parseUnitFilters,
  readModelNumber,
  readUnitInvoices,
  resolveVin,
  soldOf,
  tidyDescription,
  unitChanges,
  unitListHref,
  unitTotals,
  unitValues,
  vinOnLine,
  vinParts,
  withPaint,
  type UnitFields,
} from "../src/lib/unit-list-rules";
import { vinCheckDigit, vinYearCode } from "../src/lib/vin";

// A whole VIN from its other 16 characters, "_" where the check digit goes.
const whole = (pattern: string) => pattern.replace("_", vinCheckDigit(pattern.replace("_", "0"))!);

const RANGER = whole("4XARSY99_V8000123");
const RANGER_PS = whole("3NSTAU99_VH000077");
const GENERAL = whole("3NSGMK99_TF000456");

// --- A made-up invoice, laid out as the portal prints it ----------------------

// In OCR's pixels at 300 dpi: a line of print is 24 tall and 40 apart; the
// headings sit where the portal's printout has them.
const HEIGHT = 24;

type Row = { part?: string[]; text?: [string, number][]; price?: string; amount?: string };
type Printed = [string, number][];

// One invoice's page of words as Tesseract gives them (each with its line),
// or as a PDF's own text gives them (`text: true`).
function invoicePage({
  number,
  type,
  date = "11/06/26",
  rows,
  total,
  dash = "-",
  text = false,
  heading = true,
  below = [],
}: {
  number: string | null;
  type: string;
  date?: string;
  rows: Row[];
  total?: string;
  dash?: string;
  text?: boolean;
  heading?: boolean;
  below?: Printed[];
}): InvoicePage {
  const words: InvoiceWord[] = [];
  let y = 60;
  let line = 0;
  const put = (cells: Printed) => {
    line++;
    for (const [value, left] of cells) words.push({ text: value, left, top: y, width: value.length * 20, height: HEIGHT, ...(text ? {} : { line: `1.1.${line}` }) });
    y += 40;
  };
  put([["11/7/26,", 121], ["7:05", 246], ["AM", 316], ["Invoice", 1388], ["Print", 1503]]);
  const [first, ...more] = type.split(" ");
  put([["Invoice", 147], ...(number ? ([[dash, 296], [number, 324]] as Printed) : []), [`Type:${first}`, 485], ...more.map((word, i): [string, number] => [word, 709 + i * 120])]);
  put([["Sold", 598], ["To", 690], ["Ship", 1498], ["To", 1591]]);
  put([["EAST", 600], ["AMERICAN", 697], ["MOTORSPORTS", 892]]);
  put([["Customer", 260], ["Your", 597], ["PO", 698], ["No.", 763], ["VDO", 1265], ["Invoice", 1497], ["Date", 1650], ["Order", 2067], ["Number", 2186]]);
  put([["02106000", 260], ["NA", 1271], [date, 1499], ["2153742", 2067]]);
  put([["Parts", 136]]);
  if (heading) put([["Ord", 158], ["Ship", 266], ["B/0", 381], ["Part", 480], ["Description", 828], ["Unit", 2038], ["Price", 2127], ["Amount", 2304]]);
  for (const row of rows) {
    const cells: Printed = [];
    (row.part ?? []).forEach((value, i) => cells.push([value, [184, 299, 480][i] ?? 480]));
    for (const cell of row.text ?? []) cells.push(cell);
    if (row.price) cells.push([row.price, 2026]);
    if (row.amount) cells.push([row.amount, 2257]);
    put(cells);
  }
  put([["Summary", 135]]);
  put([["This", 915], ["Order", 997], ["is", 1105], ["Financed", 1143], ["by", 1303], ["Polaris", 1355], ["Acceptance", 1474]]);
  if (total) {
    put([["Tax", 1918], ["Discount", 2056], ["Total", 2354]]);
    put([["$0.00", 1891], ["$0.00", 2123], [total, 2256]]);
  }
  for (const cells of below) put(cells);
  put([["https://apps.polarisportal.com/accred/InvoicePrintNew.asp", 116], ["3/6", 2420]]);
  return { words };
}

// A unit's two lines: the model number, description and price, then the
// VIN (as read) and the engine number.
const unitRows = (model: string, description: string, price: string, vin: string | [string, number][], engine: string): Row[] => [
  { part: ["1", "1", model], text: [[description, 828]], price, amount: price },
  { text: [...(typeof vin === "string" ? ([[vin, 874]] as [string, number][]) : vin), [engine, 1320]] },
];

const partsPage = (number: string) =>
  invoicePage({ number, type: "PG&A", rows: [{ part: ["3", "3", "1332637"], text: [["FRONT LEFT HALFSHAFT ASS CN", 828]], price: "$162.49", amount: "$487.47" }], total: "$487.47" });
const rebatePage = (number: string) =>
  invoicePage({ number, type: "Rebate", rows: [{ part: ["700"], text: [[`${whole("3NSNMS99_TF213597")}/Z26NMS99A`, 828]], price: "$0.00", amount: "-$2,500.00" }], total: "-$2,500.00" });

// --- Reading ----------------------------------------------------------------------

describe("reading whole goods invoices", () => {
  test("a scan of several invoices: the parts and rebate ones left out, each whole goods unit with all it says", () => {
    const pages = [
      partsPage("370898"),
      invoicePage({ number: "374952", type: "Whole Goods", rows: unitRows("R27TAU99AN", "RGR-27,1K,PS,HTR,SPRBLUE", "$21,064.00", RANGER_PS, "1209259165869"), total: "$21,064.00" }),
      // OCR read the dash as a tilde.
      invoicePage({ number: "374953", type: "Whole Goods", dash: "~", rows: unitRows("R27RSY99AA", "RGR-27,1K,XP,NSULT,CR,ARMYG", "$34,893.00", RANGER, "1209389077163"), total: "$34,893.00" }),
      invoicePage({
        number: "374954",
        type: "Whole Goods",
        rows: unitRows("G26GMK99AJ", "GEN-26,1K,XP,4P,OPT1,M.S.GRPH", "$29,639.00", GENERAL, "1206233542681"),
        total: "$29,639.00",
        // What's written by hand under the summary isn't read as the table.
        below: [[["3/6/27", 900]], [["$31,999.00", 950]]],
      }),
      rebatePage("379048"),
    ];
    const read = readUnitInvoices(pages);
    assert.ok(!("error" in read), JSON.stringify(read));
    assert.deepEqual(
      read.invoices.map((invoice) => [invoice.number, invoice.type, invoice.kind, invoice.date, invoice.total?.cents, invoice.pages, invoice.units.length]),
      [
        ["370898", "PG&A", "parts", "2026-11-06", 48747, [1], 0],
        ["374952", "Whole Goods", "wholeGoods", "2026-11-06", 2106400, [2], 1],
        ["374953", "Whole Goods", "wholeGoods", "2026-11-06", 3489300, [3], 1],
        ["374954", "Whole Goods", "wholeGoods", "2026-11-06", 2963900, [4], 1],
        ["379048", "Rebate", "rebate", "2026-11-06", 250000, [5], 0],
      ],
    );
    const units = read.invoices.flatMap((invoice) => invoice.units);
    assert.deepEqual(
      units.map((unit) => [unit.index, unit.invoice, unit.page, unit.modelNumber, unit.description, unit.year, unit.vin?.vin, unit.vin?.sure, unit.engineNumber, unit.cost.cents, unit.cost.sure]),
      [
        [1, "374952", 2, "R27TAU99AN", "RGR-27,1K,PS,HTR,SPRBLUE", 2027, RANGER_PS, true, "1209259165869", 2106400, true],
        [2, "374953", 3, "R27RSY99AA", "RGR-27,1K,XP,NSULT,CR,ARMYG", 2027, RANGER, true, "1209389077163", 3489300, true],
        [3, "374954", 4, "G26GMK99AJ", "GEN-26,1K,XP,4P,OPT1,M.S.GRPH", 2026, GENERAL, true, "1206233542681", 2963900, true],
      ],
    );
    for (const invoice of read.invoices) assert.deepEqual(invoice.charges, []);
  });

  test("a PDF's own text reads the same, and a continuation page joins its invoice", () => {
    const first = invoicePage({ number: "380001", type: "Whole Goods", text: true, rows: unitRows("R27RSY99AA", "RGR-27,1K,XP,NSULT,CR,ARMYG", "$34,893.00", RANGER, "1209389077163") });
    // The next page of the same invoice: no totals on the first, so it goes on.
    const second = invoicePage({ number: "380001", type: "Whole Goods", text: true, rows: unitRows("G26GMK99AJ", "GEN-26,1K,XP,4P", "$29,639.00", GENERAL, "1206233542681"), total: "$64,532.00" });
    const read = readUnitInvoices([first, second]);
    assert.ok(!("error" in read));
    assert.equal(read.invoices.length, 1);
    assert.deepEqual(read.invoices[0].pages, [1, 2]);
    assert.deepEqual(
      read.invoices[0].units.map((unit) => [unit.vin?.vin, unit.cost.cents, unit.cost.sure, unit.page]),
      [
        [RANGER, 3489300, true, 1],
        [GENERAL, 2963900, true, 2],
      ],
    );
  });

  test("two units shipped on one line, each with its own VIN", () => {
    const page = invoicePage({
      number: "380002",
      type: "Whole Goods",
      rows: [
        { part: ["2", "2", "R27RSY99AA"], text: [["RGR-27,1K,XP,NSULT,CR,ARMYG", 828]], price: "$34,893.00", amount: "$69,786.00" },
        { text: [[RANGER, 874], ["1209389077163", 1320]] },
        { text: [[whole("4XARSY99_V8000124"), 874], ["1209389077164", 1320]] },
      ],
      total: "$69,786.00",
    });
    const read = readUnitInvoices([page]);
    assert.ok(!("error" in read));
    assert.deepEqual(
      read.invoices[0].units.map((unit) => [unit.vin?.vin, unit.engineNumber, unit.cost.cents, unit.cost.sure]),
      [
        [RANGER, "1209389077163", 3489300, true],
        [whole("4XARSY99_V8000124"), "1209389077164", 3489300, true],
      ],
    );
  });

  test("a charge that isn't a unit, and a total its units don't add up to", () => {
    const page = invoicePage({
      number: "380003",
      type: "Whole Goods",
      rows: [...unitRows("R27RSY99AA", "RGR-27,1K,XP,NSULT,CR,ARMYG", "$34,893.00", RANGER, "1209389077163"), { part: ["1", "1", "FRT"], text: [["FREIGHT", 828]], price: "$450.00", amount: "$450.00" }],
      total: "$35,393.00",
    });
    const read = readUnitInvoices([page]);
    assert.ok(!("error" in read));
    const [invoice] = read.invoices;
    assert.equal(invoice.units.length, 1);
    assert.deepEqual(invoice.charges, [{ description: "FREIGHT", amount: 45000 }]);
    assert.deepEqual(invoiceAddsUp(invoice), { sum: 3489300, charges: 45000, total: 3539300, apart: 50 * 100 });
  });

  test("a scan's streak: a VIN split and a character lost, a figure read as a letter, the Part misread too", () => {
    // 3NS TAU99 c VH000077: the streak took the T out, and OCR read the 9
    // after AU as an S.
    const check = RANGER_PS[8];
    const split: [string, number][] = [
      ["3NS", 874],
      [`AUS9${check}VH000077`, 954],
    ];
    const misreadPart = invoicePage({ number: "380004", type: "Whole Goods", rows: unitRows("R27RSYS9AA", "RGR-27[HK,XP,NSULT,CR,ARMYG", "$34,893.00", RANGER, "1209389077163"), total: "$34,893.00" });
    const read = readUnitInvoices([
      invoicePage({ number: "380005", type: "Whole Goods", rows: unitRows("R27TAU99AN", "RGR-2% 1K,PS,HTR,SPRBLUE", "$21,064.00", split, "1209259165869"), total: "$21,064.00" }),
      misreadPart,
    ]);
    assert.ok(!("error" in read));
    const [ps, xp] = read.invoices.flatMap((invoice) => invoice.units);
    assert.equal(ps.vin?.text, `3NS?AUS9${check}VH000077`);
    assert.equal(ps.vin?.vin, RANGER_PS);
    assert.equal(ps.vin?.sure, true);
    assert.equal(ps.engineNumber, "1209259165869");
    // The VIN read right puts the model number's code right.
    assert.equal(xp.vin?.vin, RANGER);
    assert.equal(xp.modelNumber, "R27RSY99AA");
  });

  test("VINs put right, or left unsure with what else they could be", () => {
    const check = RANGER[8];
    // A figure read as a letter where the model number says otherwise.
    assert.deepEqual(resolveVin(`4XARSYS9${check}V8000123`, "R27RSY99AA"), { text: `4XARSYS9${check}V8000123`, vin: RANGER, sure: true, others: [], checkDigitOk: true });
    // Read right: as it is.
    assert.equal(resolveVin(RANGER, "R27RSY99AA").sure, true);
    assert.equal(resolveVin(RANGER).vin, RANGER);
    // I and O are never in a VIN.
    assert.equal(resolveVin(RANGER.replace(/1/g, "I")).vin, RANGER);
    // B and S count the same in the check digit: it can't say which.
    const either = resolveVin(`4XARBY99${check}V8000123`, "R27RSY99AA");
    assert.equal(either.sure, false);
    assert.equal(either.checkDigitOk, true);
    assert.deepEqual([either.vin, ...either.others].sort(), [`4XARBY99${check}V8000123`, RANGER].sort());
    // A serial figure misread with nothing to say so: the check digit fails.
    const off = `${RANGER.slice(0, 16)}${RANGER[16] === "3" ? "8" : "3"}`;
    assert.deepEqual(resolveVin(off, "R27RSY99AA"), { text: off, vin: off, sure: false, others: [], checkDigitOk: false });
    // A character OCR couldn't make out, outside the model code: the check
    // digit says what it was (a figure, at the end).
    assert.equal(resolveVin(`${RANGER.slice(0, 14)}?${RANGER.slice(15)}`, "R27RSY99AA").vin, RANGER);
    // The model number's year: character 10.
    assert.equal(vinYearCode(2027), "V");
    assert.equal(vinYearCode(2026), "T");
    assert.equal(vinYearCode(1979), null);
  });

  test("a VIN on its line, put together from pieces, with the engine number after it", () => {
    assert.deepEqual(vinOnLine(`${RANGER} 1209389077163`), { text: RANGER, rest: ["1209389077163"] });
    assert.deepEqual(vinOnLine(`${RANGER}1209389077163`), { text: RANGER, rest: ["1209389077163"] });
    // Split by a gap OCR saw: put back together.
    assert.deepEqual(vinOnLine(`${RANGER.slice(0, 3)} ${RANGER.slice(3)} 1209389077163`), { text: RANGER, rest: ["1209389077163"] });
    // Split, a character short: the gap took it ("?").
    assert.deepEqual(vinOnLine(`3NS ${RANGER_PS.slice(4)} 1209259165869`), { text: `3NS?${RANGER_PS.slice(4)}`, rest: ["1209259165869"] });
    // A mark OCR couldn't make out is "?".
    assert.deepEqual(vinOnLine(`3NS|${RANGER_PS.slice(4)}`), { text: `3NS?${RANGER_PS.slice(4)}`, rest: [] });
    assert.equal(vinOnLine("RGR-27,1K,XP,NSULT,CR,ARMYG"), null);
    assert.equal(vinOnLine("FRONT LEFT HALFSHAFT ASS CN"), null);
  });

  test("model numbers in the Part column, OCR's slips put right", () => {
    assert.equal(readModelNumber("1 1 R27RSY99AA"), "R27RSY99AA");
    assert.equal(readModelNumber("1 1 G26GMK99A]"), "G26GMK99AJ");
    assert.equal(readModelNumber("1 1 R2TRSY99AA"), "R27RSY99AA");
    assert.equal(readModelNumber("3 3 1332637"), null);
    assert.equal(readModelNumber("700"), null);
    assert.equal(modelNumberByVin("R27RSYS9AA", resolveVin(RANGER, "R27RSYS9AA")), "R27RSY99AA");
    // A model code more than OCR's slips away from the VIN's stays as read.
    assert.equal(modelNumberByVin("R27TAU99AN", resolveVin(RANGER)), "R27TAU99AN");
  });

  test("what isn't a whole goods invoice", () => {
    assert.deepEqual(readUnitInvoices([{ words: [{ text: "Hello", left: 0, top: 0, width: 100, height: 24 }] }]), { error: NO_TABLE });
    const read = readUnitInvoices([partsPage("370898"), rebatePage("379048")]);
    assert.ok(!("error" in read));
    assert.deepEqual(
      read.invoices.map((invoice) => [invoice.kind, invoice.units.length]),
      [
        ["parts", 0],
        ["rebate", 0],
      ],
    );
    assert.equal(invoiceKind("Whole Goods"), "wholeGoods");
    assert.equal(invoiceKind("WholeGoods"), "wholeGoods");
    assert.equal(invoiceKind("PG&A"), "parts");
    assert.equal(invoiceKind("Rebate"), "rebate");
    assert.equal(invoiceKind(null), "other");
  });

  test("a streak through the headings' Description", () => {
    const page = invoicePage({ number: "380006", type: "Whole Goods", heading: false, rows: unitRows("R27RSY99AA", "RGR-27,1K,XP,NSULT,CR,ARMYG", "$34,893.00", RANGER, "1209389077163"), total: "$34,893.00" });
    // The headings with "Description" cut in two.
    const words: InvoiceWord[] = [["Ord", 158], ["Ship", 266], ["B/0", 381], ["Part", 480], ["Descrip", 828], ["ion", 990], ["Unit", 2038], ["Price", 2127], ["Amount", 2304]].map(([text, left]) => ({
      text: String(text),
      left: Number(left),
      top: 340,
      width: String(text).length * 20,
      height: HEIGHT,
      line: "1.1.99",
    }));
    const read = readUnitInvoices([{ words: [...page.words.map((word) => (word.top >= 340 ? { ...word, top: word.top + 40 } : word)), ...words] }]);
    assert.ok(!("error" in read), JSON.stringify(read));
    assert.equal(read.invoices[0].units[0]?.vin?.vin, RANGER);
  });
});

describe("models, a unit as typed, and the list", () => {
  test("models from Polaris's description, and another paint's name", () => {
    assert.equal(tidyDescription("RGR-27 1K, XP,NSULT,CR,ARMYG"), "RGR-27,1K,XP,NSULT,CR,ARMYG");
    assert.equal(tidyDescription("RGR-27:1K,PS,HTR,SPRBLUE"), "RGR-27,1K,PS,HTR,SPRBLUE");
    assert.equal(descriptionYear("GEN-2¢,1K,XP", "G26GMK99AJ"), "GEN-26,1K,XP");
    assert.equal(modelFromDescription("RGR-27,1K,XP,NSULT,CR,ARMYG"), "RGR 1K XP NSULT CR ARMYG");
    assert.equal(paintOf("RGR-27,1K,XP,NSULT,CR,ARMYG"), "ARMYG");
    assert.equal(paintOf("RGR-27,1K,XP"), null);
    assert.equal(withPaint("Rngr 1000 XP NSU Crew - Blue Lab", "ARMYG"), "Rngr 1000 XP NSU Crew - ARMYG");
    assert.equal(withPaint("Rngr 1000 XP NSU Crew", "ARMYG"), "Rngr 1000 XP NSU Crew");
    assert.deepEqual(vinParts(RANGER), [RANGER.slice(0, 10), RANGER.slice(10)]);
  });

  test("a unit as typed", () => {
    const typed = { vin: ` ${RANGER.toLowerCase()} `, unitYear: "2027", model: " Rngr 1000 XP  NSU Crew ", modelNumber: "r27rsy99aa", receivedOn: "2026-11-09", cost: "34,893.00", listPrice: "37399", soldOn: "", notes: "" };
    const checked = checkUnit(typed);
    assert.ok("unit" in checked, JSON.stringify(checked));
    assert.deepEqual(checked.unit, {
      vin: RANGER,
      unitYear: 2027,
      model: "Rngr 1000 XP NSU Crew",
      modelNumber: "R27RSY99AA",
      description: null,
      engineNumber: null,
      receivedOn: "2026-11-09",
      cost: 3489300,
      listPrice: 3739900,
      soldOn: null,
      notes: null,
    });
    assert.deepEqual(unitValues(checked.unit).cost, "34,893.00");
    const problem = (change: Record<string, string>) => {
      const result = checkUnit({ ...typed, ...change });
      return "error" in result ? result.field : null;
    };
    assert.equal(problem({ vin: "" }), "vin");
    assert.equal(problem({ vin: "4XARSY99IV8000123" }), "vin");
    assert.equal(problem({ model: " " }), "model");
    assert.equal(problem({ unitYear: "27" }), "unitYear");
    assert.equal(problem({ receivedOn: "" }), "receivedOn");
    assert.equal(problem({ receivedOn: "2026-02-30" }), "receivedOn");
    assert.equal(problem({ cost: "lots" }), "cost");
    assert.equal(problem({ listPrice: "-5" }), "listPrice");
    assert.equal(problem({ soldOn: "someday" }), "soldOn");
    assert.equal(problem({ listPrice: "" }), null);
    assert.deepEqual(Object.keys(unitChanges(checked.unit, { ...checked.unit, listPrice: 3699900, notes: "Presold" })), ["listPrice", "notes"]);
  });

  test("the list by model, its totals, and days in stock", () => {
    const unit = (vin: string, model: string, unitYear: number, receivedOn: string, cost: number | null, listPrice: number | null, soldOn: string | null = null) => ({
      vin,
      model,
      unitYear,
      receivedOn,
      cost,
      listPrice,
      soldOn,
      nusrSale: null,
    });
    const units = [
      unit("C", "Rngr 1000 XP NSU Crew - Blue Lab", 2027, "2026-10-29", 3524700, 3779900),
      unit("A", "GEN XP 1000 Ult", 2026, "2026-08-12", 3188400, null),
      unit("B", "rngr 1000 xp nsu crew -  blue lab", 2027, "2026-09-01", 3489300, 3739900),
    ];
    const groups = groupUnits(units, "2026-11-09");
    assert.deepEqual(
      groups.map((group) => [group.name, group.units.map((one) => one.vin), group.totals.units, group.totals.cost, group.totals.list]),
      [
        ["2027 Rngr 1000 XP NSU Crew - Blue Lab", ["B", "C"], 2, 7014000, 7519800],
        ["2026 GEN XP 1000 Ult", ["A"], 1, 3188400, 0],
      ],
    );
    assert.deepEqual(unitTotals(units, "2026-11-09"), { units: 3, cost: 10202400, list: 7519800, noCost: 0, noList: 1, averageDays: 56, oldestDays: 89 });
    assert.equal(daysInStock(unit("D", "X", 2027, "2026-11-01", null, null, "2026-11-21"), "2026-12-25"), 20);
    // Presold before it came in: never below zero.
    assert.equal(daysInStock(unit("D", "X", 2027, "2026-11-09", null, null, "2026-11-01"), "2026-12-25"), 0);
    const nusrSale = { id: "s", soldOn: "2026-11-21", customerName: "Someone", salesperson: null };
    assert.deepEqual(soldOf({ soldOn: null, nusrSale }), { on: "2026-11-21", how: "nusr" });
    assert.deepEqual(soldOf({ soldOn: "2026-11-20", nusrSale }), { on: "2026-11-20", how: "marked" });
    assert.equal(soldOf({ soldOn: null, nusrSale: null }), null);
  });

  test("the list's filters in the address", () => {
    assert.deepEqual(parseUnitFilters({}), { status: "stock", query: "" });
    assert.deepEqual(parseUnitFilters({ status: "sold", q: "  ranger  crew " }), { status: "sold", query: "ranger crew" });
    assert.deepEqual(parseUnitFilters({ status: "nope" }), { status: "stock", query: "" });
    assert.equal(unitListHref({ status: "stock", query: "" }), "/unit-list");
    assert.equal(unitListHref({ status: "all", query: "army green" }), "/unit-list?status=all&q=army+green");
  });
});

// --- On the server ----------------------------------------------------------------

describe("on the server: looking up, adding, the list, correcting and removing", () => {
  const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
  const shopIds: string[] = [];
  let manager: CurrentUser;
  let other: CurrentUser;
  let writer: CurrentUser;
  const ids: Record<string, string> = {};

  async function person(code: string, role: "manager" | "service_writer", shop?: CurrentUser["shop"]): Promise<CurrentUser> {
    const created = shop ?? (await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name }))[0];
    if (!shop) shopIds.push(created.id);
    const id = randomUUID();
    await systemDb.insert(users).values({ id, shopId: created.id, role, name: "Morgan", username: `${created.code}.${role}`, displayUsername: role, email: `${randomUUID()}@no-email.invalid` });
    return { id, name: "Morgan", username: role, role, shop: created, bay: null };
  }

  async function sell(actor: CurrentUser, values: Partial<SaleValues>) {
    const result = await logSale(actor, { ...blankSaleValues({ soldOn: "2026-08-21", holdbackRateBp: 400, bonusRateBp: 1000 }), ...values });
    assert.ok("id" in result, JSON.stringify(result));
    return result.id;
  }

  const read = (vin: string, fields: Partial<Record<keyof UnitFields | "key" | "invoiceNumber" | "invoiceDate", string>> = {}) => ({
    key: vin,
    vin,
    unitYear: "2027",
    model: "RGR 1K XP NSULT CR ARMYG",
    modelNumber: "R27RSY99AA",
    description: "RGR-27,1K,XP,NSULT,CR,ARMYG",
    engineNumber: "1209389077163",
    receivedOn: "2026-11-09",
    cost: "34,893.00",
    listPrice: "",
    notes: "",
    invoiceNumber: "374953",
    invoiceDate: "2026-11-06",
    ...fields,
  });

  const entries = (shopId: string, targetId: string) =>
    withShop(shopId, (tx) =>
      tx
        .select({ action: auditLog.action, targetType: auditLog.targetType, targetId: auditLog.targetId, details: auditLog.details })
        .from(auditLog)
        .where(and(eq(auditLog.targetType, "stock_unit"), eq(auditLog.targetId, targetId)))
        .orderBy(asc(auditLog.createdAt), asc(auditLog.seq)),
    );

  before(async () => {
    manager = await person(`ul${suffix}`, "manager");
    other = await person(`uo${suffix}`, "manager");
    writer = await person("", "service_writer", manager.shop);
    // The shop's NUSR: a 2026 General of the same model sold before (its
    // name, in the shop's words), and the Ranger PS presold before it
    // came in.
    ids.general = await sell(manager, { customerName: "Dana Quillfeather", unitYear: "2026", unitModel: "General XP 1000 4P Premium", vin: whole("3NSGMK99_TF000999"), msrp: "33999", category: "UTV" });
    ids.presold = await sell(manager, { soldOn: "2026-11-21", customerName: "Pat Quarry", salesperson: "Lee", unitYear: "2027", unitModel: "Ranger PS", vin: RANGER_PS, msrp: "23499", category: "UTV" });
    // Polaris's model list, as imported under System Admin > Manuals.
    await systemDb.insert(manualCatalogDocuments).values({ shopId: manager.shop.id, fileName: "rgr.pdf", brand: "RGR", importId: randomUUID() });
    await systemDb.execute(sql`
      insert into manual_catalog_models (shop_id, file_key, model_year, model_number, model_description)
      values (${manager.shop.id}, 'rgr.pdf', 2027, 'A27SXE99AA', 'SPORTSMAN XP 1000 S - TITANIUM')
    `);
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  test("looking units up before any are on the list: the NUSR's name for the model, Polaris's model list, sold in the NUSR", async () => {
    const result = await lookUpUnits(manager, [
      { key: "a", vin: GENERAL, modelNumber: "G26GMK99AJ", description: "GEN-26,1K,XP,4P" },
      { key: "b", vin: RANGER_PS, modelNumber: "R27TAU99AN", description: "RGR-27,1K,PS,HTR,SPRBLUE" },
      { key: "c", vin: RANGER, modelNumber: "R27RSY99AA", description: "RGR-27,1K,XP,NSULT,CR,ARMYG" },
      { key: "d", vin: "", modelNumber: "A27SXE99AA", description: "SPM-27,XP1K,S,TITANIUM" },
    ]);
    assert.ok(!("error" in result), JSON.stringify(result));
    const [general, ps, xp, sportsman] = result.units;
    assert.deepEqual(general.model, { name: "General XP 1000 4P Premium", from: "nusr" });
    assert.equal(general.sold, null);
    // Presold: the NUSR's sale of the unit itself names it.
    assert.deepEqual(ps.model, { name: "Ranger PS", from: "nusr" });
    assert.deepEqual(sportsman.model, { name: "SPORTSMAN XP 1000 S - TITANIUM", from: "models" });
    assert.deepEqual(ps.sold && [ps.sold.id, ps.sold.soldOn, ps.sold.customerName, ps.sold.salesperson], [ids.presold, "2026-11-21", "Pat Quarry", "Lee"]);
    assert.equal(xp.model, null);
    assert.equal(xp.onList, null);
    assert.equal(xp.listPrice, null);
    // Another shop's NUSR and model list aren't this one's.
    const elsewhere = await lookUpUnits(other, [{ key: "a", vin: GENERAL, modelNumber: "G26GMK99AJ", description: null }]);
    assert.ok(!("error" in elsewhere));
    assert.equal(elsewhere.units[0].model, null);
  });

  test("adding units: each once, with the Activity log", async () => {
    const result = await addStockUnits(manager, {
      fileName: "polaris.pdf",
      units: [read(RANGER, { model: "Rngr 1000 XP NSU Crew - Army Green", listPrice: "37,399.00", notes: "On the floor" }), read(RANGER_PS, { model: "Rngr 1000 PS - Super Blue", modelNumber: "R27TAU99AN", cost: "21064", listPrice: "21999", invoiceNumber: "374952" })],
    });
    assert.ok("added" in result, JSON.stringify(result));
    assert.deepEqual(result.already, []);
    assert.deepEqual(result.added.map((one) => one.key), [RANGER, RANGER_PS]);
    ids.ranger = result.added[0].id;
    ids.ps = result.added[1].id;
    const unit = await getStockUnit(manager, ids.ranger);
    assert.ok(unit);
    assert.deepEqual(
      [unit.vin, unit.unitYear, unit.model, unit.modelNumber, unit.description, unit.engineNumber, unit.receivedOn, unit.cost, unit.listPrice, unit.soldOn, unit.notes, unit.invoiceNumber, unit.invoiceDate, unit.fileName, unit.createdBy],
      [RANGER, 2027, "Rngr 1000 XP NSU Crew - Army Green", "R27RSY99AA", "RGR-27,1K,XP,NSULT,CR,ARMYG", "1209389077163", "2026-11-09", 3489300, 3739900, null, "On the floor", "374953", "2026-11-06", "polaris.pdf", "Morgan"],
    );
    const [added] = await entries(manager.shop.id, ids.ranger);
    assert.equal(added.action, "stock_unit.added");
    const said = describeAuditEntry(added);
    assert.equal(said.summary, "Added 2027 Rngr 1000 XP NSU Crew - Army Green to the Unit List");
    assert.deepEqual(
      said.facts.map((fact) => [fact.label, fact.value]),
      [
        ["VIN", RANGER],
        ["Received", "11/9/2026"],
        ["Cost", "$34,893.00"],
        ["List Price", "$37,399.00"],
        ["Invoice", "374953"],
        ["File", "polaris.pdf"],
      ],
    );

    // Dropped again: on the list already, not added twice.
    const again = await addStockUnits(manager, { fileName: "polaris.pdf", units: [read(RANGER), read(GENERAL, { model: "General XP 1000 4P Premium", modelNumber: "G26GMK99AJ", unitYear: "2026" })] });
    assert.ok("added" in again, JSON.stringify(again));
    assert.deepEqual(again.already, [{ key: RANGER, id: ids.ranger, name: "2027 Rngr 1000 XP NSU Crew - Army Green" }]);
    assert.deepEqual(again.added.map((one) => one.key), [GENERAL]);
    ids.general = again.added[0].id;

    // Something wrong with one: nothing's added, and it says which and why.
    const wrong = await addStockUnits(manager, { units: [read(whole("4XARSY99_V8000200")), read(whole("4XARSY99_V8000201"), { receivedOn: "" }), read(whole("4XARSY99_V8000200"))] });
    assert.ok("problems" in wrong, JSON.stringify(wrong));
    assert.deepEqual(
      wrong.problems.map((problem) => [problem.key, problem.field]),
      [
        [whole("4XARSY99_V8000201"), "receivedOn"],
        [whole("4XARSY99_V8000200"), "vin"],
      ],
    );
    const [{ count }] = await withShop(manager.shop.id, (tx) => tx.select({ count: sql<number>`count(*)::int` }).from(stockUnits));
    assert.equal(count, 3);
  });

  test("looking up once units are on the list: its names and list prices, and on the list already", async () => {
    const result = await lookUpUnits(manager, [
      { key: "same", vin: RANGER, modelNumber: "R27RSY99AA", description: "RGR-27,1K,XP,NSULT,CR,ARMYG" },
      { key: "next", vin: whole("4XARSY99_V8000124"), modelNumber: "R27RSY99AA", description: "RGR-27,1K,XP,NSULT,CR,ARMYG" },
      { key: "paint", vin: whole("4XARSY99_V8000125"), modelNumber: "R27RSY99AL", description: "RGR-27,1K,XP,NSULT,CR,BLUELAB" },
    ]);
    assert.ok(!("error" in result), JSON.stringify(result));
    const [same, next, paint] = result.units;
    assert.deepEqual(same.onList, { id: ids.ranger, name: "2027 Rngr 1000 XP NSU Crew - Army Green", receivedOn: "2026-11-09", soldOn: null });
    assert.equal(next.onList, null);
    assert.deepEqual(next.model, { name: "Rngr 1000 XP NSU Crew - Army Green", from: "list" });
    assert.deepEqual(next.listPrice, { cents: 3739900, receivedOn: "2026-11-09", vin: RANGER });
    assert.deepEqual(paint.model, { name: "Rngr 1000 XP NSU Crew - BLUELAB", from: "paint" });
    assert.equal(paint.listPrice, null);
  });

  test("the list: in stock, sold (marked, or sold new in the NUSR), all, and a search", async () => {
    const today = "2026-12-01";
    const stock = await listStockUnits(manager, { status: "stock", query: "" }, today);
    assert.ok(!("error" in stock));
    // The Ranger PS is sold in the NUSR: not in stock.
    assert.deepEqual(stock.counts, { stock: 2, sold: 1 });
    assert.deepEqual(
      stock.groups.map((group) => [group.name, group.units.map((unit) => unit.vin)]),
      [
        ["2027 Rngr 1000 XP NSU Crew - Army Green", [RANGER]],
        ["2026 General XP 1000 4P Premium", [GENERAL]],
      ],
    );
    assert.deepEqual(stock.totals, { units: 2, cost: 6978600, list: 3739900, noCost: 0, noList: 1, averageDays: 22, oldestDays: 22 });

    const sold = await listStockUnits(manager, { status: "sold", query: "" }, today);
    assert.ok(!("error" in sold));
    const [ps] = sold.groups.flatMap((group) => group.units);
    assert.equal(ps.vin, RANGER_PS);
    assert.deepEqual(soldOf(ps), { on: "2026-11-21", how: "nusr" });
    assert.equal(ps.nusrSale?.customerName, "Pat Quarry");

    const all = await listStockUnits(manager, { status: "all", query: "" }, today);
    assert.ok(!("error" in all));
    assert.equal(all.shown, 3);
    const found = await listStockUnits(manager, { status: "all", query: "army 8000123" }, today);
    assert.ok(!("error" in found));
    assert.deepEqual(found.groups.flatMap((group) => group.units.map((unit) => unit.vin)), [RANGER]);
    const byNotes = await listStockUnits(manager, { status: "stock", query: "floor" }, today);
    assert.ok(!("error" in byNotes));
    assert.equal(byNotes.found, 1);
    const none = await listStockUnits(manager, { status: "stock", query: "sportsman" }, today);
    assert.ok(!("error" in none));
    assert.equal(none.shown, 0);
  });

  test("correcting a unit, marking it sold and back in stock, with the Activity log (notes by name only)", async () => {
    const unit = await getStockUnit(manager, ids.ranger);
    assert.ok(unit);
    const values = unitValues(unit);
    const saved = await updateStockUnit(manager, ids.ranger, { ...values, listPrice: "36,999", notes: "Presold to someone" });
    assert.deepEqual(saved, { ok: true, changed: true });
    assert.deepEqual(await updateStockUnit(manager, ids.ranger, { ...values, listPrice: "36,999", notes: "Presold to someone" }), { ok: true, changed: false });
    const sold = await updateStockUnit(manager, ids.ranger, { ...values, listPrice: "36,999", notes: "Presold to someone", soldOn: "2026-11-30" });
    assert.deepEqual(sold, { ok: true, changed: true });
    const stock = await listStockUnits(manager, { status: "stock", query: "" }, "2026-12-01");
    assert.ok(!("error" in stock));
    assert.deepEqual(stock.counts, { stock: 1, sold: 2 });
    const back = await updateStockUnit(manager, ids.ranger, { ...values, listPrice: "36,999", notes: "Presold to someone", soldOn: "" });
    assert.deepEqual(back, { ok: true, changed: true });

    const [, corrected, markedSold, inStock] = await entries(manager.shop.id, ids.ranger);
    assert.deepEqual(corrected.details.fields, ["listPrice", "notes"]);
    assert.ok(!JSON.stringify(corrected.details).includes("Presold"));
    const said = describeAuditEntry(corrected);
    assert.equal(said.summary, "Corrected 2027 Rngr 1000 XP NSU Crew - Army Green on the Unit List");
    assert.deepEqual(
      said.facts.map((fact) => [fact.label, fact.value]),
      [
        ["List Price", "$37,399.00 → $36,999.00"],
        ["Also changed", "notes"],
        ["VIN", RANGER],
      ],
    );
    assert.equal(describeAuditEntry(markedSold).summary, "Marked 2027 Rngr 1000 XP NSU Crew - Army Green sold on the Unit List");
    assert.equal(describeAuditEntry(inStock).summary, "Put 2027 Rngr 1000 XP NSU Crew - Army Green back in stock on the Unit List");

    // Another unit's VIN: refused, with the box it's about.
    assert.deepEqual(await updateStockUnit(manager, ids.ranger, { ...values, vin: GENERAL }), { error: `Another unit on the list has the VIN ${GENERAL}.`, field: "vin" });
    assert.deepEqual(await updateStockUnit(manager, ids.ranger, { ...values, model: "" }), { error: "Give the unit its model, as the list should show it.", field: "model" });
  });

  test("removing a unit, with the Activity log", async () => {
    const removed = await removeStockUnit(manager, ids.general);
    assert.deepEqual(removed, { ok: true, name: "2026 General XP 1000 4P Premium" });
    assert.equal(await getStockUnit(manager, ids.general), null);
    const [, gone] = await entries(manager.shop.id, ids.general);
    assert.equal(describeAuditEntry(gone).summary, "Removed 2026 General XP 1000 4P Premium from the Unit List");
    assert.deepEqual(await removeStockUnit(manager, ids.general), { error: "That unit isn't on the list. It may have been removed." });
  });

  test("kept to the shop and to managers and admins signed in with a password", async () => {
    // Another shop: can't see, open, change or remove this shop's units,
    // and has its own list (the same VIN can be on it).
    const theirs = await listStockUnits(other, { status: "all", query: "" });
    assert.ok(!("error" in theirs));
    assert.equal(theirs.shown, 0);
    assert.equal(await getStockUnit(other, ids.ranger), null);
    const unit = await getStockUnit(manager, ids.ranger);
    assert.ok(unit);
    assert.deepEqual(await updateStockUnit(other, ids.ranger, { ...unitValues(unit), listPrice: "1" }), { error: "That unit isn't on the list. It may have been removed." });
    assert.deepEqual(await removeStockUnit(other, ids.ranger), { error: "That unit isn't on the list. It may have been removed." });
    const added = await addStockUnits(other, { units: [read(RANGER)] });
    assert.ok("added" in added && added.added.length === 1, JSON.stringify(added));
    const lookup = await lookUpUnits(other, [{ key: "a", vin: RANGER, modelNumber: "R27RSY99AA", description: null }]);
    assert.ok(!("error" in lookup));
    assert.notEqual(lookup.units[0].onList?.id, ids.ranger);

    // A service writer, and a manager on a bay tablet's PIN, can't.
    const notAllowed = { error: "Only a manager or admin signed in with a password can use the Unit List." };
    assert.deepEqual(await listStockUnits(writer, { status: "stock", query: "" }), notAllowed);
    assert.deepEqual(await lookUpUnits(writer, [{ key: "a", vin: RANGER, modelNumber: null, description: null }]), notAllowed);
    assert.deepEqual(await addStockUnits(writer, { units: [read(whole("4XARSY99_V8000300"))] }), notAllowed);
    assert.deepEqual(await updateStockUnit(writer, ids.ranger, unitValues(unit)), notAllowed);
    assert.deepEqual(await removeStockUnit(writer, ids.ranger), notAllowed);
    assert.equal(await getStockUnit(writer, ids.ranger), null);
    const onTablet = { ...manager, bay: { deviceId: "d", deviceName: "Bay 1", sessionId: "s" } };
    assert.deepEqual(await listStockUnits(onTablet, { status: "stock", query: "" }), notAllowed);

    // By the database too: no reaching into another shop, and a unit never
    // changes shop or the invoice it came in on.
    const rlsDenied = (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501";
    await assert.rejects(
      withShop(other.shop.id, (tx) => tx.insert(stockUnits).values({ shopId: manager.shop.id, vin: "X1", model: "Sneaky", receivedOn: "2026-11-09" })),
      rlsDenied,
    );
    const moved = await withShop(other.shop.id, (tx) => tx.update(stockUnits).set({ listPriceCents: 1 }).where(eq(stockUnits.id, ids.ranger)).returning({ id: stockUnits.id }));
    assert.deepEqual(moved, []);
    await assert.rejects(
      withShop(manager.shop.id, (tx) => tx.update(stockUnits).set({ invoiceNumber: "999999" }).where(eq(stockUnits.id, ids.ranger))),
      rlsDenied,
    );
    await assert.rejects(
      withShop(manager.shop.id, (tx) => tx.update(stockUnits).set({ shopId: other.shop.id }).where(eq(stockUnits.id, ids.ranger))),
      rlsDenied,
    );
  });
});
