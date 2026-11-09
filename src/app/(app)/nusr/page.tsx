import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { primaryLinkClass } from "@/components/hud";
import { getSale, listSales, saleSuggestions, saleYears, type SaleLog } from "@/lib/nusr";
import { listSearchIsCut, parsePage, MAX_LIST_WORDS } from "@/lib/diagnose-list-rules";
import {
  MONTH_NAMES,
  SALE_STATUSES,
  SALE_STATUS_LABELS,
  UNIT_TYPES,
  UNIT_TYPE_LABELS,
  filtersSearch,
  filtersTitle,
  formatMoney,
  parseSaleFilters,
  perUnit,
  shopToday,
  shopYear,
  unitLabel,
  type SaleFilters,
} from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";

import { ListSearch } from "../diagnose/list-search";
import { Pagination } from "../diagnose/pagination";
import { ExcelLink, LogFilter, MarkPaidForm, WidePage } from "./forms";
import { MARK_PAID_FORM, SalesTable, type TableColumns } from "./sales-table";

export const metadata: Metadata = { title: "NUSR" };

export default function NusrPage(props: PageProps<"/nusr">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Nusr searchParams={props.searchParams} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// The trade-ins a removed sale left on the LOC (?kept=, one each), as
// removeSaleAction named them.
const keptTradeIns = (value: string | string[] | undefined) => (Array.isArray(value) ? value : value ? [value] : []).slice(0, 5).map((label) => label.slice(0, 200));

const linkButton =
  "inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

async function Nusr({ searchParams }: { searchParams: PageProps<"/nusr">["searchParams"] }) {
  const user = await requireCapability("sales.log");
  const params = await searchParams;
  const thisYear = shopYear();
  const filters = parseSaleFilters(params, thisYear);
  const columns: TableColumns = params.columns === "all" ? "all" : "key";
  const [log, years, suggestions, logged] = await Promise.all([
    listSales(user.shop.id, filters, { page: parsePage(params.page) }),
    saleYears(user.shop.id),
    saleSuggestions(user.shop.id),
    typeof params.logged === "string" ? getSale(user.shop.id, params.logged) : Promise.resolve(null),
  ]);
  const extra = { columns: columns === "all" ? "all" : null };
  // The address as it stands, and the list's own path for the search box
  // and pages (which carry the search themselves).
  const search = filtersSearch(filters, thisYear, extra).slice(1);
  const path = `/nusr${filtersSearch({ ...filters, query: "" }, thisYear, extra)}`;
  const download = filtersSearch(filters, thisYear);

  return (
    <WidePage className="space-y-6">
      <PageHeading
        title="NUSR"
        description="Every unit sold, new and used: the customer, the unit, what it sold for and cost, and the profit, holdback, bonuses and financing worked out for you."
        action={
          <div className="flex flex-wrap gap-3">
            <Link href="/nusr/import" className={linkButton}>
              Import
            </Link>
            <Link href="/nusr/new" className={primaryLinkClass} data-nusr-add>
              Log a sale
            </Link>
          </div>
        }
      />

      {logged && (
        <Notice>
          Logged the sale of {unitLabel(logged)} to {logged.customerName}.{" "}
          <Link href="/nusr/new" className="font-medium underline">
            Log another
          </Link>
        </Notice>
      )}
      {typeof params.removed === "string" && (
        <Notice>
          Removed the sale of {params.removed} from the NUSR.
          {keptTradeIns(params.kept).map((label) => (
            <span key={label} className="block">
              Its trade-in, {label}, stays on the{" "}
              <Link href="/loc" className="font-medium underline">
                LOC
              </Link>
              : remove it there if it came in by mistake too.
            </span>
          ))}
        </Notice>
      )}
      {typeof params.paid === "string" && /^\d+$/.test(params.paid) && (
        <Notice>
          Marked {plural(Number(params.paid), "unit", "units")} paid off.
          {typeof params.unchanged === "string" && /^\d+$/.test(params.unchanged) && Number(params.unchanged) > 0
            ? ` ${plural(Number(params.unchanged), "ticked unit was", "ticked units were")} left as they were: used, or paid off already.`
            : ""}
        </Notice>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3" data-nusr-filters>
          <LogFilter
            name="year"
            label="Year"
            search={search}
            value={filters.year === null ? "all" : filters.year === thisYear ? "" : String(filters.year)}
            options={[
              { value: "", label: String(thisYear) },
              ...[...new Set(years)].filter((year) => year !== thisYear).map((year) => ({ value: String(year), label: String(year) })),
              { value: "all", label: "All years" },
            ]}
          />
          {filters.year !== null && (
            <LogFilter
              name="month"
              label="Month"
              search={search}
              value={filters.month === null ? "" : String(filters.month)}
              options={[{ value: "", label: "Every month" }, ...MONTH_NAMES.map((name, index) => ({ value: String(index + 1), label: name }))]}
            />
          )}
          <LogFilter
            name="condition"
            label="New or used"
            search={search}
            value={filters.condition ?? ""}
            options={[
              { value: "", label: "New and used" },
              { value: "new", label: "New" },
              { value: "used", label: "Used" },
            ]}
          />
          <LogFilter
            name="type"
            label="Type of deal"
            search={search}
            value={filters.unitType ?? ""}
            options={[{ value: "", label: "Every type" }, ...UNIT_TYPES.map((type) => ({ value: type, label: UNIT_TYPE_LABELS[type] }))]}
          />
          <LogFilter
            name="category"
            label="Category"
            search={search}
            value={filters.category ?? ""}
            options={[{ value: "", label: "Every category" }, ...suggestions.categories.map((category) => ({ value: category, label: category }))]}
          />
          <LogFilter
            name="salesperson"
            label="Salesman"
            search={search}
            value={filters.salesperson ?? ""}
            options={[{ value: "", label: "Every salesman" }, ...suggestions.salespeople.map((name) => ({ value: name, label: name }))]}
          />
          <LogFilter
            name="status"
            label="Still to do"
            search={search}
            value={filters.status ?? ""}
            options={[{ value: "", label: "Everything" }, ...SALE_STATUSES.map((status) => ({ value: status, label: SALE_STATUS_LABELS[status] }))]}
          />
        </div>
        <div className="mt-4">
          <ListSearch query={filters.query} path={path} label="Search the NUSR" placeholder="Customer, phone, VIN, model, COMS #…">
            <Results
              log={log}
              filters={filters}
              columns={columns}
              path={path}
              download={download}
              search={search}
              everyYear={`/nusr${filtersSearch({ ...filters, year: null, month: null }, thisYear, extra)}`}
              comsNumbers={suggestions.comsNumbers}
            />
          </ListSearch>
        </div>
      </Card>
    </WidePage>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-1 font-mono text-lg text-ink tabular-nums">{value}</dd>
      {sub && <dd className="text-xs text-ink-muted">{sub}</dd>}
    </div>
  );
}

function Results({
  log,
  filters,
  columns,
  path,
  download,
  search,
  everyYear,
  comsNumbers,
}: {
  log: SaleLog;
  filters: SaleFilters;
  columns: TableColumns;
  path: string;
  download: string;
  search: string;
  // The same search and filters across every year.
  everyYear: string;
  comsNumbers: string[];
}) {
  // The Not paid off list: its units can be ticked and marked paid off together.
  const ticking = filters.status === "unpaid" && log.items.length > 0;
  const { totals } = log;
  const title = filtersTitle(filters);
  const cut = listSearchIsCut(filters.query) ? ` (only its first ${MAX_LIST_WORDS} words are searched)` : "";
  const toggle = new URLSearchParams(search);
  if (columns === "all") toggle.delete("columns");
  else toggle.set("columns", "all");
  return (
    <>
      {/* Always there, so a new count is read out as the list changes. */}
      <p role="status" data-result-count className="mt-3 text-sm text-ink-muted">
        {log.total === 0 ? `No sales in ${title}${cut}.` : `${plural(log.total, "sale", "sales")} in ${title}${cut}.`}
      </p>
      {log.total > 0 && (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-4 rounded-xl border border-white/10 bg-forest-950/40 p-4 sm:grid-cols-3 lg:grid-cols-6" data-nusr-stats>
            <Stat label="Units" value={totals.units.toLocaleString("en-US")} sub={`${totals.newUnits.toLocaleString("en-US")} new · ${totals.usedUnits.toLocaleString("en-US")} used`} />
            <Stat label="Gross" value={formatMoney(totals.figures.gross)} />
            <Stat label="Total profit" value={formatMoney(totals.figures.totalProfit)} sub={`${formatMoney(perUnit(totals.figures.totalProfit, totals.units))} a unit`} />
            <Stat label="Holdback" value={formatMoney(totals.figures.holdback)} />
            <Stat label="Total bonus" value={formatMoney(totals.figures.totalBonus)} />
            <Stat label="Sales bonus" value={formatMoney(totals.figures.salesBonus)} />
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link href={`/nusr/summary${download}`} className={linkButton} data-nusr-summary-link>
              Summary
            </Link>
            <ExcelLink search={download} className={linkButton} />
            <Link href={`/nusr/print${download}${columns === "all" ? `${download ? "&" : "?"}columns=all` : ""}`} className={linkButton} data-nusr-print>
              Print or PDF
            </Link>
            <Link href={`/nusr?${toggle.toString()}`} className="ml-auto min-h-11 content-center text-sm font-medium text-glow/90 hover:text-glow hover:underline" data-nusr-columns>
              {columns === "all" ? "Show the key columns" : "Show every column"}
            </Link>
          </div>
          {/* A fresh count of the tick boxes for each page and search of the list. */}
          {ticking && <MarkPaidForm key={`${search}|${log.page}`} formId={MARK_PAID_FORM} back={search} today={shopToday()} comsNumbers={comsNumbers} />}
          <div className="-mx-5 mt-4 overflow-x-auto border-y border-white/10 sm:-mx-6">
            <SalesTable sales={log.items} totals={totals} columns={columns} variant="screen" back={log.page > 1 ? `${search}${search ? "&" : ""}page=${log.page}` : search} ticking={ticking} />
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <p className="font-mono text-xs text-ink-muted" data-list-range>
              {log.from.toLocaleString("en-US")}–{log.to.toLocaleString("en-US")} of {log.total.toLocaleString("en-US")}
            </p>
            <Pagination query={filters.query} page={log.page} pages={log.pages} label="Pages of the NUSR" path={path} />
          </div>
        </>
      )}
      {log.total === 0 && filters.year !== null && (
        <p className="mt-2 text-sm leading-6 text-ink-muted" data-list-empty>
          <Link href={everyYear} className="text-glow hover:underline">
            Look through every year
          </Link>
          , or{" "}
          <Link href="/nusr/new" className="text-glow hover:underline">
            log a sale
          </Link>
          .
        </p>
      )}
    </>
  );
}
