import "server-only";

import { and, asc, count, eq, isNotNull, sql, type SQL } from "drizzle-orm";

import { withShop } from "@/db";
import { manualCatalogDocuments, manualCatalogModels, manualFileNames, manuals } from "@/db/schema";
import { entryOfName, manualBrands, manualDisplayTitle, manualModelYears, modelsOfName } from "@/lib/manual-catalog";
import {
  CATALOG_LIMITS,
  KNOWN_BRANDS,
  MAX_MODEL_YEAR,
  MIN_MODEL_YEAR,
  MODEL_YEARS_PATTERN,
  VEHICLES,
  brandInfo,
  brandsOf,
  cleanCatalogText,
  compareBrands,
  type Vehicle,
} from "@/lib/manual-catalog-rules";
import { SNIPPET_START, SNIPPET_STOP, cutText, parseSnippet, type SnippetPart } from "@/lib/manual-rules";
import { isManualId } from "@/lib/manuals";

// Reading the shop's manual library: full-text search over page text, the
// filters from the model list, and the manuals for the viewer. Callers must
// check library.read first.

export const SEARCH_LIMIT = 50;
export const MAX_QUERY_LENGTH = 200;
export const MAX_MODEL_FILTER_LENGTH = 60;
const MAX_MODEL_FILTER_WORDS = 6;

// Short snippets with up to two passages around the matches. The match
// markers are characters page text never contains (see cleanPageText).
const HEADLINE_OPTIONS = [
  `StartSel="${SNIPPET_START}"`,
  `StopSel="${SNIPPET_STOP}"`,
  "MaxWords=30",
  "MinWords=12",
  "MaxFragments=2",
  'FragmentDelimiter=" … "',
].join(", ");

export type SearchHit = {
  manualId: string;
  title: string;
  // From the model list, when the manual is in it: the brand codes of its
  // entries (see brandLabels), and the Model Years of the one naming it.
  brands: string[];
  modelYears: string | null;
  pageNumber: number;
  pageCount: number;
  rank: number;
  snippet: SnippetPart[];
};

// What a search box sends, tidied for Postgres: no NULs (text parameters
// can't hold them, so a query like ?q=%00 would fail), trimmed and capped
// (without cutting an emoji in half, which would break links built from it).
export function cleanSearchQuery(query: string) {
  return cutText(query.replace(/\u0000/g, "").trim(), MAX_QUERY_LENGTH);
}

// Narrowing the library down with the model list (see src/lib/manual-catalog.ts):
// a kind of vehicle or one of Polaris's category codes, a model year, and a
// model number or name.
export type LibraryFilters = { vehicle?: Vehicle; brand?: string; year?: number; model?: string };

type FilterParams = Record<string, string | string[] | undefined>;

const param = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

// "rzr xp-1000" -> ["RZR", "XP", "1000"]: what the Model filter looks for at
// the start of the words of a model number or description, split the same
// way as manual_catalog_models.model_words.
export function modelFilterWords(model: string) {
  return model
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .slice(0, MAX_MODEL_FILTER_WORDS);
}

const cleanBrand = (value: string | string[] | undefined) => {
  const brand = cleanCatalogText(param(value));
  return brand && brand.length <= CATALOG_LIMITS.brand ? brand : undefined;
};

// The filters from the Library's address (?vehicle=UTV&year=2020&model=RZR+XP,
// or ?brand=RGR for one line), tidied. Anything that can't be a filter is left
// out. A brand is narrower than a vehicle, so it wins when both are given.
// Without JavaScript the Vehicle select sends its brand codes as ?vehicle=RGR
// too, so a vehicle that isn't one of VEHICLES is taken as a brand.
export function cleanLibraryFilters(params: FilterParams): LibraryFilters {
  const filters: LibraryFilters = {};
  const asked = cleanBrand(params.vehicle);
  const vehicle = VEHICLES.find((name) => name.toLowerCase() === asked?.toLowerCase());
  const brand = cleanBrand(params.brand) ?? (vehicle ? undefined : asked);
  if (brand) filters.brand = brand;
  else if (vehicle) filters.vehicle = vehicle;
  const year = param(params.year).trim();
  if (/^\d{4}$/.test(year) && Number(year) >= MIN_MODEL_YEAR && Number(year) <= MAX_MODEL_YEAR) {
    filters.year = Number(year);
  }
  const model = cutText(cleanCatalogText(param(params.model)) ?? "", MAX_MODEL_FILTER_LENGTH).trim();
  if (model && modelFilterWords(model).length > 0) filters.model = model;
  return filters;
}

export const hasLibraryFilters = (filters: LibraryFilters) =>
  filters.vehicle !== undefined ||
  filters.brand !== undefined ||
  filters.year !== undefined ||
  filters.model !== undefined;

// The shop the transaction is for (see withShop). Row-level security keeps
// every query to it; the checks below say so too.
const thisShop = sql`nullif(current_setting('app.shop_id', true), '')::uuid`;

const codeList = (codes: string[]) => sql.join(codes.map((code) => sql`${code}`), sql`, `);

// An entry's brand (the column) is that kind of vehicle. Other is any code
// the app doesn't know; a blank brand is no vehicle at all.
function brandIsVehicle(vehicle: Vehicle, brand: SQL): SQL {
  return vehicle === "Other"
    ? sql`${brand} not in (${codeList(KNOWN_BRANDS)})`
    : sql`${brand} in (${codeList(brandsOf(vehicle))})`;
}

// An entry's brand (the column) meets the Vehicle filter, which must be set.
function brandMatches(filters: LibraryFilters, brand: SQL): SQL {
  const conditions = [
    ...(filters.brand === undefined ? [] : [sql`${brand} = ${filters.brand}`]),
    ...(filters.vehicle === undefined ? [] : [brandIsVehicle(filters.vehicle, brand)]),
  ];
  return sql.join(conditions, sql` and `);
}

// The file keys of the shop's entries with a model that meets every
// condition (on cm), as an array worked out once rather than per entry (see
// below).
function entriesWithModels(conditions: SQL[]): SQL {
  return sql`array(
    select distinct cm.file_key from manual_catalog_models cm
    where cm.shop_id = ${thisShop} and ${sql.join(conditions, sql` and `)}
  )`;
}

// Every name of the manuals with an entry whose brand meets the Vehicle
// filter, as an array worked out once.
function namesOfManualsWithBrand(filters: LibraryFilters): SQL {
  return sql`array(
    select o.file_key from manual_file_names o
    where o.shop_id = ${thisShop} and o.manual_id = any(array(
      select b.manual_id from manual_file_names b
      join manual_catalog_documents bd on bd.shop_id = b.shop_id and bd.file_key = b.file_key
      where b.shop_id = ${thisShop} and ${brandMatches(filters, sql`bd.brand`)}
    ))
  )`;
}

// The IDs of ready manuals that match every filter that's set, as an array
// for `id = any(...)`, or null with no filters. A manual is in the model list
// once for each of its names the list has, and matches when one of those
// entries matches every filter. Year and Model have to match the same model
// ("a 2020 RZR XP 1000"), not two different ones. An entry with no brand
// counts as having the brands of the manual's other entries: Polaris lists
// the RZR 800 manual's 2013 models under a name with no brand, and its 2014
// ones under a RZR name. Manuals that aren't in the model list never match
// a filter.
//
// Arrays, not `id in (subquery)` or `exists (...)`: Postgres works each out
// once, before the rest. As subqueries they can become joins that Postgres
// runs again for every page, manual or entry it checks, which takes seconds
// to minutes whenever it underestimates the shop's list (before it has
// statistics on a freshly imported one, say).
function manualsMatching(filters: LibraryFilters): SQL | null {
  const conditions: SQL[] = [];
  const words = filters.model === undefined ? [] : modelFilterWords(filters.model);
  const byModel = filters.year !== undefined || words.length > 0;
  if (filters.brand !== undefined || filters.vehicle !== undefined) {
    const brand = brandMatches(filters, sql`d.brand`);
    // With a vehicle alone, a blank entry adds no manual that its branded
    // ones don't already match.
    conditions.push(
      byModel
        ? sql`(${brand} or (d.brand is null and d.file_key = any(${namesOfManualsWithBrand(filters)})))`
        : brand,
    );
  }
  if (byModel) {
    const model = [
      ...(filters.year === undefined ? [] : [sql`cm.model_year = ${filters.year}`]),
      ...words.map((word) => sql`cm.model_words like ${`% ${word}%`}`),
    ];
    const covered = sql`d.file_key = any(${entriesWithModels(model)})`;
    // Year alone: an entry with no dated models (a manual listed without
    // any) goes by its Model Years text instead.
    conditions.push(
      filters.year === undefined || words.length > 0
        ? covered
        : sql`(${covered} or (
            d.file_key <> all(${entriesWithModels([sql`cm.model_year is not null`])})
            and exists (
              select 1 from regexp_matches(coalesce(d.model_years, ''), ${MODEL_YEARS_PATTERN}, 'g') r(m)
              where ${filters.year} between symmetric r.m[1]::int and coalesce(r.m[2], r.m[1])::int
            )
          ))`,
    );
  }
  if (conditions.length === 0) return null;
  // The matching entries first, then the ready manuals known by their names.
  return sql`array(
    select n.manual_id from manual_file_names n
    join manuals fm on fm.id = n.manual_id and fm.shop_id = n.shop_id
    where fm.status = 'ready' and n.file_key = any(array(
      select d.file_key from manual_catalog_documents d
      where d.shop_id = ${thisShop} and ${sql.join(conditions, sql` and `)}
    ))
  )`;
}

// The search itself, apart from searchManuals so tests can check its plan.
// Matches come from ready_manual_pages rather than manual_pages: under
// row-level security the GIN index can't be used and every search would read
// every page (see drizzle/0010_manual_search.sql). Run it inside withShop.
//
// The index finds every matching page first, in a CTE the filters can't
// reach into, and the filters then pick from those. Otherwise Postgres,
// guessing a filter leaves a manual or two, reads each of those manuals'
// pages instead, which is slow when the filter matches hundreds.
export function searchQuery(q: string, limit: number, filters: LibraryFilters = {}) {
  const only = manualsMatching(filters);
  return sql`
    with query as (select websearch_to_tsquery('english', ${q}) as tsq),
    matches as materialized (
      select v.manual_id, v.page_number,
        ts_rank_cd(v.search_vector, query.tsq, 1) as rank
      from ready_manual_pages v
      cross join query
      where v.search_vector @@ query.tsq
    ),
    top as materialized (
      select manual_id, page_number, rank
      from matches
      ${only ? sql`where manual_id = any(${only})` : sql``}
      order by rank desc, manual_id, page_number
      limit ${limit}
    )
    -- Snippets are slow to build, so only for the pages that made the cut.
    -- (manuals isn't aliased: the model-list details refer to it by name.)
    select top.manual_id, ${manualDisplayTitle} as title, ${manualBrands} as brands,
      ${manualModelYears} as model_years, top.page_number, manuals.page_count, top.rank::float8 as rank,
      ts_headline('english', p.text, query.tsq, ${HEADLINE_OPTIONS}) as snippet
    from top
    join manual_pages p on p.manual_id = top.manual_id and p.page_number = top.page_number
    join manuals on manuals.id = top.manual_id
    cross join query
    order by top.rank desc, title, top.page_number
  `;
}

// Searches ready manuals, only those matching the filters if any are set.
// Supports what people type into web search: plain words (all must match),
// "quoted phrases", OR, and -excluded words.
export async function searchManuals(
  shopId: string,
  query: string,
  filters: LibraryFilters = {},
  limit = SEARCH_LIMIT,
): Promise<SearchHit[]> {
  const q = cleanSearchQuery(query);
  if (!q) return [];
  const result = await withShop(shopId, (tx) =>
    tx.execute<{
      manual_id: string;
      title: string;
      brands: string[];
      model_years: string | null;
      page_number: number;
      page_count: number;
      rank: number;
      snippet: string;
    }>(searchQuery(q, limit, filters)),
  );
  return result.rows.map((row) => ({
    manualId: row.manual_id,
    title: row.title,
    brands: sortBrands(row.brands),
    modelYears: row.model_years,
    pageNumber: row.page_number,
    pageCount: row.page_count,
    rank: row.rank,
    snippet: parseSnippet(row.snippet),
  }));
}

// Brand codes in the order the Library shows them (see compareBrands).
const sortBrands = (codes: string[]) => [...codes].sort(compareBrands);

export type LibraryManual = {
  id: string;
  title: string;
  // As in SearchHit.
  brands: string[];
  modelYears: string | null;
  pageCount: number;
  pagesWithoutText: number;
};

// Selected from manuals.
const libraryColumns = {
  id: manuals.id,
  title: manualDisplayTitle,
  brands: manualBrands,
  modelYears: manualModelYears,
  pageCount: sql<number>`coalesce(${manuals.pageCount}, 0)`,
  pagesWithoutText: sql<number>`coalesce(${manuals.pagesWithoutText}, 0)`,
};

const withSortedBrands = <T extends { brands: string[] }>(rows: T[]) =>
  rows.map((row) => ({ ...row, brands: sortBrands(row.brands) }));

// The ready manuals, only those matching the filters if any are set.
export async function listReadyManuals(shopId: string, filters: LibraryFilters = {}): Promise<LibraryManual[]> {
  const only = manualsMatching(filters);
  const rows = await withShop(shopId, (tx) =>
    tx
      .select(libraryColumns)
      .from(manuals)
      .where(and(eq(manuals.status, "ready"), only ? sql`${manuals.id} = any(${only})` : undefined))
      .orderBy(manualDisplayTitle, asc(manuals.id)),
  );
  return withSortedBrands(rows);
}

export type FilterOptions = {
  // Ready manuals in all.
  manuals: number;
  // Kinds of vehicle among ready manuals, in VEHICLES order, with how many
  // manuals each. A manual listed for two lines of one vehicle (a Ranger and
  // a RZR) counts once.
  vehicles: { vehicle: Vehicle; manuals: number }[];
  // Brand codes among ready manuals (in compareBrands order), with how many
  // manuals each.
  brands: { brand: string; manuals: number }[];
  // Model years among ready manuals' models, newest first.
  years: number[];
};

// What the Library's filters can offer: only vehicles, brands and years some
// ready manual has.
export function libraryFilterOptions(shopId: string): Promise<FilterOptions> {
  // One query at a time: a transaction's queries share one connection.
  return withShop(shopId, async (tx) => {
    const ready = eq(manuals.status, "ready");
    const [total] = await tx.select({ n: count() }).from(manuals).where(ready);
    // Each ready manual's brands, once each: a few hundred rows for a shop.
    const pairs = await tx
      .selectDistinct({ brand: sql<string>`${manualCatalogDocuments.brand}`, manualId: manualFileNames.manualId })
      .from(manualFileNames)
      .innerJoin(manualCatalogDocuments, entryOfName)
      .innerJoin(manuals, and(eq(manuals.id, manualFileNames.manualId), eq(manuals.shopId, manualFileNames.shopId)))
      .where(and(ready, isNotNull(manualCatalogDocuments.brand)));
    const byBrand = new Map<string, Set<string>>();
    const byVehicle = new Map<Vehicle, Set<string>>();
    for (const { brand, manualId } of pairs) {
      byBrand.set(brand, (byBrand.get(brand) ?? new Set()).add(manualId));
      const vehicle = brandInfo(brand).vehicle;
      byVehicle.set(vehicle, (byVehicle.get(vehicle) ?? new Set()).add(manualId));
    }
    // From each ready manual's names to their entries' years, in that order:
    // a lateral subquery can't be turned inside out. Otherwise, until
    // Postgres has gathered statistics on a shop's freshly imported list
    // (which autovacuum does within a minute or so), it can take the shop to
    // have one model and loop over all of its thousands, once per name.
    const years = await tx.execute<{ year: number }>(sql`
      select distinct y.model_year as year
      from manual_file_names n
      join manuals m on m.id = n.manual_id and m.shop_id = n.shop_id and m.status = 'ready'
      cross join lateral (
        select distinct cm.model_year from manual_catalog_models cm
        where cm.shop_id = n.shop_id and cm.file_key = n.file_key and cm.model_year is not null
      ) y
      order by 1 desc
    `);
    return {
      manuals: total.n,
      vehicles: VEHICLES.filter((vehicle) => byVehicle.has(vehicle)).map((vehicle) => ({
        vehicle,
        manuals: byVehicle.get(vehicle)!.size,
      })),
      brands: [...byBrand.keys()].sort(compareBrands).map((brand) => ({ brand, manuals: byBrand.get(brand)!.size })),
      years: years.rows.map((row) => row.year),
    };
  });
}

// The ready manuals that cover a model number (exactly, whatever the case),
// under any of their names, by the model list: what the diagnosis assistant
// should read for a unit. The models are found first, once (see
// manualsMatching for why it's an array).
export async function manualsForModel(shopId: string, modelNumber: string): Promise<LibraryManual[]> {
  const number = cleanCatalogText(String(modelNumber ?? ""))?.toUpperCase();
  if (!number || number.length > CATALOG_LIMITS.modelNumber) return [];
  const covering = sql`array(
    select ${manualFileNames.manualId} from ${manualCatalogModels} join ${manualFileNames} on ${modelsOfName}
    where ${manualCatalogModels.modelNumber} = ${number}
  )`;
  const rows = await withShop(shopId, (tx) =>
    tx
      .select(libraryColumns)
      .from(manuals)
      .where(and(eq(manuals.status, "ready"), sql`${manuals.id} = any(${covering})`))
      .orderBy(manualDisplayTitle, asc(manuals.id)),
  );
  return withSortedBrands(rows);
}

// A ready manual and where its file is, for the viewer.
export async function getReadyManual(
  shopId: string,
  id: string,
): Promise<(LibraryManual & { storageKey: string }) | null> {
  if (!isManualId(id)) return null;
  const [row] = await withShop(shopId, (tx) =>
    tx
      .select({ ...libraryColumns, storageKey: manuals.storageKey })
      .from(manuals)
      .where(and(eq(manuals.id, id), eq(manuals.status, "ready"))),
  );
  return row ? withSortedBrands([row])[0] : null;
}
