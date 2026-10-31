import type { ReactNode } from "react";

import {
  MONTH_NAMES,
  UNIT_TYPES,
  UNIT_TYPE_LABELS,
  formatMoney,
  formatPct,
  perUnit,
  saleTotals,
  totalsBy,
  type FiguredSale,
  type MonthlyComparison,
  type SaleTotals,
} from "@/lib/nusr-rules";

// NUSR's summary, for its page and its printout: what the spreadsheet's
// TOTAL, AVG, NEW WG, TRADE, TRAILER and salesman blocks and its Comparison
// table showed, worked out from the sales instead of typed.

type Row = { label: string; totals: SaleTotals };

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

function Table({ caption, head, rows, variant }: { caption: string; head: string[]; rows: ReactNode[][]; variant: "screen" | "print" }) {
  const screen = variant === "screen";
  const cell = screen ? "px-3 py-2 whitespace-nowrap first:pl-0 last:pr-0" : "border border-neutral-300 px-1.5 py-1 whitespace-nowrap";
  return (
    <div className={screen ? "overflow-x-auto" : "break-inside-avoid"}>
      <table className={screen ? "w-full text-sm" : "mt-2 w-full border-collapse text-[8pt] text-black"}>
        <caption className={screen ? "pb-2 text-left text-base font-semibold text-ink" : "pb-1 text-left text-[10pt] font-semibold"}>{caption}</caption>
        <thead className={screen ? "border-b border-white/10" : undefined}>
          <tr>
            {head.map((label, index) => (
              <th
                key={label}
                scope="col"
                className={`${cell} ${index === 0 ? "text-left" : "text-right"} ${screen ? "text-xs font-medium text-ink-muted" : "bg-neutral-100 font-semibold"}`}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={screen ? "divide-y divide-white/10" : undefined}>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className={screen && rowIndex === rows.length - 1 && rows.length > 1 ? "font-semibold" : undefined}>
              {row.map((value, index) =>
                index === 0 ? (
                  <th key={index} scope="row" className={`${cell} text-left font-normal ${screen ? "text-ink" : ""}`}>
                    {value}
                  </th>
                ) : (
                  <td key={index} className={`${cell} text-right tabular-nums ${screen ? "text-ink" : ""}`}>
                    {value}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PROFIT_HEAD = ["", "Units", "Gross", "Unit profit", "Acc. profit", "ESC profit", "Holdback", "Total profit", "Profit %", "A unit", "Total bonus", "Sales bonus"];
const profitRow = ({ label, totals }: Row): ReactNode[] => [
  label,
  totals.units.toLocaleString("en-US"),
  formatMoney(totals.figures.gross),
  formatMoney(totals.figures.unitProfit),
  formatMoney(totals.figures.accProfit),
  formatMoney(totals.figures.escProfit),
  formatMoney(totals.figures.holdback),
  formatMoney(totals.figures.totalProfit),
  formatPct(totals.profitPct),
  formatMoney(perUnit(totals.figures.totalProfit, totals.units)),
  formatMoney(totals.figures.totalBonus),
  formatMoney(totals.figures.salesBonus),
];

// What a unit averaged, as the spreadsheet's AVG rows had it: each total
// over the units, to the cent.
const AVERAGE_HEAD = ["", "Units", "Sales price", "Dealer cost", "Unit profit", "Acc. profit", "Holdback", "Total profit", "Total bonus", "Sales bonus"];
const averageRow = ({ label, totals }: Row): ReactNode[] => [
  label,
  totals.units.toLocaleString("en-US"),
  ...[
    totals.amounts.salesPrice,
    totals.amounts.dealerCost,
    totals.figures.unitProfit,
    totals.figures.accProfit,
    totals.figures.holdback,
    totals.figures.totalProfit,
    totals.figures.totalBonus,
    totals.figures.salesBonus,
  ].map((cents) => formatMoney(perUnit(cents, totals.units))),
];

export function SummaryTables({
  sales,
  comparison,
  narrowing = "",
  today,
  variant,
}: {
  sales: FiguredSale[];
  comparison: MonthlyComparison | null;
  // What narrows the log besides the year and month, which the
  // year-by-year counts follow too.
  narrowing?: string;
  // The shop's day ("2026-10-31"): months after it are still to come.
  today: string;
  variant: "screen" | "print";
}) {
  const all = saleTotals(sales);
  const byType = UNIT_TYPES.map((type) => ({ label: UNIT_TYPE_LABELS[type], totals: saleTotals(sales.filter((sale) => sale.unitType === type)) })).filter(
    (row) => row.totals.units > 0,
  );
  const sorted = (rows: { key: string; totals: SaleTotals }[]) =>
    rows.sort((a, b) => b.totals.units - a.totals.units || a.key.localeCompare(b.key)).map((row) => ({ label: row.key, totals: row.totals }));
  // Salesmen are one person however their name's capitalised.
  const bySalesman = sorted(totalsBy(sales, (sale) => sale.salesperson?.trim() || "No salesman"));
  const byCategory = sorted(totalsBy(sales, (sale) => sale.category?.trim() || "No category"));
  const byMonth = totalsBy(sales, (sale) => sale.soldOn.slice(0, 7))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((row) => ({ label: `${MONTH_NAMES[Number(row.key.slice(5, 7)) - 1]} ${row.key.slice(0, 4)}`, totals: row.totals }));
  const total = { label: `Total: ${plural(all.units, "unit", "units")}`, totals: all };
  const screen = variant === "screen";
  const gap = screen ? "space-y-8" : "space-y-4";

  return (
    <div className={gap} data-nusr-summary>
      <Table caption="By type of deal (NEW WG, Trade, Trailer…)" head={PROFIT_HEAD} rows={[...byType, total].map(profitRow)} variant={variant} />
      <Table caption="Averages a unit, by type of deal (AVG NEW WG, AVG TRADE…)" head={AVERAGE_HEAD} rows={[...byType, total].map(averageRow)} variant={variant} />
      <Table
        caption="By salesman"
        head={["", "Units", "Total profit", "A unit", "Total bonus", "Holdback bonus", "Sales bonus"]}
        rows={[...bySalesman, total].map(({ label, totals }) => [
          label,
          totals.units.toLocaleString("en-US"),
          formatMoney(totals.figures.totalProfit),
          formatMoney(perUnit(totals.figures.totalProfit, totals.units)),
          formatMoney(totals.figures.totalBonus),
          formatMoney(totals.figures.holdbackBonus),
          formatMoney(totals.figures.salesBonus),
        ])}
        variant={variant}
      />
      <Table caption="By category" head={PROFIT_HEAD} rows={[...byCategory, total].map(profitRow)} variant={variant} />
      {byMonth.length > 1 && <Table caption="By month" head={PROFIT_HEAD} rows={[...byMonth, total].map(profitRow)} variant={variant} />}
      {comparison && comparison.years.length > 0 && <ComparisonTable comparison={comparison} narrowing={narrowing} today={today} variant={variant} />}
    </div>
  );
}

// Units sold each month, year beside year, with the change from the year
// before, as the spreadsheet's Comparison table had them. A month still to
// come is blank, not 0, unless it has sales, as in the download.
export function ComparisonTable({
  comparison,
  narrowing = "",
  today,
  variant,
}: {
  comparison: MonthlyComparison;
  narrowing?: string;
  today: string;
  variant: "screen" | "print";
}) {
  const { years } = comparison;
  const change = (now: number, before: number) => {
    const diff = now - before;
    return diff > 0 ? `+${diff}` : String(diff);
  };
  const [thisYear, thisMonth] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const toCome = (year: number, month: number, units: number) => units === 0 && (year > thisYear || (year === thisYear && month > thisMonth));
  const head = ["", ...years.flatMap((year, index) => (index === 0 ? [String(year)] : [String(year), `vs ${years[index - 1]}`]))];
  const rows = [
    ...comparison.months.map(({ month, units }) => [
      MONTH_NAMES[month - 1],
      ...years.flatMap((year, index) => {
        const count = toCome(year, month, units[year]) ? "" : String(units[year]);
        return index === 0 ? [count] : [count, count === "" ? "" : change(units[year], units[years[index - 1]])];
      }),
    ]),
    ["Total", ...years.flatMap((year, index) => (index === 0 ? [String(comparison.totals[year])] : [String(comparison.totals[year]), change(comparison.totals[year], comparison.totals[years[index - 1]])]))],
  ];
  return <Table caption={`Units sold, year by year${narrowing ? ` · ${narrowing}` : ""}`} head={head} rows={rows} variant={variant} />;
}
