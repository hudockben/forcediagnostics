// NUSR's download (Download Excel on the NUSR tab): the log as the shop's
// own NUSR spreadsheet, so it opens on the sheet the shop knows. The NUSR
// sheet has the spreadsheet's columns, headings and colours, each figure it
// worked out as a live formula over the row's own cells (with the value
// saleFigures works out, shown before Excel works it out itself), and its
// TOTAL and AVG TOTAL rows. Summary has the period's totals, split by deal
// type as the spreadsheet's TOTAL NEW WG, TRADE, TRAILER and CONTEST rows
// split them, and by salesman, category and month. Comparison has the
// units sold each month, year beside year, which the shop used to type in.
// Pure: the route (src/app/(app)/nusr/export/route.ts) writes the sheets
// out with src/lib/xlsx-write.ts.

import {
  CONDITION_LETTERS,
  MONTH_NAMES,
  SALE_LABELS,
  UNIT_TYPES,
  UNIT_TYPE_LABELS,
  UNIT_TYPE_MARKERS,
  perUnit,
  saleTotals,
  totalsBy,
  type Cents,
  type FiguredSale,
  type MonthlyComparison,
  type SaleTotals,
} from "@/lib/nusr-rules";
import type { Cell, CellStyle, CellValue, Column, Sheet } from "@/lib/xlsx-write";

// The shop's own time zone, for when the download was made.
const SHOP_TIME_ZONE = "America/New_York";

// The headings the spreadsheet gave the columns it worked out.
export const FIGURE_HEADINGS = {
  unitProfit: "Unit Profit",
  unitProfitPct: "Unit Profit %",
  accProfit: "Acc. Profit",
  accProfitPct: "Acc. Profit %",
  holdback: "Holdback",
  totalProfit: "TOTAL PROFIT",
  profitPct: "PROFIT %",
  totalBonus: "TOTAL BONUS",
  holdbackBonus: "Holdback Bonus",
  salesBonus: "Sales Bonus",
} as const;

export type NusrWorkbookOptions = {
  // The log's title for what's in it ("2026", "October 2026 · New"; see
  // filtersTitle).
  title: string;
  comparison: MonthlyComparison;
  generatedAt: Date;
  timeZone?: string;
};

// The download's sheets, NUSR first, for writeXlsx.
export function nusrWorkbook(sales: readonly FiguredSale[], options: NusrWorkbookOptions): Sheet[] {
  const timeZone = options.timeZone ?? SHOP_TIME_ZONE;
  // The oldest first, as the spreadsheet reads; a day's sales stay in the
  // order they came.
  const ordered = [...sales].sort((a, b) => (a.soldOn < b.soldOn ? -1 : a.soldOn > b.soldOn ? 1 : 0));
  return [
    nusrSheet(ordered, options.title),
    summarySheet(ordered, options.title, options.generatedAt, timeZone),
    comparisonSheet(options.comparison, monthIn(options.generatedAt, timeZone), options.title),
  ];
}

const dollars = (cents: Cents | null) => (cents === null ? null : cents / 100);
// A date the log keeps ("2026-10-30") as a date cell.
const day = (iso: string | null) => (iso === null ? null : new Date(`${iso}T00:00:00Z`));

// --- The NUSR sheet ------------------------------------------------------------

type HeadStyle = "header" | "headerGreen" | "headerYellow";

// The NUSR sheet's columns, A to AQ: the spreadsheet's own (A left blank, as
// it was), then the four the app keeps that it didn't have. The headings of
// what's typed are the spreadsheet's, as SALE_LABELS has them.
const NUSR_COLUMNS: { heading: string; width: number; style?: CellStyle; head?: HeadStyle }[] = [
  { heading: "", width: 3 }, // A
  { heading: SALE_LABELS.soldOn, width: 11, style: "date" }, // B
  { heading: SALE_LABELS.salesperson, width: 15 }, // C
  { heading: SALE_LABELS.customerName, width: 28 }, // D
  { heading: SALE_LABELS.customerAddress, width: 36 }, // E
  { heading: SALE_LABELS.customerPhone, width: 15 }, // F
  { heading: SALE_LABELS.unitYear, width: 7 }, // G
  { heading: SALE_LABELS.unitModel, width: 24 }, // H
  { heading: SALE_LABELS.condition, width: 11 }, // I
  { heading: SALE_LABELS.vin, width: 21 }, // J
  { heading: SALE_LABELS.msrp, width: 13, style: "money" }, // K
  { heading: SALE_LABELS.salesPrice, width: 13, style: "money" }, // L
  { heading: SALE_LABELS.dealerCost, width: 13, style: "money" }, // M
  { heading: SALE_LABELS.unitLabor, width: 12, style: "money" }, // N
  { heading: SALE_LABELS.rebate, width: 15, style: "money" }, // O
  { heading: "*Notes*", width: 30 }, // P
  { heading: FIGURE_HEADINGS.unitProfit, width: 13, style: "money", head: "headerGreen" }, // Q
  { heading: FIGURE_HEADINGS.unitProfitPct, width: 14, style: "percent", head: "headerGreen" }, // R
  { heading: SALE_LABELS.accPrice, width: 17, style: "money" }, // S
  { heading: SALE_LABELS.accCost, width: 12, style: "money" }, // T
  { heading: SALE_LABELS.accLabor, width: 12, style: "money" }, // U
  { heading: FIGURE_HEADINGS.accProfit, width: 12, style: "money", head: "headerGreen" }, // V
  { heading: FIGURE_HEADINGS.accProfitPct, width: 14, style: "percent", head: "headerGreen" }, // W
  { heading: SALE_LABELS.escPrice, width: 12, style: "money" }, // X
  { heading: SALE_LABELS.escCost, width: 12, style: "money" }, // Y
  { heading: SALE_LABELS.rewards, width: 11, style: "money" }, // Z
  { heading: FIGURE_HEADINGS.holdback, width: 12, style: "money", head: "headerYellow" }, // AA
  { heading: FIGURE_HEADINGS.totalProfit, width: 15, style: "money", head: "headerYellow" }, // AB
  { heading: FIGURE_HEADINGS.profitPct, width: 11, style: "percent", head: "headerYellow" }, // AC
  { heading: FIGURE_HEADINGS.totalBonus, width: 14, style: "money", head: "headerYellow" }, // AD
  { heading: FIGURE_HEADINGS.holdbackBonus, width: 16, style: "money", head: "headerYellow" }, // AE
  { heading: FIGURE_HEADINGS.salesBonus, width: 13, style: "money", head: "headerYellow" }, // AF
  { heading: SALE_LABELS.financeCompany, width: 18 }, // AG
  { heading: SALE_LABELS.amountFinanced, width: 14, style: "money" }, // AH
  { heading: SALE_LABELS.downPayment, width: 12, style: "money" }, // AI
  { heading: SALE_LABELS.fundingReceivedOn, width: 14, style: "date" }, // AJ
  { heading: SALE_LABELS.paidOn, width: 11, style: "date" }, // AK
  { heading: SALE_LABELS.comsNumber, width: 12 }, // AL
  { heading: SALE_LABELS.category, width: 10 }, // AM
  { heading: SALE_LABELS.unitType, width: 15 }, // AN
  { heading: SALE_LABELS.holdbackRateBp, width: 12, style: "percent" }, // AO
  { heading: SALE_LABELS.bonusRateBp, width: 9, style: "percent" }, // AP
  { heading: SALE_LABELS.bonusAdjustment, width: 17, style: "money" }, // AQ
];

const LAST_COLUMN = "AQ";

// A sale's row, r being its row number: what was typed, and each figure as
// the spreadsheet's formula over the row's own cells, with the value
// saleFigures works out (in dollars, as Excel holds them). Blanks stay
// blank, which a formula counts as nothing, as saleFigures does. TOTAL
// PROFIT is kept to the cent, as saleFigures keeps it: amounts added up in
// dollars can come out a hair under (502.999999999997 for 503), and a bonus
// on it that's an exact half cent would then round the other way.
function saleRow(sale: FiguredSale, r: number): Cell[] {
  const f = sale.figures;
  const figure = (formula: string, value: CellValue): Cell => ({ formula, value });
  return [
    null,
    day(sale.soldOn),
    sale.salesperson,
    sale.customerName,
    sale.customerAddress,
    sale.customerPhone,
    sale.unitYear,
    sale.unitModel,
    CONDITION_LETTERS[sale.condition],
    sale.vin,
    // A deal with no MSRP says what it is there instead, as the spreadsheet
    // did; Holdback counts only a number.
    sale.msrp === null ? UNIT_TYPE_MARKERS[sale.unitType] || null : dollars(sale.msrp),
    dollars(sale.salesPrice),
    dollars(sale.dealerCost),
    dollars(sale.unitLabor),
    dollars(sale.rebate),
    sale.notes,
    figure(`L${r}-M${r}-N${r}+O${r}`, dollars(f.unitProfit)),
    figure(`IF(L${r}=0,"",Q${r}/L${r})`, f.unitProfitPct ?? ""),
    dollars(sale.accPrice),
    dollars(sale.accCost),
    dollars(sale.accLabor),
    figure(`S${r}-T${r}-U${r}`, dollars(f.accProfit)),
    figure(`IF(S${r}=0,"",V${r}/S${r})`, f.accProfitPct ?? ""),
    dollars(sale.escPrice),
    dollars(sale.escCost),
    dollars(sale.rewards),
    figure(`IF(ISNUMBER(K${r}),ROUND(K${r}*AO${r},2),0)`, dollars(f.holdback)),
    figure(`ROUND(Q${r}+V${r}+X${r}-Y${r}+Z${r}+AA${r},2)`, dollars(f.totalProfit)),
    figure(`IF(L${r}+S${r}+X${r}=0,"",AB${r}/(L${r}+S${r}+X${r}))`, f.profitPct ?? ""),
    figure(`ROUND(AB${r}*AP${r},2)`, dollars(f.totalBonus)),
    figure(`ROUND(AA${r}*AP${r},2)`, dollars(f.holdbackBonus)),
    figure(`AD${r}-AE${r}+AQ${r}`, dollars(f.salesBonus)),
    sale.financeCompany,
    dollars(sale.amountFinanced),
    dollars(sale.downPayment),
    day(sale.fundingReceivedOn),
    day(sale.paidOn),
    sale.comsNumber,
    sale.category,
    UNIT_TYPE_LABELS[sale.unitType],
    sale.holdbackRateBp / 10_000,
    sale.bonusRateBp / 10_000,
    dollars(sale.bonusAdjustment),
  ];
}

// The amounts the TOTAL row adds up, by column, and what each adds up to in
// saleTotals; the ones marked average also have an AVG TOTAL, per unit, as
// the spreadsheet's AVG rows had.
const SUMMED: { column: string; total: (totals: SaleTotals) => Cents; average?: true }[] = [
  { column: "K", total: (t) => t.amounts.msrp },
  { column: "L", total: (t) => t.amounts.salesPrice, average: true },
  { column: "M", total: (t) => t.amounts.dealerCost, average: true },
  { column: "N", total: (t) => t.amounts.unitLabor, average: true },
  { column: "O", total: (t) => t.amounts.rebate, average: true },
  { column: "Q", total: (t) => t.figures.unitProfit, average: true },
  { column: "S", total: (t) => t.amounts.accPrice, average: true },
  { column: "T", total: (t) => t.amounts.accCost, average: true },
  { column: "U", total: (t) => t.amounts.accLabor, average: true },
  { column: "V", total: (t) => t.figures.accProfit, average: true },
  { column: "X", total: (t) => t.amounts.escPrice, average: true },
  { column: "Y", total: (t) => t.amounts.escCost, average: true },
  { column: "Z", total: (t) => t.amounts.rewards, average: true },
  { column: "AA", total: (t) => t.figures.holdback, average: true },
  { column: "AB", total: (t) => t.figures.totalProfit, average: true },
  { column: "AD", total: (t) => t.figures.totalBonus, average: true },
  { column: "AE", total: (t) => t.figures.holdbackBonus, average: true },
  { column: "AF", total: (t) => t.figures.salesBonus, average: true },
  { column: "AH", total: (t) => t.amounts.amountFinanced },
  { column: "AI", total: (t) => t.amounts.downPayment },
  { column: "AQ", total: (t) => t.amounts.bonusAdjustment },
];

// Its place in a row: A is 0, Z 25, AA 26.
const columnIndex = (letters: string) => [...letters].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;

// The NUSR sheet: the headings, a row per sale, then the totals, frozen,
// filtered and set to print as the shop would want it on paper.
function nusrSheet(sales: readonly FiguredSale[], title: string): Sheet {
  const totals = saleTotals(sales);
  const lastSale = sales.length + 1;
  // A blank row under the sales, inside the TOTAL row's sums, so a row
  // inserted there in Excel is counted too.
  const spare = lastSale + 1;
  // The TOTAL row; AVG TOTAL is under it.
  const t = spare + 1;

  // The line over the TOTAL row runs the width of the sheet.
  const totalRow = NUSR_COLUMNS.map((_, i): Cell => (i === 0 ? null : { value: null, style: "total" }));
  const averageRow: Cell[] = [];
  totalRow[1] = { formula: `COUNTA(B2:B${spare})`, value: totals.units, style: "totalInteger" };
  totalRow[2] = { value: "TOTAL", style: "total" };
  averageRow[2] = { value: "AVG TOTAL", style: "bold" };
  for (const { column, total, average } of SUMMED) {
    const cents = total(totals);
    totalRow[columnIndex(column)] = { formula: `SUM(${column}2:${column}${spare})`, value: cents / 100, style: "totalMoney" };
    if (average) {
      averageRow[columnIndex(column)] = { formula: `IF($B$${t}=0,"",${column}${t}/$B$${t})`, value: totals.units ? cents / totals.units / 100 : "", style: "money" };
    }
  }
  totalRow[columnIndex("R")] = { formula: `IF(L${t}=0,"",Q${t}/L${t})`, value: totals.unitProfitPct ?? "", style: "totalPercent" };
  totalRow[columnIndex("W")] = { formula: `IF(S${t}=0,"",V${t}/S${t})`, value: totals.accProfitPct ?? "", style: "totalPercent" };
  totalRow[columnIndex("AC")] = { formula: `IF(L${t}+S${t}+X${t}=0,"",AB${t}/(L${t}+S${t}+X${t}))`, value: totals.profitPct ?? "", style: "totalPercent" };

  return {
    name: "NUSR",
    columns: NUSR_COLUMNS.map(({ width, style }): Column => ({ width, style })),
    rows: [
      NUSR_COLUMNS.map(({ heading, head }) => (heading ? { value: heading, style: head ?? "header" } : null)),
      ...sales.map((sale, i) => saleRow(sale, i + 2)),
      [],
      totalRow,
      averageRow,
    ],
    // The headings, and the date, salesman and customer, stay in view.
    freeze: { rows: 1, columns: 4 },
    autoFilter: `B1:${LAST_COLUMN}${lastSale}`,
    landscape: true,
    fitToWidth: true,
    printTitles: 1,
    printGridlines: true,
    footer: `NUSR ${title}`,
  };
}

// --- Summary --------------------------------------------------------------------

// Summary's columns after the first: the period's figures, by the
// spreadsheet's headings where it had them.
const SUMMARY_COLUMNS: { heading: string; width: number; style: CellStyle; value: (totals: SaleTotals) => CellValue }[] = [
  { heading: "Units", width: 8, style: "integer", value: (t) => t.units },
  { heading: "New", width: 7, style: "integer", value: (t) => t.newUnits },
  { heading: "Used", width: 7, style: "integer", value: (t) => t.usedUnits },
  { heading: "Gross", width: 15, style: "money", value: (t) => dollars(t.figures.gross) },
  { heading: FIGURE_HEADINGS.unitProfit, width: 14, style: "money", value: (t) => dollars(t.figures.unitProfit) },
  { heading: FIGURE_HEADINGS.accProfit, width: 13, style: "money", value: (t) => dollars(t.figures.accProfit) },
  { heading: "ESC Profit", width: 13, style: "money", value: (t) => dollars(t.figures.escProfit) },
  { heading: FIGURE_HEADINGS.holdback, width: 13, style: "money", value: (t) => dollars(t.figures.holdback) },
  { heading: FIGURE_HEADINGS.totalProfit, width: 15, style: "money", value: (t) => dollars(t.figures.totalProfit) },
  { heading: FIGURE_HEADINGS.profitPct, width: 11, style: "percent", value: (t) => t.profitPct },
  { heading: "Profit per unit", width: 15, style: "money", value: (t) => dollars(perUnit(t.figures.totalProfit, t.units)) },
  { heading: FIGURE_HEADINGS.totalBonus, width: 14, style: "money", value: (t) => dollars(t.figures.totalBonus) },
  { heading: FIGURE_HEADINGS.holdbackBonus, width: 16, style: "money", value: (t) => dollars(t.figures.holdbackBonus) },
  { heading: FIGURE_HEADINGS.salesBonus, width: 14, style: "money", value: (t) => dollars(t.figures.salesBonus) },
];

// Totals for each salesman or category, however its capitals were typed
// ("Sam Ortiz" and "sam ortiz" are one), under the spelling typed most
// (the first of those when it's a tie); the most units first.
function groupedBy(sales: readonly FiguredSale[], valueOf: (sale: FiguredSale) => string | null, none: string) {
  const spellings = new Map<string, Map<string, number>>();
  const keyOf = (sale: FiguredSale) => {
    const value = valueOf(sale)?.trim() ?? "";
    const key = value.toLowerCase();
    const counts = spellings.get(key) ?? new Map<string, number>();
    counts.set(value, (counts.get(value) ?? 0) + 1);
    spellings.set(key, counts);
    return key;
  };
  const labelOf = (key: string) => {
    let best = "";
    let most = 0;
    for (const [spelling, count] of spellings.get(key) ?? []) {
      if (count > most) [best, most] = [spelling, count];
    }
    return best || none;
  };
  return totalsBy(sales, keyOf)
    .map(({ key, totals }) => ({ label: labelOf(key), totals }))
    .sort((a, b) => b.totals.units - a.totals.units || a.label.localeCompare(b.label));
}

// Summary: what the download holds and when it was made, then a table of
// the figures for each way of splitting the sales.
function summarySheet(sales: readonly FiguredSale[], title: string, generatedAt: Date, timeZone: string): Sheet {
  const downloaded = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "long", timeStyle: "short" }).format(generatedAt);
  const block = (heading: string, groups: { label: string; totals: SaleTotals }[]): Cell[][] => [
    [{ value: heading, style: "header" }, ...SUMMARY_COLUMNS.map(({ heading }): Cell => ({ value: heading, style: "header" }))],
    ...groups.map(({ label, totals }): Cell[] => [label, ...SUMMARY_COLUMNS.map(({ value }) => value(totals))]),
    [],
  ];
  const months = totalsBy(sales, (sale) => sale.soldOn.slice(0, 7))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map(({ key, totals }) => ({ label: `${MONTH_NAMES[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`, totals }));
  return {
    name: "Summary",
    columns: [{ width: 24 }, ...SUMMARY_COLUMNS.map(({ width, style }) => ({ width, style }))],
    rows: [
      [{ value: `NUSR ${title}`, style: "title" }],
      [`Downloaded ${downloaded}`],
      [],
      ...block("Totals", [{ label: "TOTAL", totals: saleTotals(sales) }]),
      ...block(
        "Deal type",
        UNIT_TYPES.map((type) => ({ label: UNIT_TYPE_LABELS[type], totals: saleTotals(sales.filter((sale) => sale.unitType === type)) })),
      ),
      ...block("Salesman", groupedBy(sales, (sale) => sale.salesperson, "No salesman")),
      ...block("Category", groupedBy(sales, (sale) => sale.category, "No category")),
      ...block("Month", months),
    ],
    landscape: true,
    fitToWidth: true,
    footer: `NUSR ${title}`,
  };
}

// --- Comparison -----------------------------------------------------------------

// The year and month it is in the shop's time zone.
function monthIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(date);
  const part = (type: "year" | "month") => Number(parts.find((p) => p.type === type)?.value);
  return { year: part("year"), month: part("month") };
}

// Its letters: 0 is A, 25 Z, 26 AA.
function columnLetters(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// Units sold each month of every year with sales, with the change from the
// year before between each two years ("2025 to 2026") and the year's totals
// under them, as the spreadsheet's Comparison table had them, worked out
// with formulas. A month that hasn't come yet is blank, not 0, unless
// something was sold in it.
function comparisonSheet(comparison: MonthlyComparison, now: { year: number; month: number }, title: string): Sheet {
  const { years } = comparison;
  // Month in A, then each year with the change from the one before it
  // between them: the year i is column 2i + 1.
  const letterOf = years.map((_, i) => columnLetters(2 * i + 1));
  const totalRow = comparison.months.length + 2;
  const heading: Cell[] = [{ value: "Month", style: "header" }];
  const columns: Column[] = [{ width: 12 }];
  years.forEach((year, i) => {
    if (i > 0) {
      heading.push({ value: `${years[i - 1]} to ${year}`, style: "header" });
      columns.push({ width: 13, style: "change" });
    }
    heading.push({ value: String(year), style: "header" });
    columns.push({ width: 8, style: "integer" });
  });

  const rows: Cell[][] = comparison.months.map(({ month, units }, m) => {
    const r = m + 2;
    const yet = (year: number) => year < now.year || (year === now.year && month <= now.month) || units[year] > 0;
    const row: Cell[] = [MONTH_NAMES[month - 1]];
    years.forEach((year, i) => {
      if (i > 0) {
        const before = years[i - 1];
        row.push(yet(year) ? { formula: `${letterOf[i]}${r}-${letterOf[i - 1]}${r}`, value: units[year] - units[before] } : null);
      }
      row.push(yet(year) ? units[year] : null);
    });
    return row;
  });

  const totals: Cell[] = [{ value: "Total", style: "total" }];
  years.forEach((year, i) => {
    if (i > 0) {
      const before = years[i - 1];
      totals.push({ formula: `${letterOf[i]}${totalRow}-${letterOf[i - 1]}${totalRow}`, value: comparison.totals[year] - comparison.totals[before], style: "totalChange" });
    }
    totals.push({ formula: `SUM(${letterOf[i]}2:${letterOf[i]}${totalRow - 1})`, value: comparison.totals[year], style: "totalInteger" });
  });

  return {
    name: "Comparison",
    columns,
    rows: [heading, ...rows, totals],
    freeze: { rows: 1, columns: 1 },
    landscape: true,
    fitToWidth: true,
    footer: `NUSR ${title}`,
  };
}

// --- The download's name --------------------------------------------------------

// The download's file name, "NUSR 2026 2026-10-31.xlsx": the log's title
// for what's in it and the day it was downloaded, without anything a
// computer won't have in a file name (/ \ : * ? " < > |).
export function nusrFileName(title: string, today: string) {
  const safe = title
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .trim()
    .slice(0, 120)
    .trim();
  return `NUSR ${safe} ${today}.xlsx`.replace(/\s+/g, " ");
}

// Content-Disposition for a download: the name as it is (filename*, which
// today's browsers read), and in plain ASCII for any that don't.
export function attachmentHeader(fileName: string) {
  const ascii = fileName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”‘’]/g, "'")
    .replace(/[·–—]/g, "-")
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\]/g, "'");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
