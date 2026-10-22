import "server-only";

import { and, asc, count, countDistinct, desc, eq, exists, isNotNull, sql, type SQL } from "drizzle-orm";

import { withShop } from "@/db";
import { manualCatalogDocuments, manualCatalogModels, manuals } from "@/db/schema";
import { catalogEntryOfManual, manualDisplayTitle } from "@/lib/manual-catalog";
import {
  CATALOG_LIMITS,
  MAX_MODEL_YEAR,
  MIN_MODEL_YEAR,
  cleanCatalogText,
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
  // From the model list, when the manual is in it.
  brand: string | null;
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
// Polaris's category code, a model year, and a model number or name.
export type LibraryFilters = { brand?: string; year?: number; model?: string };

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

// The filters from the Library's address (?brand=ATV&year=2020&model=RZR+XP),
// tidied. Anything that can't be a filter is left out.
export function cleanLibraryFilters(params: FilterParams): LibraryFilters {
  const filters: LibraryFilters = {};
  const brand = cleanCatalogText(param(params.brand));
  if (brand && brand.length <= CATALOG_LIMITS.brand) filters.brand = brand;
  const year = param(params.year).trim();
  if (/^\d{4}$/.test(year) && Number(year) >= MIN_MODEL_YEAR && Number(year) <= MAX_MODEL_YEAR) {
    filters.year = Number(year);
  }
  const model = cutText(cleanCatalogText(param(params.model)) ?? "", MAX_MODEL_FILTER_LENGTH).trim();
  if (model && modelFilterWords(model).length > 0) filters.model = model;
  return filters;
}

export const hasLibraryFilters = (filters: LibraryFilters) =>
  filters.brand !== undefined || filters.year !== undefined || filters.model !== undefined;

// A year or a range of years in an entry's Model Years text: "2020, 2022"
// lists two, "2018-2027" ten.
const MODEL_YEARS_PATTERN = "(\\d{4})(?:\\s*[-\u2013]\\s*(\\d{4}))?";

// The IDs of ready manuals that match every filter that's set, as a
// subquery for `id in (...)`, or null with no filters. Year and Model have
// to match the same model ("a 2020 RZR XP 1000"), not two different ones.
// Manuals that aren't in the model list never match a filter.
function manualsMatching(filters: LibraryFilters): SQL | null {
  const conditions: SQL[] = [];
  if (filters.brand !== undefined) conditions.push(sql`d.brand = ${filters.brand}`);
  const words = filters.model === undefined ? [] : modelFilterWords(filters.model);
  if (filters.year !== undefined || words.length > 0) {
    const model = [
      ...(filters.year === undefined ? [] : [sql`cm.model_year = ${filters.year}`]),
      ...words.map((word) => sql`cm.model_words like ${`% ${word}%`}`),
    ];
    const covered = sql`exists (
      select 1 from manual_catalog_models cm
      where cm.shop_id = d.shop_id and cm.file_key = d.file_key and ${sql.join(model, sql` and `)}
    )`;
    // Year alone: an entry with no dated models (a manual listed without
    // any) goes by its Model Years text instead.
    conditions.push(
      filters.year === undefined || words.length > 0
        ? covered
        : sql`(${covered} or (
            not exists (
              select 1 from manual_catalog_models cm
              where cm.shop_id = d.shop_id and cm.file_key = d.file_key and cm.model_year is not null
            )
            and exists (
              select 1 from regexp_matches(coalesce(d.model_years, ''), ${MODEL_YEARS_PATTERN}, 'g') r(m)
              where ${filters.year} between symmetric r.m[1]::int and coalesce(r.m[2], r.m[1])::int
            )
          ))`,
    );
  }
  if (conditions.length === 0) return null;
  return sql`(
    select fm.id from manuals fm
    join manual_catalog_documents d on d.shop_id = fm.shop_id and d.file_key = lower(fm.file_name)
    where fm.status = 'ready' and ${sql.join(conditions, sql` and `)}
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
      ${only ? sql`where manual_id in ${only}` : sql``}
      order by rank desc, manual_id, page_number
      limit ${limit}
    )
    -- Snippets are slow to build, so only for the pages that made the cut.
    select top.manual_id, coalesce(d.title, m.title) as title, d.brand, d.model_years,
      top.page_number, m.page_count, top.rank::float8 as rank,
      ts_headline('english', p.text, query.tsq, ${HEADLINE_OPTIONS}) as snippet
    from top
    join manual_pages p on p.manual_id = top.manual_id and p.page_number = top.page_number
    join manuals m on m.id = top.manual_id
    left join manual_catalog_documents d on d.shop_id = m.shop_id and d.file_key = lower(m.file_name)
    cross join query
    order by top.rank desc, coalesce(d.title, m.title), top.page_number
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
      brand: string | null;
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
    brand: row.brand,
    modelYears: row.model_years,
    pageNumber: row.page_number,
    pageCount: row.page_count,
    rank: row.rank,
    snippet: parseSnippet(row.snippet),
  }));
}

export type LibraryManual = {
  id: string;
  title: string;
  brand: string | null;
  modelYears: string | null;
  pageCount: number;
  pagesWithoutText: number;
};

// Selected from manuals left-joined to their model-list entry.
const libraryColumns = {
  id: manuals.id,
  title: manualDisplayTitle,
  brand: manualCatalogDocuments.brand,
  modelYears: manualCatalogDocuments.modelYears,
  pageCount: sql<number>`coalesce(${manuals.pageCount}, 0)`,
  pagesWithoutText: sql<number>`coalesce(${manuals.pagesWithoutText}, 0)`,
};

// The ready manuals, only those matching the filters if any are set.
export function listReadyManuals(shopId: string, filters: LibraryFilters = {}): Promise<LibraryManual[]> {
  const only = manualsMatching(filters);
  return withShop(shopId, (tx) =>
    tx
      .select(libraryColumns)
      .from(manuals)
      .leftJoin(manualCatalogDocuments, catalogEntryOfManual)
      .where(and(eq(manuals.status, "ready"), only ? sql`${manuals.id} in ${only}` : undefined))
      .orderBy(manualDisplayTitle, asc(manuals.id)),
  );
}

export type FilterOptions = {
  // Ready manuals in all.
  manuals: number;
  // Brands among ready manuals, with how many manuals each.
  brands: { brand: string; manuals: number }[];
  // Model years among ready manuals' models, newest first.
  years: number[];
};

// What the Library's filters can offer: only brands and years some ready
// manual has.
export function libraryFilterOptions(shopId: string): Promise<FilterOptions> {
  // One query at a time: a transaction's queries share one connection.
  return withShop(shopId, async (tx) => {
    const ready = eq(manuals.status, "ready");
    const [total] = await tx.select({ n: count() }).from(manuals).where(ready);
    const brands = await tx
      .select({ brand: sql<string>`${manualCatalogDocuments.brand}`, manuals: countDistinct(manuals.id) })
      .from(manuals)
      .innerJoin(manualCatalogDocuments, catalogEntryOfManual)
      .where(and(ready, isNotNull(manualCatalogDocuments.brand)))
      .groupBy(manualCatalogDocuments.brand)
      .orderBy(asc(manualCatalogDocuments.brand));
    const years = await tx
      .selectDistinct({ year: sql<number>`${manualCatalogModels.modelYear}` })
      .from(manuals)
      .innerJoin(manualCatalogDocuments, catalogEntryOfManual)
      .innerJoin(
        manualCatalogModels,
        and(
          eq(manualCatalogModels.shopId, manualCatalogDocuments.shopId),
          eq(manualCatalogModels.fileKey, manualCatalogDocuments.fileKey),
        ),
      )
      .where(and(ready, isNotNull(manualCatalogModels.modelYear)))
      .orderBy(desc(manualCatalogModels.modelYear));
    return { manuals: total.n, brands, years: years.map((row) => row.year) };
  });
}

// The ready manuals that cover a model number (exactly, whatever the case),
// by the model list: what the diagnosis assistant should read for a unit.
export async function manualsForModel(shopId: string, modelNumber: string): Promise<LibraryManual[]> {
  const number = cleanCatalogText(String(modelNumber ?? ""))?.toUpperCase();
  if (!number || number.length > CATALOG_LIMITS.modelNumber) return [];
  return withShop(shopId, (tx) =>
    tx
      .select(libraryColumns)
      .from(manuals)
      .innerJoin(manualCatalogDocuments, catalogEntryOfManual)
      .where(
        and(
          eq(manuals.status, "ready"),
          exists(
            tx
              .select({ one: sql`1` })
              .from(manualCatalogModels)
              .where(
                and(
                  eq(manualCatalogModels.shopId, manualCatalogDocuments.shopId),
                  eq(manualCatalogModels.fileKey, manualCatalogDocuments.fileKey),
                  eq(manualCatalogModels.modelNumber, number),
                ),
              ),
          ),
        ),
      )
      .orderBy(manualDisplayTitle, asc(manuals.id)),
  );
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
      .leftJoin(manualCatalogDocuments, catalogEntryOfManual)
      .where(and(eq(manuals.id, id), eq(manuals.status, "ready"))),
  );
  return row ?? null;
}
