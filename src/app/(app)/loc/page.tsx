import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Card, LoadingLine, Notice, PageHeading } from "@/components/app/ui";
import { primaryLinkClass } from "@/components/hud";
import { MAX_LIST_WORDS, listSearchIsCut } from "@/lib/diagnose-list-rules";
import { getLocUnit, listLocUnits, locSuggestions, type LocList } from "@/lib/loc";
import {
  FLOOR_STATES,
  FLOOR_STATE_LABELS,
  LOC_ACCOUNT,
  LOC_SHOWS,
  LOC_SHOW_LABELS,
  ON_THE_LIST,
  locCategories,
  locFiltersSearch,
  locFiltersTitle,
  locNarrowed,
  locUnitLabel,
  parseLocFilters,
  type LocFilters,
  type LocTotals,
} from "@/lib/loc-rules";
import { formatMoney, shopToday } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";

import { ListSearch } from "../diagnose/list-search";
import { LogFilter } from "../nusr/forms";
import { BalanceCheck, MarkUnitsForm } from "./forms";
import { LocTable, MARK_FORM } from "./units-table";

export const metadata: Metadata = { title: "LOC" };

export default function LocPage(props: PageProps<"/loc">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Loc searchParams={props.searchParams} />
    </Suspense>
  );
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const count = (value: string | string[] | undefined) => (typeof value === "string" && /^\d{1,6}$/.test(value) ? Number(value) : null);

const linkButton =
  "inline-flex min-h-11 items-center rounded-lg border border-glow/30 px-4 text-sm font-medium text-glow transition hover:border-glow/50 hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none";

// How many units the table draws at once; the totals count them all.
const SHOWN_ROWS = 1_000;

async function Loc({ searchParams }: { searchParams: PageProps<"/loc">["searchParams"] }) {
  const user = await requireCapability("sales.log");
  const params = await searchParams;
  const filters = parseLocFilters(params);
  const today = shopToday();
  const [list, suggestions, added] = await Promise.all([
    listLocUnits(user.shop.id, filters, today),
    locSuggestions(user.shop.id),
    typeof params.added === "string" ? getLocUnit(user.shop.id, params.added) : Promise.resolve(null),
  ]);
  // The address as it stands, and the list's own path for the search box
  // (which carries the search itself).
  const search = locFiltersSearch(filters).slice(1);
  const path = `/loc${locFiltersSearch({ ...filters, query: "" })}`;
  const marked = count(params.marked);
  const unchanged = count(params.unchanged);
  const owed = count(params.owed);
  const imported = count(params.imported);

  return (
    <div className="space-y-6">
      <PageHeading
        title="LOC"
        description={`The units on the line of credit and the ones we own, as the LOC sheet keeps them: what each cost, when its free floor ends, and the totals, the LOC's to balance with account ${LOC_ACCOUNT}. A unit goes on as it comes in; a trade-in logged on the NUSR comes on by itself.`}
        action={
          <div className="flex flex-wrap gap-3">
            <Link href="/loc/import" className={linkButton}>
              Import
            </Link>
            <a href={`/loc/export${search ? `?${search}` : ""}`} className={linkButton} data-loc-export>
              Download Excel
            </a>
            <Link href="/loc/new" className={primaryLinkClass} data-loc-add>
              Add a unit
            </Link>
          </div>
        }
      />

      {added && (
        <Notice>
          Added {locUnitLabel(added)}
          {added.stockNumber ? ` (stock # ${added.stockNumber})` : ""} {added.onLoc ? "to the LOC" : "to the units we own"}.{" "}
          <Link href="/loc/new" className="font-medium underline">
            Add another
          </Link>
        </Notice>
      )}
      {typeof params.removed === "string" && <Notice>Removed {params.removed.slice(0, 200)} from the LOC.</Notice>}
      {marked !== null && (
        <Notice>
          Marked {plural(marked, "unit", "units")} {params.mark === "paid" ? "paid off" : "sold"}.
          {owed ? ` ${plural(owed, "is", "are")} still owed on the LOC: mark ${owed === 1 ? "it" : "them"} paid off once the payoff's made.` : ""}
          {unchanged ? ` ${plural(unchanged, "ticked unit was", "ticked units were")} left as ${unchanged === 1 ? "it was" : "they were"}: ${params.mark === "paid" ? "ours already" : "sold already, or sold before it came in"}.` : ""}
        </Notice>
      )}
      {imported !== null && <Notice>Imported {plural(imported, "unit", "units")} onto the LOC.</Notice>}

      <Totals totals={list.totals} filters={filters} />

      <Card>
        <div className="flex flex-wrap items-center gap-3" data-loc-filters>
          <LogFilter
            path="/loc"
            name="show"
            label="Show"
            search={search}
            value={filters.show ?? ""}
            options={[{ value: "", label: ON_THE_LIST }, ...LOC_SHOWS.map((show) => ({ value: show, label: LOC_SHOW_LABELS[show] }))]}
          />
          <LogFilter
            path="/loc"
            name="floor"
            label="Free floor"
            search={search}
            value={filters.floor ?? ""}
            options={[{ value: "", label: "Any free floor" }, ...FLOOR_STATES.map((state) => ({ value: state, label: FLOOR_STATE_LABELS[state] }))]}
          />
          <LogFilter
            path="/loc"
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
            path="/loc"
            name="category"
            label="Category"
            search={search}
            value={filters.category ?? ""}
            options={[{ value: "", label: "Every category" }, ...locCategories(suggestions.categories).map((category) => ({ value: category, label: category }))]}
          />
          <LogFilter
            path="/loc"
            name="year"
            label="Model year"
            search={search}
            value={filters.year === null ? "" : String(filters.year)}
            options={[{ value: "", label: "Every model year" }, ...[...new Set([...suggestions.years, ...(filters.year === null ? [] : [filters.year])])].map((year) => ({ value: String(year), label: String(year) }))]}
          />
        </div>
        <div className="mt-4">
          <ListSearch query={filters.query} path={path} label="Search the LOC" placeholder="Stock #, model, VIN, notes…">
            <Results list={list} filters={filters} search={search} today={today} />
          </ListSearch>
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value, sub, tone, href }: { label: string; value: string; sub?: string; tone?: "trail" | "glow"; href?: string }) {
  const body = (
    <>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={`mt-1 font-mono text-lg tabular-nums ${tone === "trail" ? "text-trail" : tone === "glow" ? "text-glow" : "text-ink"}`}>{value}</dd>
      {sub && <dd className="text-xs text-ink-muted">{sub}</dd>}
    </>
  );
  return href ? (
    <Link href={href} className="block min-w-0 rounded-lg hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none">
      {body}
    </Link>
  ) : (
    <div className="min-w-0">{body}</div>
  );
}

// The totals, at the top: as the sheet's (what's on the LOC, which
// balances with the books; what we own; both), with what needs seeing to:
// free floors run out and running out, sold units still owed, and what the
// NUSR has sold that the LOC doesn't know of yet. Of what the filters find.
function Totals({ totals, filters }: { totals: LocTotals; filters: LocFilters }) {
  const narrowed = locNarrowed(filters);
  const units = (tally: { units: number }) => plural(tally.units, "unit", "units");
  return (
    <section aria-labelledby="loc-totals" className="rounded-xl border border-white/10 bg-charcoal-900/70 p-5 sm:p-6" data-loc-totals>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="loc-totals" className="text-base font-semibold text-ink">
          Totals
        </h2>
        <p className="text-xs text-ink-muted">{narrowed ? `Of the units listed (${locFiltersTitle(filters)}): clear the filters for the whole LOC.` : "Of everything on the LOC and everything we own."}</p>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="On the LOC" value={formatMoney(totals.loc.cost)} sub={`${units(totals.loc)} · balances with ${LOC_ACCOUNT}`} tone="glow" />
        <Stat label="We own" value={formatMoney(totals.owned.cost)} sub={units(totals.owned)} />
        <Stat label="Grand total" value={formatMoney(totals.all.cost)} sub={units(totals.all)} />
        <Stat
          label="Free floor ended"
          value={formatMoney(totals.ended.cost)}
          sub={`${units(totals.ended)}${totals.ended.units ? ` · ${totals.ended.owned} we own · ${totals.ended.loc} on the LOC` : ""}`}
          tone={totals.ended.units ? "trail" : undefined}
          href={`/loc${locFiltersSearch({ ...filters, floor: "ended" })}`}
        />
        <Stat label="Ends within 30 days" value={formatMoney(totals.soon.cost)} sub={units(totals.soon)} href={`/loc${locFiltersSearch({ ...filters, floor: "soon" })}`} />
        {totals.nusr > 0 ? (
          <Stat label="Sold in the NUSR" value={totals.nusr.toLocaleString("en-US")} sub="to mark sold or paid off here" tone="trail" href={`/loc${locFiltersSearch({ ...filters, show: "nusr" })}`} />
        ) : (
          <Stat label="Sold, still owed" value={formatMoney(totals.soldOnLoc.cost)} sub={units(totals.soldOnLoc)} />
        )}
      </dl>
      {!narrowed && totals.loc.units > 0 && (
        <div className="mt-5 border-t border-white/10 pt-4">
          <BalanceCheck total={totals.loc.cost} />
        </div>
      )}
    </section>
  );
}

function Results({ list, filters, search, today }: { list: LocList; filters: LocFilters; search: string; today: string }) {
  const title = locFiltersTitle(filters);
  const cut = listSearchIsCut(filters.query) ? ` (only its first ${MAX_LIST_WORDS} words are searched)` : "";
  const shown = list.units.slice(0, SHOWN_ROWS);
  // In the sheet's sections unless the list is one of them, or sold units.
  const grouped = filters.show === null || filters.show === "nusr";
  const ticking = shown.length > 0;
  return (
    <>
      {/* Always there, so a new count is read out as the list changes. */}
      <p role="status" data-result-count className="mt-3 text-sm text-ink-muted">
        {list.units.length === 0 ? `No units: ${title}${cut}.` : `${plural(list.units.length, "unit", "units")}: ${title}${cut}.`}
        {list.units.length > shown.length || list.capped ? ` The first ${shown.length.toLocaleString("en-US")} are listed; the filters or a search narrow it.` : ""}
      </p>
      {ticking && <MarkUnitsForm key={search} formId={MARK_FORM} back={search} today={today} />}
      {shown.length > 0 && (
        <div className="-mx-5 mt-4 overflow-x-auto border-y border-white/10 sm:-mx-6">
          <LocTable units={shown} today={today} back={search} ticking={ticking} grouped={grouped} />
        </div>
      )}
      {list.units.length === 0 && (
        <p className="mt-2 text-sm leading-6 text-ink-muted" data-list-empty>
          {filters.show === null && !filters.query && !filters.floor && !filters.condition && !filters.category && filters.year === null ? (
            <>
              Nothing on the LOC yet.{" "}
              <Link href="/loc/import" className="text-glow hover:underline">
                Import the LOC sheet
              </Link>
              , or{" "}
              <Link href="/loc/new" className="text-glow hover:underline">
                add a unit
              </Link>
              .
            </>
          ) : (
            <Link href="/loc" className="text-glow hover:underline">
              Show everything on the LOC
            </Link>
          )}
        </p>
      )}
    </>
  );
}
