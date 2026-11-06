// Reports (the Reports tab): what the salesmen's bonuses come to by week,
// month, quarter and year, from the NUSR's own figures for each sale: its
// Sales Bonus (paid on the deal, with any bonus adjustment) and its
// Holdback Bonus, which together are the bonus the deal pays. A sale counts
// in a period by the day it was sold (the NUSR's Date), or by the day its
// funding came in (Funding Rec'd), for a shop that pays bonuses then.
// Weeks run Monday to Sunday; quarters and years are the calendar's. No
// server imports: the page, the download and the tests share these.

import { formatMoney, line, parseIsoDate, shopToday, type Cents, type FiguredSale } from "@/lib/nusr-rules";

// --- Periods --------------------------------------------------------------------

export const REPORT_PERIODS = ["week", "month", "quarter", "year"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];
export const PERIOD_LABELS: Record<ReportPeriod, string> = { week: "Week", month: "Month", quarter: "Quarter", year: "Year" };

// A stretch of days, both ends included ("2026-11-02" to "2026-11-08").
export type Span = { start: string; end: string; label: string };
export type Period = Span & { kind: ReportPeriod; short: string };

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const DAY_MS = 86_400_000;
const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`);
const isoOf = (date: Date) => date.toISOString().slice(0, 10);
export const addDays = (iso: string, days: number) => isoOf(new Date(dateOf(iso).getTime() + days * DAY_MS));
// Monday 0 to Sunday 6.
const weekday = (iso: string) => (dateOf(iso).getUTCDay() + 6) % 7;
const parts = (iso: string) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) });
// The first and last days of a month (1-12), as days.
const monthStart = (year: number, month: number) => isoOf(new Date(Date.UTC(year, month - 1, 1)));
const monthEnd = (year: number, month: number) => isoOf(new Date(Date.UTC(year, month, 0)));

// "Nov 2 – 8, 2026", "Oct 26 – Nov 1, 2026", "Dec 29, 2025 – Jan 4, 2026".
function daysLabel(start: string, end: string) {
  const a = parts(start);
  const b = parts(end);
  if (start === end) return `${SHORT_MONTHS[a.month - 1]} ${a.day}, ${a.year}`;
  if (a.year !== b.year) return `${SHORT_MONTHS[a.month - 1]} ${a.day}, ${a.year} – ${SHORT_MONTHS[b.month - 1]} ${b.day}, ${b.year}`;
  if (a.month !== b.month) return `${SHORT_MONTHS[a.month - 1]} ${a.day} – ${SHORT_MONTHS[b.month - 1]} ${b.day}, ${b.year}`;
  return `${SHORT_MONTHS[a.month - 1]} ${a.day} – ${b.day}, ${a.year}`;
}

// The week, month, quarter or year a day is in.
export function periodOf(kind: ReportPeriod, day: string): Period {
  const { year, month } = parts(day);
  switch (kind) {
    case "week": {
      const start = addDays(day, -weekday(day));
      const end = addDays(start, 6);
      return { kind, start, end, label: daysLabel(start, end), short: `Week of ${SHORT_MONTHS[parts(start).month - 1]} ${parts(start).day}` };
    }
    case "month":
      return { kind, start: monthStart(year, month), end: monthEnd(year, month), label: `${LONG_MONTHS[month - 1]} ${year}`, short: LONG_MONTHS[month - 1] };
    case "quarter": {
      const first = Math.floor((month - 1) / 3) * 3 + 1;
      const quarter = (first + 2) / 3;
      return {
        kind,
        start: monthStart(year, first),
        end: monthEnd(year, first + 2),
        label: `Q${quarter} ${year} (${SHORT_MONTHS[first - 1]} – ${SHORT_MONTHS[first + 1]})`,
        short: `Q${quarter}`,
      };
    }
    case "year":
      return { kind, start: `${year}-01-01`, end: `${year}-12-31`, label: String(year), short: String(year) };
  }
}

// A day in the period before (-1) or after (1) this one: its first day.
export function shiftPeriod(period: Period, step: -1 | 1): string {
  const { year, month } = parts(period.start);
  switch (period.kind) {
    case "week":
      return addDays(period.start, 7 * step);
    case "month":
      return isoOf(new Date(Date.UTC(year, month - 1 + step, 1)));
    case "quarter":
      return isoOf(new Date(Date.UTC(year, month - 1 + 3 * step, 1)));
    case "year":
      return `${year + step}-01-01`;
  }
}

// A period split up for its breakdown: a week by day, a month by week (cut
// at the month's ends), a quarter or a year by month.
export function subPeriods(period: Period): Span[] {
  if (period.kind === "week") {
    return WEEKDAYS.map((name, index) => {
      const day = addDays(period.start, index);
      return { start: day, end: day, label: `${name} ${parts(day).month}/${parts(day).day}` };
    });
  }
  if (period.kind === "month") {
    const spans: Span[] = [];
    for (let start = period.start; start <= period.end; ) {
      const sunday = addDays(start, 6 - weekday(start));
      const end = sunday < period.end ? sunday : period.end;
      const [a, b] = [parts(start), parts(end)];
      spans.push({ start, end, label: start === end ? `${SHORT_MONTHS[a.month - 1]} ${a.day}` : `${SHORT_MONTHS[a.month - 1]} ${a.day} – ${b.day}` });
      start = addDays(end, 1);
    }
    return spans;
  }
  const { year, month } = parts(period.start);
  const months = period.kind === "quarter" ? 3 : 12;
  return Array.from({ length: months }, (_, index) => ({
    start: monthStart(year, month + index),
    end: monthEnd(year, month + index),
    label: SHORT_MONTHS[month + index - 1],
  }));
}

// --- What the page shows ------------------------------------------------------

// The overview (each salesman's week, month, quarter and year), or one
// period on its own.
export type ReportView = "overview" | ReportPeriod;
// Which day counts a sale in a period: when it was sold, or when its
// funding came in.
export type DateBasis = "sold" | "funded";
export const DATE_BASIS_LABELS: Record<DateBasis, string> = { sold: "Date sold", funded: "Funding Rec'd" };

export type ReportParams = { view: ReportView; on: string; by: DateBasis };

type Params = Record<string, string | string[] | undefined>;
const param = (params: Params, key: string) => {
  const value = params[key];
  return line(typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? "") : "");
};

// From the address: the view (the overview unless a period is asked for),
// the day it's about (the shop's today unless another real day is asked
// for) and the date that counts a sale.
export function parseReportParams(params: Params, today = shopToday()): ReportParams {
  const view = param(params, "view");
  return {
    view: (REPORT_PERIODS as readonly string[]).includes(view) ? (view as ReportPeriod) : "overview",
    on: parseIsoDate(param(params, "on")) ?? today,
    by: param(params, "by") === "funded" ? "funded" : "sold",
  };
}

// The address's search for a report, leaving out what's as it is by
// default ("?view=month&on=2026-10-01").
export function reportSearch({ view, on, by }: ReportParams, today = shopToday()) {
  const search = new URLSearchParams();
  if (view !== "overview") search.set("view", view);
  if (on !== today) search.set("on", on);
  if (by !== "sold") search.set("by", by);
  const text = search.toString();
  return text ? `?${text}` : "";
}

// The four periods of the overview, the day `on` is in.
export const overviewPeriods = (on: string): Period[] => REPORT_PERIODS.map((kind) => periodOf(kind, on));

// The days a report's sales come from: every period it shows.
export function reportDays(params: ReportParams): { from: string; to: string } {
  const periods = params.view === "overview" ? overviewPeriods(params.on) : [periodOf(params.view, params.on)];
  return {
    from: periods.reduce((from, period) => (period.start < from ? period.start : from), periods[0].start),
    to: periods.reduce((to, period) => (period.end > to ? period.end : to), periods[0].end),
  };
}

// --- Bonuses --------------------------------------------------------------------

// What sales came to: units, their total profit, and their bonuses (the
// Sales Bonus, the Holdback Bonus, and the two together).
export type BonusTotals = { units: number; totalProfit: Cents; salesBonus: Cents; holdbackBonus: Cents; total: Cents };

export const noBonus = (): BonusTotals => ({ units: 0, totalProfit: 0, salesBonus: 0, holdbackBonus: 0, total: 0 });

export function addBonus(totals: BonusTotals, sale: FiguredSale) {
  const { salesBonus, holdbackBonus, totalProfit } = sale.figures;
  totals.units += 1;
  totals.totalProfit += totalProfit;
  totals.salesBonus += salesBonus;
  totals.holdbackBonus += holdbackBonus;
  totals.total += salesBonus + holdbackBonus;
  return totals;
}

// The day that counts a sale, or null (a sale not funded yet, by funding).
export const saleDay = (by: DateBasis) => (sale: Pick<FiguredSale, "soldOn" | "fundingReceivedOn">) => (by === "funded" ? sale.fundingReceivedOn : sale.soldOn);

// A salesman as the NUSR has them: one person however their name's
// capitalised or spaced; a sale with none is "No salesman".
export const NO_SALESMAN = "No salesman";
const salesmanKey = (name: string | null) => (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export type BonusRow = { key: string; label: string; cells: BonusTotals[] };
export type BonusTable = { spans: Span[]; rows: BonusRow[]; totals: BonusTotals[] };

// Each salesman's bonuses in each span (a sale counts in every span its day
// is in), under the spelling of their name most sales have (the first of
// those when it's a tie), the most paid in the span `rankBy` first and
// sales with no salesman last; a salesman with no sales in any span isn't
// listed.
export function bonusTable(sales: readonly FiguredSale[], dayOf: (sale: FiguredSale) => string | null, spans: readonly Span[], rankBy = spans.length - 1): BonusTable {
  const rows = new Map<string, { cells: BonusTotals[]; spellings: Map<string, number> }>();
  const totals = spans.map(noBonus);
  for (const sale of sales) {
    const day = dayOf(sale);
    if (!day) continue;
    const inSpans = spans.flatMap((span, index) => (day >= span.start && day <= span.end ? [index] : []));
    if (inSpans.length === 0) continue;
    const key = salesmanKey(sale.salesperson);
    const row = rows.get(key) ?? { cells: spans.map(noBonus), spellings: new Map<string, number>() };
    const spelling = (sale.salesperson ?? "").trim().replace(/\s+/g, " ");
    row.spellings.set(spelling, (row.spellings.get(spelling) ?? 0) + 1);
    for (const index of inSpans) {
      addBonus(row.cells[index], sale);
      addBonus(totals[index], sale);
    }
    rows.set(key, row);
  }
  const labelOf = (key: string, spellings: Map<string, number>) => {
    let best = "";
    let most = 0;
    for (const [spelling, count] of spellings) if (count > most) [best, most] = [spelling, count];
    return key === "" ? NO_SALESMAN : best;
  };
  return {
    spans: [...spans],
    rows: [...rows.entries()]
      .map(([key, row]) => ({ key, label: labelOf(key, row.spellings), cells: row.cells }))
      .sort((a, b) => Number(a.key === "") - Number(b.key === "") || b.cells[rankBy].total - a.cells[rankBy].total || a.label.localeCompare(b.label)),
    totals,
  };
}

// The sales of a period, each salesman's together in the order the table
// lists them, then by day.
export function periodSales<T extends FiguredSale>(sales: readonly T[], dayOf: (sale: T) => string | null, period: Span, order: readonly BonusRow[]): T[] {
  const rank = new Map(order.map((row, index) => [row.key, index]));
  return sales
    .filter((sale) => {
      const day = dayOf(sale);
      return day !== null && day >= period.start && day <= period.end;
    })
    .sort((a, b) => {
      const byRow = (rank.get(salesmanKey(a.salesperson)) ?? order.length) - (rank.get(salesmanKey(b.salesperson)) ?? order.length);
      const [dayA, dayB] = [dayOf(a)!, dayOf(b)!];
      return byRow || (dayA < dayB ? -1 : dayA > dayB ? 1 : 0);
    });
}

// "$1,234.56", for a bonus.
export const formatBonus = (cents: Cents) => formatMoney(cents);

// The download's name: "Bonuses November 2026 2026-11-06.xlsx", "Bonuses
// as of 2026-11-06.xlsx" for the overview, with "by funding" when it counts
// sales by their funding.
export function bonusesFileName(params: ReportParams, today: string) {
  const what = params.view === "overview" ? `as of ${params.on}` : periodOf(params.view, params.on).label.replace(/[^\w ,–-]+/g, "").replace(/\s+/g, " ").trim();
  return `Bonuses ${what}${params.by === "funded" ? " by funding" : ""} ${today}.xlsx`;
}
