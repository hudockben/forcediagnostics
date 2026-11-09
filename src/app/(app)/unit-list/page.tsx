import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Badge, Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { MAX_LIST_WORDS, listSearchIsCut } from "@/lib/diagnose-list-rules";
import { formatDay, formatMoney, shopToday } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";
import { MAX_LISTED, listStockUnits, type StockUnit, type UnitList } from "@/lib/unit-list";
import {
  UNIT_STATUSES,
  UNIT_STATUS_LABELS,
  daysInStock,
  isPartialVin,
  parseUnitFilters,
  soldOf,
  unitListHref,
  unitName,
  vinParts,
  type UnitFilters,
  type UnitTotals,
} from "@/lib/unit-list-rules";

import { ListSearch } from "../diagnose/list-search";
import { WidePage } from "../nusr/forms";
import { ChooseInvoicesButton, NewUnits } from "./new-units";

// The Unit List tab: New invoices at the top (drop Polaris's whole goods
// invoices anywhere on the page to read their units, check them, fill in
// the list prices and add them), then the list: the units in stock (or
// sold, or all of them) by model, as the shop's sheet kept them, each
// model's count, cost and list price, and the totals.

export const metadata: Metadata = { title: "Unit List" };

const buttonClass =
  "inline-flex h-12 items-center rounded-lg border border-glow/30 px-5 text-base font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

export default function UnitListPage(props: PageProps<"/unit-list">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <UnitListTab searchParams={props.searchParams} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

async function UnitListTab({ searchParams }: { searchParams: PageProps<"/unit-list">["searchParams"] }) {
  const user = await requireCapability("sales.log");
  const params = await searchParams;
  const filters = parseUnitFilters(params);
  const today = shopToday();
  const list = await listStockUnits(user, filters, today);
  // Only a manager or admin gets this far, so the list doesn't say no.
  if ("error" in list) throw new Error("The Unit List said no to a user allowed to see it");
  const note = (value: string | string[] | undefined) => (typeof value === "string" ? value.slice(0, 200) : null);
  const added = note(params.added);
  const filled = note(params.filled);
  const removed = note(params.removed);

  return (
    <WidePage className="space-y-6">
      <PageHeading
        title="Unit List"
        description="Every unit in stock, with what it cost and its list price. Drop Polaris's whole goods invoices anywhere on this page to add their units."
        action={
          <div className="flex flex-wrap gap-3">
            <Link href="/unit-list/import" className={buttonClass} data-unit-import-link>
              Import
            </Link>
            <Link href="/unit-list/new" className={buttonClass} data-unit-add-link>
              Add a unit
            </Link>
            <ChooseInvoicesButton />
          </div>
        }
      />
      {added && <Notice>Added {added} to the list.</Notice>}
      {filled && <Notice>Filled in the whole VIN of {filled}, which the list had only the end of.</Notice>}
      {removed && <Notice>Removed {removed} from the list.</Notice>}
      <NewUnits today={today} />
      <UnitListCard list={list} filters={filters} today={today} />
    </WidePage>
  );
}

// --- The list -------------------------------------------------------------------

function UnitListCard({ list, filters, today }: { list: UnitList; filters: UnitFilters; today: string }) {
  const nothingYet = list.counts.stock + list.counts.sold === 0 && !filters.query;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="In stock or sold" className="flex flex-wrap gap-2">
          {UNIT_STATUSES.map((status) => {
            const count = status === "stock" ? list.counts.stock : status === "sold" ? list.counts.sold : list.counts.stock + list.counts.sold;
            return (
              <Link
                key={status}
                href={unitListHref({ ...filters, status })}
                aria-current={status === filters.status ? "page" : undefined}
                className={`flex h-10 items-center gap-2 rounded-full px-4 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none ${
                  status === filters.status ? "bg-glow/15 text-glow" : "text-ink-muted hover:bg-white/5 hover:text-ink"
                }`}
              >
                {UNIT_STATUS_LABELS[status]}
                <span className="font-mono text-xs opacity-80">{count.toLocaleString("en-US")}</span>
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="mt-4">
        {nothingYet ? (
          <p className="text-sm leading-6 text-ink-muted" data-unit-list-empty>
            No units on the list yet.{" "}
            <Link href="/unit-list/import" className="text-glow hover:underline">
              Import your spreadsheet
            </Link>{" "}
            of the units in stock, drop a Polaris whole goods invoice on this page (the PDF from the dealer portal, or a scan of the printout) to add its units, or{" "}
            <Link href="/unit-list/new" className="text-glow hover:underline">
              add a unit by hand
            </Link>
            .
          </p>
        ) : (
          <ListSearch
            query={filters.query}
            path={filters.status === "stock" ? "/unit-list" : `/unit-list?status=${filters.status}`}
            label="Search the Unit List"
            placeholder="Model, VIN, model number, notes or invoice #"
          >
            <Results list={list} filters={filters} today={today} />
          </ListSearch>
        )}
      </div>
    </Card>
  );
}

function Results({ list, filters, today }: { list: UnitList; filters: UnitFilters; today: string }) {
  const quote = filters.query ? `“${filters.query}”${listSearchIsCut(filters.query) ? ` (only its first ${MAX_LIST_WORDS} words are searched)` : ""}` : "";
  const what = filters.status === "stock" ? "in stock" : filters.status === "sold" ? "sold" : "on the list";
  return (
    <>
      {/* Always there, so a new count is read out as the list changes. */}
      <p role="status" data-result-count className="mt-3 text-sm text-ink-muted empty:hidden">
        {filters.query ? (list.found === 0 ? `Nothing ${what} matches ${quote}.` : `${plural(list.found, "unit", "units")} ${what} ${list.found === 1 ? "matches" : "match"} ${quote}.`) : ""}
      </p>
      {list.shown === 0 ? (
        <p className="mt-2 text-sm leading-6 text-ink-muted" data-list-empty>
          {filters.query ? (
            <Link href={unitListHref({ ...filters, query: "" })} className="text-glow hover:underline">
              Show every unit {what}
            </Link>
          ) : filters.status === "stock" ? (
            "Nothing in stock: every unit on the list is sold."
          ) : (
            "Nothing sold yet."
          )}
        </p>
      ) : (
        <>
          <Totals totals={list.totals} status={filters.status} />
          {list.found > list.shown && (
            <p className="mt-3 text-sm text-ink-muted">
              Showing the {MAX_LISTED.toLocaleString("en-US")} received most recently of {list.found.toLocaleString("en-US")}; search to find the others.
            </p>
          )}
          <UnitTable list={list} status={filters.status} today={today} />
        </>
      )}
    </>
  );
}

// The figures over the table: units, what they cost and are listed at, and
// how long they've been in stock.
function Totals({ totals, status }: { totals: UnitTotals; status: UnitFilters["status"] }) {
  const stats: { label: string; value: string; note?: string }[] = [
    { label: status === "sold" ? "Units sold" : status === "stock" ? "Units in stock" : "Units", value: totals.units.toLocaleString("en-US") },
    { label: "Cost", value: formatMoney(totals.cost), note: totals.noCost ? `${plural(totals.noCost, "unit has", "units have")} none` : undefined },
    { label: "List", value: formatMoney(totals.list), note: totals.noList ? `${plural(totals.noList, "unit has", "units have")} no list price yet` : undefined },
    {
      label: status === "stock" ? "Days in stock" : "Days to sell",
      value: totals.averageDays === null ? "—" : `${totals.averageDays.toLocaleString("en-US")} avg`,
      note: totals.oldestDays === null ? undefined : `${status === "stock" ? "oldest" : "longest"} ${plural(totals.oldestDays, "day", "days")}`,
    },
  ];
  return (
    <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4" data-unit-totals>
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-lg border border-white/10 bg-forest-950/40 px-4 py-3">
          <dt className="text-xs text-ink-muted">{stat.label}</dt>
          <dd className="mt-1 font-mono text-lg text-ink">{stat.value}</dd>
          {stat.note && <dd className={`mt-0.5 text-xs ${stat.label === "List" ? "text-trail" : "text-ink-muted"}`}>{stat.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

const cellClass = "px-3 py-2.5";
const moneyClass = `${cellClass} text-right font-mono whitespace-nowrap`;

// The units by model, as the shop's sheet had them: each model's units
// together, a 1 in Units for each, and a line adding up a model with more
// than one; the total under them all.
function UnitTable({ list, status, today }: { list: UnitList; status: UnitFilters["status"]; today: string }) {
  const showSold = status !== "stock";
  return (
    <div className="-mx-5 mt-4 overflow-x-auto border-y border-white/10 sm:-mx-6">
      <table className="w-full min-w-[52rem] text-sm" data-unit-table>
        <thead>
          <tr className="border-b border-white/10 text-left text-xs text-ink-muted">
            <th scope="col" className="px-5 py-2 font-medium sm:px-6">
              Model
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              VIN
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Received
            </th>
            {showSold && (
              <th scope="col" className="px-3 py-2 font-medium">
                Sold
              </th>
            )}
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Days
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Cost
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              List
            </th>
            <th scope="col" className="px-5 py-2 text-right font-medium sm:px-6">
              Units
            </th>
          </tr>
        </thead>
        {list.groups.map((group) => (
          <tbody key={group.key} className="border-b-2 border-white/10" data-unit-group={group.name}>
            {group.units.map((unit) => (
              <UnitRow key={unit.id} unit={unit} showSold={showSold} today={today} />
            ))}
            {group.units.length > 1 && (
              <tr className="bg-white/[0.03] text-xs text-ink-muted" data-unit-group-total>
                <th scope="row" colSpan={showSold ? 5 : 4} className="px-5 py-2 text-right font-medium sm:px-6">
                  {group.name}
                </th>
                <td className={`${moneyClass} py-2`}>{formatMoney(group.totals.cost)}</td>
                <td className={`${moneyClass} py-2`}>{formatMoney(group.totals.list)}</td>
                <td className="px-5 py-2 text-right font-mono font-semibold text-ink sm:px-6">{group.totals.units}</td>
              </tr>
            )}
          </tbody>
        ))}
        <tfoot>
          <tr className="text-sm text-ink" data-unit-total>
            <th scope="row" colSpan={showSold ? 5 : 4} className="px-5 py-3 text-right font-semibold sm:px-6">
              Total
            </th>
            <td className={`${moneyClass} py-3 font-semibold`}>{formatMoney(list.totals.cost)}</td>
            <td className={`${moneyClass} py-3 font-semibold`}>{formatMoney(list.totals.list)}</td>
            <td className="px-5 py-3 text-right font-mono font-semibold sm:px-6">{list.totals.units.toLocaleString("en-US")}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function UnitRow({ unit, showSold, today }: { unit: StockUnit; showSold: boolean; today: string }) {
  const [head, tail] = vinParts(unit.vin);
  const sold = soldOf(unit);
  return (
    <tr className="border-t border-white/5 align-top" data-unit-row={unit.vin}>
      <th scope="row" className="px-5 py-2.5 text-left font-medium text-ink sm:px-6">
        <Link href={`/unit-list/${unit.id}`} className="hover:text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none">
          {unitName(unit)}
        </Link>
        {(unit.modelNumber || unit.notes) && (
          <span className="mt-0.5 block text-xs font-normal text-ink-muted">{[unit.modelNumber, unit.notes].filter(Boolean).join(" · ")}</span>
        )}
      </th>
      <td className={`${cellClass} font-mono whitespace-nowrap`}>
        {isPartialVin(unit.vin) ? (
          <span title="Only the VIN's end, as the spreadsheet had it" className="text-ink-muted">
            …
          </span>
        ) : (
          <span className="text-ink-muted">{head}</span>
        )}
        <span className="font-semibold text-ink">{tail}</span>
      </td>
      <td className={`${cellClass} whitespace-nowrap`}>{formatDay(unit.receivedOn)}</td>
      {showSold && (
        <td className={`${cellClass} whitespace-nowrap`}>
          {sold ? (
            <>
              {formatDay(sold.on)}{" "}
              {sold.how === "nusr" && (
                <span title={unit.nusrSale ? `Sold to ${unit.nusrSale.customerName} in the NUSR` : undefined}>
                  <Badge>NUSR</Badge>
                </span>
              )}
            </>
          ) : (
            <Badge tone="glow">In stock</Badge>
          )}
        </td>
      )}
      <td className={`${cellClass} text-right font-mono`}>{daysInStock(unit, today)}</td>
      <td className={moneyClass}>{unit.cost === null ? <span className="text-ink-muted">—</span> : formatMoney(unit.cost)}</td>
      <td className={moneyClass}>{unit.listPrice === null ? <span className="font-sans text-xs text-trail">to fill in</span> : formatMoney(unit.listPrice)}</td>
      <td className="px-5 py-2.5 text-right font-mono sm:px-6">1</td>
    </tr>
  );
}
