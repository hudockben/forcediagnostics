import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { inputBaseClass } from "@/components/hud";
import type { Sale } from "@/lib/nusr";
import { formatDay, formatMoney, shopToday, unitLabel } from "@/lib/nusr-rules";
import {
  DATE_BASIS_LABELS,
  PERIOD_LABELS,
  REPORT_PERIODS,
  bonusTable,
  overviewPeriods,
  parseReportParams,
  periodOf,
  periodSales,
  reportDays,
  reportSearch,
  saleDay,
  shiftPeriod,
  subPeriods,
  type BonusTotals,
  type DateBasis,
  type ReportParams,
  type ReportPeriod,
  type ReportView,
} from "@/lib/report-rules";
import { bonusSales } from "@/lib/reports";
import { requireCapability } from "@/lib/session";

import { WidePage } from "../nusr/forms";

// The Reports tab: the salesmen's bonuses, from the NUSR's own figures,
// for the week, month, quarter and year a day is in (the overview), or one
// of those periods on its own with its breakdown and the sales behind it.
// Everything it shows lives in the address (?view=, ?on=, ?by=), so a
// report can be bookmarked or sent on.

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage(props: PageProps<"/reports">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Reports searchParams={props.searchParams} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const pillClass = (active: boolean) =>
  `flex h-10 items-center rounded-full px-4 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none ${
    active ? "bg-glow/15 text-glow" : "text-ink-muted hover:bg-white/5 hover:text-ink"
  }`;
const linkButton =
  "inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";
const textLink = "text-sm text-glow/90 hover:text-glow hover:underline focus-visible:underline focus-visible:outline-none";

type Href = (change: Partial<ReportParams>) => string;

async function Reports({ searchParams }: { searchParams: PageProps<"/reports">["searchParams"] }) {
  const user = await requireCapability("sales.log");
  const today = shopToday();
  const params = parseReportParams(await searchParams, today);
  const result = await bonusSales(user, params);
  const href: Href = (change) => `/reports${reportSearch({ ...params, ...change }, today)}`;

  return (
    <WidePage className="space-y-6">
      <PageHeading
        title="Reports"
        description="What the salesmen's deals have paid them in bonuses, by week, month, quarter and year, worked out from every sale in the NUSR."
        action={
          <a href={`/reports/export${reportSearch(params, today)}`} className={linkButton} data-reports-export>
            Download Excel
          </a>
        }
      />
      <section className="space-y-6 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-reports-bonuses>
        <div>
          <h2 className="text-base font-semibold text-ink">Salesman bonuses</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
            A deal&apos;s bonus is its Sales Bonus (with any bonus adjustment) and its Holdback Bonus, as the NUSR works them out. Each sale counts on{" "}
            {params.by === "sold" ? "the day it was sold" : "the day its funding came in (Funding Rec'd)"}; weeks run Monday to Sunday.
          </p>
        </div>
        <Controls params={params} today={today} href={href} />
        {"error" in result ? (
          <Notice tone="trail">{result.error}</Notice>
        ) : (
          <>
            {params.by === "funded" && result.unfunded > 0 && (
              <Notice tone="trail" live={false}>
                {plural(result.unfunded, "sale", "sales")} sold from {formatDay(reportDays(params).from)} to {formatDay(reportDays(params).to)}{" "}
                {result.unfunded === 1 ? "has" : "have"} no Funding Rec&apos;d date yet, so {result.unfunded === 1 ? "it isn't" : "they aren't"} counted until it&apos;s
                entered in the NUSR.
              </Notice>
            )}
            {params.view === "overview" ? (
              <Overview params={params} sales={result.sales} href={href} />
            ) : (
              <PeriodReport kind={params.view} params={params} sales={result.sales} today={today} href={href} />
            )}
          </>
        )}
      </section>
    </WidePage>
  );
}

// The view (the overview or a period), what counts a sale, and the day.
function Controls({ params, today, href }: { params: ReportParams; today: string; href: Href }) {
  const views: ReportView[] = ["overview", ...REPORT_PERIODS];
  const bases: DateBasis[] = ["sold", "funded"];
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <nav aria-label="Report period">
        <ul className="flex flex-wrap gap-2">
          {views.map((view) => (
            <li key={view}>
              <Link href={href({ view })} aria-current={params.view === view ? "page" : undefined} className={pillClass(params.view === view)}>
                {view === "overview" ? "Overview" : PERIOD_LABELS[view]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <div>
          <p className="text-xs text-ink-muted" id="count-by">
            Count each sale by
          </p>
          <ul aria-labelledby="count-by" className="mt-1 flex gap-2">
            {bases.map((by) => (
              <li key={by}>
                <Link href={href({ by })} aria-current={params.by === by ? "true" : undefined} className={pillClass(params.by === by)}>
                  {DATE_BASIS_LABELS[by]}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <form action="/reports" className="flex items-end gap-2">
          {params.view !== "overview" && <input type="hidden" name="view" value={params.view} />}
          {params.by !== "sold" && <input type="hidden" name="by" value={params.by} />}
          <label className="text-xs text-ink-muted">
            As of
            <input type="date" name="on" defaultValue={params.on} required className={`${inputBaseClass} mt-1 h-10 w-44 text-sm`} />
          </label>
          <button type="submit" className={`${linkButton} min-h-10`}>
            Show
          </button>
          {params.on !== today && (
            <Link href={href({ on: today })} className={`${textLink} pb-2.5`}>
              Today
            </Link>
          )}
        </form>
      </div>
    </div>
  );
}

// A table of figures: the first column names the row, the last row is the
// total.
function Table({ caption, head, rows, data }: { caption: string; head: ReactNode[]; rows: ReactNode[][]; data?: string }) {
  const cell = "px-3 py-2 whitespace-nowrap first:pl-0 last:pr-0";
  return (
    <div className="overflow-x-auto" data-reports-table={data}>
      <table className="w-full text-sm">
        <caption className="pb-2 text-left text-base font-semibold text-ink">{caption}</caption>
        <thead className="border-b border-white/10">
          <tr>
            {head.map((label, index) => (
              <th key={index} scope="col" className={`${cell} align-bottom text-xs font-medium text-ink-muted ${index === 0 ? "text-left" : "text-right"}`}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex === rows.length - 1 && rows.length > 1 ? "font-semibold" : undefined}>
              {row.map((value, index) =>
                index === 0 ? (
                  <th key={index} scope="row" className={`${cell} text-left font-normal text-ink`}>
                    {value}
                  </th>
                ) : (
                  <td key={index} className={`${cell} text-right text-ink tabular-nums`}>
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

// A salesman's bonus in a period, with the units it's from.
function Bonus({ totals }: { totals: BonusTotals }) {
  if (totals.units === 0) return <span className="text-ink-muted">—</span>;
  return (
    <>
      <span className="font-medium">{formatMoney(totals.total)}</span>
      <span className="block text-xs font-normal text-ink-muted">{plural(totals.units, "unit", "units")}</span>
    </>
  );
}

// Each salesman's week, month, quarter and year, each heading opening that
// period on its own.
function Overview({ params, sales, href }: { params: ReportParams; sales: Sale[]; href: Href }) {
  const periods = overviewPeriods(params.on);
  const table = bonusTable(sales, saleDay(params.by), periods);
  if (table.rows.length === 0) return <p className="text-sm text-ink-muted">No sales counted in {periods[3].label} yet.</p>;
  return (
    <Table
      caption={`Bonuses as of ${formatDay(params.on)}`}
      data="overview"
      head={[
        "Salesman",
        ...periods.map((period) => (
          <Link key={period.kind} href={href({ view: period.kind })} className="text-glow/90 hover:text-glow hover:underline">
            {PERIOD_LABELS[period.kind]}
            <span className="block font-normal text-ink-muted">{period.label}</span>
          </Link>
        )),
      ]}
      rows={[
        ...table.rows.map((row) => [row.label, ...row.cells.map((cell, index) => <Bonus key={index} totals={cell} />)]),
        ["Total", ...table.totals.map((cell, index) => <Bonus key={index} totals={cell} />)],
      ]}
    />
  );
}

const SPLIT_HEAD = ["Salesman", "Units", "Total profit", "Sales bonus", "Holdback bonus", "Total bonus"];
const splitCells = (totals: BonusTotals): ReactNode[] => [
  totals.units.toLocaleString("en-US"),
  formatMoney(totals.totalProfit),
  formatMoney(totals.salesBonus),
  formatMoney(totals.holdbackBonus),
  formatMoney(totals.total),
];

// One week, month, quarter or year: who was paid what, its breakdown, and
// the sales behind it, with the periods before and after it a click away.
function PeriodReport({ kind, params, sales, today, href }: { kind: ReportPeriod; params: ReportParams; sales: Sale[]; today: string; href: Href }) {
  const period = periodOf(kind, params.on);
  const previous = periodOf(kind, shiftPeriod(period, -1));
  const next = periodOf(kind, shiftPeriod(period, 1));
  const dayOf = saleDay(params.by);
  const split = bonusTable(sales, dayOf, [period]);
  const breakdown = bonusTable(sales, dayOf, subPeriods(period));
  const order = new Map(split.rows.map((row, index) => [row.key, index]));
  breakdown.rows.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  const listed = periodSales(sales, dayOf, period, split.rows);
  const isCurrent = periodOf(kind, today).start === period.start;
  const by = kind === "week" ? "day" : kind === "month" ? "week" : "month";
  const rowTotal = (cells: BonusTotals[]) => formatMoney(cells.reduce((sum, cell) => sum + cell.total, 0));

  return (
    <div className="space-y-8">
      <nav aria-label={`Other ${kind}s`} className="flex flex-wrap items-center justify-between gap-3 border-y border-white/10 py-3">
        <Link href={href({ on: previous.start })} className={textLink}>
          ‹ {previous.label}
        </Link>
        <div className="text-center">
          <h3 className="text-lg font-semibold text-ink" data-reports-period>
            {period.label}
          </h3>
          {!isCurrent && (
            <Link href={href({ on: today })} className={textLink}>
              This {kind}
            </Link>
          )}
        </div>
        {next.start <= today ? (
          <Link href={href({ on: next.start })} className={textLink}>
            {next.label} ›
          </Link>
        ) : (
          <span className="text-sm text-ink-muted/60">{next.label} ›</span>
        )}
      </nav>

      {split.rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No sales counted in {period.label}.</p>
      ) : (
        <>
          <Table
            caption="By salesman"
            data="salesmen"
            head={SPLIT_HEAD}
            rows={[...split.rows.map((row) => [row.label, ...splitCells(row.cells[0])]), ["Total", ...splitCells(split.totals[0])]]}
          />
          <Table
            caption={`By ${by}: total bonus`}
            data="breakdown"
            head={["Salesman", ...breakdown.spans.map((span) => span.label), "Total"]}
            rows={[
              ...breakdown.rows.map((row) => [row.label, ...row.cells.map((cell) => (cell.units ? formatMoney(cell.total) : "—")), rowTotal(row.cells)]),
              ["Total", ...breakdown.totals.map((cell) => (cell.units ? formatMoney(cell.total) : "—")), rowTotal(breakdown.totals)],
            ]}
          />
          <SalesList sales={listed} by={params.by} />
        </>
      )}
    </div>
  );
}

// The sales a period's bonuses come from, each opening in the NUSR.
function SalesList({ sales, by }: { sales: Sale[]; by: DateBasis }) {
  const dayOf = saleDay(by);
  const total = sales.reduce((sum, sale) => sum + sale.figures.salesBonus + sale.figures.holdbackBonus, 0);
  const cell = "px-3 py-2 first:pl-0 last:pr-0";
  return (
    <div className="overflow-x-auto" data-reports-table="sales">
      <table className="w-full min-w-[52rem] text-sm">
        <caption className="pb-2 text-left text-base font-semibold text-ink">The sales: {plural(sales.length, "sale", "sales")}</caption>
        <thead className="border-b border-white/10 text-xs text-ink-muted">
          <tr>
            <th scope="col" className={`${cell} text-left font-medium`}>
              {DATE_BASIS_LABELS[by]}
            </th>
            <th scope="col" className={`${cell} text-left font-medium`}>
              Salesman
            </th>
            <th scope="col" className={`${cell} text-left font-medium`}>
              Customer
            </th>
            <th scope="col" className={`${cell} text-left font-medium`}>
              Unit
            </th>
            <th scope="col" className={`${cell} text-right font-medium`}>
              Total profit
            </th>
            <th scope="col" className={`${cell} text-right font-medium`}>
              Sales bonus
            </th>
            <th scope="col" className={`${cell} text-right font-medium`}>
              Holdback bonus
            </th>
            <th scope="col" className={`${cell} text-right font-medium`}>
              Total bonus
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {sales.map((sale) => (
            <tr key={sale.id}>
              <td className={`${cell} whitespace-nowrap text-ink`}>{formatDay(dayOf(sale))}</td>
              <td className={`${cell} text-ink`}>{sale.salesperson ?? "—"}</td>
              <th scope="row" className={`${cell} text-left font-normal`}>
                <Link href={`/nusr/${sale.id}`} className="text-ink hover:text-glow hover:underline">
                  {sale.customerName}
                </Link>
              </th>
              <td className={`${cell} text-ink`}>
                {unitLabel(sale)}
                {sale.condition === "used" && <span className="text-ink-muted"> · Used</span>}
              </td>
              <td className={`${cell} text-right whitespace-nowrap text-ink tabular-nums`}>{formatMoney(sale.figures.totalProfit)}</td>
              <td className={`${cell} text-right whitespace-nowrap text-ink tabular-nums`}>{formatMoney(sale.figures.salesBonus)}</td>
              <td className={`${cell} text-right whitespace-nowrap text-ink tabular-nums`}>{formatMoney(sale.figures.holdbackBonus)}</td>
              <td className={`${cell} text-right whitespace-nowrap text-ink tabular-nums`}>{formatMoney(sale.figures.salesBonus + sale.figures.holdbackBonus)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <th scope="row" colSpan={7} className={`${cell} text-left text-ink`}>
              Total
            </th>
            <td className={`${cell} text-right text-ink tabular-nums`}>{formatMoney(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
