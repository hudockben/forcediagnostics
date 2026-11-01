// NUSR > Import: reading the shop's NUSR workbook (src/lib/nusr-import-
// rules.ts), on made-up sheets shaped as the Excel reader gives them: which
// sheets are NUSR sheets and which are chosen to start with, which rows are
// sales (not the spacers, year dividers, template rows, TOTAL and AVG rows
// or the comparison table), the MSRP column's markers, the Used sheet's
// rebate a column over, dates and payments as typed, the Trailers sheet's
// payment columns a column over, words where an amount goes, salesmen's and
// lenders' spellings, the rates and the figures, and a sale on two sheets
// coming in once; then saving (importSales in src/lib/nusr-import.ts):
// adding, finding sales already in the NUSR, never twice on a second run,
// tying a sale to a customer on file only by name and phone, the Activity
// log, and staying inside the shop.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, customers, shops, unitSales, users } from "../src/db/schema";
import { createCustomer } from "../src/lib/customers";
import { readSpreadsheet, type Sheet } from "../src/lib/customer-import-rules";
import { logSale, removeSale } from "../src/lib/nusr";
import { nusrWorkbook } from "../src/lib/nusr-export";
import { importSales } from "../src/lib/nusr-import";
import {
  MAX_NUSR_IMPORT_BATCH,
  importNotesCsv,
  nusrImportBatches,
  planNusrImport,
  readNusrWorkbook,
  readSheetDate,
  saleFinder,
  type NusrImportEntry,
  type NusrImportPlan,
  type PlannedSale,
} from "../src/lib/nusr-import-rules";
import { SALE_LABELS, checkSale, monthlyComparison, saleFigures, shopToday, withFigures, type SaleFields } from "../src/lib/nusr-rules";
import type { CurrentUser } from "../src/lib/session";
import { writeXlsx } from "../src/lib/xlsx-write";
import { vinCheckDigit } from "../src/lib/vin";

// The NUSR's headings, A to AM, as every sheet has them (column A has none).
const HEADINGS = [
  "", "Date", "Salesman", "Customer Name", "Address", "Phone", "Year", "Model", "New/Used", "VIN", "MSRP", "Sales Price", "Dealer Cost",
  "Unit Labor", "Polaris Rebate", "*Notes*", "Unit Profit", "Unit Profit %", "Acc. Sales Price", "Acc. Cost", "Acc. Labor", "Acc. Profit",
  "Acc. Profit %", "ESC Price", "ESC Cost", "Rewards", "Holdback", "TOTAL PROFIT", "PROFIT %", "TOTAL BONUS", "Holdback Bonus", "Sales Bonus",
  "Finance Company", "Amt Financed", "Down Pymt", "Funding Rec'd", "Date Paid", "COMS #", "Category",
];
// New and Trailers have no heading over P; on Used the rebate's heading is
// over P and O has none.
const NEW_HEADINGS = HEADINGS.map((heading, column) => (column === 15 ? "" : heading));
const USED_HEADINGS = HEADINGS.map((heading, column) => (column === 14 ? "" : column === 15 ? "Polaris Rebate" : heading));

const letterAt = (index: number) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const LETTERS = Array.from({ length: 41 }, (_, index) => letterAt(index));

// A row as the reader gives one: cells by column letter, the rest blank.
function cellsOf(values: Record<string, string>): string[] {
  const row = Array.from({ length: Math.max(0, ...Object.keys(values).map((letter) => LETTERS.indexOf(letter))) + 1 }, () => "");
  for (const [letter, value] of Object.entries(values)) row[LETTERS.indexOf(letter)] = value;
  return row;
}

// A number as the reader writes one: "1250.5", "-42.1".
const num = (n: number) => String(Number(n.toPrecision(15)));

// A sale row as the sheet has it: what was typed, and what its formulas
// make of it (Unit Profit, the Holdback at the rate, TOTAL PROFIT and the
// bonuses), unless the row gives its own.
function saleRow(values: Record<string, string>, { rate = 0.04, rebate = "O" }: { rate?: number; rebate?: "O" | "P" } = {}): string[] {
  const amount = (letter: string) => {
    const n = Number(values[letter] ?? "");
    return Number.isFinite(n) ? n : 0;
  };
  const msrp = /^\d/.test(values.K ?? "") ? Number(values.K) : null;
  const unitProfit = amount("L") - amount("M") - amount("N") + amount(rebate);
  const accProfit = amount("S") - amount("T") - amount("U");
  const holdback = values.AA !== undefined ? amount("AA") : msrp === null ? 0 : msrp * rate;
  const total = unitProfit + accProfit + amount("X") - amount("Y") + amount("Z") + holdback;
  return cellsOf({
    Q: num(unitProfit),
    V: num(accProfit),
    AA: num(holdback),
    AB: num(total),
    AD: num(total * 0.1),
    AE: num(holdback * 0.1),
    AF: num(total * 0.1 - holdback * 0.1),
    ...values,
  });
}

// A made-up VIN with its check digit worked out (the stem has _ for it).
const vin = (stem: string) => stem.replace("_", vinCheckDigit(stem.replace("_", "0"))!);

// A new unit sold by Sam, unless the row says otherwise.
const unit = (values: Record<string, string>, options?: { rate?: number; rebate?: "O" | "P" }) =>
  saleRow({ C: "Sam Teller", E: "12 Orchard Ln, Altoona, PA", F: "814-555-0199", G: "2026", H: "Rngr 1000", I: "N", K: "24999", L: "23500", M: "21250", AL: "PLA9001", ...values }, options);

const sheet = (name: string, rows: string[][], headings = HEADINGS): Sheet => ({ name, rows: [headings, ...rows] });

// Reads and plans a workbook as the page does, with the sheets chosen to
// start with (or the ones given).
function plan(sheets: Sheet[], chosen?: string[], today = "2026-10-31"): NusrImportPlan {
  const workbook = readNusrWorkbook(sheets, { today });
  return planNusrImport(
    workbook,
    workbook.sheets.filter((entry) => (chosen ? chosen.includes(entry.name) : entry.chosen)).map((entry) => entry.index),
  );
}

const only = (result: NusrImportPlan, ref: string): PlannedSale => {
  const found = result.sales.find((sale) => sale.ref === ref);
  assert.ok(found, `${ref} is planned`);
  return found;
};
const notesOn = (result: NusrImportPlan, ref: string) => result.notes.filter((note) => `${note.sheet}!${note.row}` === ref).map((note) => note.message);

describe("which sheets and rows", () => {
  test("the NUSR sheets are found; the year sheets and Trailers are chosen, New and Used offered as repeats", () => {
    const row = unit({ B: "2025-03-01", D: "Dana Whitfield", J: vin("4XARRE99_S8000001") });
    const workbook = readNusrWorkbook([
      sheet("New", [row], NEW_HEADINGS),
      sheet("Used", [], USED_HEADINGS),
      sheet("Trailers", [row], NEW_HEADINGS),
      sheet("2025", [row]),
      { name: "Price list", rows: [["Model", "Price"], ["Rngr 1000", "24999"]] },
    ]);
    assert.deepEqual(
      workbook.sheets.map(({ name, year, sales, repeats, chosen }) => [name, year, sales, repeats, chosen]),
      [
        ["New", null, 1, true, false],
        ["Used", null, 0, true, false],
        ["Trailers", null, 1, false, true],
        ["2025", 2025, 1, false, true],
      ],
    );
    // Without year sheets, New and Used are the sales themselves.
    const alone = readNusrWorkbook([sheet("New", [row], NEW_HEADINGS), sheet("Used", [], USED_HEADINGS)]);
    assert.deepEqual(alone.sheets.map((entry) => entry.chosen), [true, true]);
    // Headings a few rows down, under a title, are found too.
    assert.equal(readNusrWorkbook([{ name: "Sales", rows: [["NUSR 2026"], [], HEADINGS, row] }]).sheets[0]?.sales, 1);
  });

  test("only sale rows count: not spacers, year dividers, template rows, stray numbers, TOTAL and AVG rows or the comparison table", () => {
    const result = plan([
      sheet("2026", [
        ["", "1905-07-18"], // 2026 typed into a date cell
        unit({ B: "2026-01-02", D: "Dana Whitfield", J: vin("4XARRE99_T8000001") }),
        [],
        cellsOf({ Q: "0", R: "#DIV/0!", V: "0", W: "#DIV/0!", AB: "0", AC: "#DIV/0!", AD: "0", AE: "0", AF: "0" }),
        cellsOf({ Z: "200" }),
        unit({ A: "2", B: "2026-01-31", D: "Rhett Carver", J: vin("4XARRE99_T8000002") }),
        ["", "2026"],
        unit({ B: "2026-02-03", D: "Walt Ostrowski", J: vin("4XARRE99_T8000003") }),
        [],
        cellsOf({ B: "1900-04-11", C: "TOTAL", K: "74997", L: "70500" }),
        cellsOf({ C: "AVG TOTAL", L: "23500" }),
        cellsOf({ C: "Sam Teller" }),
        unit({ B: "2026-02-04", D: "Under The Totals", J: vin("4XARRE99_T8000004") }),
        cellsOf({ C: "Comparison", F: "2025 to 2026" }),
        cellsOf({ C: "January ", D: "12", E: "14" }),
      ]),
    ]);
    assert.deepEqual(
      result.sales.map((sale) => [sale.ref, sale.sale.customerName]),
      [
        ["2026!3", "Dana Whitfield"],
        ["2026!7", "Rhett Carver"],
        ["2026!9", "Walt Ostrowski"],
      ],
    );
    // Nothing from row 11 on is read: the sheet's TOTAL rows, which the NUSR
    // tab works out from the sales.
    assert.deepEqual(result.sheets, [{ index: 0, name: "2026", sales: 3, toAdd: 3, duplicates: 0, skipped: 0, totalsFrom: 11 }]);
    assert.deepEqual(result.notes, []);
    // New's comparison table has the month in D.
    const onNew = plan([sheet("New", [unit({ B: "2026-01-02", D: "Dana Whitfield" }), cellsOf({ D: "Comparison" }), unit({ B: "2026-01-03", D: "Pat Lee" })], NEW_HEADINGS)]);
    assert.equal(onNew.sales.length, 1);
  });

  test("a sale whose Date is blank, lost its date format or was typed some other way still counts: read, or left out with a note", () => {
    const result = plan([
      sheet("2024", [
        unit({ B: "2024-06-01", D: "Wren Calloway", J: vin("4XARRE99_R8000201") }),
        // An Excel day number without its date format.
        unit({ B: "45449", D: "Ezra Mossman", J: vin("4XARRE99_R8000202") }),
        unit({ B: "", D: "Lior Fenwright", J: vin("4XARRE99_R8000203") }),
        // No salesman or VIN, but a sales price: a sale too.
        cellsOf({ B: "June 7, 2024", D: "Tamsin Okoro", L: "9800" }),
        // A name and nothing else isn't a sale.
        cellsOf({ D: "Odalys Brightwater" }),
        unit({ B: "2024-06-08", D: "Ines Vandermeer", J: vin("4XARRE99_R8000204") }),
      ]),
    ]);
    assert.deepEqual(
      result.sales.map(({ ref, sale }) => [ref, sale.soldOn]),
      [
        ["2024!2", "2024-06-01"],
        ["2024!3", "2024-06-06"],
        ["2024!7", "2024-06-08"],
      ],
    );
    assert.deepEqual(result.sheets, [{ index: 0, name: "2024", sales: 5, toAdd: 3, duplicates: 0, skipped: 2, totalsFrom: null }]);
    assert.deepEqual(
      result.notes.map((note) => [`${note.sheet}!${note.row}`, note.kind, note.message]),
      [
        ["2024!3", "date", "Date 45449 read as the date 2024-06-06."],
        ["2024!4", "skipped", "No Date: left out."],
        ["2024!5", "skipped", "Date “June 7, 2024” isn't a day: left out."],
      ],
    );
  });

  test("a sheet hidden in the workbook is listed, marked hidden, and left out to start with", () => {
    const shown = unit({ B: "2020-05-01", D: "Wren Calloway", J: vin("4XARRE99_L8000211") });
    const hiddenRow = unit({ B: "2019-05-01", D: "Ezra Mossman", J: vin("4XARRE99_K8000212") });
    const workbook = readNusrWorkbook([
      sheet("2020", [shown]),
      { ...sheet("2019", [hiddenRow]), hidden: true },
      { name: "Lookups", rows: [["Model", "Price"]], hidden: true },
    ]);
    assert.deepEqual(
      workbook.sheets.map(({ name, sales, hidden, chosen }) => [name, sales, hidden, chosen]),
      [
        ["2020", 1, false, true],
        ["2019", 1, true, false],
      ],
    );
    // Ticked, its sales come in as any year sheet's do.
    const ticked = planNusrImport(workbook, [0, 1]);
    assert.deepEqual(
      ticked.sales.map((sale) => sale.ref),
      ["2020!2", "2019!2"],
    );
  });
});

describe("reading a sale", () => {
  test("the MSRP column says what kind of deal it is; a trade is a used unit", () => {
    const result = plan([
      sheet("2025", [
        unit({ B: "2025-04-01", D: "A Buyer", I: "U", K: "TRADE", H: "Spm 570", L: "6500", M: "6000" }),
        unit({ B: "2025-04-02", D: "B Buyer", K: "Trailer ", H: "Alcom", L: "2900", M: "2500" }),
        unit({ B: "2025-04-03", D: "C Buyer", K: "CONTEST", H: "Outlaw 110", L: "0", M: "0" }),
        unit({ B: "2025-04-04", D: "D Buyer", K: "FREE", H: "Outlaw 70", L: "0", M: "0" }),
        unit({ B: "2025-04-05", D: "E Buyer", I: "U", K: "TRAE", H: "General", L: "9000", M: "8500" }),
        unit({ B: "2025-04-06", D: "F Buyer", K: "3400", H: "6.5 x 14 Trlr", L: "3400", M: "2700" }),
        unit({ B: "2025-04-07", D: "G Buyer", K: "18000", H: "Rngr 1000", L: "17500", M: "16000" }, { rate: 0.05 }),
        unit({ B: "2025-04-08", D: "H Buyer", I: "N", K: "Trade", H: "Rngr 900", L: "10000", M: "8000" }),
        unit({ B: "2025-04-09", D: "J Buyer", I: "U", K: "18500", H: "RZR 1000", L: "17500", M: "15000", AA: "0" }),
      ]),
    ]);
    const kind = (ref: string) => {
      const { fields } = only(result, ref);
      return [fields.unitType, fields.condition, fields.category, fields.msrp, fields.holdbackRateBp];
    };
    assert.deepEqual(kind("2025!2"), ["trade", "used", "ATV", "", "0"]);
    assert.deepEqual(kind("2025!3"), ["trailer", "new", "Trailer", "", "0"]);
    assert.deepEqual(kind("2025!4"), ["contest", "new", "ATV", "", "0"]);
    assert.deepEqual(kind("2025!5"), ["free", "new", "ATV", "", "0"]);
    assert.deepEqual(kind("2025!6"), ["trade", "used", "UTV", "", "0"]);
    // A trailer with a price in the MSRP column is still a trailer, and
    // keeps the holdback the sheet worked out on it.
    assert.deepEqual(kind("2025!7"), ["trailer", "new", "Trailer", "3400.00", "4"]);
    assert.deepEqual(kind("2025!8"), ["whole_good", "new", "UTV", "18000.00", "5"]);
    assert.deepEqual(kind("2025!9"), ["trade", "used", "UTV", "", "0"]);
    assert.deepEqual(notesOn(result, "2025!9"), ["New/Used says N, but the MSRP column says Trade: imported as used."]);
    assert.deepEqual(kind("2025!10"), ["whole_good", "used", "RZR", "18500.00", "0"]);
    assert.match(notesOn(result, "2025!10")[0], /^New\/Used says U, but the MSRP column has a price/);
  });

  test("the rebate is in whichever column beside it holds a number, as on the Used sheet; words there are notes", () => {
    const used = plan([
      sheet(
        "Used",
        [
          unit({ B: "2022-03-01", D: "Dana Whitfield", L: "9000", M: "8000", P: "500" }, { rebate: "P" }),
          unit({ B: "2022-05-12", D: "Rhett Carver", L: "9000", M: "8000", O: "750" }),
          unit({ B: "2022-05-13", D: "Walt Ostrowski", L: "9000", M: "8000", O: "Price match" }),
        ],
        USED_HEADINGS,
      ),
    ]);
    assert.deepEqual(
      used.sales.map(({ fields }) => [fields.rebate, fields.notes]),
      [
        ["500.00", ""],
        ["750.00", ""],
        ["", "Price match"],
      ],
    );
    assert.deepEqual(used.notes, []);
    // On New, P has no heading: its notes, and a number there only when
    // the Unit Profit adds it.
    const onNew = plan([
      sheet(
        "New",
        [
          unit({ B: "2021-03-01", D: "Dana Whitfield", O: "1000", P: "Spring promo" }),
          unit({ B: "2021-03-02", D: "Rhett Carver", P: "250" }),
          unit({ B: "2021-03-03", D: "Walt Ostrowski", P: "250" }, { rebate: "P" }),
        ],
        NEW_HEADINGS,
      ),
    ]);
    assert.deepEqual(
      onNew.sales.map(({ fields }) => [fields.rebate, fields.notes]),
      [
        ["1000.00", "Spring promo"],
        ["", "Polaris Rebate: 250"],
        ["250.00", ""],
      ],
    );
    assert.match(notesOn(onNew, "New!3")[0], /^Polaris Rebate “250” isn't the rebate this row's Unit Profit adds/);
  });

  test("words where an amount goes are kept in the notes, after the sheet's own; a dot typed twice is read", () => {
    const result = plan([
      sheet("2024", [
        unit({
          B: "2024-10-26",
          D: "Dana Whitfield",
          N: "pending rebate",
          P: "Spring promo",
          Z: "See office",
          AI: "18250..75",
          AN: "In stock UTV",
          AO: "Checked 8/6/24",
        }),
        unit({ B: "2024-10-27", D: "Rhett Carver", AI: "A/R", S: "#REF!" }),
      ]),
    ]);
    const first = only(result, "2024!2").fields;
    assert.equal(first.notes, "Spring promo | In stock UTV | Checked 8/6/24 | Unit Labor: pending rebate | Rewards: See office");
    assert.deepEqual([first.unitLabor, first.rewards, first.downPayment], ["", "", "18250.75"]);
    assert.deepEqual(notesOn(result, "2024!2"), [
      "Unit Labor “pending rebate” isn't an amount: put in the notes.",
      "Rewards “See office” isn't an amount: put in the notes.",
      "Down Pymt “18250..75” read as 18250.75.",
    ]);
    const second = only(result, "2024!3").fields;
    assert.deepEqual([second.notes, second.downPayment, second.accPrice], ["Down Pymt: A/R", "", ""]);
    assert.ok(notesOn(result, "2024!3").includes("Acc. Sales Price shows #REF!: left blank."));
  });

  test("VINs are upper-cased; NONE is none; one that can't be right is kept, with a note", () => {
    const whole = vin("4XARRE99_L8000005");
    const wrongDigit = whole.slice(0, 8) + (whole[8] === "1" ? "2" : "1") + whole.slice(9);
    const result = plan([
      sheet("2020", [
        unit({ B: "2020-05-01", D: "A Buyer", J: ` ${whole.slice(0, 8).toLowerCase()} ${whole.slice(8)} ` }),
        unit({ B: "2020-05-02", D: "B Buyer", J: "NONE" }),
        unit({ B: "2020-05-03", D: "C Buyer", J: whole.slice(0, 16) }),
        unit({ B: "2020-05-04", D: "D Buyer", J: wrongDigit }),
        unit({ B: "2020-05-05", D: "E Buyer", J: whole.replace(/0/g, "O") }),
      ]),
    ]);
    assert.deepEqual(
      result.sales.map(({ fields }) => fields.vin),
      [whole, "", whole.slice(0, 16), wrongDigit, whole],
    );
    assert.deepEqual(notesOn(result, "2020!3"), ["VIN “NONE”: left blank."]);
    assert.deepEqual(notesOn(result, "2020!4"), [`VIN ${whole.slice(0, 16)} has 16 characters (a whole VIN has 17): kept as typed.`]);
    assert.match(notesOn(result, "2020!5")[0], /its check digit \(the 9th character\) doesn't match the rest/);
    assert.match(notesOn(result, "2020!6")[0], /has an I, O or Q, which a VIN never has: read as/);
  });

  test("salesmen and lenders go by the name most rows give them", () => {
    const rows = [
      ...["Sam Teller", "Sam Teller", "Sam Teller", "Sam Teller", "Sam Teller", "sam  teller", "Sam Tellr"].map((salesman, at) =>
        unit({ B: `2023-02-${String(at + 1).padStart(2, "0")}`, C: salesman, D: `Buyer ${at}`, AG: "Keystone Finance" }),
      ),
      unit({ B: "2023-03-01", C: "Robin Hale", D: "Buyer R1", AG: "Keystone Finance Co" }),
      unit({ B: "2023-03-02", C: "Robin Hale", D: "Buyer R2", AG: "Keystne Finance" }),
      unit({ B: "2023-03-03", C: "Robin", D: "Buyer R3", AG: "-" }),
      unit({ B: "2023-03-04", C: "Dale Kent", D: "Buyer C1", AG: "0" }),
      unit({ B: "2023-03-05", C: "Dale Moss", D: "Buyer C2", AG: "Keystone Finance " }),
      unit({ B: "2023-03-06", C: "Dale", D: "Buyer C3" }),
    ];
    const result = plan([sheet("2023", rows)]);
    assert.deepEqual(
      result.sales.map(({ fields }) => [fields.salesperson, fields.financeCompany]),
      [
        ...Array.from({ length: 7 }, () => ["Sam Teller", "Keystone Finance"]),
        ["Robin Hale", "Keystone Finance"],
        ["Robin Hale", "Keystone Finance"],
        ["Robin Hale", ""],
        ["Dale Kent", ""],
        ["Dale Moss", "Keystone Finance"],
        // "Dale" could be either: left as it is.
        ["Dale", ""],
      ],
    );
    assert.deepEqual(
      result.notes.filter((note) => note.kind === "name").map((note) => note.message),
      [
        "Salesman “Sam Tellr” read as Sam Teller, as most rows have it.",
        "Finance Company “Keystone Finance Co” read as Keystone Finance, as most rows have it.",
        "Finance Company “Keystne Finance” read as Keystone Finance, as most rows have it.",
        "Salesman “Robin” read as Robin Hale, as most rows have it.",
      ],
    );
  });

  test("a look-alike of a much more common name is that one only as a one-sale slip of 8 letters or more; otherwise it's kept, noted", () => {
    const day = (at: number) => `2022-0${1 + Math.floor(at / 28)}-${String((at % 28) + 1).padStart(2, "0")}`;
    const rows = [
      ...Array.from({ length: 10 }, (_, at) => unit({ B: day(at), C: "Corwin Haldane", D: `Buyer ${at}`, AG: "QNB" })),
      ...Array.from({ length: 10 }, (_, at) => unit({ B: day(at + 10), C: "Abe", D: `Buyer ${at + 10}` })),
      // Two sales each: someone else a letter or two off, maybe.
      unit({ B: day(20), C: "Corwyn Haldane", D: "Buyer 20", AG: "ZNB" }),
      unit({ B: day(21), C: "Corwyn Haldane", D: "Buyer 21", AG: "ZNB" }),
      unit({ B: day(22), C: "Ade", D: "Buyer 22" }),
      unit({ B: day(23), C: "Ade", D: "Buyer 23" }),
      // One sale each: a slip, when it's long enough to tell.
      unit({ B: day(24), C: "Corwin Haldame", D: "Buyer 24" }),
      unit({ B: day(25), C: "Abd", D: "Buyer 25" }),
    ];
    // The slip's row copied onto New is still the one sale.
    const result = plan([sheet("2022", rows), sheet("New", [rows[24]], NEW_HEADINGS)], ["2022"]);
    const named = (ref: string) => [only(result, ref).fields.salesperson, only(result, ref).fields.financeCompany];
    assert.deepEqual(named("2022!22"), ["Corwyn Haldane", "ZNB"]);
    assert.deepEqual(named("2022!24"), ["Ade", ""]);
    assert.deepEqual(named("2022!26"), ["Corwin Haldane", ""]);
    assert.deepEqual(named("2022!27"), ["Abd", ""]);
    assert.deepEqual(
      result.notes.filter((note) => note.kind === "name").map((note) => `${note.sheet}!${note.row}: ${note.message}`),
      [
        "2022!22: Salesman “Corwyn Haldane” may be Corwin Haldane: kept as typed (2 sales).",
        "2022!22: Finance Company “ZNB” may be QNB: kept as typed (2 sales).",
        "2022!24: Salesman “Ade” may be Abe: kept as typed (2 sales).",
        "2022!26: Salesman “Corwin Haldame” read as Corwin Haldane, as most rows have it.",
        "2022!27: Salesman “Abd” may be Abe: kept as typed.",
      ],
    );
  });

  test("the holdback and bonus rates are the sheet's own; a Sales Bonus changed by hand is kept as an adjustment", () => {
    const result = plan([
      sheet("2019", [
        unit({ B: "2019-08-01", D: "A Buyer", K: "18000", L: "17500", M: "16000", O: "500" }, { rate: 0.05 }),
        unit({ B: "2019-08-02", D: "B Buyer", K: "18000", L: "17500", M: "16000", O: "500" }, { rate: 0.07 }),
        // A new unit with no holdback on the sheet.
        unit({ B: "2019-08-03", D: "C Buyer", K: "47000", L: "45000", M: "44000", AA: "" }),
        // A loss deal whose bonus the sheet zeroed.
        unit({ B: "2019-09-11", D: "D Buyer", K: "17000", L: "13000", M: "15500", O: "1000", AD: "0", AE: "0", AF: "0" }, { rate: 0.05 }),
        // Sales Bonus = TOTAL BONUS - Holdback Bonus - 100.
        unit({ B: "2019-08-24", D: "E Buyer", K: "20000", L: "19000", M: "18500", O: "1000", AF: "50" }, { rate: 0.05 }),
      ]),
    ]);
    const rates = result.sales.map(({ fields }) => [fields.holdbackRateBp, fields.bonusRateBp, fields.bonusAdjustment]);
    assert.deepEqual(rates, [
      ["5", "10", ""],
      ["7", "10", ""],
      ["0", "10", ""],
      ["5", "0", ""],
      ["5", "10", "-100.00"],
    ]);
    assert.deepEqual(notesOn(result, "2019!4"), ["No Holdback on the sheet for this new whole good: imported with none."]);
    assert.deepEqual(notesOn(result, "2019!6"), ["Sales Bonus on the sheet is $100.00 less than TOTAL BONUS less Holdback Bonus: kept as a bonus adjustment of -$100.00."]);
    // Worked out again, the figures are the sheet's.
    const adjusted = saleFigures(only(result, "2019!6").sale);
    assert.deepEqual([adjusted.totalProfit, adjusted.totalBonus, adjusted.holdbackBonus, adjusted.salesBonus], [250000, 25000, 10000, 5000]);
    assert.equal(saleFigures(only(result, "2019!5").sale).salesBonus, 0);
  });

  test("a figure the sheet worked out from the wrong row is noted; the log works it out from the row", () => {
    const result = plan([
      sheet("2020", [
        unit({ B: "2020-08-04", D: "A Buyer", I: "U", K: "TRADE", L: "6000", M: "4500", AB: "1800", AD: "180", AF: "180" }),
        unit({ B: "2020-09-01", D: "B Buyer", K: "9000", L: "8500", M: "8800", O: "900", Z: "300", Q: "0" }),
      ]),
    ]);
    assert.deepEqual(notesOn(result, "2020!2"), [
      "Worked out from the row's amounts: TOTAL PROFIT $1,500.00 (the sheet has $1,800.00) and Sales Bonus $150.00 (the sheet has $180.00).",
    ]);
    assert.match(notesOn(result, "2020!3")[0], /^Worked out from the row's amounts: Unit Profit \$600\.00 \(the sheet has \$0\.00\)/);
    assert.equal(saleFigures(only(result, "2020!2").sale).totalProfit, 150000);
  });
});

describe("dates and payments", () => {
  test("dates as typed, slips and all", () => {
    const day = (text: string) => {
      const read = readSheetDate(text);
      return read && `${read.date.year}-${String(read.date.month).padStart(2, "0")}-${String(read.date.day).padStart(2, "0")}${read.typed ? " typed" : ""}`;
    };
    assert.equal(day("2024-06-14"), "2024-06-14");
    assert.equal(day("2024-06-14 00:00"), "2024-06-14");
    assert.equal(day("0614/24"), "2024-06-14 typed");
    assert.equal(day("6/14/2/4"), "2024-06-14 typed");
    assert.equal(day("06/14//24"), "2024-06-14 typed");
    assert.equal(day("006/14/24"), "2024-06-14 typed");
    assert.equal(day("6/14/2024"), "2024-06-14 typed");
    for (const wrong of ["06/314/24", "0/14/24", "066/14/24", "6/14/224", "2026", "pending", "6/14"]) assert.equal(day(wrong), null, wrong);
  });

  test("a year sheet's date in another year takes the sheet's year when it fits between the rows around it", () => {
    const result = plan([
      sheet("2017", [
        unit({ B: "2016-12-30", D: "Late Entry", J: vin("4XARRE99_H8000001") }),
        unit({ B: "2017-01-03", D: "A Buyer" }),
        unit({ B: "2017-06-20", D: "B Buyer" }),
        unit({ B: "2016-06-25", D: "C Buyer" }),
        unit({ B: "2017-06-30", D: "D Buyer" }),
        unit({ B: "0914/17", D: "E Buyer" }),
        unit({ B: "2017-12-28", D: "F Buyer" }),
        unit({ B: "1917-12-30", D: "G Buyer" }),
        unit({ B: "09/314/17", D: "H Buyer" }),
      ]),
    ]);
    assert.deepEqual(
      result.sales.map(({ ref, sale }) => [ref, sale.soldOn]),
      [
        ["2017!2", "2016-12-30"],
        ["2017!3", "2017-01-03"],
        ["2017!4", "2017-06-20"],
        ["2017!5", "2017-06-25"],
        ["2017!6", "2017-06-30"],
        ["2017!7", "2017-09-14"],
        ["2017!8", "2017-12-28"],
        ["2017!9", "2017-12-30"],
      ],
    );
    assert.deepEqual(notesOn(result, "2017!2"), [
      "Date 2016-12-30 is on the 2017 sheet, but in 2017 it wouldn't fall between the rows around it: kept as 2016-12-30. Check it.",
    ]);
    assert.deepEqual(notesOn(result, "2017!5"), ["Date 2016-06-25 is on the 2017 sheet: read as 2017-06-25."]);
    assert.deepEqual(notesOn(result, "2017!7"), ["Date “0914/17” read as 2017-09-14."]);
    assert.deepEqual(notesOn(result, "2017!9"), ["Date 1917-12-30 is on the 2017 sheet: read as 2017-12-30."]);
    assert.deepEqual(notesOn(result, "2017!10"), ["Date “09/314/17” isn't a day: left out."]);
    assert.deepEqual(result.sheets[0], { index: 0, name: "2017", sales: 9, toAdd: 8, duplicates: 0, skipped: 1, totalsFrom: null });
  });

  test("Funding Rec'd and Date Paid: N/A and dashes are none; slips, Excel's day numbers and times read; the rest left blank", () => {
    const result = plan([
      sheet("2024", [
        unit({ B: "2024-04-12", D: "A Buyer", I: "U", K: "Trade", AJ: "N/A", AK: "-", AL: "N/A" }),
        unit({ B: "2024-04-12", D: "B Buyer", AJ: "0416/24", AK: "004/26/24" }),
        unit({ B: "2024-04-13", D: "C Buyer", AJ: "45394", AK: "00:00" }),
        unit({ B: "2024-04-14", D: "D Buyer", AJ: "04/316/24", AK: "1944-04-15" }),
        unit({ B: "2024-04-15", D: "E Buyer", AJ: "2026-12-09", AK: "2022-01-01" }),
        unit({ B: "2024-04-16", D: "F Buyer", AI: "2024-04-17" }),
        unit({ B: "2024-04-17", D: "G Buyer", AI: "4/18/24", AJ: "2024-04-19" }),
      ]),
    ]);
    const payment = (ref: string) => {
      const { fields } = only(result, ref);
      return [fields.fundingReceivedOn, fields.paidOn, fields.comsNumber, fields.downPayment];
    };
    assert.deepEqual(payment("2024!2"), ["", "", "", ""]);
    assert.deepEqual(notesOn(result, "2024!2"), []);
    assert.deepEqual(payment("2024!3"), ["2024-04-16", "2024-04-26", "PLA9001", ""]);
    assert.deepEqual(notesOn(result, "2024!3"), ["Funding Rec'd “0416/24” read as 2024-04-16.", "Date Paid “004/26/24” read as 2024-04-26."]);
    assert.deepEqual(payment("2024!4"), ["2024-04-12", "", "PLA9001", ""]);
    assert.deepEqual(notesOn(result, "2024!4"), ["Funding Rec'd 45394 read as the date 2024-04-12.", "Date Paid holds only a time (00:00): left blank."]);
    assert.deepEqual(payment("2024!5"), ["", "", "PLA9001", ""]);
    assert.deepEqual(notesOn(result, "2024!5"), ["Funding Rec'd “04/316/24” isn't a date: left blank.", "Date Paid 1944-04-15 can't be right: left blank."]);
    assert.deepEqual(payment("2024!6"), ["2026-12-09", "2022-01-01", "PLA9001", ""]);
    assert.deepEqual(notesOn(result, "2024!6"), ["Funding Rec'd 2026-12-09 is in the future: check it.", "Date Paid 2022-01-01 is 2 years before the sale: check it."]);
    // A date typed in Down Pymt is the funding date when there isn't one.
    assert.deepEqual(payment("2024!7"), ["2024-04-17", "", "PLA9001", ""]);
    assert.deepEqual(notesOn(result, "2024!7"), ["Down Pymt holds a date, 2024-04-17: read as Funding Rec'd."]);
    assert.deepEqual(payment("2024!8"), ["2024-04-19", "", "PLA9001", ""]);
    assert.equal(only(result, "2024!8").fields.notes, "Down Pymt: 4/18/24");
  });

  test("on the Trailers sheet's first rows Date Paid and COMS # are a column to the left", () => {
    const result = plan([
      sheet(
        "Trailers",
        [
          unit({ B: "2015-06-22", D: "A Buyer", H: "Trailer", K: "TRAILER", L: "2300", M: "1800", AI: "2300", AJ: "2015-06-24", AK: "PLA9090", AL: "" }),
          unit({ B: "2016-12-31", D: "B Buyer", H: "Trailer 6.5 x 14", K: "TRAILER", L: "2900", M: "2500", AI: "2500", AJ: "", AK: "S & T Bank", AL: "" }),
          unit({ B: "2025-09-30", D: "C Buyer", H: "6.5 x 12 trailer", K: "Trailer", L: "3900", M: "3000", AJ: "2025-09-30", AK: "2025-06-01", AL: "Ck #1234" }),
        ],
        NEW_HEADINGS,
      ),
    ]);
    assert.deepEqual(
      result.sales.map(({ fields }) => [fields.fundingReceivedOn, fields.paidOn, fields.comsNumber]),
      [
        ["", "2015-06-24", "PLA9090"],
        ["", "", "S & T Bank"],
        ["2025-09-30", "2025-06-01", "Ck #1234"],
      ],
    );
    assert.deepEqual(notesOn(result, "Trailers!2"), [
      "Date Paid and COMS # are a column to the left, as on the sheet's first rows: read as Date Paid 2015-06-24 and COMS # PLA9090.",
    ]);
    assert.deepEqual(notesOn(result, "Trailers!3"), [
      "Date Paid and COMS # are a column to the left, as on the sheet's first rows: read as COMS # S & T Bank, with no Date Paid.",
    ]);
  });
});

describe("a sale on two sheets", () => {
  const dana = vin("4XARRE99_S8000101");
  const rhett = vin("4XARRE99_S8000102");
  const walt = vin("4XARRE99_S8000103");
  const resold = vin("4XARRE99_S8000104");
  const farm = [vin("3NSRGE99_S8000201"), vin("3NSRGE99_S8000202"), vin("3NSRGE99_S8000203"), vin("3NSRGE99_S8000204")];
  const year = sheet("2025", [
    unit({ B: "2025-03-01", D: "Dana Whitfield", J: dana }),
    unit({ B: "2025-03-02", D: "Rhett Carver", J: rhett }),
    unit({ B: "2025-03-03", D: "Walt Ostrowski", J: walt, L: "15000" }),
    unit({ B: "2025-03-10", D: "Pat Lee", J: resold, L: "12000" }),
    // Three of a model bought together: three sales.
    ...farm.slice(0, 3).map((farmVin) => unit({ B: "2025-04-01", D: "Hollow Creek Farms", J: farmVin, H: "Rngr 570", L: "11999" })),
    unit({ B: "2025-05-01", D: "Mara Quinlan", J: "", H: "Rngr 500", L: "9499" }),
  ]);
  const trailers = sheet(
    "Trailers",
    [
      unit({ B: "2025-03-01", D: "Dana Whitfield", J: dana }),
      unit({ B: "2016-07-01", D: "Gus Abernathy", J: vin("5WFBU141_GW060001"), H: "6.5 x 14 Trlr", K: "TRAILER", L: "2900", M: "2500" }),
    ],
    NEW_HEADINGS,
  );
  const repeats = sheet(
    "New",
    [
      // The date typed a day off: the same VIN, sold to the same customer.
      unit({ B: "2025-03-03", D: "Rhett Carver", J: rhett }),
      // A VIN typed wrong (its check digit doesn't match): the same
      // customer and price within a week.
      unit({ B: "2025-03-05", D: "Walt Ostrowski", J: walt.slice(0, 16) + (walt[16] === "1" ? "2" : "1"), L: "15000" }),
      // Another sale's VIN copied in: still the same customer and price.
      unit({ B: "2025-03-10", D: "Pat Lee", J: dana, L: "12000" }),
      ...farm.slice(0, 2).map((farmVin) => unit({ B: "2025-04-01", D: "Hollow Creek Farms", J: farmVin, H: "Rngr 570", L: "11999" })),
      // A fourth unit no year sheet has, with a VIN of its own.
      unit({ B: "2025-04-01", D: "Hollow Creek Farms", J: farm[3], H: "Rngr 570", L: "11999" }),
      unit({ B: "2025-05-02", D: "Mara Quinlan", J: "", H: "Rngr 500", L: "9499" }),
    ],
    NEW_HEADINGS,
  );

  test("it comes in once, from its year sheet; a customer's several units stay several", () => {
    const result = plan([repeats, trailers, year], ["2025", "Trailers", "New"]);
    assert.deepEqual(
      result.sheets.map(({ name, sales, toAdd, duplicates }) => [name, sales, toAdd, duplicates]),
      [
        ["2025", 8, 8, 0],
        ["Trailers", 2, 1, 1],
        ["New", 7, 1, 6],
      ],
    );
    assert.deepEqual(
      result.notes.filter((note) => note.kind === "duplicate").map((note) => `${note.sheet}!${note.row}: ${note.message}`),
      [
        "Trailers!2: Already on the 2025 sheet, row 2 (the same VIN, sold the same day): left out.",
        "New!2: Already on the 2025 sheet, row 3 (the same VIN, sold to the same customer): left out.",
        "New!3: Already on the 2025 sheet, row 4 (the same customer and sales price, within a week): left out.",
        "New!4: Already on the 2025 sheet, row 5 (the same customer and sales price, within a week): left out.",
        "New!5: Already on the 2025 sheet, row 6 (the same VIN, sold the same day): left out.",
        "New!6: Already on the 2025 sheet, row 7 (the same VIN, sold the same day): left out.",
        "New!8: Already on the 2025 sheet, row 9 (the same customer and sales price, within a week): left out.",
      ],
    );
    assert.deepEqual(
      result.sales.filter((sale) => sale.sheet !== "2025").map((sale) => sale.ref),
      ["Trailers!3", "New!7"],
    );
    // The duplicates' own notes (the VIN typed wrong) aren't the import's.
    assert.deepEqual(notesOn(result, "New!3"), ["Already on the 2025 sheet, row 4 (the same customer and sales price, within a week): left out."]);
  });

  test("New and Used left out to start with; without the year sheet, its sales come from the others", () => {
    assert.deepEqual(
      plan([repeats, trailers, year]).sheets.map((entry) => entry.name),
      ["2025", "Trailers"],
    );
    const without = plan([repeats, trailers, year], ["Trailers", "New"]);
    assert.deepEqual(
      without.sheets.map(({ name, toAdd, duplicates }) => [name, toAdd, duplicates]),
      [
        ["Trailers", 2, 0],
        ["New", 7, 0],
      ],
    );
  });

  test("ticked, New and Used leave out a row with the year sheet's customer that day, New one with a VIN it sold new; what they add is noted", () => {
    const sold = vin("4XARRE99_S8000301");
    const traded = vin("4XARRE99_P8000302");
    const pair = [vin("3NSRGE99_S8000303"), vin("3NSRGE99_S8000304")];
    const yearSheet = sheet("2025", [
      unit({ B: "2025-06-02", D: "Petra Lindgren", J: sold, L: "20000" }),
      // A unit traded in, sold again used.
      unit({ B: "2025-06-03", D: "Oren Castellano", I: "U", K: "TRADE", J: traded, H: "Fieldrunner 900", L: "9000", M: "8000" }),
      unit({ B: "2025-06-04", D: "Farrow Orchards", J: pair[0], H: "Fieldrunner 600", L: "11999" }),
    ]);
    const newSheet = sheet(
      "New",
      [
        // The same deal with its VIN typed a character long and its price off.
        unit({ B: "2025-06-02", D: "Petra Lindgren", J: `${sold}7`, L: "20500" }),
        // The year sheet's new unit, sold new to someone else before: an unwound deal.
        unit({ B: "2025-05-20", D: "Gideon Fairweather", J: sold }),
        // The traded unit's own sale new, which the year sheets don't have.
        unit({ B: "2021-04-10", D: "Mabel Dunmore", J: traded, L: "15000" }),
        // A second unit bought that day, with a whole VIN of its own.
        unit({ B: "2025-06-04", D: "Farrow Orchards", J: pair[1], H: "Fieldrunner 600", L: "11999" }),
      ],
      NEW_HEADINGS,
    );
    const usedSheet = sheet(
      "Used",
      [
        // Only the customer, day and model filled in.
        cellsOf({ B: "2025-06-03", D: "Oren Castellano", H: "Fieldrunner 900" }),
        // The same deal with its VIN and price typed differently.
        unit({ B: "2025-06-03", D: "Oren Castellano", I: "U", K: "TRADE", J: traded.slice(0, 16), L: "9100", M: "8000" }),
        // The new unit back in trade and sold again: on Used a VIN isn't one sale.
        unit({ B: "2025-09-15", D: "Lena Vasquez", I: "U", K: "TRADE", J: sold, L: "15000", M: "14000" }),
      ],
      USED_HEADINGS,
    );
    const result = plan([yearSheet, newSheet, usedSheet], ["2025", "New", "Used"]);
    assert.deepEqual(
      result.sheets.map(({ name, sales, toAdd, duplicates }) => [name, sales, toAdd, duplicates]),
      [
        ["2025", 3, 3, 0],
        ["New", 4, 2, 2],
        ["Used", 3, 1, 2],
      ],
    );
    assert.deepEqual(
      result.notes.filter((note) => note.kind === "duplicate").map((note) => `${note.sheet}!${note.row}: ${note.message}`),
      [
        "New!2: Already on the 2025 sheet, row 2 (the same customer the same day): left out.",
        "New!3: Already on the 2025 sheet, row 2 (the same VIN, sold new): left out.",
        "Used!2: Already on the 2025 sheet, row 3 (the same customer the same day, one of them with no sales price): left out.",
        "Used!3: Already on the 2025 sheet, row 3 (the same customer the same day): left out.",
      ],
    );
    assert.deepEqual(
      result.notes.filter((note) => note.kind === "repeat").map((note) => `${note.sheet}!${note.row}`),
      ["New!4", "New!5", "Used!4"],
    );
    assert.match(notesOn(result, "New!4")[0], /^No year sheet has this sale, but New repeats them: it may be one of theirs .* Check it\.$/);
    // Without a year sheet in the import there's nothing for them to repeat.
    const alone = plan([yearSheet, newSheet, usedSheet], ["New", "Used"]);
    assert.deepEqual(
      alone.sheets.map(({ name, toAdd, duplicates }) => [name, toAdd, duplicates]),
      [
        ["New", 4, 0],
        ["Used", 3, 0],
      ],
    );
    assert.equal(alone.notes.filter((note) => note.kind === "repeat").length, 0);
  });

  test("every planned sale has its sheet and row and fields the form takes, in batches small enough to send", () => {
    const result = plan([repeats, trailers, year], ["2025", "Trailers", "New"]);
    for (const planned of result.sales) {
      assert.match(planned.ref, /^(?:2025|Trailers|New)!\d+$/);
      assert.equal(planned.ref, `${planned.sheet}!${planned.row}`);
      assert.deepEqual(Object.keys(planned.fields).sort(), Object.keys(SALE_LABELS).sort());
      assert.deepEqual(checkSale(planned.fields), { sale: planned.sale });
    }
    const many = Array.from({ length: 600 }, (_, at) => ({ ...result.sales[0], ref: `2025!${at + 2}`, fields: { ...result.sales[0].fields, notes: "x".repeat(1500) } }));
    const batches = nusrImportBatches(many);
    assert.ok(batches.length > 1);
    assert.equal(batches.flat().length, 600);
    for (const batch of batches) {
      assert.ok(batch.length <= MAX_NUSR_IMPORT_BATCH);
      assert.ok(JSON.stringify(batch).length < 300 * 1024, "well under the 1 MB limit");
      assert.deepEqual(Object.keys(batch[0]), ["ref", "fields"]);
    }
  });

  test("the notes download as CSV, by sheet and row", () => {
    const csv = importNotesCsv([
      { sheet: "2026", row: 43, kind: "unit", message: "New/Used says N, but the MSRP column says Trade: imported as used.", skipped: false },
      { sheet: "=Sheet", row: 2, kind: "amount", message: "Unit Labor “pending, hero” isn't an amount: put in the notes.", skipped: false },
    ]);
    assert.equal(
      csv,
      "﻿Sheet,Row,About,What happened\r\n" +
        "2026,43,\"New/Used, type and category\",\"New/Used says N, but the MSRP column says Trade: imported as used.\"\r\n" +
        "'=Sheet,2,Amounts,\"Unit Labor “pending, hero” isn't an amount: put in the notes.\"\r\n",
    );
  });

  test("finding a sale again: the same row only for the same unit or customer; two whole VINs are two units", () => {
    const finder = saleFinder([
      { ref: "2026!374", vin: dana, soldOn: "2026-10-28", customerName: "Dana Whitfield", salesPrice: 950000 },
      { ref: null, vin: farm[0], soldOn: "2026-04-01", customerName: "Hollow Creek Farms", salesPrice: 1199900 },
    ]);
    const find = (sale: Parameters<typeof finder.find>[0]) => {
      const found = finder.find(sale);
      return found.match ? found.how : found.refTaken ? "refTaken" : null;
    };
    assert.equal(find({ ref: "2026!374", vin: dana, soldOn: "2026-10-29", customerName: "Dana Whitfield", salesPrice: 950000 }), "ref");
    // The file changed: that row is another sale now.
    assert.equal(find({ ref: "2026!374", vin: rhett, soldOn: "2026-10-30", customerName: "Rhett Carver", salesPrice: 1000000 }), "refTaken");
    assert.equal(find({ ref: "2026!9", vin: dana, soldOn: "2026-10-28", customerName: "Somebody Else", salesPrice: 1 }), "vinDay");
    assert.equal(find({ ref: null, vin: dana, soldOn: "2027-01-02", customerName: "dana whitfield", salesPrice: 1 }), "vinCustomer");
    assert.equal(find({ ref: null, vin: null, soldOn: "2026-04-06", customerName: "Hollow Creek Farms, Inc", salesPrice: 1199900 }), null);
    assert.equal(find({ ref: null, vin: null, soldOn: "2026-04-06", customerName: "Hollow Creek Farms", salesPrice: 1199900 }), "customerPrice");
    assert.equal(find({ ref: null, vin: null, soldOn: "2026-04-09", customerName: "Hollow Creek Farms", salesPrice: 1199900 }), null);
    assert.equal(find({ ref: null, vin: farm[1], soldOn: "2026-04-01", customerName: "Hollow Creek Farms", salesPrice: 1199900 }), null);
    // A VIN typed wrong is the same unit: a character off, or with
    // something typed in front of it; one that's nothing like it isn't.
    assert.equal(find({ ref: null, vin: farm[0].slice(0, 16), soldOn: "2026-04-01", customerName: "Hollow Creek Farms", salesPrice: 1199900 }), "customerPrice");
    assert.equal(find({ ref: null, vin: `N0${farm[0]}`, soldOn: "2026-04-01", customerName: "Hollow Creek Farms", salesPrice: 1199900 }), "customerPrice");
    assert.equal(find({ ref: null, vin: "3NSVDE9920HF79278", soldOn: "2026-04-01", customerName: "Hollow Creek Farms", salesPrice: 1199900 }), null);
  });

  test("a sale on file is found by the customer rules once an import, and on its own sheet only once the rows have moved", () => {
    const ids = Array.from({ length: 4 }, () => randomUUID());
    const onFile = (id: string, ref: string | null, customerName: string, thisImport = false) => ({
      ref,
      vin: null,
      soldOn: "2024-06-03",
      customerName,
      salesPrice: 1199900,
      onFile: { id, thisImport },
    });
    // Typed in; from an earlier import of the 2024 sheet; from this import;
    // typed in and found by an earlier batch of this import.
    const finder = saleFinder(
      [onFile(ids[0], null, "Quenby Marchetti"), onFile(ids[1], "2024!2", "Tobiah Ferncastle"), onFile(ids[2], "2024!3", "Linnet Okonkwo", true), onFile(ids[3], null, "Ysolde Penhallow")],
      [ids[3]],
    );
    const find = (ref: string, customerName: string) => {
      const found = finder.find({ ref, vin: null, soldOn: "2024-06-04", customerName, salesPrice: 1199900 });
      return found.match ? `${found.how} ${found.match.onFile?.id}` : found.refTaken ? "refTaken" : null;
    };
    // Found once: the customer's second unit is another sale.
    assert.equal(find("2024!40", "Quenby Marchetti"), `customerPrice ${ids[0]}`);
    assert.equal(find("2024!41", "Quenby Marchetti"), null);
    assert.equal(find("2024!42", "Ysolde Penhallow"), null);
    // An earlier import's sale of the same sheet: not while the rows are
    // where they were, but once its row is another sale's.
    assert.equal(find("2024!9", "Tobiah Ferncastle"), null);
    assert.equal(find("2024!2", "Wren Calloway"), "refTaken");
    assert.equal(find("2024!9", "Tobiah Ferncastle"), `customerPrice ${ids[1]}`);
    // This import's own is another row of the file: on another sheet only.
    assert.equal(find("2024!8", "Linnet Okonkwo"), null);
    assert.equal(find("New!8", "Linnet Okonkwo"), `customerPrice ${ids[2]}`);
  });
});

describe("a big workbook", () => {
  test("is read once in well under two seconds, and planning again as sheets are ticked is quick", () => {
    const year = (name: string, count: number) =>
      sheet(
        name,
        Array.from({ length: count }, (_, at) =>
          unit({ B: `${name}-${String((at % 12) + 1).padStart(2, "0")}-${String((at % 28) + 1).padStart(2, "0")}`, D: `Buyer ${at}`, J: vin(`4XARRE99_${name.slice(2)}${String(at).padStart(6, "0")}`.slice(0, 17)) }),
        ),
      );
    const sheets = [...Array.from({ length: 12 }, (_, at) => year(String(2015 + at), 400)), year("2026", 400)];
    sheets.push({ ...sheets[0], name: "New", rows: [NEW_HEADINGS, ...sheets.flatMap((entry) => entry.rows.slice(1)).slice(0, 4400)] });
    let started = performance.now();
    const workbook = readNusrWorkbook(sheets);
    assert.ok(performance.now() - started < 2000, `read in ${Math.round(performance.now() - started)} ms`);
    started = performance.now();
    const result = planNusrImport(workbook, workbook.sheets.map((entry) => entry.index));
    assert.ok(performance.now() - started < 300, `planned in ${Math.round(performance.now() - started)} ms`);
    assert.equal(result.sales.length + result.sheets.reduce((sum, entry) => sum + entry.duplicates, 0), 5200 + 4400);
  });
});

describe("the NUSR tab's own Download Excel", () => {
  test("comes back in as it went out: every field of every sale, with no notes", async () => {
    const blank: SaleFields = {
      soldOn: "2026-01-02",
      salesperson: null,
      customerName: "",
      customerAddress: null,
      customerPhone: null,
      unitYear: null,
      unitModel: null,
      condition: "new",
      unitType: "whole_good",
      vin: null,
      category: null,
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
    const sales: SaleFields[] = [
      {
        ...blank,
        soldOn: "2026-03-04",
        salesperson: "Sam Ortega",
        customerName: "Casey Lindqvist",
        customerAddress: "301 Birch Hill Rd, Stonebridge, PA",
        customerPhone: "(724) 555-0118",
        unitYear: 2026,
        unitModel: "Rngr 570 NS",
        vin: "3NSMAU576TE100318",
        category: "UTV",
        notes: "Line one\nline two",
        financeCompany: "Lakeside Credit",
        fundingReceivedOn: "2026-03-10",
        paidOn: "2026-03-12",
        comsNumber: "TST1001",
        msrp: 1899900,
        salesPrice: 1805125,
        dealerCost: 1765000,
        unitLabor: 5000,
        rebate: 50000,
        accPrice: 74000,
        accCost: 50250,
        accLabor: 7500,
        escPrice: 89900,
        escCost: 43000,
        rewards: 2500,
        amountFinanced: 1444100,
        downPayment: 150000,
        holdbackRateBp: 475,
        bonusRateBp: 1250,
      },
      // A trade that had an MSRP typed: only the Type column says it's a trade.
      { ...blank, soldOn: "2026-03-05", customerName: "Terry Voss", condition: "used", unitType: "trade", unitModel: "Spmn 570 EPS", category: "ATV", msrp: 979900, salesPrice: 836700, dealerCost: 746700, holdbackRateBp: 0 },
      { ...blank, soldOn: "2026-03-06", customerName: "Maplewick Orchards", unitType: "trailer", unitModel: "6x12 Trailer", category: "Trailer", salesPrice: 245000, dealerCost: 198000, holdbackRateBp: 0 },
      { ...blank, soldOn: "2026-03-07", customerName: "Avery Quinlan", unitType: "contest", unitModel: "RZR XP 1000", category: "RZR", salesPrice: 2752625, dealerCost: 2582000, holdbackRateBp: 0, bonusRateBp: 0 },
      { ...blank, soldOn: "2026-03-08", customerName: "Jamie Okafor", unitType: "free", unitModel: "Outlaw 70", category: "ATV", holdbackRateBp: 0 },
      // A loss, and a Sales Bonus taken down by hand.
      { ...blank, soldOn: "2026-03-09", customerName: "Robin Achterberg", unitModel: "General XP 1000", category: "UTV", msrp: 2799900, salesPrice: 2500000, dealerCost: 2582000, bonusAdjustment: -5000 },
      // No model, no category, no salesman: still a sale.
      { ...blank, soldOn: "2026-03-10", customerName: "Lee Brandvold", salesPrice: 100000, dealerCost: 90000 },
      // Rates of 100%, which Excel keeps as 1.
      { ...blank, soldOn: "2026-03-11", customerName: "Pat Rowan", unitModel: "Spmn 570", category: "ATV", msrp: 100000, salesPrice: 95000, dealerCost: 90000, holdbackRateBp: 10000, bonusRateBp: 10000 },
    ];
    const file = writeXlsx(nusrWorkbook(sales.map(withFigures), { title: "2026", comparison: monthlyComparison([]), generatedAt: new Date("2026-03-20T12:00:00Z") }));
    const read = await readSpreadsheet("NUSR 2026.xlsx", file);
    assert.ok("sheets" in read, JSON.stringify(read));
    const book = readNusrWorkbook(read.sheets, { today: "2026-03-20" });
    assert.deepEqual(book.sheets.map((entry) => [entry.name, entry.sales, entry.chosen]), [["NUSR", sales.length, true]]);
    const plan = planNusrImport(book, book.sheets.map((entry) => entry.index));
    assert.deepEqual(plan.notes, []);
    assert.equal(plan.sales.length, sales.length);
    for (const original of sales) {
      const planned = plan.sales.find((entry) => entry.fields.customerName === original.customerName);
      assert.ok(planned, original.customerName);
      assert.deepEqual(checkSale(planned.fields), { sale: original }, original.customerName);
    }
    // A blank category is filled in from the model, as the sale form does.
    const read2 = await readSpreadsheet("NUSR 2026.xlsx", writeXlsx(nusrWorkbook([withFigures({ ...sales[1], category: null })], { title: "2026", comparison: monthlyComparison([]), generatedAt: new Date("2026-03-20T12:00:00Z") })));
    assert.ok("sheets" in read2);
    const again = planNusrImport(readNusrWorkbook(read2.sheets, { today: "2026-03-20" }), [0]);
    assert.equal(again.sales[0]?.fields.category, "ATV");
  });
});

describe("saving an import", () => {
  const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
  const shopIds: string[] = [];
  let manager: CurrentUser;
  let other: CurrentUser;

  async function createManager(code: string): Promise<CurrentUser> {
    const [shop] = await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name });
    shopIds.push(shop.id);
    const id = randomUUID();
    await systemDb.insert(users).values({
      id,
      shopId: shop.id,
      role: "manager",
      name: "Morgan",
      username: `${code}.morgan`,
      displayUsername: "morgan",
      email: `${randomUUID()}@no-email.invalid`,
    });
    return { id, name: "Morgan", username: "morgan", role: "manager", shop, bay: null };
  }

  before(async () => {
    manager = await createManager(`nu${suffix}`);
    other = await createManager(`nv${suffix}`);
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  // A workbook's sales as the page sends them: planned, in batches.
  const entriesOf = (sheets: Sheet[]) => nusrImportBatches(plan(sheets).sales).flat();
  const send = (actor: CurrentUser, sales: NusrImportEntry[], importId = randomUUID()) => importSales(actor, { importId, fileName: "NUSR_2026.xlsx", sales });
  const salesOf = (shopId: string) => systemDb.select().from(unitSales).where(eq(unitSales.shopId, shopId)).orderBy(unitSales.soldOn, unitSales.createdAt);
  const results = (outcome: { outcomes: { ref: string; result: string; reason: string | null }[] } | { error: string }) => {
    assert.ok("outcomes" in outcome, JSON.stringify(outcome));
    return outcome.outcomes.map(({ ref, result, reason }) => [ref, result, reason]);
  };
  // A sale typed into the NUSR tab's form.
  const typed = (fields: Partial<Record<keyof SaleFields, string>>) =>
    ({ ...Object.fromEntries(Object.keys(SALE_LABELS).map((key) => [key, ""])), condition: "new", unitType: "whole_good", ...fields }) as Record<keyof SaleFields, string>;

  test("adds the sales, writes the Activity log, and importing again adds nothing", async () => {
    const workbook = [
      sheet("2026", [
        unit({ B: "2026-01-02", D: "Dana Whitfield", J: vin("3NSGZW99_TM300001"), K: "40000", L: "38500.25", M: "36000", S: "1200", T: "950.4" }),
        unit({ B: "2026-01-03", D: "Rhett Carver", I: "U", K: "Trade", J: vin("4XARRE99_K8300002"), L: "10500", M: "8500" }),
        unit({ B: "2026-01-04", D: "Walt Ostrowski", J: vin("4XARRE99_T8300003"), N: "pending rebate" }),
      ]),
      sheet("Trailers", [unit({ B: "2016-07-01", D: "Gus Abernathy", J: vin("5WFBU141_GW300004"), H: "6.5 x 14 Trlr", K: "TRAILER", L: "2900", M: "2500" })], NEW_HEADINGS),
    ];
    const entries = entriesOf(workbook);
    const importId = randomUUID();
    // In two batches, as a big file is sent.
    const first = results(await send(manager, entries.slice(0, 2), importId));
    const second = results(await send(manager, entries.slice(2), importId));
    assert.deepEqual([...first, ...second], [
      ["2026!2", "added", null],
      ["2026!3", "added", null],
      ["2026!4", "added", null],
      ["Trailers!2", "added", null],
    ]);
    const saved = await salesOf(manager.shop.id);
    assert.deepEqual(
      saved.map((row) => [row.importRef, row.soldOn, row.customerName, row.unitType, row.condition, row.createdByUserId, row.customerId]),
      [
        ["Trailers!2", "2016-07-01", "Gus Abernathy", "trailer", "new", manager.id, null],
        ["2026!2", "2026-01-02", "Dana Whitfield", "whole_good", "new", manager.id, null],
        ["2026!3", "2026-01-03", "Rhett Carver", "trade", "used", manager.id, null],
        ["2026!4", "2026-01-04", "Walt Ostrowski", "whole_good", "new", manager.id, null],
      ],
    );
    const dana = saved[1];
    assert.deepEqual(
      [dana.msrpCents, dana.salesPriceCents, dana.dealerCostCents, dana.accPriceCents, dana.accCostCents, dana.holdbackRateBp, dana.bonusRateBp, dana.customerPhone],
      [4000000, 3850025, 3600000, 120000, 95040, 400, 1000, "(814) 555-0199"],
    );
    assert.equal(saved[3].notes, "Unit Labor: pending rebate");
    const entriesLogged = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, importId)).orderBy(auditLog.seq);
    assert.deepEqual(
      entriesLogged.map((entry) => [entry.action, entry.targetType, entry.shopId, entry.actorUserId, entry.details]),
      [
        ["unit_sales.imported", "unit_sale", manager.shop.id, manager.id, { fileName: "NUSR_2026.xlsx", added: 2, already: 0, failed: 0 }],
        ["unit_sales.imported", "unit_sale", manager.shop.id, manager.id, { fileName: "NUSR_2026.xlsx", added: 2, already: 0, failed: 0 }],
      ],
    );

    // Again, all at once: nothing new.
    const again = results(await send(manager, entriesOf(workbook)));
    assert.deepEqual(
      again.map(([, result, reason]) => [result, reason]),
      Array.from({ length: 4 }, () => ["already", "Already in the NUSR: the same row of the same sheet."]),
    );
    assert.equal((await salesOf(manager.shop.id)).length, 4);
  });

  test("a sale already in the NUSR is found by VIN and day, by VIN and customer, and by customer and price within a week", async () => {
    const vins = [vin("4XARRE99_T8400001"), vin("4XARRE99_T8400002"), vin("4XARRE99_T8400003"), vin("4XARRE99_T8400004")];
    for (const sale of [
      typed({ soldOn: "2025-05-01", customerName: "Lena Marsh", vin: vins[0], salesPrice: "23500" }),
      typed({ soldOn: "2025-05-02", customerName: "Otis Brandt", vin: vins[1], salesPrice: "23500" }),
      typed({ soldOn: "2025-05-03", customerName: "Ivy Calder", vin: vins[2].slice(0, 16), salesPrice: "31000" }),
    ]) {
      const logged = await logSale(manager, sale);
      assert.ok("id" in logged, JSON.stringify(logged));
    }
    const entries = entriesOf([
      sheet("2025", [
        unit({ B: "2025-05-01", D: "Someone Else", J: vins[0] }),
        unit({ B: "2025-05-04", D: "Otis  Brandt", J: vins[1] }),
        unit({ B: "2025-05-06", D: "Ivy Calder", J: vins[2], L: "31000" }),
        unit({ B: "2025-05-06", D: "Ivy Calder", J: vins[3], L: "31000" }),
      ]),
    ]);
    assert.deepEqual(results(await send(manager, entries)), [
      ["2025!2", "already", "Already in the NUSR: the same VIN, sold the same day."],
      ["2025!3", "already", "Already in the NUSR: the same VIN, sold to the same customer."],
      ["2025!4", "already", "Already in the NUSR: the same customer and sales price, within a week."],
      // A second unit with a whole VIN of its own is another sale.
      ["2025!5", "added", null],
    ]);
  });

  test("a customer's several units on one sheet stay several, even sent in separate batches", async () => {
    const rows = Array.from({ length: 3 }, (_, at) => unit({ B: "2024-06-01", D: "Juniper Acres", J: at === 0 ? "" : "NONE", H: "Rngr 570", L: "11999" }));
    const entries = entriesOf([sheet("2024", rows)]);
    const outcomes = [];
    for (const entry of entries) outcomes.push(...results(await send(manager, [entry])));
    assert.deepEqual(outcomes.map(([, result]) => result), ["added", "added", "added"]);
    // A repeat on another sheet is the same sale.
    const onNew = entriesOf([sheet("New", [unit({ B: "2024-06-02", D: "Juniper Acres", J: "", H: "Rngr 570", L: "11999" })], NEW_HEADINGS)]);
    assert.deepEqual(results(await send(manager, onNew)), [["New!2", "already", "Already in the NUSR: the same customer and sales price, within a week."]]);
  });

  test("a sale is tied to a customer on file by name and phone number, never by name alone, and no customer is added", async () => {
    const made = await createCustomer(manager, { name: "Nell Fairbanks", phone: "814-555-0142", email: "", addressLine1: "", addressLine2: "", city: "Altoona", state: "PA", postalCode: "", notes: "" });
    assert.ok("id" in made, JSON.stringify(made));
    const [{ before: customersBefore }] = await systemDb.select({ before: sql<number>`count(*)::int` }).from(customers).where(eq(customers.shopId, manager.shop.id));
    const entries = entriesOf([
      sheet("2023", [
        unit({ B: "2023-07-01", D: "nell  fairbanks", F: "(814) 555-0142", J: vin("4XARRE99_T8500001") }),
        unit({ B: "2023-07-02", D: "Nell Fairbanks", F: "814-555-0999", J: vin("4XARRE99_T8500002") }),
        unit({ B: "2023-07-03", D: "Nell Fairbanks", F: "", J: vin("4XARRE99_T8500003") }),
        unit({ B: "2023-07-04", D: "Boyd Lattimer", F: "814-555-0142", J: vin("4XARRE99_T8500004") }),
      ]),
    ]);
    assert.deepEqual(results(await send(manager, entries)).map(([, result]) => result), ["added", "added", "added", "added"]);
    const tied = await systemDb
      .select({ ref: unitSales.importRef, customerId: unitSales.customerId })
      .from(unitSales)
      .where(and(eq(unitSales.shopId, manager.shop.id), sql`${unitSales.soldOn} between '2023-07-01' and '2023-07-04'`))
      .orderBy(unitSales.soldOn);
    assert.deepEqual(tied, [
      { ref: "2023!2", customerId: made.id },
      { ref: "2023!3", customerId: null },
      { ref: "2023!4", customerId: null },
      { ref: "2023!5", customerId: null },
    ]);
    const [{ after: customersAfter }] = await systemDb.select({ after: sql<number>`count(*)::int` }).from(customers).where(eq(customers.shopId, manager.shop.id));
    assert.equal(customersAfter, customersBefore);
  });

  test("the server checks every sale again, whatever the browser sent", async () => {
    const [good] = entriesOf([sheet("2022", [unit({ B: "2022-08-01", D: "Cora Wynn", J: vin("4XARRE99_T8600001") })])]);
    const outcome = results(
      await send(manager, [
        { ref: "2022!20", fields: { ...good.fields, soldOn: "08/01/2022" } },
        { ref: "2022!21", fields: { ...good.fields, unitType: "boat" } },
        { ref: "no row", fields: good.fields },
        { ref: "2022!22", fields: { ...good.fields, holdbackRateBp: "250" } },
        { ref: "2022!2", fields: good.fields },
      ] as NusrImportEntry[]),
    );
    assert.deepEqual(outcome.map(([ref, result]) => [ref, result]), [
      ["2022!20", "failed"],
      ["2022!21", "failed"],
      ["no row", "failed"],
      ["2022!22", "failed"],
      ["2022!2", "added"],
    ]);
    assert.equal(outcome[0][2], "Enter the date it was sold.");
    assert.equal(outcome[2][2], "That sale's sheet and row couldn't be read.");
    assert.equal(outcome[3][2], "The holdback rate is over 100%.");
    assert.deepEqual(await importSales(manager, { importId: "nope", fileName: "x", sales: [good] }), { error: "That import couldn't be read. Choose the file again." });
    assert.deepEqual(await importSales(manager, { importId: randomUUID(), fileName: "x", sales: [] }), { error: "There were no sales in that batch." });
    assert.deepEqual(await importSales(manager, { importId: randomUUID(), fileName: "x", sales: Array.from({ length: MAX_NUSR_IMPORT_BATCH + 1 }, () => good) }), {
      error: "That batch is too big. Reload the page and try again.",
    });
  });

  test("another shop's sales and customers are never matched", async () => {
    const shared = vin("4XARRE99_T8700001");
    const theirs = await createCustomer(other, { name: "Tess Harlan", phone: "814-555-0177", email: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", notes: "" });
    assert.ok("id" in theirs);
    const logged = await logSale(other, typed({ soldOn: "2021-09-01", customerName: "Tess Harlan", vin: shared, salesPrice: "23500" }));
    assert.ok("id" in logged);
    const entries = entriesOf([sheet("2021", [unit({ B: "2021-09-01", D: "Tess Harlan", F: "814-555-0177", J: shared })])]);
    assert.deepEqual(results(await send(manager, entries)), [["2021!2", "added", null]]);
    const [mine] = await systemDb.select().from(unitSales).where(and(eq(unitSales.shopId, manager.shop.id), eq(unitSales.vin, shared)));
    assert.equal(mine.customerId, null);
    assert.equal((await salesOf(other.shop.id)).length, 1);
  });

  test("a row another sale has, after the workbook changed, is added without that row", async () => {
    const before = entriesOf([sheet("2019", [unit({ B: "2019-10-01", D: "Arlo Pike", J: vin("4XARRE99_T8800001") })])]).map((entry) => ({ ...entry, ref: "2019!300" }));
    assert.deepEqual(results(await send(manager, before)), [["2019!300", "added", null]]);
    const after = entriesOf([sheet("2019", [unit({ B: "2019-10-02", D: "Bea Sutter", J: vin("4XARRE99_T8800002") })])]).map((entry) => ({ ...entry, ref: "2019!300" }));
    assert.deepEqual(results(await send(manager, after)), [["2019!300", "added", null]]);
    const rows = await systemDb.select({ ref: unitSales.importRef, name: unitSales.customerName }).from(unitSales).where(and(eq(unitSales.shopId, manager.shop.id), sql`${unitSales.customerName} in ('Arlo Pike', 'Bea Sutter')`)).orderBy(unitSales.soldOn);
    assert.deepEqual(rows, [
      { ref: "2019!300", name: "Arlo Pike" },
      { ref: null, name: "Bea Sutter" },
    ]);
  });

  test("two imports of the same sales at once add each of them once", async () => {
    const entries = entriesOf([
      sheet("2018", Array.from({ length: 20 }, (_, at) => unit({ B: `2018-11-${String(at + 1).padStart(2, "0")}`, D: `Racer ${at}`, J: vin(`4XARRE99_J89${String(at).padStart(5, "0")}`) }))),
    ]);
    const [a, b] = await Promise.all([send(manager, entries), send(manager, entries)]);
    const added = [...results(a), ...results(b)].filter(([, result]) => result === "added").length;
    assert.equal(added, 20);
    const [{ count }] = await systemDb.select({ count: sql<number>`count(*)::int` }).from(unitSales).where(and(eq(unitSales.shopId, manager.shop.id), sql`${unitSales.customerName} like 'Racer %'`));
    assert.equal(count, 20);
  });

  // An import's batches as the page sends them: one after another, each
  // with the sales on file the ones before it found.
  async function sendInBatches(actor: CurrentUser, batches: NusrImportEntry[][], importId = randomUUID()) {
    const outcomes: [string, string, string | null][] = [];
    let found: string[] = [];
    for (const batch of batches) {
      const result = await importSales(actor, { importId, fileName: "NUSR_2026.xlsx", sales: batch, found });
      assert.ok("outcomes" in result, JSON.stringify(result));
      outcomes.push(...result.outcomes.map(({ ref, result: what, reason }): [string, string, string | null] => [ref, what, reason]));
      found = [...found, ...result.found];
    }
    return { outcomes, found };
  }

  test("one sale on file stands for one of a customer's units, not all of them, in one batch or several", async () => {
    const shop = await createManager(`nk${suffix}`);
    // Logged by hand before the VIN was in.
    const logged = await logSale(shop, typed({ soldOn: "2024-06-01", customerName: "Marlow Fenwick", unitModel: "Fieldrunner 600", salesPrice: "11999" }));
    assert.ok("id" in logged, JSON.stringify(logged));
    const units = (customerName: string, stem: string) =>
      entriesOf([
        sheet(
          "2024",
          ["2024-06-01", "2024-06-01", "2024-06-03"].map((day, at) => unit({ B: day, D: customerName, J: vin(`${stem}${at}`), H: "Fieldrunner 600", L: "11999" })),
        ),
      ]);
    const one = await sendInBatches(shop, units("Marlow Fenwick", "3NSRGE99_R830000").map((entry) => [entry]));
    assert.deepEqual(
      one.outcomes.map(([ref, result]) => [ref, result]),
      [
        ["2024!2", "already"],
        ["2024!3", "added"],
        ["2024!4", "added"],
      ],
    );
    assert.deepEqual(one.found, [logged.id]);
    assert.equal((await salesOf(shop.shop.id)).length, 3);
    // All in one batch, for another customer.
    assert.ok("id" in (await logSale(shop, typed({ soldOn: "2024-06-01", customerName: "Delphine Ashgrove", unitModel: "Fieldrunner 600", salesPrice: "11999" }))));
    const all = await sendInBatches(shop, [units("Delphine Ashgrove", "3NSRGE99_R830001")]);
    assert.deepEqual(
      all.outcomes.map(([, result]) => result),
      ["already", "added", "added"],
    );
    // A sale sent back as found that wasn't only leaves a sale to be added.
    const [entry] = entriesOf([sheet("2024", [unit({ B: "2024-06-20", D: "Ansel Whitcombe", J: vin("3NSRGE99_R8300020"), L: "8000" })])]);
    assert.ok("id" in (await logSale(shop, typed({ soldOn: "2024-06-20", customerName: "Ansel Whitcombe", salesPrice: "8000" }))));
    const made = await importSales(shop, { importId: randomUUID(), fileName: "x.xlsx", sales: [entry], found: ["nope", 7, ...(await salesOf(shop.shop.id)).map((row) => row.id)] });
    assert.ok("outcomes" in made);
    assert.deepEqual(made.outcomes.map((outcome) => outcome.result), ["added"]);
  });

  test("after a row is put in above them or taken out, importing again finds the sales without a VIN on their own sheet", async () => {
    const shop = await createManager(`nl${suffix}`);
    const rows = [
      unit({ B: "2024-08-01", D: "Isolde Varga", J: vin("4XARRE99_R8300101") }),
      unit({ B: "2024-08-02", D: "Caspian Rourke", J: "", L: "9999" }),
      unit({ B: "2024-08-03", D: "Wilhelmina Strand", J: "", L: "8999" }),
    ];
    const first = await sendInBatches(shop, [entriesOf([sheet("2024", rows)])]);
    assert.deepEqual(
      first.outcomes.map(([, result]) => result),
      ["added", "added", "added"],
    );
    // A late deal put in at the top: every row under it is a row down.
    const late = unit({ B: "2024-07-31", D: "Leopold Avery", J: vin("4XARRE99_R8300104") });
    const again = await sendInBatches(shop, [entriesOf([sheet("2024", [late, ...rows])])]);
    assert.deepEqual(again.outcomes, [
      ["2024!2", "added", null],
      ["2024!3", "already", "Already in the NUSR: the same VIN, sold the same day."],
      ["2024!4", "already", "Already in the NUSR: the same customer and sales price, within a week."],
      ["2024!5", "already", "Already in the NUSR: the same customer and sales price, within a week."],
    ]);
    // Taken out again: every row back up one.
    const back = await sendInBatches(shop, [entriesOf([sheet("2024", rows)])]);
    assert.deepEqual(
      back.outcomes.map(([, result]) => result),
      ["already", "already", "already"],
    );
    assert.equal((await salesOf(shop.shop.id)).length, 4);
    // A second unit of a customer's, at the same price that week, added to
    // the sheet since: another sale, in the same batch or the next.
    const second = unit({ B: "2024-08-04", D: "Caspian Rourke", J: "", L: "9999" });
    const more = await sendInBatches(shop, [entriesOf([sheet("2024", [...rows, second])]).slice(0, 2), entriesOf([sheet("2024", [...rows, second])]).slice(2)]);
    assert.deepEqual(
      more.outcomes.map(([ref, result]) => [ref, result]),
      [
        ["2024!2", "already"],
        ["2024!3", "already"],
        ["2024!4", "already"],
        ["2024!5", "added"],
      ],
    );
  });

  test("a sale removed from the NUSR isn't brought back by importing the workbook again; another sale on its row is added", async () => {
    const shop = await createManager(`nm${suffix}`);
    const kept = unit({ B: "2024-07-01", D: "Rosalind Pryce", J: vin("4XARRE99_R8300201") });
    const workbook = [sheet("2024", [kept, unit({ B: "2024-07-02", D: "Thaddeus Wrenfield", J: "", L: "7300" })])];
    assert.deepEqual(
      results(await send(shop, entriesOf(workbook))).map(([, result]) => result),
      ["added", "added"],
    );
    const gone = (await salesOf(shop.shop.id)).find((row) => row.importRef === "2024!3")!;
    assert.ok("ok" in (await removeSale(shop, gone.id)));
    const [removal] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, gone.id), eq(auditLog.action, "unit_sale.removed")));
    assert.equal(removal.details.importRef, "2024!3");
    assert.deepEqual(results(await send(shop, entriesOf(workbook))), [
      ["2024!2", "already", "Already in the NUSR: the same row of the same sheet."],
      ["2024!3", "failed", `It was removed from the NUSR on ${shopToday(removal.createdAt)}, so it isn't brought back.`],
    ]);
    // The workbook changed: that row is another customer's sale now.
    const changed = [sheet("2024", [kept, unit({ B: "2024-07-05", D: "Ottoline Brandt", J: vin("4XARRE99_R8300203") })])];
    assert.deepEqual(results(await send(shop, entriesOf(changed)))[1], ["2024!3", "added", null]);
    // A sale logged by hand and removed has no row to leave out.
    const typedIn = await logSale(shop, typed({ soldOn: "2024-07-09", customerName: "Thaddeus Wrenfield", salesPrice: "7300" }));
    assert.ok("id" in typedIn && "ok" in (await removeSale(shop, typedIn.id)));
    const [plain] = await systemDb.select().from(auditLog).where(and(eq(auditLog.targetId, typedIn.id), eq(auditLog.action, "unit_sale.removed")));
    assert.equal("importRef" in plain.details, false);
  });

  test("a batch sent again after its reply was lost counts the sales it saved as added", async () => {
    const shop = await createManager(`nn${suffix}`);
    // On file from an earlier import: row 4 is another sale's.
    assert.deepEqual(results(await send(shop, entriesOf([sheet("2023", [unit({ B: "2023-03-01", D: "Bramwell Thistlecombe", J: vin("4XARRE99_P8300301") })])]).map((entry) => ({ ...entry, ref: "2023!4" })))), [
      ["2023!4", "added", null],
    ]);
    const entries = entriesOf([
      sheet("2023", [
        unit({ B: "2023-03-02", D: "Seraphine Quillfeather", J: vin("4XARRE99_P8300302") }),
        unit({ B: "2023-03-03", D: "Quillon Dacre", J: "", L: "6400" }),
        unit({ B: "2023-03-04", D: "Ingrid Solberg", J: vin("4XARRE99_P8300304") }),
      ]),
    ]);
    const importId = randomUUID();
    // Saved, but its reply never came, so it's sent again.
    assert.deepEqual(results(await send(shop, entries, importId)).map(([, result]) => result), ["added", "added", "added"]);
    assert.deepEqual(results(await send(shop, entries, importId)), [
      ["2023!2", "added", null],
      ["2023!3", "added", null],
      ["2023!4", "added", null],
    ]);
    // Each batch's own entry in the Activity log says what it did itself.
    const logged = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, importId)).orderBy(auditLog.seq);
    assert.deepEqual(
      logged.map(({ details }) => [details.added, details.already]),
      [
        [3, 0],
        [0, 3],
      ],
    );
    const saved = await salesOf(shop.shop.id);
    assert.equal(saved.length, 4);
    assert.deepEqual(
      saved.filter((row) => row.importId === importId).map((row) => [row.importRef, row.customerName]),
      [
        ["2023!2", "Seraphine Quillfeather"],
        ["2023!3", "Quillon Dacre"],
        [null, "Ingrid Solberg"],
      ],
    );
    // Another import of the same file finds them already in the NUSR.
    assert.deepEqual(
      results(await send(shop, entries)).map(([, result]) => result),
      ["already", "already", "already"],
    );
  });

  test("a sale logged by hand before its price was in is found by the same customer the same day, when the models agree", async () => {
    const shop = await createManager(`nq${suffix}`);
    const logged = await logSale(shop, typed({ soldOn: "2026-10-20", customerName: "Bertrand Ashby", unitModel: "Trailhawk 450", condition: "used", unitType: "trade" }));
    assert.ok("id" in logged, JSON.stringify(logged));
    const entries = entriesOf([
      sheet("2026", [
        // Another unit the same day, a model of its own.
        unit({ B: "2026-10-20", D: "Bertrand Ashby", H: "Wisp 70", L: "2500", M: "2000" }),
        unit({ B: "2026-10-20", D: "Bertrand Ashby", I: "U", K: "Trade", H: "TRAILHAWK450", L: "5500", M: "4800" }),
      ]),
    ]);
    assert.deepEqual(results(await send(shop, entries)), [
      ["2026!2", "added", null],
      ["2026!3", "already", "Already in the NUSR: the same customer the same day, one of them with no sales price."],
    ]);
    assert.equal((await salesOf(shop.shop.id)).length, 2);
  });

  test("a file name with half of a two-part character is saved with that half replaced", async () => {
    const shop = await createManager(`nr${suffix}`);
    const importId = randomUUID();
    const entries = entriesOf([sheet("2022", [unit({ B: "2022-09-01", D: "Corisande Ashvane", J: vin("4XARRE99_N8300401") })])]);
    const outcome = await importSales(shop, { importId, fileName: "NUSR\ud800 2026.xlsx", sales: entries });
    assert.deepEqual(results(outcome), [["2022!2", "added", null]]);
    const [entry] = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, importId));
    assert.equal(entry.details.fileName, "NUSR� 2026.xlsx");
  });

  test("app_user can't change which import added a sale", async () => {
    const shop = await createManager(`ns${suffix}`);
    results(await send(shop, entriesOf([sheet("2021", [unit({ B: "2021-02-01", D: "Evander Lusk", J: vin("4XARRE99_M8300501") })])])));
    await assert.rejects(
      withShop(shop.shop.id, (tx) => tx.execute(sql`update unit_sales set import_id = ${randomUUID()} where shop_id = ${shop.shop.id}`)),
      (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501",
    );
  });
});
