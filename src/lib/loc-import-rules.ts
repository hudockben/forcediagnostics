// Importing units onto the LOC tab, in the browser: the shop's LOC
// spreadsheet as it keeps it (or the LOC tab's own Download Excel), the
// lender's list of what's on the line, or rows pasted from either. The
// headings row is found among the first ten and each column matched to a
// field by its heading (changeable on the page). The sheet's sections are
// read as the sheet marks them: a "WE OWN" row puts the units under it
// with the ones we own, and "we owe on LOC" (on a row of its own or beside
// a unit, "here down we owe on LOC") puts that unit and the ones under it
// on the LOC; units above any mark go where the page says. Its totals and
// the lines about them ("this amt MUST always balance with", "Grand
// Total", "L/S account # 32400") aren't units. A unit whose stock # is on
// the list already is left as it is, so the same file, or the lender's
// next list, adds only what's new. No server imports, so the browser plans
// an import the way the server checks it.

import { headingKey, parseImportDate } from "@/lib/customer-import-rules";
import {
  MAX_LOC_YEAR,
  MIN_LOC_YEAR,
  checkLocUnit,
  cleanStockNumber,
  floorDateLooksOff,
  locUnitLabel,
  splitModelYear,
  stockKey,
  type LocSection,
  type LocUnitFields,
  type LocValueKey,
  type Tally,
} from "@/lib/loc-rules";
import { cleanVin, formatDay, guessCategory, line, parseMoney } from "@/lib/nusr-rules";

export const LOC_IMPORT_FIELDS = ["model", "stockNumber", "freeFloorEnds", "cost", "vin", "unitYear", "category", "condition", "receivedOn", "notes"] as const;
export type LocImportField = (typeof LOC_IMPORT_FIELDS)[number];

export const LOC_IMPORT_LABELS: Record<LocImportField, string> = {
  model: "Model",
  stockNumber: "Stock #",
  freeFloorEnds: "Free Floor Ends",
  cost: "Cost",
  vin: "VIN",
  unitYear: "Year",
  category: "Category",
  condition: "New/Used",
  receivedOn: "Date in",
  notes: "Notes",
};

// The headings each field goes by on the shop's sheet, the tab's download
// and lenders' lists of floored units, best first.
const HEADINGS: Record<LocImportField, string[]> = {
  model: ["model", "unit", "modeldescription", "unitdescription", "description", "vehicle", "modelname", "unitmodel"],
  stockNumber: ["stocknumber", "stock", "stockno", "stk", "stknumber", "stkno", "stockid"],
  freeFloorEnds: [
    "freefloorends", "freefloorend", "freefloor", "freefloorexpires", "freefloorexpiration", "freefloorenddate", "freefloordate",
    "freeflooring", "freeflooringends", "freeflooringexpires", "interestbegins", "intereststarts", "interestdate", "intereststartdate",
  ],
  cost: [
    "cost", "dealercost", "unitcost", "invoice", "invoicecost", "invoiceamount", "invoiceprice", "amount", "flooredamount",
    "amountfloored", "principal", "principalbalance", "balance", "currentbalance", "amountowed", "owed",
  ],
  vin: ["vin", "vinnumber", "serial", "serialnumber", "vinserial", "serialvin"],
  unitYear: ["year", "modelyear", "yr", "unityear"],
  category: ["category", "unittype", "vehicletype", "type", "class"],
  condition: ["newused", "nu", "neworused", "condition"],
  receivedOn: [
    "datein", "received", "receiveddate", "datereceived", "receivedon", "instock", "instockdate", "arrived", "arrivaldate",
    "shipdate", "shippeddate", "invoicedate", "flooreddate", "floordate", "floorplandate",
  ],
  notes: ["notes", "note", "comments", "comment", "memo", "remarks"],
};

const fieldFor = new Map<string, { field: LocImportField; rank: number }>();
for (const field of LOC_IMPORT_FIELDS) {
  HEADINGS[field].forEach((heading, rank) => {
    if (!fieldFor.has(heading)) fieldFor.set(heading, { field, rank });
  });
}

// Which field each column is, by its heading: each field from one column,
// its best heading winning (" Stock #" is the Stock #, as the sheet heads
// it with a space).
export function locColumns(headings: string[]): (LocImportField | null)[] {
  const best = new Map<LocImportField, { column: number; rank: number }>();
  headings.forEach((heading, column) => {
    const found = fieldFor.get(headingKey(heading ?? ""));
    if (!found) return;
    const taken = best.get(found.field);
    if (!taken || found.rank < taken.rank) best.set(found.field, { column, rank: found.rank });
  });
  const mapping: (LocImportField | null)[] = headings.map(() => null);
  for (const [field, { column }] of best) mapping[column] = field;
  return mapping;
}

// The headings row: the one among the first ten naming the most fields
// (two at least), or -1.
export function findLocHeader(rows: string[][]): number {
  let best = -1;
  let bestCount = 1;
  for (let index = 0; index < rows.length && index < 10; index++) {
    const count = locColumns(rows[index]).filter(Boolean).length;
    if (count > bestCount) [best, bestCount] = [index, count];
  }
  return best;
}

// The sheet's marks for its sections, and its lines about its totals. The
// units we own are under a "WE OWN" of their own.
const WE_OWN = /^\W*(?:units\s+)?we\s+own\b/i;
const ON_LOC = /\bowe\b.*\bloc\b|\bon\s+(?:the\s+)?loc\b/i;
const TOTAL_LINE = /\btotal\b|\bbalance\s+with\b|^>{2,}$|\bgrand\b/i;
const isMark = (text: string) => WE_OWN.test(text) || ON_LOC.test(text);

// A date as a sheet or a lender's list has it ("1/7/2026", "2026-01-07",
// "07-Jan-26"), or as Excel stores it when its format's been lost (46029).
export function parseLocDate(text: string): string | null {
  const typed = line(text);
  if (!typed) return null;
  const found = parseImportDate(typed);
  if (found) return found;
  if (/^\d{5}(?:\.\d+)?$/.test(typed)) {
    const serial = Math.floor(Number(typed));
    // 1/1/2000 to 12/31/2099, counted from Excel's day 0, 12/30/1899.
    if (serial >= 36_526 && serial <= 73_050) return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

// New or Used as a sheet writes it: N, U, a trade.
function readCondition(text: string): "new" | "used" | null {
  const key = headingKey(text);
  if (key === "" || key === "n" || key === "new") return "new";
  if (["u", "used", "t", "trade", "tradein", "traded", "preowned"].includes(key)) return "used";
  return null;
}

export type LocImportRow = LocUnitFields & { row: number };
// skipped: the row's unit isn't imported (otherwise the note is about a
// value the row's unit was imported without, or changed).
export type LocImportNote = { row: number; message: string; skipped: boolean };
export type LocImportPlan = {
  units: LocImportRow[];
  notes: LocImportNote[];
  // Rows with a unit on them, imported or not.
  rowsRead: number;
  sections: Record<LocSection, Tally>;
};

export const MAX_LOC_IMPORT_ROWS = 5_000;
export const MAX_LOC_IMPORT_BATCH = 500;

// What importing the rows would do. section is where units go before the
// sheet marks a section (all of them when it marks none: a lender's list
// is all on the LOC).
export function planLocImport(rows: string[][], headerRow: number, mapping: (LocImportField | null)[], { section: first }: { section: LocSection }): LocImportPlan {
  const columns = new Map<LocImportField, number>();
  mapping.forEach((field, column) => {
    if (field && !columns.has(field)) columns.set(field, column);
  });
  // Where a total's words sit: the unit's own columns (a note can say
  // anything).
  const unitColumns = new Set(["model", "stockNumber", "freeFloorEnds", "cost", "vin", "unitYear"].map((field) => columns.get(field as LocImportField) ?? -1));
  // A stock # Excel stored as a number loses its leading zero: when the
  // sheet's six-digit stock #s start with one, a shorter number gets it back.
  const stockColumn = columns.get("stockNumber");
  const zeroLed = stockColumn !== undefined && rows.slice(headerRow + 1).some((cells) => /^0\d{5}$/.test(line(cells[stockColumn])));

  const units: LocImportRow[] = [];
  const notes: LocImportNote[] = [];
  const seen = new Map<string, number>();
  const sections: Record<LocSection, Tally> = { owned: { units: 0, cost: 0 }, loc: { units: 0, cost: 0 } };
  let section = first;
  let rowsRead = 0;
  for (let index = headerRow + 1; index < rows.length; index++) {
    const cells = rows[index].map((cell) => line(cell));
    if (!cells.some(Boolean)) continue;
    const row = index + 1;
    // A section's mark, on a row of its own or beside its first unit.
    if (cells.some((cell) => WE_OWN.test(cell))) section = "owned";
    else if (cells.some((cell) => ON_LOC.test(cell))) section = "loc";
    if (cells.some((cell, column) => unitColumns.has(column) && TOTAL_LINE.test(cell))) continue;
    const get = (field: LocImportField) => {
      const value = cells[columns.get(field) ?? -1] ?? "";
      return isMark(value) ? "" : value;
    };
    const modelText = get("model");
    const stockText = get("stockNumber");
    const costText = get("cost");
    const vinText = get("vin");
    const floorText = get("freeFloorEnds");
    // A unit has a model or a stock #, and something more than words: a
    // spacer, a sum under a column or a line about the account isn't one.
    if (!modelText && !stockText && !vinText) continue;
    if (!stockText && !costText && !vinText && !floorText) continue;
    rowsRead++;
    if (rowsRead > MAX_LOC_IMPORT_ROWS) {
      notes.push({ row, message: `Only the first ${MAX_LOC_IMPORT_ROWS.toLocaleString("en-US")} units are imported; split the file to import the rest.`, skipped: true });
      break;
    }
    const note = (message: string, skipped = false) => notes.push({ row, message, skipped });

    // The model year: its own column, or in front of the model.
    const split = splitModelYear(modelText);
    const yearText = get("unitYear");
    let unitYear = split.unitYear;
    let model = split.model;
    if (yearText) {
      const year = /^\d{4}$/.test(yearText) && Number(yearText) >= MIN_LOC_YEAR && Number(yearText) <= MAX_LOC_YEAR ? Number(yearText) : null;
      if (year === null) {
        note(`Year “${yearText}” isn't a model year: ${split.unitYear === null ? "left blank" : `${split.unitYear}, from the model, instead`}.`);
      } else {
        // Two years that differ: the Year column's, and the model as written.
        if (split.unitYear !== null && split.unitYear !== year) model = modelText;
        unitYear = year;
      }
    }

    let stockNumber: string | null = null;
    const stock = cleanStockNumber(stockText);
    if ("error" in stock) note(`Stock # “${stockText}” isn't one: imported without it.`);
    else stockNumber = stock.stockNumber;
    if (stockNumber && zeroLed && /^\d{1,5}$/.test(stockNumber)) {
      const padded = stockNumber.padStart(6, "0");
      note(`Stock # ${stockNumber} read as ${padded}: Excel drops the leading zero from a number, and the sheet's other stock #s keep theirs.`);
      stockNumber = padded;
    }

    let vin: string | null = null;
    const cleaned = cleanVin(vinText);
    if ("error" in cleaned) note(`VIN “${vinText}”: ${cleaned.error} Imported without it.`);
    else vin = cleaned.vin;

    const cost = parseMoney(costText);
    if (!costText || ("cents" in cost && cost.cents === null)) {
      note("No cost: row left out.", true);
      continue;
    }
    if ("error" in cost) {
      note(`Cost “${costText}” ${cost.error}: row left out.`, true);
      continue;
    }

    const dates: Record<"freeFloorEnds" | "receivedOn", string | null> = { freeFloorEnds: null, receivedOn: null };
    for (const field of ["freeFloorEnds", "receivedOn"] as const) {
      const text = get(field);
      if (!text) continue;
      dates[field] = parseLocDate(text);
      if (!dates[field]) note(`${LOC_IMPORT_LABELS[field]} “${text}” isn't a date: left blank.`);
    }

    const conditionText = get("condition");
    let condition = readCondition(conditionText);
    if (!condition) {
      note(`New/Used “${conditionText}” isn't either: imported as new.`);
      condition = "new";
    }

    const checked = checkLocUnit({
      model,
      unitYear: unitYear === null ? "" : String(unitYear),
      stockNumber: stockNumber ?? "",
      vin: vin ?? "",
      category: get("category") || guessCategory(model) || "",
      condition,
      cost: costText,
      ...dates,
      section,
      notes: get("notes"),
    });
    if ("error" in checked) {
      note(`${checked.error.replace(/\.$/, "")}: row left out.`, true);
      continue;
    }
    const unit = checked.unit;
    if (unit.stockNumber) {
      const earlier = seen.get(stockKey(unit.stockNumber));
      if (earlier) {
        note(`Stock # ${unit.stockNumber} is on row ${earlier} too: this row is left out.`, true);
        continue;
      }
      seen.set(stockKey(unit.stockNumber), row);
    }
    if (floorDateLooksOff(unit.unitYear, unit.freeFloorEnds)) {
      note(`Free floor ends ${formatDay(unit.freeFloorEnds)}, before a ${unit.unitYear} could have come in: check the year.`);
    }
    units.push({ ...unit, row });
    sections[section].units++;
    sections[section].cost += unit.cost;
  }
  return { units, notes, rowsRead, sections };
}

// A unit of an import as the server checks it, from what the browser
// sent: the fields a unit has, as a form would send them.
export function importedUnitInput(entry: unknown): Partial<Record<LocValueKey, unknown>> {
  const unit = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "");
  return {
    model: text(unit.model),
    unitYear: text(unit.unitYear),
    stockNumber: text(unit.stockNumber),
    vin: text(unit.vin),
    category: text(unit.category),
    condition: text(unit.condition),
    cost: Number.isSafeInteger(unit.cost) ? (Number(unit.cost) / 100).toFixed(2) : "",
    freeFloorEnds: text(unit.freeFloorEnds),
    receivedOn: text(unit.receivedOn),
    section: unit.onLoc === true ? "loc" : unit.onLoc === false ? "owned" : "",
    notes: text(unit.notes),
  };
}

// What the server did with each unit of an import batch: added, on the
// list already (by its stock # or VIN), or left out.
export type LocImportOutcome = { row: number; result: "added" | "already" | "failed"; error: string | null };

// What a unit is, for the preview and the report: "2026 RZR 900 · 168072".
export const importedLabel = (unit: LocImportRow) => [locUnitLabel(unit), unit.stockNumber].filter(Boolean).join(" · ");
