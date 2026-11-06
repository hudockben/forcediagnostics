// The Rebates tab's download (src/app/(app)/rebates/export/route.ts): the
// NUSR sheet as the shop keeps it, every sale of the years the invoice's
// units were sold in, with the rebates in AO (Holdback), AP (Retail Rwds)
// and AQ (Add'l Hlbk) and their TOTAL (nusrRebateSheet); and a Rebates
// sheet: each invoice and whether its lines add up to its total, every
// line as read (its Description, Unit Price and Amount) beside the sale it
// was found as, and the rebates by salesman and by category. Pure:
// src/lib/rebates.ts gathers the sales, and src/lib/xlsx-write.ts writes
// the sheets out.

import { nusrRebateSheet } from "@/lib/nusr-export";
import { unitLabel, type Cents, type FiguredSale } from "@/lib/nusr-rules";
import { REBATE_COLUMNS, REBATE_COLUMN_HEADINGS, REBATE_COLUMN_LETTERS, rebateCells, saleNotes, vinGuess, type RebateCells, type RebateColumn } from "@/lib/rebate-rules";
import type { Cell, Column, Sheet } from "@/lib/xlsx-write";

// A line of an invoice as the browser read it (and the person checked it):
// amounts as positive cents, the credit Polaris gives.
export type RebateLine = {
  line: number;
  part: string | null;
  vinRead: string;
  modelCode: string | null;
  programs: string[];
  dates: string[];
  names: string[];
  unitPrice: Cents | null;
  amount: Cents | null;
  saleId: string | null;
};

export type RebateInvoice = {
  fileName: string;
  number: string | null;
  type: string | null;
  date: string | null;
  total: Cents | null;
  // Which of AO, AP and AQ its amounts go in.
  column: RebateColumn;
  lines: RebateLine[];
};

export type RebateSale = FiguredSale & { id: string };

// What a line pays: its Amount, or its Unit Price when the Amount is blank.
export const lineRebate = (line: Pick<RebateLine, "amount" | "unitPrice">): Cents => (line.amount ? line.amount : (line.unitPrice ?? 0));

// "Invoice 314886", "Invoices 314886 and 314901", for titles.
export function invoicesTitle(invoices: readonly Pick<RebateInvoice, "number">[]) {
  const numbers = [...new Set(invoices.map((invoice) => invoice.number).filter((number): number is string => Boolean(number)))];
  if (numbers.length === 0) return invoices.length === 1 ? "Invoice" : "Invoices";
  if (numbers.length === 1) return `Invoice ${numbers[0]}`;
  return `Invoices ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}

// Each sale's AO, AP and AQ, from the lines found as it.
export function rebatesBySale(invoices: readonly RebateInvoice[], sales: ReadonlyMap<string, RebateSale>): Map<string, RebateCells> {
  const paid = new Map<string, { column: RebateColumn; cents: Cents }[]>();
  for (const invoice of invoices) {
    for (const line of invoice.lines) {
      if (!line.saleId || !sales.has(line.saleId)) continue;
      paid.set(line.saleId, [...(paid.get(line.saleId) ?? []), { column: invoice.column, cents: lineRebate(line) }]);
    }
  }
  return new Map([...paid].map(([id, lines]) => [id, rebateCells(lines, sales.get(id)!.figures.holdback)]));
}

// What's worth knowing about a line: the sale it was found as, as the page
// notes it, or that it wasn't found.
function lineNote(line: RebateLine, sale: RebateSale | undefined, column: RebateColumn, others: number[]) {
  if (!sale) return "Not found in the NUSR.";
  const how = sale.vin === vinGuess(line.vinRead) ? "vin" : null;
  return saleNotes({ vinRead: line.vinRead, how, sharedWith: others }, { vin: sale.vin, condition: sale.condition, holdback: sale.figures.holdback }, column)
    .map((note) => note.text)
    .join(" ");
}

const dollars = (cents: Cents | null) => (cents === null ? null : cents / 100);
// A credit as the invoice prints it: -$796.22 (and $0.00, not -$0.00).
const credit = (cents: Cents | null) => (cents === null ? null : cents === 0 ? 0 : -cents / 100);
const day = (iso: string | null) => (iso === null ? null : new Date(`${iso}T00:00:00Z`));

type Shares = Record<RebateColumn, Cents | null>;

// The download's sheets: NUSR with the rebates (when any line was found
// in the NUSR; `sales` are the sales of the years they were sold in), then
// Rebates.
export function rebateWorkbook(
  invoices: readonly RebateInvoice[],
  sales: readonly RebateSale[],
  { generatedAt, timeZone }: { generatedAt: Date; timeZone: string },
): Sheet[] {
  const byId = new Map(sales.map((sale) => [sale.id, sale]));
  const cells = rebatesBySale(invoices, byId);
  const title = invoicesTitle(invoices);
  const sheets: Sheet[] = [];
  if (cells.size > 0) sheets.push(nusrRebateSheet(sales, `Rebates ${title}`, (sale) => cells.get(sale.id) ?? null));
  sheets.push(rebatesSheet(invoices, byId, cells, { title, generatedAt, timeZone }));
  return sheets;
}

// The Rebates sheet's line columns: the invoice's, then the sale's, then
// what goes in AO, AP and AQ.
const LINE_COLUMNS: { heading: string; width: number; style?: Column["style"] }[] = [
  { heading: "Invoice", width: 18 },
  { heading: "Line", width: 6, style: "integer" },
  { heading: "Part", width: 6 },
  { heading: "VIN on the invoice", width: 21 },
  { heading: "Model code", width: 12 },
  { heading: "Program", width: 22 },
  { heading: "Purchased", width: 24 },
  { heading: "Name on the invoice", width: 26 },
  { heading: "Unit Price", width: 11, style: "money" },
  { heading: "Amount", width: 12, style: "money" },
  { heading: "Date sold", width: 11, style: "date" },
  { heading: "Salesman", width: 15 },
  { heading: "Customer (NUSR)", width: 26 },
  { heading: "Unit", width: 24 },
  { heading: "Category", width: 10 },
  { heading: "VIN in the NUSR", width: 21 },
  ...REBATE_COLUMNS.map((column) => ({ heading: `${REBATE_COLUMN_HEADINGS[column]} (${REBATE_COLUMN_LETTERS[column]})`, width: 15, style: "money" as const })),
  { heading: "Note", width: 44 },
];
// Where AO, AP and AQ's amounts are in it.
const FIRST_SHARE = LINE_COLUMNS.length - 1 - REBATE_COLUMNS.length;
const letter = (index: number) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

function rebatesSheet(
  invoices: readonly RebateInvoice[],
  sales: ReadonlyMap<string, RebateSale>,
  cells: ReadonlyMap<string, RebateCells>,
  { title, generatedAt, timeZone }: { title: string; generatedAt: Date; timeZone: string },
): Sheet {
  const downloaded = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "long", timeStyle: "short" }).format(generatedAt);
  const rows: Cell[][] = [[{ value: `Rebates · ${title}`, style: "title" }], [`Downloaded ${downloaded}`], []];

  // Each invoice: its total, what its lines add up to, and the difference.
  rows.push(["Invoice", "Date", "Type", "Lines", "Amounts in", "Total on the invoice", "Lines add up to", "Difference"].map((value): Cell => ({ value, style: "header" })));
  for (const invoice of invoices) {
    const read = invoice.lines.reduce((sum, line) => sum + lineRebate(line), 0);
    rows.push([
      invoice.number ?? invoice.fileName,
      { value: day(invoice.date), style: "date" },
      invoice.type,
      { value: invoice.lines.length, style: "integer" },
      `${REBATE_COLUMN_HEADINGS[invoice.column]} (${REBATE_COLUMN_LETTERS[invoice.column]})`,
      { value: invoice.total === null ? null : -Math.abs(invoice.total) / 100, style: "money" },
      { value: -read / 100, style: "money" },
      { value: invoice.total === null ? null : (Math.abs(invoice.total) - read) / 100, style: "money" },
    ]);
  }
  rows.push([]);

  // Every line, each sale's holdback from the NUSR on its first line, so
  // the totals here are the NUSR sheet's.
  type Group = { units: number; shares: Record<RebateColumn, Cents> };
  const bySalesman = new Map<string, { label: string; group: Group }>();
  const byCategory = new Map<string, { label: string; group: Group }>();
  const add = (groups: typeof bySalesman, label: string, shares: Shares) => {
    const key = label.trim().replace(/\s+/g, " ").toLowerCase();
    const entry = groups.get(key) ?? { label, group: { units: 0, shares: { holdback: 0, retailRewards: 0, addlHoldback: 0 } } };
    entry.group.units += 1;
    for (const column of REBATE_COLUMNS) entry.group.shares[column] += shares[column] ?? 0;
    groups.set(key, entry);
  };
  const holdbackShown = new Set<string>();
  const header = rows.length + 1;
  rows.push(LINE_COLUMNS.map(({ heading }): Cell => ({ value: heading, style: "header" })));
  for (const invoice of invoices) {
    const lineOf = new Map<string, number[]>();
    for (const line of invoice.lines) if (line.saleId) lineOf.set(line.saleId, [...(lineOf.get(line.saleId) ?? []), line.line]);
    for (const line of invoice.lines) {
      const sale = line.saleId ? sales.get(line.saleId) : undefined;
      const shares: Shares = { holdback: null, retailRewards: null, addlHoldback: null };
      shares[invoice.column] = lineRebate(line);
      const saleCells = sale ? cells.get(sale.id) : undefined;
      if (sale && saleCells?.holdback != null && invoice.column === "addlHoldback" && !holdbackShown.has(sale.id) && !paysHoldback(invoices, sale.id)) {
        shares.holdback = saleCells.holdback;
        holdbackShown.add(sale.id);
      }
      const also = sale ? (lineOf.get(sale.id) ?? []).filter((other) => other !== line.line) : [];
      const note = lineNote(line, sale, invoice.column, also);
      rows.push([
        invoice.number ?? invoice.fileName,
        line.line,
        line.part,
        line.vinRead,
        line.modelCode,
        line.programs.join("; ") || null,
        line.dates.join("; ") || null,
        line.names.join("; ") || null,
        credit(line.unitPrice),
        credit(line.amount),
        sale ? day(sale.soldOn) : null,
        sale?.salesperson ?? null,
        sale?.customerName ?? null,
        sale ? unitLabel(sale) : null,
        sale?.category ?? null,
        sale?.vin ?? null,
        ...REBATE_COLUMNS.map((column) => dollars(shares[column])),
        note || null,
      ]);
      add(bySalesman, sale ? sale.salesperson?.trim() || "No salesman" : "Not in the NUSR", shares);
      add(byCategory, sale ? sale.category?.trim() || "No category" : "Not in the NUSR", shares);
    }
  }
  const last = rows.length;
  const totals = LINE_COLUMNS.map((): Cell => ({ value: null, style: "total" }));
  totals[0] = { value: "TOTAL", style: "total" };
  for (const [offset, column] of REBATE_COLUMNS.entries()) {
    const at = letter(FIRST_SHARE + offset);
    const sum = [...bySalesman.values()].reduce((all, { group }) => all + group.shares[column], 0);
    totals[FIRST_SHARE + offset] = { formula: `SUM(${at}${header + 1}:${at}${last})`, value: sum / 100, style: "totalMoney" };
  }
  rows.push(totals, []);

  // The rebates by salesman and by category, the most units first, as the
  // shop added them up by hand under its sheet.
  for (const [heading, groups] of [
    ["Salesman", bySalesman],
    ["Category", byCategory],
  ] as const) {
    rows.push([heading, "Units", ...REBATE_COLUMNS.map((column) => REBATE_COLUMN_HEADINGS[column])].map((value): Cell => ({ value, style: "header" })));
    const sorted = [...groups.values()].sort((a, b) => b.group.units - a.group.units || a.label.localeCompare(b.label));
    for (const { label, group } of sorted) {
      rows.push([label, { value: group.units, style: "integer" }, ...REBATE_COLUMNS.map((column): Cell => ({ value: group.shares[column] / 100, style: "money" }))]);
    }
    rows.push([]);
  }

  return {
    name: "Rebates",
    columns: LINE_COLUMNS.map(({ width, style }) => ({ width, style })),
    rows,
    landscape: true,
    fitToWidth: true,
    footer: `Rebates · ${title}`,
  };
}

// Whether an invoice paid a sale's holdback itself (its amounts go in AO).
const paysHoldback = (invoices: readonly RebateInvoice[], saleId: string) =>
  invoices.some((invoice) => invoice.column === "holdback" && invoice.lines.some((line) => line.saleId === saleId));
