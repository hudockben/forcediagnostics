// Importing the Unit List from the shop's spreadsheet (Unit List > Import):
// the sheet it kept its units on before the tab (Model, VIN, Received, Cost,
// List, Online $, Tax, Total, and a 1 in a column of its own for each unit),
// as a CSV or Excel file, or the rows pasted from it. Each column is matched
// to a field by its heading (and can be changed on the page); the count
// column has no heading, so it's found by its 1s. Online $, Tax and Total
// aren't the Unit List's and are left out. Each row is read as a unit with
// the same rules as the tab's form (checkUnit), leaving out what isn't one:
// the blank rows between models, a model's heading, the totals. The model
// year comes off the front of the model ("2027 Rngr 1000 XP NSU Crew - Blue
// Lab"). The VIN is what the sheet has, often only its last seven, which
// the tab matches by the end of a whole VIN (sameVin in unit-list-rules.ts).
//
// No server imports: the browser shows what will happen before anything is
// saved, and the server checks every unit again as it saves it
// (importStockUnits in src/lib/unit-list.ts).

import { readSheetDate } from "@/lib/nusr-import-rules";
import { formatDay, line, parseIsoDate, parseMoney } from "@/lib/nusr-rules";
import { MIN_VIN_TAIL, checkUnit, isPartialVin, type UnitFields } from "@/lib/unit-list-rules";
import { vinYears } from "@/lib/vin";

export const UNIT_IMPORT_FIELDS = ["model", "unitYear", "vin", "receivedOn", "cost", "listPrice", "count", "modelNumber", "engineNumber", "soldOn", "notes"] as const;
export type UnitImportField = (typeof UNIT_IMPORT_FIELDS)[number];

export const UNIT_IMPORT_LABELS: Record<UnitImportField, string> = {
  model: "Model",
  unitYear: "Year",
  vin: "VIN",
  receivedOn: "Received",
  cost: "Cost",
  listPrice: "List Price",
  count: "Unit count",
  modelNumber: "Model number",
  engineNumber: "Engine #",
  soldOn: "Sold",
  notes: "Notes",
};

// Where to look for the headings: a sheet often starts with a title line.
export const UNIT_HEADER_SEARCH_ROWS = 10;
export const MAX_UNIT_IMPORT_ROWS = 5_000;
export const MAX_UNIT_IMPORT_BATCH = 250;

// A heading as it's compared: lower case, punctuation as spaces ("Rec'd" and
// "Recd" alike), "#" and "$" kept.
const headingKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9#$&]+/g, " ")
    .trim();

// What each field's heading can be, the first that fits taking a column.
const HEADINGS: [UnitImportField, RegExp][] = [
  ["modelNumber", /^(?:(?:model|part|item) ?(?:#|no|num|number|code)|part)$/],
  ["unitYear", /^(?:year|yr|my|model year)$/],
  ["model", /^(?:model|unit|description|desc|model description|unit description|make (?:&|and )?model|whole goods?)$/],
  ["vin", /^(?:vin|vins|vin ?(?:#|no|number)|serial(?: ?(?:#|no|number))?|(?:vin )?last ?[678](?: of vin)?)$/],
  ["receivedOn", /^(?:received|recieved|recd|rcvd|recv|date (?:received|recieved|recd|in)|in stock|arrived|date)$/],
  ["cost", /^(?:cost|dealer cost|our cost|unit cost|net|net cost|invoice|invoice (?:cost|amount|\$))$/],
  ["listPrice", /^(?:list|list price|list \$|asking|asking price|retail|price|sticker|selling price)$/],
  ["count", /^(?:count|unit count|units|qty|quantity|#|ct)$/],
  ["engineNumber", /^(?:engine|engine ?(?:#|no|number|serial))$/],
  ["soldOn", /^(?:sold|date sold|sold (?:on|date))$/],
  ["notes", /^(?:notes?|comments?|remarks?|memo)$/],
];

const fieldOf = (heading: string): UnitImportField | null => {
  const key = headingKey(heading);
  return key ? (HEADINGS.find(([, pattern]) => pattern.test(key))?.[0] ?? null) : null;
};

// The row the headings are on: of the first few, the one naming the most
// fields, with the Model or the VIN among them; -1 when none does.
export function findUnitHeader(rows: readonly string[][]): number {
  let best = -1;
  let most = 0;
  for (let index = 0; index < Math.min(UNIT_HEADER_SEARCH_ROWS, rows.length); index++) {
    const fields = new Set(rows[index].map(fieldOf).filter((field): field is UnitImportField => field !== null));
    if ((fields.has("model") || fields.has("vin")) && fields.size > most) {
      best = index;
      most = fields.size;
    }
  }
  return best;
}

// Each column's field, by its heading (each field once, the first column
// with it). The count column, which the shop's sheet left without a
// heading, is a column with none whose cells on the units' rows are 1s (or
// a few 0s).
export function unitImportColumns(rows: readonly string[][], headerRow: number): (UnitImportField | null)[] {
  const headings = rows[headerRow] ?? [];
  const sample = rows.slice(headerRow + 1, headerRow + 201);
  const width = Math.max(headings.length, ...sample.map((row) => row.length));
  const mapping: (UnitImportField | null)[] = [];
  for (let column = 0; column < width; column++) {
    const field = fieldOf(headings[column] ?? "");
    mapping.push(field && !mapping.includes(field) ? field : null);
  }
  if (!mapping.includes("count")) {
    // Only the units' rows: a total under them isn't a 1.
    const key = mapping.includes("vin") ? mapping.indexOf("vin") : mapping.indexOf("model");
    const units = key < 0 ? sample : sample.filter((row) => (row[key] ?? "").trim());
    for (let column = 0; column < width; column++) {
      if (mapping[column] !== null || (headings[column] ?? "").trim()) continue;
      const values = units.map((row) => (row[column] ?? "").trim()).filter(Boolean);
      if (values.length >= 2 && values.every((value) => /^[01](?:\.0+)?$/.test(value)) && values.filter((value) => Number(value) === 1).length * 2 >= values.length) {
        mapping[column] = "count";
        break;
      }
    }
  }
  return mapping;
}

// A unit as the import sends it (the cells as the form would have them
// typed) and as checked, with its row on the sheet.
export type UnitImportRow = { row: number; fields: Record<keyof UnitFields, string>; unit: UnitFields };
export type UnitImportNote = { row: number; message: string };
export type UnitImportPlan = { units: UnitImportRow[]; notes: UnitImportNote[]; rowsRead: number };

const quoted = (text: string) => `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`;

// A sheet's date ("9/1/26", "2026-09-01" from a date cell, "0901/26"), as
// "2026-09-01", or null.
function sheetDay(text: string): string | null {
  const read = readSheetDate(text);
  if (!read) return null;
  const { year, month, day } = read.date;
  return parseIsoDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

// What importing the rows would do: each row with a VIN is a unit, its
// model year off the front of its model (or from a Year column, or a whole
// VIN), its Received day (today's when it has none), and its cost and list
// price; a row without a VIN is a model's heading or a total, and is left
// out (with a note when it looks like a unit: a model with a date or a
// price). A row the count column has as 0 isn't counted on the sheet, and
// is left out; a VIN on an earlier row too is imported once. What's wrong
// with a row says so, by its row on the sheet.
export function planUnitImport(rows: readonly string[][], headerRow: number, mapping: readonly (UnitImportField | null)[], { today }: { today: string }): UnitImportPlan {
  const column = (field: UnitImportField) => mapping.indexOf(field);
  const read = mapping.flatMap((field, at) => (field ? [at] : []));
  const notes: UnitImportNote[] = [];
  const units: UnitImportRow[] = [];
  const byVin = new Map<string, number>();
  let rowsRead = 0;
  for (let index = headerRow + 1; index < rows.length; index++) {
    const cells = rows[index];
    if (!read.some((at) => (cells[at] ?? "").trim())) continue;
    const row = index + 1;
    if (rowsRead === MAX_UNIT_IMPORT_ROWS) {
      notes.push({ row, message: `Only the first ${MAX_UNIT_IMPORT_ROWS.toLocaleString("en-US")} rows are imported; split the file to import the rest.` });
      break;
    }
    rowsRead++;
    const get = (field: UnitImportField) => {
      const at = column(field);
      return at < 0 ? "" : line(cells[at] ?? "");
    };
    const note = (message: string) => notes.push({ row, message });
    const vinText = get("vin");
    const modelText = get("model");
    // The headings again (a sheet printed in pages has them on each).
    if (fieldOf(vinText) === "vin" || fieldOf(modelText) === "model") continue;
    if (!vinText) {
      if (modelText && (get("receivedOn") || get("cost") || get("listPrice"))) note(`No VIN for ${quoted(modelText)}: left out.`);
      continue;
    }
    const vin = vinText.toUpperCase().replace(/[\s-]+/g, "");
    const what = modelText ? `${quoted(modelText)} (${vin})` : `VIN ${vin}`;
    if (!/^[A-Z0-9]+$/.test(vin)) {
      note(`VIN ${quoted(vinText)} isn't letters and figures: left out.`);
      continue;
    }
    if (vin.length < MIN_VIN_TAIL || vin.length > 17) {
      note(`VIN ${quoted(vinText)} ${vin.length > 17 ? "is too long" : `is too short to know the unit by (at least its last ${MIN_VIN_TAIL})`}: left out.`);
      continue;
    }
    const count = get("count");
    if (count && Number(count) === 0) {
      note(`${what} has 0 in the unit count, so the sheet doesn't count it: left out.`);
      continue;
    }
    if (count && Number(count) > 1) note(`${what} has ${count} in the unit count, but one VIN: imported once.`);

    // The year: its own column, else the front of the model, else a whole
    // VIN's character 10 (the latest year it can mean, up to next year).
    let model = modelText;
    let year = get("unitYear");
    const front = /^((?:19|20)\d{2})\s+(.+)$/.exec(model);
    if (front && (!year || front[1] === year || /^\d{2}$/.test(year))) {
      year ||= front[1];
      model = front[2];
    }
    if (/^\d{2}$/.test(year)) year = String(2000 + Number(year));
    if (!year && vin.length === 17) {
      const thisYear = Number(today.slice(0, 4));
      year = String(vinYears(vin, thisYear + 1)[0] ?? "");
    }
    if (!model) {
      note(`No model for VIN ${vin}: left out.`);
      continue;
    }

    // The day it came in: today's when the sheet has none.
    const receivedText = get("receivedOn");
    let receivedOn = receivedText ? sheetDay(receivedText) : null;
    if (!receivedOn) {
      note(receivedText ? `Received ${quoted(receivedText)} isn't a date: ${what} is imported as received today.` : `No Received date for ${what}: imported as received today.`);
      receivedOn = today;
    } else if (receivedOn > today) {
      note(`${what} was received ${formatDay(receivedOn)}, after today: check it.`);
    }
    const soldText = get("soldOn");
    const soldOn = soldText ? sheetDay(soldText) : null;
    if (soldText && !soldOn) note(`Sold ${quoted(soldText)} isn't a date: ${what} is imported as in stock.`);

    // An amount that isn't one is left out, keeping the unit.
    const amount = (field: "cost" | "listPrice") => {
      const text = get(field);
      if (!text) return "";
      const read = parseMoney(text);
      if ("error" in read || (read.cents !== null && read.cents < 0)) {
        note(`${UNIT_IMPORT_LABELS[field]} ${quoted(text)} for ${what} isn't an amount: left out.`);
        return "";
      }
      return text;
    };

    const fields: Record<keyof UnitFields, string> = {
      vin,
      unitYear: year,
      model,
      modelNumber: get("modelNumber"),
      description: "",
      engineNumber: get("engineNumber"),
      receivedOn,
      cost: amount("cost"),
      listPrice: amount("listPrice"),
      soldOn: soldOn ?? "",
      notes: get("notes"),
    };
    const checked = checkUnit(fields);
    if ("error" in checked) {
      note(`${what}: ${checked.error} Left out.`);
      continue;
    }
    const earlier = byVin.get(checked.unit.vin);
    if (earlier !== undefined) {
      note(`VIN ${checked.unit.vin} is on row ${earlier} too: imported once.`);
      continue;
    }
    byVin.set(checked.unit.vin, row);
    units.push({ row, fields, unit: checked.unit });
  }
  notes.sort((a, b) => a.row - b.row);
  return { units, notes, rowsRead };
}

// "12 units (11 with only the VIN's last 7)".
export function unitsInWords(units: readonly { unit: UnitFields }[]) {
  const partial = units.filter((one) => isPartialVin(one.unit.vin)).length;
  const count = `${units.length.toLocaleString("en-US")} ${units.length === 1 ? "unit" : "units"}`;
  if (partial === 0) return count;
  return `${count} (${partial === units.length ? (units.length === 1 ? "it has" : "all have") : `${partial.toLocaleString("en-US")} ${partial === 1 ? "has" : "have"}`} only the end of the VIN)`;
}

// What the server did with each unit of an import batch: added, on the list
// already (by its VIN, or its end), or left out, and why.
export type UnitImportOutcome = { row: number; result: "added" | "already" | "failed"; id: string | null; message: string | null };
