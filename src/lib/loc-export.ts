// The LOC tab's download (Download Excel): the list as the shop's own LOC
// sheet, so it opens on the layout the shop knows. The units we own under
// WE OWN, then the ones on the LOC, each by when its free floor ends, with
// the sheet's columns (Model, Stock #, Free Floor Ends, Cost, and a 1 in
// Units for counting) and the app's after them. Each section's total is a
// live SUM over its rows and a blank row under them, so a row inserted
// above the total is counted (the sheet's own WE OWN total had stopped six
// rows short); the LOC's is the Total on Flooring, which balances with the
// books, and the Grand Total adds the two. The totals are also at the top,
// as the tab has them. Stock #s are text, so a leading zero stays. Pure: the
// route (src/app/(app)/loc/export/route.ts) writes it out with
// src/lib/xlsx-write.ts, and the LOC tab's Import reads it back in.

import { LOC_ACCOUNT, LOC_SECTIONS, daysInStock, locUnitLabel, sectionOf, type LocSection, type LocUnitFields } from "@/lib/loc-rules";
import { formatDay } from "@/lib/nusr-rules";
import type { Cell, Column, Sheet } from "@/lib/xlsx-write";

export const LOC_EXPORT_HEADINGS = ["Model", "Stock #", "Free Floor Ends", "Cost", "VIN", "Units", "Notes", "New/Used", "Category", "Date in", "Days in stock", "Sold", "Paid off"] as const;

const COLUMNS: Column[] = [
  { width: 44 },
  { width: 12 },
  { width: 15, style: "date" },
  { width: 14, style: "money" },
  { width: 20 },
  { width: 7, style: "integer" },
  { width: 36 },
  { width: 10 },
  { width: 10 },
  { width: 11, style: "date" },
  { width: 9, style: "integer" },
  { width: 11, style: "date" },
  { width: 11, style: "date" },
];

const day = (iso: string | null): Cell => (iso === null ? null : { value: new Date(`${iso}T00:00:00Z`), style: "date" });
const dollars = (cents: number) => cents / 100;

// Excel's name for a row's cell in a column: D for Cost, F for Units.
const at = (column: "D" | "F", row: number) => `${column}${row}`;

export type LocWorkbookOptions = {
  // What the list is ("On the list", "On the LOC · Used"; see locFiltersTitle).
  title: string;
  // The shop's day the download was made, for its title and days in stock.
  today: string;
  // Whether the units are in the sheet's sections (the whole list), or one
  // list (one section, or sold units).
  grouped: boolean;
};

function unitRow(unit: LocUnitFields, today: string): Cell[] {
  const days = daysInStock(unit, today);
  return [
    locUnitLabel(unit),
    // Text, so "099837" keeps its zero.
    unit.stockNumber ?? null,
    day(unit.freeFloorEnds),
    { value: dollars(unit.cost), style: "money" },
    unit.vin,
    { value: 1, style: "integer" },
    unit.notes,
    unit.condition === "new" ? "New" : "Used",
    unit.category,
    day(unit.receivedOn),
    days === null ? null : { value: days, style: "integer" },
    day(unit.soldOn),
    day(unit.paidOffOn),
  ];
}

const SECTION_HEADS: Record<LocSection, string> = { owned: "WE OWN", loc: "ON THE LOC (we owe)" };

// The workbook's one sheet, LOC.
export function locWorkbook(units: readonly LocUnitFields[], options: LocWorkbookOptions): Sheet[] {
  const groups: { section: LocSection | null; units: LocUnitFields[] }[] = options.grouped
    ? LOC_SECTIONS.map((section) => ({ section, units: units.filter((unit) => sectionOf(unit) === section) })).filter((group) => group.units.length > 0)
    : [{ section: null, units: [...units] }];

  // The top: a title, a row for each total (filled in once the rows they
  // add up are known), a blank row, then the headings.
  const topRows = groups.length + (groups.length > 1 ? 1 : 0);
  const rows: Cell[][] = [[{ value: `LOC: ${options.title}, ${formatDay(options.today)}`, style: "title" }], ...Array.from({ length: topRows }, (): Cell[] => []), []];
  const headingRow = rows.length + 1;
  rows.push(LOC_EXPORT_HEADINGS.map((heading) => ({ value: heading, style: "header" })));

  // Each group's units, a blank row inside its sums, and its total.
  const totals: { section: LocSection | null; row: number; units: LocUnitFields[] }[] = [];
  for (const group of groups) {
    if (group.section) rows.push([{ value: SECTION_HEADS[group.section], style: "bold" }]);
    const first = rows.length + 1;
    for (const unit of group.units) rows.push(unitRow(unit, options.today));
    rows.push([]);
    const last = rows.length;
    const label =
      group.section === "loc"
        ? `Total on Flooring: must always balance with L/S account # ${LOC_ACCOUNT}`
        : group.section === "owned"
          ? "We own total"
          : "Total";
    const cost = group.units.reduce((sum, unit) => sum + unit.cost, 0);
    rows.push([
      { value: label, style: "total" },
      { value: null, style: "total" },
      { value: null, style: "total" },
      { formula: `SUM(${at("D", first)}:${at("D", last)})`, value: dollars(cost), style: "totalMoney" },
      { value: null, style: "total" },
      { formula: `SUM(${at("F", first)}:${at("F", last)})`, value: group.units.length, style: "totalInteger" },
    ]);
    totals.push({ section: group.section, row: rows.length, units: group.units });
    rows.push([]);
  }

  // The Grand Total, under the sections, as the sheet has it.
  const allCost = units.reduce((sum, unit) => sum + unit.cost, 0);
  if (totals.length > 1) {
    rows.push([
      { value: "Grand Total", style: "total" },
      { value: null, style: "total" },
      { value: null, style: "total" },
      { formula: totals.map((total) => at("D", total.row)).join("+"), value: dollars(allCost), style: "totalMoney" },
      { value: null, style: "total" },
      { formula: totals.map((total) => at("F", total.row)).join("+"), value: units.length, style: "totalInteger" },
    ]);
  }

  // The totals at the top, under Cost and Units, pointing at the ones below.
  const topTotal = (label: string, cost: number, count: number, rowsOf: number[]): Cell[] => [
    { value: label, style: "bold" },
    null,
    null,
    { formula: rowsOf.map((row) => at("D", row)).join("+"), value: dollars(cost), style: "money" },
    null,
    { formula: rowsOf.map((row) => at("F", row)).join("+"), value: count, style: "integer" },
  ];
  totals.forEach((total, index) => {
    const label = total.section === "loc" ? `On the LOC (balances with ${LOC_ACCOUNT})` : total.section === "owned" ? "We own" : "Total";
    rows[1 + index] = topTotal(label, total.units.reduce((sum, unit) => sum + unit.cost, 0), total.units.length, [total.row]);
  });
  if (totals.length > 1) {
    rows[1 + totals.length] = topTotal(
      "Grand Total",
      allCost,
      units.length,
      totals.map((total) => total.row),
    );
  }

  return [
    {
      name: "LOC",
      columns: COLUMNS,
      rows,
      freeze: { rows: headingRow, columns: 1 },
      landscape: true,
      fitToWidth: true,
      printTitles: headingRow,
      footer: `LOC ${formatDay(options.today)}`,
    },
  ];
}

// "LOC 2026-11-09.xlsx", "LOC On the LOC 2026-11-09.xlsx".
export function locFileName(title: string, today: string) {
  const what = title === "On the list" ? "" : ` ${title.replace(/[\\/:*?"<>|“”]+/g, "").replace(/\s*·\s*/g, " ").trim()}`;
  return `LOC${what.slice(0, 80)} ${today}.xlsx`;
}
