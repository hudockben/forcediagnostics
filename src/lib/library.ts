import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { withShop } from "@/db";
import { manuals } from "@/db/schema";
import { SNIPPET_START, SNIPPET_STOP, parseSnippet, type SnippetPart } from "@/lib/manual-rules";
import { isManualId } from "@/lib/manuals";

// Reading the shop's manual library: full-text search over page text and
// the manuals for the viewer. Callers must check library.read first.

export const SEARCH_LIMIT = 50;
export const MAX_QUERY_LENGTH = 200;

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
  pageNumber: number;
  pageCount: number;
  rank: number;
  snippet: SnippetPart[];
};

// What a search box sends, tidied for Postgres: no NULs (text parameters
// can't hold them, so a query like ?q=%00 would fail), trimmed and capped.
export function cleanSearchQuery(query: string) {
  return query.replace(/\u0000/g, "").trim().slice(0, MAX_QUERY_LENGTH);
}

// The search itself, apart from searchManuals so tests can check its plan.
// Matches come from ready_manual_pages rather than manual_pages: under
// row-level security the GIN index can't be used and every search would read
// every page (see drizzle/0010_manual_search.sql). Run it inside withShop.
export function searchQuery(q: string, limit: number) {
  return sql`
    with query as (select websearch_to_tsquery('english', ${q}) as tsq),
    top as materialized (
      select v.manual_id, v.page_number,
        ts_rank_cd(v.search_vector, query.tsq, 1) as rank
      from ready_manual_pages v
      cross join query
      where v.search_vector @@ query.tsq
      order by rank desc, v.manual_id, v.page_number
      limit ${limit}
    )
    -- Snippets are slow to build, so only for the pages that made the cut.
    select top.manual_id, m.title, top.page_number, m.page_count, top.rank::float8 as rank,
      ts_headline('english', p.text, query.tsq, ${HEADLINE_OPTIONS}) as snippet
    from top
    join manual_pages p on p.manual_id = top.manual_id and p.page_number = top.page_number
    join manuals m on m.id = top.manual_id
    cross join query
    order by top.rank desc, m.title, top.page_number
  `;
}

// Searches ready manuals. Supports what people type into web search: plain
// words (all must match), "quoted phrases", OR, and -excluded words.
export async function searchManuals(
  shopId: string,
  query: string,
  limit = SEARCH_LIMIT,
): Promise<SearchHit[]> {
  const q = cleanSearchQuery(query);
  if (!q) return [];
  const result = await withShop(shopId, (tx) =>
    tx.execute<{
      manual_id: string;
      title: string;
      page_number: number;
      page_count: number;
      rank: number;
      snippet: string;
    }>(searchQuery(q, limit)),
  );
  return result.rows.map((row) => ({
    manualId: row.manual_id,
    title: row.title,
    pageNumber: row.page_number,
    pageCount: row.page_count,
    rank: row.rank,
    snippet: parseSnippet(row.snippet),
  }));
}

export type LibraryManual = {
  id: string;
  title: string;
  pageCount: number;
  pagesWithoutText: number;
};

const libraryColumns = {
  id: manuals.id,
  title: manuals.title,
  pageCount: sql<number>`coalesce(${manuals.pageCount}, 0)`,
  pagesWithoutText: sql<number>`coalesce(${manuals.pagesWithoutText}, 0)`,
};

export function listReadyManuals(shopId: string): Promise<LibraryManual[]> {
  return withShop(shopId, (tx) =>
    tx
      .select(libraryColumns)
      .from(manuals)
      .where(eq(manuals.status, "ready"))
      .orderBy(asc(manuals.title)),
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
      .where(and(eq(manuals.id, id), eq(manuals.status, "ready"))),
  );
  return row ?? null;
}
