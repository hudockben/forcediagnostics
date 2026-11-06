// Reports' download (src/app/(app)/reports/export/route.ts): the salesmen's
// bonuses as a workbook, as the page shows them. For the overview, each
// salesman's week, month, quarter and year, then each of those periods
// with its units, total profit, Sales Bonus and Holdback Bonus; for one
// period, the same for it, its breakdown (by day, week or month), and the
// sales in it on a sheet of their own. Totals are live SUMs over the rows,
// holding the values the page shows. Pure: the route writes the sheets out
// with src/lib/xlsx-write.ts.

import { CONDITION_LETTERS, unitLabel, type FiguredSale } from "@/lib/nusr-rules";
import {
  DATE_BASIS_LABELS,
  PERIOD_LABELS,
  bonusTable,
  overviewPeriods,
  periodOf,
  periodSales,
  saleDay,
  subPeriods,
  type BonusTable,
  type BonusTotals,
  type ReportParams,
} from "@/lib/report-rules";
import type { Cell, Sheet } from "@/lib/xlsx-write";

type Sale = FiguredSale & { id: string };

const dollars = (cents: number) => cents / 100;
const day = (iso: string | null) => (iso === null ? null : new Date(`${iso}T00:00:00Z`));
// "November 6, 2026".
const longDay = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "long" }).format(new Date(`${iso}T00:00:00Z`));

// Its letters: 0 is A, 25 Z, 26 AA.
function letters(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const SPLIT_HEAD = ["Salesman", "Units", "Total profit", "Sales bonus", "Holdback bonus", "Total bonus"];
const splitCells = (totals: BonusTotals): Cell[] => [
  { value: totals.units, style: "integer" },
  { value: dollars(totals.totalProfit), style: "money" },
  { value: dollars(totals.salesBonus), style: "money" },
  { value: dollars(totals.holdbackBonus), style: "money" },
  { value: dollars(totals.total), style: "money" },
];

// A table's rows from the sheet's row `top` (1-based, its headings): one
// per salesman and a TOTAL row of SUMs over them. `cells` gives a row's
// cells after the salesman, `totals` the TOTAL row's values.
function block(top: number, head: string[], rows: { label: string; cells: Cell[] }[], totals: (number | null)[], money: boolean[]): Cell[][] {
  const first = top + 1;
  const last = top + rows.length;
  const totalRow: Cell[] = [{ value: "TOTAL", style: "total" }];
  totals.forEach((value, index) => {
    const column = letters(index + 1);
    totalRow.push(
      rows.length
        ? { formula: `SUM(${column}${first}:${column}${last})`, value: value ?? 0, style: money[index] ? "totalMoney" : "totalInteger" }
        : { value: value ?? 0, style: money[index] ? "totalMoney" : "totalInteger" },
    );
  });
  return [head.map((value): Cell => ({ value, style: "header" })), ...rows.map((row): Cell[] => [row.label, ...row.cells]), totalRow];
}

// A period's salesmen with their units, profit and bonuses.
function splitBlock(top: number, table: BonusTable): Cell[][] {
  const totals = table.totals[0];
  return block(
    top,
    SPLIT_HEAD,
    table.rows.map((row) => ({ label: row.label, cells: splitCells(row.cells[0]) })),
    [totals.units, dollars(totals.totalProfit), dollars(totals.salesBonus), dollars(totals.holdbackBonus), dollars(totals.total)],
    [false, true, true, true, true],
  );
}

// Each salesman's total bonus in each span, and in all of them.
function spansBlock(top: number, table: BonusTable, whole: string | null): Cell[][] {
  const rowTotal = (cells: BonusTotals[]) => cells.reduce((sum, cell) => sum + cell.total, 0);
  const head = ["Salesman", ...table.spans.map((span) => span.label), ...(whole ? [whole] : [])];
  return block(
    top,
    head,
    table.rows.map((row) => ({
      label: row.label,
      cells: [...row.cells.map((cell): Cell => ({ value: dollars(cell.total), style: "money" })), ...(whole ? [{ value: dollars(rowTotal(row.cells)), style: "money" } as Cell] : [])],
    })),
    [...table.totals.map((cell) => dollars(cell.total)), ...(whole ? [dollars(rowTotal(table.totals))] : [])],
    head.slice(1).map(() => true),
  );
}

// The sales behind it, the salesmen in the table's order.
function salesSheet(sales: readonly Sale[], params: ReportParams, title: string): Sheet {
  const head = [DATE_BASIS_LABELS[params.by], "Salesman", "Customer", "Unit", "VIN", "New/Used", "Total profit", "Sales bonus", "Holdback bonus", "Total bonus"];
  const dayOf = saleDay(params.by);
  const rows: Cell[][] = sales.map((sale) => [
    { value: day(dayOf(sale)), style: "date" },
    sale.salesperson,
    sale.customerName,
    unitLabel(sale),
    sale.vin,
    CONDITION_LETTERS[sale.condition],
    { value: dollars(sale.figures.totalProfit), style: "money" },
    { value: dollars(sale.figures.salesBonus), style: "money" },
    { value: dollars(sale.figures.holdbackBonus), style: "money" },
    { value: dollars(sale.figures.salesBonus + sale.figures.holdbackBonus), style: "money" },
  ]);
  const sum = (pick: (sale: Sale) => number) => dollars(sales.reduce((all, sale) => all + pick(sale), 0));
  const last = rows.length + 1;
  const total = (column: string, value: number): Cell => (rows.length ? { formula: `SUM(${column}2:${column}${last})`, value, style: "totalMoney" } : { value, style: "totalMoney" });
  return {
    name: "Sales",
    columns: [{ width: 13 }, { width: 18 }, { width: 28 }, { width: 26 }, { width: 21 }, { width: 9 }, { width: 14 }, { width: 14 }, { width: 15 }, { width: 14 }],
    rows: [
      head.map((value): Cell => ({ value, style: "header" })),
      ...rows,
      [
        { value: `TOTAL: ${sales.length} ${sales.length === 1 ? "sale" : "sales"}`, style: "total" },
        ...Array.from({ length: 5 }, (): Cell => ({ value: null, style: "total" })),
        total("G", sum((sale) => sale.figures.totalProfit)),
        total("H", sum((sale) => sale.figures.salesBonus)),
        total("I", sum((sale) => sale.figures.holdbackBonus)),
        total("J", sum((sale) => sale.figures.salesBonus + sale.figures.holdbackBonus)),
      ],
    ],
    freeze: { rows: 1, columns: 2 },
    autoFilter: `A1:J${Math.max(1, last)}`,
    landscape: true,
    fitToWidth: true,
    printTitles: 1,
    footer: title,
  };
}

// The download's sheets: Bonuses, then Sales.
export function bonusWorkbook(params: ReportParams, sales: readonly Sale[], { generatedAt, timeZone }: { generatedAt: Date; timeZone: string }): Sheet[] {
  const dayOf = saleDay(params.by);
  const downloaded = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "long", timeStyle: "short" }).format(generatedAt);
  const counted = `Each sale counted by its ${params.by === "sold" ? "date sold" : "Funding Rec'd date"}; a sale's bonus is its Sales Bonus (with any adjustment) and its Holdback Bonus, as the NUSR works them out. Weeks run Monday to Sunday.`;
  const rows: Cell[][] = [];
  let title: string;
  let listed: Sale[];

  if (params.view === "overview") {
    const periods = overviewPeriods(params.on);
    title = `Salesman bonuses as of ${longDay(params.on)}`;
    rows.push([{ value: `${title}: the week, month, quarter and year`, style: "title" }], [`Downloaded ${downloaded}. ${counted}`], []);
    const table = bonusTable(sales, dayOf, periods);
    rows.push(...spansBlock(rows.length + 1, { ...table, spans: periods.map((period) => ({ ...period, label: `${PERIOD_LABELS[period.kind]}: ${period.label}` })) }, null), []);
    for (const period of periods) {
      rows.push([{ value: `${PERIOD_LABELS[period.kind]}: ${period.label}`, style: "bold" }]);
      rows.push(...splitBlock(rows.length + 1, bonusTable(sales, dayOf, [period])), []);
    }
    listed = [...sales].sort((a, b) => ((dayOf(a) ?? "") < (dayOf(b) ?? "") ? -1 : 1));
  } else {
    const period = periodOf(params.view, params.on);
    title = `Salesman bonuses · ${period.label}`;
    rows.push([{ value: title, style: "title" }], [`Downloaded ${downloaded}. ${counted}`], []);
    const split = bonusTable(sales, dayOf, [period]);
    rows.push(...splitBlock(rows.length + 1, split), []);
    const breakdown = bonusTable(sales, dayOf, subPeriods(period));
    const order = new Map(split.rows.map((row, index) => [row.key, index]));
    breakdown.rows.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
    rows.push([{ value: `By ${period.kind === "week" ? "day" : period.kind === "month" ? "week" : "month"}`, style: "bold" }]);
    rows.push(...spansBlock(rows.length + 1, breakdown, "Total"), []);
    listed = periodSales(sales, dayOf, period, split.rows);
  }

  const widest = rows.reduce((most, row) => Math.max(most, row.length), 0);
  return [
    {
      name: "Bonuses",
      columns: [{ width: 22 }, ...Array.from({ length: Math.max(0, widest - 1) }, () => ({ width: 15 }))],
      rows,
      landscape: true,
      fitToWidth: true,
      footer: title,
    },
    salesSheet(listed, params, title),
  ];
}
