import { Badge, Notice } from "@/components/app/ui";
import { MAX_LIST_WORDS, listSearchIsCut } from "@/lib/diagnose-list-rules";
import { MONTH_NAMES, SHOP_TIME_ZONE, formatDay, formatMoney } from "@/lib/nusr-rules";
import {
  REBATE_COLUMNS,
  REBATE_COLUMN_LABELS,
  REBATE_COLUMN_LETTERS,
  REBATE_STATUSES,
  REBATE_STATUS_LABELS,
  rebateFiltersSearch,
  rebateFiltersTitle,
  type RebateColumn,
  type RebateFilters,
} from "@/lib/rebate-rules";
import type { SavedInvoice, SavedRebates } from "@/lib/rebates";

import { ListSearch } from "../diagnose/list-search";
import { Pagination } from "../diagnose/pagination";
import { LogFilter } from "../nusr/forms";
import { OpenInvoiceLink, RemoveInvoice } from "./saved-actions";

// Saved rebates, under the invoices on the Rebates tab: the invoices saved
// there and their lines, by the filters in the address (the year and month
// of the invoice's date, the column its amounts went in, the salesman and
// category of each line's sale, whether it was found, and a search), what
// they come to, and the workbook of them.

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const columnName = (column: RebateColumn) => REBATE_COLUMN_LABELS[column];
const savedDay = (at: Date) => at.toLocaleDateString("en-US", { timeZone: SHOP_TIME_ZONE });
const invoiceName = (invoice: Pick<SavedInvoice, "number" | "fileName">) => (invoice.number ? `invoice ${invoice.number}` : invoice.fileName);

const downloadClass =
  "inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

export function SavedRebatesSection({
  filters,
  thisYear,
  years,
  salespeople,
  categories,
  invoices,
  saved,
  removed,
}: {
  filters: RebateFilters;
  thisYear: number;
  years: number[];
  salespeople: string[];
  categories: string[];
  invoices: SavedInvoice[];
  saved: SavedRebates;
  removed: string | null;
}) {
  // The address as it stands, and the list's own path for the search box
  // and pages (which carry the search themselves).
  const search = rebateFiltersSearch(filters, thisYear).slice(1);
  const path = `/rebates${rebateFiltersSearch({ ...filters, query: "" }, thisYear)}`;
  return (
    <section className="space-y-4 rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" aria-labelledby="saved-rebates" data-rebates-saved>
      <div>
        <h2 id="saved-rebates" className="text-base font-semibold text-ink">
          Saved rebates
        </h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
          The invoices saved above, by the day on the invoice (or the day it was saved, if none was read). Open one to change it and save again; Download
          Excel gives the NUSR sheet with the rebates the filters find in AO, AP and AQ.
        </p>
      </div>
      {removed && <Notice>Removed {removed} from Saved rebates.</Notice>}

      <div className="flex flex-wrap items-center gap-3" data-rebates-filters>
        <LogFilter
          path="/rebates"
          name="year"
          label="Year"
          search={search}
          value={filters.year === null ? "all" : filters.year === thisYear ? "" : String(filters.year)}
          options={[
            { value: "", label: String(thisYear) },
            ...[...new Set(filters.year !== null && filters.year !== thisYear ? [...years, filters.year] : years)]
              .filter((year) => year !== thisYear)
              .sort((a, b) => b - a)
              .map((year) => ({ value: String(year), label: String(year) })),
            { value: "all", label: "All years" },
          ]}
        />
        {filters.year !== null && (
          <LogFilter
            path="/rebates"
            name="month"
            label="Month"
            search={search}
            value={filters.month === null ? "" : String(filters.month)}
            options={[{ value: "", label: "Every month" }, ...MONTH_NAMES.map((name, index) => ({ value: String(index + 1), label: name }))]}
          />
        )}
        <LogFilter
          path="/rebates"
          name="column"
          label="Column"
          search={search}
          value={filters.column ?? ""}
          options={[{ value: "", label: "Every column" }, ...REBATE_COLUMNS.map((column) => ({ value: column, label: columnName(column) }))]}
        />
        <LogFilter
          path="/rebates"
          name="salesperson"
          label="Salesman"
          search={search}
          value={filters.salesperson ?? ""}
          options={[
            { value: "", label: "Every salesman" },
            ...withPicked(salespeople, filters.salesperson).map((name) => ({ value: name, label: name })),
          ]}
        />
        <LogFilter
          path="/rebates"
          name="category"
          label="Category"
          search={search}
          value={filters.category ?? ""}
          options={[{ value: "", label: "Every category" }, ...withPicked(categories, filters.category).map((category) => ({ value: category, label: category }))]}
        />
        <LogFilter
          path="/rebates"
          name="status"
          label="Found in the NUSR or not"
          search={search}
          value={filters.status ?? ""}
          options={[{ value: "", label: "Found and not found" }, ...REBATE_STATUSES.map((status) => ({ value: status, label: REBATE_STATUS_LABELS[status] }))]}
        />
      </div>
      <ListSearch query={filters.query} path={path} label="Search saved rebates" placeholder="Customer, VIN, invoice #, salesman, model…">
        <SavedResults filters={filters} thisYear={thisYear} invoices={invoices} saved={saved} />
      </ListSearch>
    </section>
  );
}

// The names to pick from, with the one picked even when it's no longer
// among them (so the filter still shows it).
function withPicked(names: readonly string[], picked: string | null) {
  return picked && !names.some((name) => name.toLowerCase() === picked.toLowerCase()) ? [picked, ...names] : [...names];
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

function SavedResults({ filters, thisYear, invoices, saved }: { filters: RebateFilters; thisYear: number; invoices: SavedInvoice[]; saved: SavedRebates }) {
  const title = rebateFiltersTitle(filters);
  const cut = listSearchIsCut(filters.query) ? ` (only its first ${MAX_LIST_WORDS} words are searched)` : "";
  const { totals } = saved;
  const all = REBATE_COLUMNS.reduce((sum, column) => sum + totals.amounts[column], 0);
  const back = (extra: Record<string, string | number | null>) => `/rebates${rebateFiltersSearch(filters, thisYear, { page: saved.page > 1 ? saved.page : null, ...extra })}`;
  const narrowed = Boolean(filters.salesperson || filters.category || filters.status || filters.query);
  return (
    <>
      {/* Always there, so a new count is read out as the list changes. */}
      <p role="status" data-result-count className="mt-3 text-sm text-ink-muted">
        {saved.total === 0 && invoices.length === 0
          ? `No saved rebates in ${title}${cut}.`
          : `${plural(saved.total, "rebate", "rebates")} on ${plural(invoices.length, "invoice", "invoices")} in ${title}${cut}.`}
      </p>
      {invoices.length > 0 && (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-4 rounded-xl border border-white/10 bg-forest-950/40 p-4 sm:grid-cols-3 lg:grid-cols-5" data-rebates-stats>
            <Stat
              label="Rebates"
              value={totals.lines.toLocaleString("en-US")}
              sub={`${totals.found.toLocaleString("en-US")} found in the NUSR${totals.lines > totals.found ? ` · ${(totals.lines - totals.found).toLocaleString("en-US")} not` : ""}`}
            />
            {REBATE_COLUMNS.map((column) => (
              <Stat key={column} label={columnName(column)} value={formatMoney(totals.amounts[column])} />
            ))}
            <Stat label="Total" value={formatMoney(all)} />
          </dl>
          {totals.lines > 0 && (
            <div className="mt-3 space-y-1 text-sm text-ink-muted" data-rebates-groups>
              <p>
                By salesman: {totals.bySalesman.map((group) => `${group.label} ${formatMoney(group.amount)} (${group.lines.toLocaleString("en-US")})`).join(" · ")}
              </p>
              <p>By category: {totals.byCategory.map((group) => `${group.label} ${formatMoney(group.amount)}`).join(" · ")}</p>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {totals.lines > 0 && (
              <a href={`/rebates/saved/export${rebateFiltersSearch(filters, thisYear)}`} className={downloadClass} data-rebates-saved-export>
                Download Excel
              </a>
            )}
          </div>

          <h3 className="mt-6 text-sm font-semibold text-ink">Invoices</h3>
          <div className="relative -mx-5 mt-2 overflow-x-auto border-y border-white/10 sm:-mx-6">
            <table className="w-full min-w-[52rem] text-sm" data-rebates-saved-invoices>
              <caption className="sr-only">The saved invoices the filters find</caption>
              <thead>
                <tr className="border-b border-white/10 text-left text-xs text-ink-muted">
                  <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                    Invoice
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Date
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Goes in
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {narrowed ? "Rebates found" : "Rebates"}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Amount
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Saved
                  </th>
                  <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                    <span className="sr-only">Open or remove</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {invoices.map((invoice) => (
                  <tr key={invoice.id} className="align-top" data-rebates-saved-invoice={invoice.number ?? invoice.fileName}>
                    <td className="px-5 py-3 sm:px-6">
                      <p className="font-medium text-ink">{invoice.number ?? invoice.fileName}</p>
                      <p className="text-xs text-ink-muted">{[invoice.type, invoice.number ? invoice.fileName : null].filter(Boolean).join(" · ")}</p>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-ink">
                      {formatDay(invoice.day)}
                      {!invoice.date && <span className="block text-xs text-ink-muted">No date read: the day saved</span>}
                    </td>
                    <td className="px-3 py-3 text-ink">{columnName(invoice.column)}</td>
                    <td className="px-3 py-3 text-right whitespace-nowrap text-ink tabular-nums">
                      {narrowed ? `${invoice.shown.toLocaleString("en-US")} of ${invoice.lines.toLocaleString("en-US")}` : invoice.lines.toLocaleString("en-US")}
                      <span className="block text-xs text-ink-muted">
                        {invoice.found === invoice.lines ? "All found in the NUSR" : `${(invoice.lines - invoice.found).toLocaleString("en-US")} not found`}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap text-ink tabular-nums">
                      {formatMoney(narrowed ? invoice.shownAmount : invoice.amount)}
                      {narrowed ? (
                        <span className="block text-xs text-ink-muted">of {formatMoney(invoice.amount)}</span>
                      ) : invoice.total !== null && invoice.total !== invoice.amount ? (
                        <span className="block text-xs text-trail">Invoice total {formatMoney(invoice.total)}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-xs leading-5 text-ink-muted">
                      {savedDay(invoice.savedAt)}
                      {invoice.savedBy && <span className="block">by {invoice.savedBy}</span>}
                    </td>
                    <td className="px-5 py-3 sm:px-6">
                      <div className="flex flex-wrap items-start justify-end gap-x-4 gap-y-2">
                        <OpenInvoiceLink id={invoice.id} href={back({ open: invoice.id })} label={invoiceName(invoice)} />
                        <RemoveInvoice id={invoice.id} label={invoiceName(invoice)} lines={invoice.lines} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {saved.total > 0 && (
            <>
              <h3 className="mt-6 text-sm font-semibold text-ink">Rebates</h3>
              <div className="relative -mx-5 mt-2 overflow-x-auto border-y border-white/10 sm:-mx-6">
                <table className="w-full min-w-[56rem] text-sm" data-rebates-saved-lines>
                  <caption className="sr-only">The saved rebates the filters find, and the sales they were found as</caption>
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs text-ink-muted">
                      <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                        Invoice
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        On the invoice
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Amount
                      </th>
                      <th scope="col" className="px-5 py-2 font-medium sm:px-6">
                        In the NUSR
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {saved.items.map((line) => (
                      <tr key={line.id} className="align-top" data-rebates-saved-line>
                        <td className="px-5 py-3 whitespace-nowrap sm:px-6">
                          <p className="text-ink">
                            {line.invoiceNumber ?? "No number"}
                            <span className="text-ink-muted"> #{line.line}</span>
                          </p>
                          <p className="text-xs text-ink-muted">
                            {line.invoiceDate ? formatDay(line.invoiceDate) : "No date"} · {REBATE_COLUMN_LETTERS[line.column]}
                          </p>
                        </td>
                        <td className="px-3 py-3">
                          <p className="font-mono text-sm break-all text-ink">{line.vinRead}</p>
                          {line.names.length > 0 && <p className="text-xs text-ink-muted">{line.names.join(", ")}</p>}
                        </td>
                        <td className="px-3 py-3 text-right whitespace-nowrap text-ink tabular-nums">{line.amount === null ? "—" : formatMoney(line.amount)}</td>
                        <td className="px-5 py-3 sm:px-6">
                          {line.sale ? (
                            <>
                              <p className="text-ink">
                                {line.sale.customerName}
                                <span className="text-ink-muted"> · {line.sale.unit}</span>
                              </p>
                              <p className="text-xs text-ink-muted">
                                {[
                                  `Sold ${formatDay(line.sale.soldOn)}`,
                                  line.sale.salesperson ?? "No salesman",
                                  line.sale.category,
                                  line.sale.condition === "used" ? "Used" : null,
                                  line.sale.vin,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </p>
                            </>
                          ) : (
                            <Badge tone="trail">Not found in the NUSR</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
                <p className="font-mono text-xs text-ink-muted" data-list-range>
                  {saved.from.toLocaleString("en-US")}–{saved.to.toLocaleString("en-US")} of {saved.total.toLocaleString("en-US")}
                </p>
                <Pagination
                  query={filters.query}
                  page={saved.page}
                  pages={saved.pages}
                  label="Pages of saved rebates"
                  path={`/rebates${rebateFiltersSearch({ ...filters, query: "" }, thisYear)}`}
                />
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
