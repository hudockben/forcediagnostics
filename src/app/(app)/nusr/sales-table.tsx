import Link from "next/link";
import type { ReactNode } from "react";

import type { Sale } from "@/lib/nusr";
import {
  CONDITION_LETTERS,
  SALE_LABELS,
  UNIT_TYPE_LABELS,
  formatDay,
  formatMoney,
  formatPct,
  formatRate,
  saleFlags,
  unitLabel,
  type SaleTotals,
} from "@/lib/nusr-rules";

// The NUSR as a table, for the log and its printout: the columns that
// matter most, or every column the spreadsheet had, in its order, with the
// totals of everything listed under them.

type Column = {
  key: string;
  label: string;
  // Amounts and percentages line up on the right.
  numeric?: boolean;
  cell: (sale: Sale) => ReactNode;
  // What its totals row says: a sum, a percentage of totals, or nothing.
  total?: (totals: SaleTotals) => ReactNode;
};

const money = (cents: number | null) => (cents === null ? "" : formatMoney(cents));

const flagsOf = (sale: Sale) => {
  const flags = saleFlags(sale);
  return [flags.awaitingFunding && "Awaiting funding", flags.notPaidOff && "Not paid off"].filter((flag): flag is string => Boolean(flag));
};

// The key columns: who, what, for how much, and what it made.
const KEY_COLUMNS: Column[] = [
  { key: "soldOn", label: "Date", cell: (sale) => formatDay(sale.soldOn) },
  { key: "salesperson", label: "Salesman", cell: (sale) => sale.salesperson ?? "" },
  { key: "customerName", label: "Customer", cell: (sale) => sale.customerName },
  {
    key: "unit",
    label: "Unit",
    cell: (sale) => (
      <>
        <span className="block">{[sale.unitYear, sale.unitModel].filter(Boolean).join(" ") || "—"}</span>
        {sale.vin && <span className="block font-mono text-[11px] tracking-wide opacity-70">{sale.vin}</span>}
      </>
    ),
  },
  {
    key: "condition",
    label: "N/U",
    cell: (sale) => (
      <>
        {CONDITION_LETTERS[sale.condition]}
        {sale.unitType !== "whole_good" && sale.unitType !== "trade" && <span className="block text-[11px] opacity-70">{UNIT_TYPE_LABELS[sale.unitType]}</span>}
      </>
    ),
  },
  { key: "salesPrice", label: "Sales Price", numeric: true, cell: (sale) => money(sale.salesPrice), total: (t) => formatMoney(t.amounts.salesPrice) },
  { key: "unitProfit", label: "Unit Profit", numeric: true, cell: (sale) => formatMoney(sale.figures.unitProfit), total: (t) => formatMoney(t.figures.unitProfit) },
  { key: "accProfit", label: "Acc. Profit", numeric: true, cell: (sale) => formatMoney(sale.figures.accProfit), total: (t) => formatMoney(t.figures.accProfit) },
  { key: "holdback", label: "Holdback", numeric: true, cell: (sale) => formatMoney(sale.figures.holdback), total: (t) => formatMoney(t.figures.holdback) },
  {
    key: "totalProfit",
    label: "Total Profit",
    numeric: true,
    cell: (sale) => (
      <>
        <span className="block font-medium">{formatMoney(sale.figures.totalProfit)}</span>
        <span className="block text-[11px] opacity-70">{formatPct(sale.figures.profitPct)}</span>
      </>
    ),
    total: (t) => (
      <>
        <span className="block">{formatMoney(t.figures.totalProfit)}</span>
        <span className="block text-[11px] opacity-70">{formatPct(t.profitPct)}</span>
      </>
    ),
  },
  { key: "salesBonus", label: "Sales Bonus", numeric: true, cell: (sale) => formatMoney(sale.figures.salesBonus), total: (t) => formatMoney(t.figures.salesBonus) },
  {
    key: "finance",
    label: "Finance",
    cell: (sale) =>
      sale.financeCompany || sale.amountFinanced ? (
        <>
          <span className="block">{sale.financeCompany ?? ""}</span>
          {sale.amountFinanced !== null && <span className="block text-[11px] opacity-70">{formatMoney(sale.amountFinanced)}</span>}
        </>
      ) : (
        "Cash"
      ),
  },
  { key: "status", label: "To do", cell: (sale) => flagsOf(sale).join(", ") },
];

const amountColumn = (key: keyof Sale & keyof SaleTotals["amounts"]): Column => ({
  key,
  label: SALE_LABELS[key],
  numeric: true,
  cell: (sale) => money(sale[key] as number | null),
  total: (t) => formatMoney(t.amounts[key]),
});
const figureColumn = (key: keyof SaleTotals["figures"], label: string): Column => ({
  key,
  label,
  numeric: true,
  cell: (sale) => formatMoney(sale.figures[key]),
  total: (t) => formatMoney(t.figures[key]),
});

// Every column, as the spreadsheet had them, then the app's own.
const ALL_COLUMNS: Column[] = [
  { key: "soldOn", label: "Date", cell: (sale) => formatDay(sale.soldOn) },
  { key: "salesperson", label: "Salesman", cell: (sale) => sale.salesperson ?? "" },
  { key: "customerName", label: "Customer Name", cell: (sale) => sale.customerName },
  { key: "customerAddress", label: "Address", cell: (sale) => sale.customerAddress ?? "" },
  { key: "customerPhone", label: "Phone", cell: (sale) => sale.customerPhone ?? "" },
  { key: "unitYear", label: "Year", cell: (sale) => sale.unitYear ?? "" },
  { key: "unitModel", label: "Model", cell: (sale) => sale.unitModel ?? "" },
  { key: "condition", label: "New/Used", cell: (sale) => CONDITION_LETTERS[sale.condition] },
  { key: "vin", label: "VIN", cell: (sale) => <span className="font-mono text-[11px] tracking-wide">{sale.vin ?? ""}</span> },
  { key: "msrp", label: "MSRP", numeric: true, cell: (sale) => (sale.msrp === null ? (sale.unitType === "whole_good" ? "" : UNIT_TYPE_LABELS[sale.unitType]) : formatMoney(sale.msrp)), total: (t) => formatMoney(t.amounts.msrp) },
  amountColumn("salesPrice"),
  amountColumn("dealerCost"),
  amountColumn("unitLabor"),
  amountColumn("rebate"),
  { key: "notes", label: "Notes", cell: (sale) => <span className="block max-w-56 whitespace-normal">{sale.notes ?? ""}</span> },
  figureColumn("unitProfit", "Unit Profit"),
  { key: "unitProfitPct", label: "Unit Profit %", numeric: true, cell: (sale) => formatPct(sale.figures.unitProfitPct), total: (t) => formatPct(t.unitProfitPct) },
  amountColumn("accPrice"),
  amountColumn("accCost"),
  amountColumn("accLabor"),
  figureColumn("accProfit", "Acc. Profit"),
  { key: "accProfitPct", label: "Acc. Profit %", numeric: true, cell: (sale) => formatPct(sale.figures.accProfitPct), total: (t) => formatPct(t.accProfitPct) },
  amountColumn("escPrice"),
  amountColumn("escCost"),
  amountColumn("rewards"),
  figureColumn("holdback", "Holdback"),
  figureColumn("totalProfit", "TOTAL PROFIT"),
  { key: "profitPct", label: "PROFIT %", numeric: true, cell: (sale) => formatPct(sale.figures.profitPct), total: (t) => formatPct(t.profitPct) },
  figureColumn("totalBonus", "TOTAL BONUS"),
  figureColumn("holdbackBonus", "Holdback Bonus"),
  figureColumn("salesBonus", "Sales Bonus"),
  { key: "financeCompany", label: "Finance Company", cell: (sale) => sale.financeCompany ?? "" },
  amountColumn("amountFinanced"),
  amountColumn("downPayment"),
  { key: "fundingReceivedOn", label: "Funding Rec'd", cell: (sale) => formatDay(sale.fundingReceivedOn) },
  { key: "paidOn", label: "Date Paid", cell: (sale) => formatDay(sale.paidOn) },
  { key: "comsNumber", label: "COMS #", cell: (sale) => sale.comsNumber ?? "" },
  { key: "category", label: "Category", cell: (sale) => sale.category ?? "" },
  { key: "unitType", label: "Type", cell: (sale) => UNIT_TYPE_LABELS[sale.unitType] },
  { key: "rates", label: "Holdback % / Bonus %", numeric: true, cell: (sale) => `${formatRate(sale.holdbackRateBp)} / ${formatRate(sale.bonusRateBp)}` },
  amountColumn("bonusAdjustment"),
];

export type TableColumns = "key" | "all";

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// On screen each sale's date opens it; printed, it's all plain text in
// black on white.
export function SalesTable({
  sales,
  totals,
  columns,
  variant,
}: {
  sales: Sale[];
  totals: SaleTotals;
  columns: TableColumns;
  variant: "screen" | "print";
}) {
  const shown = columns === "all" ? ALL_COLUMNS : KEY_COLUMNS;
  const screen = variant === "screen";
  const cellClass = screen ? "px-3 py-2.5 align-top whitespace-nowrap first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6" : "border border-neutral-300 px-1.5 py-1 align-top whitespace-nowrap";
  const headClass = screen
    ? "px-3 py-2 text-left align-bottom text-xs font-medium whitespace-nowrap text-ink-muted first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6"
    : "border border-neutral-400 bg-neutral-100 px-1.5 py-1 text-left align-bottom font-semibold whitespace-nowrap";
  return (
    <table className={screen ? "w-full text-sm" : "w-full border-collapse text-[8pt] leading-tight text-black"} data-nusr-table={columns}>
      <thead className={screen ? "border-b border-white/10" : undefined}>
        <tr>
          {shown.map((column) => (
            <th key={column.key} scope="col" className={`${headClass} ${column.numeric ? "text-right" : ""}`}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className={screen ? "divide-y divide-white/10" : undefined}>
        {sales.map((sale) => (
          <tr key={sale.id} className={screen ? "transition hover:bg-white/[0.03]" : "break-inside-avoid"} data-nusr-sale={sale.id}>
            {shown.map((column, index) => (
              <td key={column.key} className={`${cellClass} ${column.numeric ? "text-right tabular-nums" : ""} ${screen && index > 0 ? "text-ink" : ""}`}>
                {screen && index === 0 ? (
                  <Link href={`/nusr/${sale.id}`} className="font-medium text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none" aria-label={`${formatDay(sale.soldOn)}: ${unitLabel(sale)} to ${sale.customerName}`}>
                    {column.cell(sale)}
                  </Link>
                ) : (
                  column.cell(sale)
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      <tfoot className={screen ? "border-t border-white/20" : undefined}>
        <tr className={screen ? "font-semibold text-ink" : "font-semibold"} data-nusr-totals>
          {shown.map((column, index) => (
            <td key={column.key} className={`${cellClass} ${column.numeric ? "text-right tabular-nums" : ""} ${screen ? "" : "bg-neutral-100"}`}>
              {index === 0 ? `TOTAL · ${plural(totals.units, "unit", "units")}` : (column.total?.(totals) ?? "")}
            </td>
          ))}
        </tr>
      </tfoot>
    </table>
  );
}
