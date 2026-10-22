import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Card, LoadingLine, PageHeading } from "@/components/app/ui";
import {
  MAX_MODEL_FILTER_LENGTH,
  MAX_QUERY_LENGTH,
  SEARCH_LIMIT,
  cleanLibraryFilters,
  cleanSearchQuery,
  hasLibraryFilters,
  libraryFilterOptions,
  listReadyManuals,
  searchManuals,
  type LibraryFilters,
} from "@/lib/library";
import { brandInfo, brandLabels, listsBrands, type Vehicle } from "@/lib/manual-catalog-rules";
import { allows, requireCapability } from "@/lib/session";

import { LibrarySearchForm } from "./search-form";

export const metadata: Metadata = { title: "Library" };

export default function LibraryPage(props: PageProps<"/library">) {
  return (
    <Suspense fallback={<LoadingLine />}>
      <Library searchParams={props.searchParams} />
    </Suspense>
  );
}

const viewerHref = (manualId: string, page: number) => `/library/${manualId}?page=${page}`;

// "Ranger, RZR · 2020, 2022": what the model list says, beside a manual's title.
function CatalogLine({ brands, modelYears }: { brands: string[]; modelYears: string | null }) {
  const text = [brandLabels(brands), modelYears].filter(Boolean).join(" · ");
  return text ? <span className="text-xs text-ink-muted">{text}</span> : null;
}

const VEHICLE_MANUALS: Record<Vehicle, string> = {
  UTV: "UTV manuals",
  ATV: "ATV manuals",
  Generator: "generator manuals",
  Other: "manuals for other vehicles",
};

// "Ranger manuals for 2020 RZR XP 1000 models", for the line above results.
// A line that is its vehicle on its own (ATV, GEN) reads as the vehicle.
function describeFilters(filters: LibraryFilters) {
  const models = [filters.year, filters.model].filter(Boolean).join(" ");
  const brand = filters.brand === undefined ? null : brandInfo(filters.brand);
  const what = filters.vehicle
    ? VEHICLE_MANUALS[filters.vehicle]
    : brand
      ? listsBrands(brand.vehicle)
        ? `${brand.label} manuals`
        : VEHICLE_MANUALS[brand.vehicle]
      : "manuals";
  return [what, models && `for ${models} models`].filter(Boolean).join(" ");
}

function ClearFilters({ query }: { query: string }) {
  return (
    <Link
      href={query ? `/library?q=${encodeURIComponent(query)}` : "/library"}
      className="text-glow hover:underline focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
    >
      Clear filters
    </Link>
  );
}

async function Library({ searchParams }: { searchParams: PageProps<"/library">["searchParams"] }) {
  const user = await requireCapability("library.read");
  const params = await searchParams;
  const query = cleanSearchQuery(typeof params.q === "string" ? params.q : "");
  const filters = cleanLibraryFilters(params);
  const options = await libraryFilterOptions(user.shop.id);

  return (
    <div className="space-y-6">
      <PageHeading
        title="Library"
        description="Search every page of the shop's service and owner manuals: fault codes, part numbers, procedures. Put a phrase in quotes to match it exactly."
      />

      <LibrarySearchForm
        query={query}
        vehicle={filters.vehicle ?? ""}
        brand={filters.brand ?? ""}
        year={filters.year === undefined ? "" : String(filters.year)}
        model={filters.model ?? ""}
        maxQueryLength={MAX_QUERY_LENGTH}
        maxModelLength={MAX_MODEL_FILTER_LENGTH}
        showFilters={options.brands.length > 0 || options.years.length > 0 || hasLibraryFilters(filters)}
        vehicles={options.vehicles}
        brands={options.brands}
        years={options.years}
      />

      {query ? (
        <Results shopId={user.shop.id} query={query} filters={filters} />
      ) : (
        <AllManuals
          shopId={user.shop.id}
          filters={filters}
          readyCount={options.manuals}
          canAdd={allows(user, "settings.manage")}
        />
      )}
    </div>
  );
}

async function Results({ shopId, query, filters }: { shopId: string; query: string; filters: LibraryFilters }) {
  const hits = await searchManuals(shopId, query, filters);
  const filtered = hasLibraryFilters(filters);
  if (hits.length === 0) {
    return (
      <Card>
        <p className="text-sm leading-6 text-ink-muted">
          Nothing matched <span className="text-ink">{query}</span>
          {filtered ? (
            <>
              {" "}
              in {describeFilters(filters)}. Try fewer words or filters, or <ClearFilters query={query} />.
            </>
          ) : (
            ". Try fewer words, another spelling, or the part number without dashes."
          )}
        </p>
      </Card>
    );
  }
  return (
    <section aria-label="Search results" className="space-y-3">
      <p className="text-sm text-ink-muted">
        {hits.length === SEARCH_LIMIT
          ? `Top ${SEARCH_LIMIT} pages for `
          : `${hits.length} ${hits.length === 1 ? "page matches" : "pages match"} `}
        <span className="text-ink">{query}</span>
        {filtered && <> in {describeFilters(filters)}</>}, best matches first.
        {filtered && (
          <>
            {" "}
            <ClearFilters query={query} />
          </>
        )}
      </p>
      <ol className="space-y-3">
        {hits.map((hit) => (
          <li key={`${hit.manualId}-${hit.pageNumber}`}>
            <Link
              href={viewerHref(hit.manualId, hit.pageNumber)}
              className="block rounded-xl border border-white/10 bg-charcoal-900/70 p-4 transition hover:border-glow/30 hover:bg-charcoal-800/70 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none sm:p-5"
            >
              <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="min-w-0 font-medium break-words text-ink">{hit.title}</span>
                <span className="font-mono text-xs text-glow/80">
                  Page {hit.pageNumber} of {hit.pageCount}
                </span>
              </span>
              <CatalogLine brands={hit.brands} modelYears={hit.modelYears} />
              <span className="mt-2 block text-sm leading-6 text-ink-muted">
                {hit.snippet.map((part, index) =>
                  part.match ? (
                    <mark key={index} className="rounded-sm bg-trail/20 px-0.5 text-trail">
                      {part.text}
                    </mark>
                  ) : (
                    <span key={index}>{part.text}</span>
                  ),
                )}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

async function AllManuals({
  shopId,
  filters,
  readyCount,
  canAdd,
}: {
  shopId: string;
  filters: LibraryFilters;
  readyCount: number;
  canAdd: boolean;
}) {
  const filtered = hasLibraryFilters(filters);
  const manuals = await listReadyManuals(shopId, filters);
  if (manuals.length === 0 && filtered) {
    return (
      <Card>
        <p className="text-sm leading-6 text-ink-muted">
          No {describeFilters(filters)}. Try fewer filters, or <ClearFilters query="" />.
        </p>
      </Card>
    );
  }
  if (manuals.length === 0) {
    return (
      <Card title="No manuals yet">
        <p className="text-sm leading-6 text-ink-muted">
          {canAdd ? (
            <>
              Add the shop&apos;s PDFs under{" "}
              <Link href="/admin/manuals" className="text-glow hover:underline">
                System Admin → Manuals
              </Link>
              .
            </>
          ) : (
            "An admin adds them under System Admin → Manuals."
          )}
        </p>
      </Card>
    );
  }
  return (
    <Card
      title={
        filtered
          ? `${manuals.length.toLocaleString("en-US")} of ${readyCount.toLocaleString("en-US")} manuals`
          : `${manuals.length.toLocaleString("en-US")} ${manuals.length === 1 ? "manual" : "manuals"}`
      }
      description={
        filtered ? (
          <>
            {describeFilters(filters).replace(/^./, (c) => c.toUpperCase())}. <ClearFilters query="" />
          </>
        ) : undefined
      }
    >
      <ul className="-mx-5 -mb-5 divide-y divide-white/10 border-t border-white/10 sm:-mx-6 sm:-mb-6">
        {manuals.map((manual) => (
          <li key={manual.id}>
            <Link
              href={viewerHref(manual.id, 1)}
              className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 transition hover:bg-white/[0.03] focus-visible:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-glow/60 focus-visible:outline-none focus-visible:ring-inset sm:px-6"
            >
              <span className="min-w-0">
                <span className="block font-medium break-words text-ink">{manual.title}</span>
                <CatalogLine brands={manual.brands} modelYears={manual.modelYears} />
              </span>
              <span className="text-xs text-ink-muted">
                {manual.pageCount.toLocaleString("en-US")} {manual.pageCount === 1 ? "page" : "pages"}
                {manual.pagesWithoutText > 0 && ` · ${manual.pagesWithoutText} not searchable`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
