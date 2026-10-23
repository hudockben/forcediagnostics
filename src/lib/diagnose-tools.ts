import "server-only";

import { and, asc, eq, sql, type SQL } from "drizzle-orm";

import { withShop } from "@/db";
import { manualPages, manuals } from "@/db/schema";
import { DIAGNOSE_LIMITS, isUuid, unitLabel, type ScopeView, type UnitSuggestion } from "@/lib/diagnose-rules";
import type { UnitVehicle } from "@/lib/diagnose-zones";
import {
  cleanSearchQuery,
  isModelYearWord,
  likeEscape,
  modelFilterWords,
  modelWordsMatch,
  searchManuals,
  uuidArray,
} from "@/lib/library";
import { manualDisplayTitle } from "@/lib/manual-catalog";
import { CATALOG_LIMITS, cleanCatalogText, isModelYear } from "@/lib/manual-catalog-rules";
import { chooseVehicle, vehicleForUnit } from "@/lib/unit-vehicle";
import { cutText } from "@/lib/manual-rules";

// What Claude's tools can reach in the shop's library, for Diagnose. Every
// function runs inside withShop, so only the shop's own manuals are visible,
// and only ready ones; on top of that the conversation's scope (the unit's
// manuals) limits searches and page reads. These limits are in code, not in
// the prompt: a manual outside them can't be read whatever Claude asks for.

// The manuals a conversation may use. Null: the whole library.
export type ManualScope = { manualIds: string[] | null; label: string | null };

export type UnitModel = { year: number | null; number: string | null; description: string | null };

export type UnitLookup = {
  // Set when the lookup found the unit's manuals: the scope to use from now on.
  scope: (ManualScope & { manualIds: string[]; unit: UnitModel | null }) | null;
  // Set when the model number is in the model list but no manual for it is
  // in the library (its PDF wasn't added, or isn't ready).
  listed?: UnitModel & { number: string };
  // What Claude gets back.
  result: Record<string, unknown>;
};

const MODELS_SHOWN = 10;
const MANUALS_SHOWN = 12;

// Ready manuals' display titles, by ID, in the order given.
async function manualTitles(shopId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await withShop(shopId, (tx) =>
    tx
      .select({ id: manuals.id, title: manualDisplayTitle, pageCount: manuals.pageCount })
      .from(manuals)
      .where(and(eq(manuals.status, "ready"), sql`${manuals.id} = any(${uuidArray(ids)})`))
      .orderBy(manualDisplayTitle, asc(manuals.id)),
  );
  return rows.map((row) => ({ id: row.id, title: row.title, pageCount: row.pageCount ?? 0 }));
}

// The scope as the screen shows it: "Using 3 manuals for …".
export async function describeScope(shopId: string, scope: ManualScope): Promise<ScopeView> {
  if (scope.manualIds === null) return { label: null, manuals: [] };
  const titles = await manualTitles(shopId, scope.manualIds);
  return { label: scope.label, manuals: titles.map(({ id, title }) => ({ id, title })) };
}

// Which drawing a conversation's unit gets: the model list's brand codes
// for its model number (RZR, RGR, ATV, GEN, ...); when those don't decide
// it, the codes of the manuals it's using; failing that, the words in its
// name.
export async function unitVehicle(
  shopId: string,
  unit: { modelNumber: string | null; manualIds: string[] | null; label: string | null },
): Promise<UnitVehicle | null> {
  if (!unit.modelNumber && !unit.manualIds?.length && !unit.label) return null;
  const { byNumber, byManual } = await withShop(shopId, async (tx) => {
    const byNumber = unit.modelNumber
      ? await tx.execute<{ brand: string }>(sql`
          select distinct d.brand from manual_catalog_models cm
          join manual_catalog_documents d on d.shop_id = cm.shop_id and d.file_key = cm.file_key
          where cm.model_number = ${unit.modelNumber.toUpperCase()} and d.brand is not null
        `)
      : null;
    const numberBrands = byNumber?.rows.map((row) => row.brand) ?? [];
    // The model number's brands decide it: no need to look at the manuals.
    if (chooseVehicle({ brands: numberBrands, label: null })) return { byNumber: numberBrands, byManual: [] };
    const byManual = unit.manualIds?.length
      ? await tx.execute<{ brand: string }>(sql`
          select distinct d.brand from manual_file_names n
          join manual_catalog_documents d on d.shop_id = n.shop_id and d.file_key = n.file_key
          where n.manual_id = any(${uuidArray(unit.manualIds)}) and d.brand is not null
        `)
      : null;
    return { byNumber: numberBrands, byManual: byManual?.rows.map((row) => row.brand) ?? [] };
  });
  return vehicleForUnit({ numberBrands: byNumber, manualBrands: byManual, label: unit.label });
}

type ModelMatches = {
  // How many models match, and how many units (a year and model name) they are.
  count: number;
  units: number;
  // The ready manuals of every one of them.
  manualIds: string[];
  // The newest few, to show.
  shown: UnitModel[];
};

// Models from the model list that meet the conditions (on cm) and have a
// ready manual. The manuals are every matching model's, not just those of
// the newest few shown: a name with no year matches hundreds of models over
// many years (a title naming two lines brings in all of both), and a scope
// of only the newest models' manuals would leave out the older units' while
// its label claims them all. One statement, so the model list is read once.
async function modelsWhere(shopId: string, conditions: SQL[]): Promise<ModelMatches> {
  const result = await withShop(shopId, (tx) =>
    tx.execute<{ count: number; units: number; manual_ids: string[] | null; shown: UnitModel[] | null }>(sql`
      with found as materialized (
        select cm.model_year as year, cm.model_number as number, cm.model_description as description, n.manual_id
        from manual_catalog_models cm
        join manual_file_names n on n.shop_id = cm.shop_id and n.file_key = cm.file_key
        join manuals m on m.id = n.manual_id and m.shop_id = n.shop_id and m.status = 'ready'
        where ${sql.join(conditions, sql` and `)}
      ),
      models as (select distinct year, number, description from found)
      select
        (select count(*) from models)::int as count,
        (select count(distinct (year, description)) from models)::int as units,
        (select array_agg(distinct manual_id) from found) as manual_ids,
        (select json_agg(s order by s.year desc nulls last, s.number, s.description) from (
          select * from models order by year desc nulls last, number, description limit ${MODELS_SHOWN}
        ) s) as shown
    `),
  );
  const [row] = result.rows;
  return { count: row.count, units: row.units, manualIds: row.manual_ids ?? [], shown: row.shown ?? [] };
}

// A model number in the model list, whether or not the shop has a manual for
// it: the newest entry.
async function listedModel(shopId: string, number: string, conditions: SQL[]) {
  const result = await withShop(shopId, (tx) =>
    tx.execute<{ year: number | null; description: string | null }>(sql`
      select cm.model_year as year, cm.model_description as description
      from manual_catalog_models cm
      where ${sql.join([sql`cm.model_number = ${number}`, ...conditions], sql` and `)}
      order by cm.model_year desc nulls last, cm.model_description
      limit 1
    `),
  );
  const [row] = result.rows;
  return row ? { year: row.year, number, description: row.description } : null;
}

const cleanModelNumber = (value: unknown) => {
  const number = cleanCatalogText(typeof value === "string" ? value : "")?.toUpperCase().replace(/\s+/g, "") ?? "";
  return number && number.length <= CATALOG_LIMITS.modelNumber ? number : "";
};

// find_unit_manuals: finds the unit in the shop's model list, by model
// number (exactly, or failing that its start), or by year and model name
// (words of the model's number or description or its manual's title, the
// way the Library's Model filter matches them).
// When the manuals of every model it finds are few enough to be a narrowing
// (one unit, or at most a vehicle line), they become the conversation's
// scope.
export async function findUnitManuals(
  shopId: string,
  input: { model_number?: unknown; description?: unknown; year?: unknown },
): Promise<UnitLookup> {
  const number = cleanModelNumber(input.model_number);
  const description = cutText(cleanCatalogText(typeof input.description === "string" ? input.description : "") ?? "", 60);
  const named = modelFilterWords(description);
  // A year in the name ("2019 RZR XP 1000") is the year asked for, which the
  // models' own years have to match, not a word their names or titles need;
  // when no year is given, the name's year is the year.
  const givenYear = isModelYear(Number(input.year)) ? Number(input.year) : null;
  const namedYear = named.find((word) => isModelYearWord(word) && isModelYear(Number(word)));
  const year = givenYear ?? (namedYear ? Number(namedYear) : null);
  const words = year === null ? named : named.filter((word) => word !== String(year));
  if (!number && words.length === 0) {
    return {
      scope: null,
      result: {
        found: false,
        message: "Give a model number (on the frame or VIN plate), or a model name with or without the year.",
      },
    };
  }

  const yearCondition = year === null ? [] : [sql`cm.model_year = ${year}`];
  let found: ModelMatches = { count: 0, units: 0, manualIds: [], shown: [] };
  let how = "";
  let byName = false;
  if (number) {
    found = await modelsWhere(shopId, [sql`cm.model_number = ${number}`, ...yearCondition]);
    how = `model number ${number}`;
    if (found.count === 0 && number.length >= 4) {
      found = await modelsWhere(shopId, [sql`cm.model_number like ${`${likeEscape(number)}%`}`, ...yearCondition]);
      how = `model numbers starting ${number}`;
    }
  }
  if (found.count === 0 && words.length > 0) {
    // With a year, the models whose own names have the words are the unit
    // ("2018 RZR S 1000" is one model); a title that has them ("2017-2020
    // RZR 900 / S 900 / S 1000 / S4 1000") only counts when none does, as
    // for older models whose names Polaris shortened. Without a year, both,
    // so a line's older manuals aren't left out.
    if (year !== null) found = await modelsWhere(shopId, [modelWordsMatch(words, { titles: false }), ...yearCondition]);
    if (found.count === 0) found = await modelsWhere(shopId, [modelWordsMatch(words), ...yearCondition]);
    // Not "2019 2019 RZR XP 1000" when the description has the year already.
    how = words.length < named.length ? description : [year, description].filter(Boolean).join(" ");
    byName = true;
  }

  const listed = found.count === 0 && number ? await listedModel(shopId, number, yearCondition) : null;
  if (listed) {
    const name = [listed.year, listed.description].filter(Boolean).join(" ");
    return {
      scope: null,
      listed,
      result: {
        found: true,
        narrowed: false,
        models: [{ model_number: listed.number, year: listed.year, description: listed.description }],
        manuals_found: 0,
        message: `${listed.number}${name ? ` (${name})` : ""} is in the shop's model list, but the shop has no manual for it. Searches still use the same manuals as before. Look it up again by year and model name to use a closely related model's manuals, or work with the whole library and say so.`,
      },
    };
  }
  if (found.count === 0) {
    return {
      scope: null,
      result: {
        found: false,
        message: `Nothing in the shop's model list matches ${[number && `model number ${number}`, description && `"${description}"`, year && `year ${year}`].filter(Boolean).join(", ")}. Searches still use the same manuals as before. Ask the tech for the model number (on the frame or VIN plate), or work with the vehicle line or the whole library and say so.`,
      },
    };
  }

  const titles = await manualTitles(shopId, found.manualIds);
  const oneUnit = found.units === 1;
  const label = oneUnit ? unitLabel(found.shown[0]) : `${how} (${found.count} models)`;
  const shown = {
    models: found.shown.map((model) => ({
      model_number: model.number,
      year: model.year,
      description: model.description,
    })),
    models_found: found.count,
    manuals: titles.slice(0, MANUALS_SHOWN).map((manual) => ({
      manual_id: manual.id,
      title: manual.title,
      pages: manual.pageCount,
    })),
    manuals_found: titles.length,
  };
  if (titles.length > DIAGNOSE_LIMITS.scopeManuals) {
    return {
      scope: null,
      result: {
        found: true,
        narrowed: false,
        ...shown,
        message: `That matches ${titles.length} manuals, too many to narrow the search to. Searches still use the same manuals as before. Ask the tech for the model number${byName && year === null ? " or the year" : ""} to narrow it down.`,
      },
    };
  }
  return {
    scope: { manualIds: titles.map((manual) => manual.id), label, unit: oneUnit ? found.shown[0] : null },
    result: {
      found: true,
      narrowed: true,
      unit: label,
      ...shown,
      message: oneUnit
        ? `Searches and page reads now use the ${titles.length === 1 ? "manual" : `${titles.length} manuals`} for ${label}.`
        : `Several models match (${found.count}); searches and page reads now use their ${titles.length} manuals. If the tech can give the exact model number, look it up again.`,
    },
  };
}

// search_manual_pages: the library's full-text search, in the scope.
export async function searchScopedPages(shopId: string, scope: ManualScope, query: unknown) {
  const q = cleanSearchQuery(typeof query === "string" ? query : "");
  if (!q) return { hits: [], result: { error: "The query is empty." } };
  const hits = await searchManuals(shopId, q, {}, DIAGNOSE_LIMITS.searchHits, scope.manualIds ?? undefined);
  return {
    hits,
    result: {
      query: q,
      searched: scope.manualIds === null ? "the whole library" : `${scope.manualIds.length} manuals for ${scope.label ?? "this unit"}`,
      results: hits.map((hit) => ({
        manual_id: hit.manualId,
        manual_title: hit.title,
        page: hit.pageNumber,
        page_count: hit.pageCount,
        snippet: hit.snippet.map((part) => part.text).join("").replace(/\s+/g, " ").trim(),
      })),
      ...(hits.length === 0
        ? { message: "No pages match. Try fewer or different words, the code alone, or how a manual would name the test." }
        : {}),
    },
  };
}

export type PageRead =
  | { ok: true; manualId: string; page: number; title: string; result: Record<string, unknown> }
  | { ok: false; result: Record<string, unknown> };

// read_manual_page: one page's text, only from a ready manual of the shop in
// the scope, and only a page it has.
export async function readScopedPage(
  shopId: string,
  scope: ManualScope,
  input: { manual_id?: unknown; page?: unknown },
): Promise<PageRead> {
  const manualId = input.manual_id;
  const page = Number(input.page);
  if (!isUuid(manualId)) return { ok: false, result: { error: "manual_id isn't a manual ID from search_manual_pages." } };
  if (!Number.isInteger(page) || page < 1) return { ok: false, result: { error: "page must be a whole number from 1." } };
  if (scope.manualIds !== null && !scope.manualIds.some((id) => id.toLowerCase() === manualId.toLowerCase())) {
    return {
      ok: false,
      result: {
        error: `That manual isn't one of the manuals this conversation is using (${scope.label ?? "the unit's manuals"}). Use find_unit_manuals if the unit is different.`,
      },
    };
  }
  const found = await withShop(shopId, async (tx) => {
    const [manual] = await tx
      .select({ id: manuals.id, title: manualDisplayTitle, pageCount: manuals.pageCount })
      .from(manuals)
      .where(and(eq(manuals.id, manualId), eq(manuals.status, "ready")));
    if (!manual) return null;
    if (page > (manual.pageCount ?? 0)) return { manual, text: null };
    const [row] = await tx
      .select({ text: manualPages.text })
      .from(manualPages)
      .where(and(eq(manualPages.manualId, manual.id), eq(manualPages.pageNumber, page)));
    return { manual, text: row?.text ?? "" };
  });
  if (!found) return { ok: false, result: { error: "There's no such manual in this shop's library." } };
  const { manual, text } = found;
  const pageCount = manual.pageCount ?? 0;
  if (text === null) {
    return { ok: false, result: { error: `Page ${page} is past the end: ${manual.title} has ${pageCount} pages.` } };
  }
  const cut = cutText(text, DIAGNOSE_LIMITS.pageTextCharacters);
  return {
    ok: true,
    manualId: manual.id,
    page,
    title: manual.title,
    result: {
      manual_id: manual.id,
      manual_title: manual.title,
      page,
      page_count: pageCount,
      text: cut || "(This page has no text the library could read, probably a scanned image or a diagram. The tech can open it in the Library to look at it.)",
      ...(cut.length < text.length
        ? { note: `The page is longer; this is its first ${DIAGNOSE_LIMITS.pageTextCharacters.toLocaleString("en-US")} characters.` }
        : {}),
    },
  };
}

// Suggestions for the quick form's model number box: models that start with
// what's typed, or whose names have words starting with each word typed,
// and that have a ready manual. Exact matches first, then newest.
export async function suggestUnits(shopId: string, query: string): Promise<UnitSuggestion[]> {
  const typed = cutText(cleanCatalogText(String(query ?? "")) ?? "", 60);
  const words = modelFilterWords(typed);
  if (words.length === 0) return [];
  const number = words.length === 1 ? words[0] : "";
  const byWords = sql.join(
    words.map((word) => sql`cm.model_words like ${`% ${likeEscape(word)}%`}`),
    sql` and `,
  );
  const result = await withShop(shopId, (tx) =>
    tx.execute<{ number: string; year: number | null; description: string | null; manuals: number }>(sql`
      select cm.model_number as number, cm.model_year as year, cm.model_description as description,
        count(distinct n.manual_id)::int as manuals
      from manual_catalog_models cm
      join manual_file_names n on n.shop_id = cm.shop_id and n.file_key = cm.file_key
      join manuals m on m.id = n.manual_id and m.shop_id = n.shop_id and m.status = 'ready'
      where cm.model_number is not null
        and (${number ? sql`cm.model_number like ${`${likeEscape(number)}%`} or ` : sql``}(${byWords}))
      group by 1, 2, 3
      order by (cm.model_number = ${number}) desc, cm.model_year desc nulls last, cm.model_number
      limit 8
    `),
  );
  return result.rows.map((row) => ({
    modelNumber: row.number,
    year: row.year,
    description: row.description,
    label: unitLabel(row),
    manuals: row.manuals,
  }));
}
