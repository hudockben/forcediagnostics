import "server-only";

import { and, asc, eq, sql, type SQL } from "drizzle-orm";

import { withShop } from "@/db";
import { manualPages, manuals } from "@/db/schema";
import { DIAGNOSE_LIMITS, isUuid, unitLabel, type ScopeView, type UnitSuggestion, type VinPreview } from "@/lib/diagnose-rules";
import type { UnitVehicle } from "@/lib/diagnose-zones";
import {
  cleanSearchQuery,
  countMatchesElsewhere,
  isModelYearWord,
  likeEscape,
  modelFilterWords,
  modelWordsMatch,
  searchManuals,
  searchManualsWithMost,
  uuidArray,
  type SearchHit,
} from "@/lib/library";
import { manualDisplayTitle } from "@/lib/manual-catalog";
import { CATALOG_LIMITS, cleanCatalogText, isModelYear } from "@/lib/manual-catalog-rules";
import { specForUnit, type UnitSpec } from "@/lib/unit-vehicle";
import { cutText } from "@/lib/manual-rules";
import {
  checkVin,
  normalizeVin,
  sharedModelName,
  vinMatchesModelNumber,
  vinModelCode,
  vinModelNumberPatterns,
  vinYears,
} from "@/lib/vin";

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
  // Set when the model number (or the VIN's) is in the model list but no
  // manual for it is in the library (its PDF wasn't added, or isn't ready):
  // the model numbers found (a VIN can match several variants; number is
  // set only when it's one), and whether it was the VIN that found them.
  listed?: UnitModel & { numbers: string[]; byVin: boolean };
  // A VIN that was looked up (17 characters, upper case), and whether it
  // found the unit.
  vin?: { vin: string; found: boolean; checkDigitOk: boolean };
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

// Which machine a conversation's unit is: its kind of vehicle (for the
// drawing) and its line, seats, size and paint (for the 3D unit), from the
// model list's entries for its model number (brand codes, descriptions,
// the titles of the manuals listing it), the brand codes and titles of the
// manuals it's using, and the words in its name. See specForUnit.
export async function unitMachine(
  shopId: string,
  unit: { modelNumber: string | null; manualIds: string[] | null; label: string | null },
): Promise<{ vehicle: UnitVehicle | null; model: UnitSpec | null }> {
  if (!unit.modelNumber && !unit.manualIds?.length && !unit.label) return { vehicle: null, model: null };
  const facts = await withShop(shopId, async (tx) => {
    const byNumber = unit.modelNumber
      ? await tx.execute<{ brand: string | null; description: string | null; title: string | null }>(sql`
          select d.brand, cm.model_description as description, d.title from manual_catalog_models cm
          join manual_catalog_documents d on d.shop_id = cm.shop_id and d.file_key = cm.file_key
          where cm.model_number = ${unit.modelNumber.toUpperCase()}
          order by cm.model_year desc nulls last, cm.model_description
          limit 50
        `)
      : null;
    const byManual = unit.manualIds?.length
      ? await tx.execute<{ brand: string | null; title: string | null }>(sql`
          select distinct d.brand, d.title from manual_file_names n
          join manual_catalog_documents d on d.shop_id = n.shop_id and d.file_key = n.file_key
          where n.manual_id = any(${uuidArray(unit.manualIds)})
          limit 50
        `)
      : null;
    const values = <T,>(rows: (T | null)[] | undefined) => [...new Set((rows ?? []).filter((v): v is T => v !== null && v !== ""))];
    return {
      numberBrands: values(byNumber?.rows.map((row) => row.brand)),
      descriptions: values(byNumber?.rows.map((row) => row.description)),
      numberTitles: values(byNumber?.rows.map((row) => row.title)),
      manualBrands: values(byManual?.rows.map((row) => row.brand)),
      manualTitles: values(byManual?.rows.map((row) => row.title)),
      label: unit.label,
    };
  });
  const model = specForUnit(facts);
  return { vehicle: model?.vehicle ?? null, model };
}

// Which drawing a conversation's unit gets (see unitMachine).
export async function unitVehicle(
  shopId: string,
  unit: { modelNumber: string | null; manualIds: string[] | null; label: string | null },
): Promise<UnitVehicle | null> {
  return (await unitMachine(shopId, unit)).vehicle;
}

type ModelMatches = {
  // How many models match, and how many units (a year and model name) they are.
  count: number;
  units: number;
  // The ready manuals of every one of them.
  manualIds: string[];
  // The newest few, to show.
  shown: UnitModel[];
  // Every one's description, once each (up to 50).
  descriptions: string[];
};

const NO_MODELS: ModelMatches = { count: 0, units: 0, manualIds: [], shown: [], descriptions: [] };

// Models from the model list that meet the conditions (on cm) and have a
// ready manual. The manuals are every matching model's, not just those of
// the newest few shown: a name with no year matches hundreds of models over
// many years (a title naming two lines brings in all of both), and a scope
// of only the newest models' manuals would leave out the older units' while
// its label claims them all. One statement, so the model list is read once.
async function modelsWhere(shopId: string, conditions: SQL[]): Promise<ModelMatches> {
  const result = await withShop(shopId, (tx) =>
    tx.execute<{
      count: number;
      units: number;
      manual_ids: string[] | null;
      shown: UnitModel[] | null;
      descriptions: string[] | null;
    }>(sql`
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
        ) s) as shown,
        (select array_agg(d.description order by d.description) from (
          select distinct description from models where description is not null order by description limit 50
        ) d) as descriptions
    `),
  );
  const [row] = result.rows;
  return {
    count: row.count,
    units: row.units,
    manualIds: row.manual_ids ?? [],
    shown: row.shown ?? [],
    descriptions: row.descriptions ?? [],
  };
}

// Models in the model list, whether or not the shop has a manual for them:
// the entries that meet the condition (on cm), newest first, once each
// (a few, to name).
async function listedModels(shopId: string, condition: SQL) {
  const result = await withShop(shopId, (tx) =>
    tx.execute<{ year: number | null; number: string; description: string | null }>(sql`
      select distinct cm.model_year as year, cm.model_number as number, cm.model_description as description
      from manual_catalog_models cm
      where cm.model_number is not null and ${condition}
      order by cm.model_year desc nulls last, cm.model_number, cm.model_description
      limit ${MODELS_SHOWN}
    `),
  );
  return result.rows;
}

// Listed models as one unit: the model itself when they're one model
// number, or (a VIN's variants) the year and the name they share.
function asListed(rows: { year: number | null; number: string; description: string | null }[], byVin: boolean) {
  const numbers = [...new Set(rows.map((row) => row.number))];
  if (numbers.length === 1) return { year: rows[0].year, number: numbers[0], description: rows[0].description, numbers, byVin };
  return { year: rows[0].year, number: null, description: sharedModelName(rows.map((row) => row.description)), numbers, byVin };
}

// "R22RSH99AG, R22RSH99BG" (or the first few and "…").
const someNumbers = (numbers: string[], shown = 6) => `${numbers.slice(0, shown).join(", ")}${numbers.length > shown ? ", …" : ""}`;

const cleanModelNumber = (value: unknown) => {
  const number = cleanCatalogText(typeof value === "string" ? value : "")?.toUpperCase().replace(/\s+/g, "") ?? "";
  return number && number.length <= CATALOG_LIMITS.modelNumber ? number : "";
};

// find_unit_manuals: finds the unit in the shop's model list, by model
// number (exactly), by VIN (its model code and year: see src/lib/vin.ts),
// by the start of a model number, or by year and model name (words of the
// model's number or description or its manual's title, the way the
// Library's Model filter matches them). A "model number" that reads as a
// name ("2023 Sportsman 570", "RZR XP 1000") is looked up as one, and a VIN
// given as the model number as a VIN.
// When the manuals of every model it finds are few enough to be a narrowing
// (one unit, or at most a vehicle line), they become the conversation's
// scope.
export async function findUnitManuals(
  shopId: string,
  input: { model_number?: unknown; vin?: unknown; description?: unknown; year?: unknown },
): Promise<UnitLookup> {
  const rawNumber = cutText(cleanCatalogText(typeof input.model_number === "string" ? input.model_number : "") ?? "", 60);
  const rawVin = typeof input.vin === "string" ? cutText(input.vin, 40) : "";
  const numberIsVin = normalizeVin(rawVin) === "" && checkVin(rawNumber).status === "ok";
  const vinCheck = checkVin(numberIsVin ? rawNumber : rawVin);
  const vin = vinCheck.status === "ok" ? vinCheck : null;
  const number = numberIsVin ? "" : cleanModelNumber(rawNumber);
  // A model number is one word of letters and digits, with both in it.
  const isModelNumber = number !== "" && /\d/.test(number) && /[A-Z]/.test(number);
  const numberIsName = !numberIsVin && rawNumber !== "" && (/\s/.test(rawNumber) || !isModelNumber);
  const givenDescription = typeof input.description === "string" ? input.description : "";
  const description = cutText(cleanCatalogText(givenDescription.trim() || (numberIsName ? rawNumber : "")) ?? "", 60);
  const named = modelFilterWords(description);
  // A year in the name ("2019 RZR XP 1000") is the year asked for, which the
  // models' own years have to match, not a word their names or titles need;
  // when no year is given, the name's year is the year.
  const givenYear = isModelYear(Number(input.year)) ? Number(input.year) : null;
  const namedYear = named.find((word) => isModelYearWord(word) && isModelYear(Number(word)));
  const year = givenYear ?? (namedYear ? Number(namedYear) : null);
  const words = year === null ? named : named.filter((word) => word !== String(year));
  const vinProblem = vinCheck.status === "partial" || vinCheck.status === "invalid" ? `${vinCheck.message} ` : "";
  if (!isModelNumber && !vin && words.length === 0) {
    return {
      scope: null,
      result: {
        found: false,
        message: `${vinProblem}Give a model number (on the frame or VIN plate), the 17-character VIN, or a model name with or without the year.`,
      },
    };
  }

  const yearCondition = year === null ? [] : [sql`cm.model_year = ${year}`];
  let found: ModelMatches = NO_MODELS;
  let how = "";
  let byName = false;
  let byNumber = false;
  // The model year a VIN that found the unit means (character 10's code
  // repeats every 30 years: the model list says which).
  let vinYear: number | null = null;
  let vinTried = false;
  if (isModelNumber) {
    // A model number is one model of one year: a year given with it
    // (often the year the unit was sold) doesn't rule it out.
    found = await modelsWhere(shopId, [sql`cm.model_number = ${number}`]);
    how = `model number ${number}`;
    byNumber = found.count > 0;
  }
  if (found.count === 0 && vin) {
    vinTried = true;
    for (const candidate of vinModelNumberPatterns(vin.vin)) {
      const byVin = await modelsWhere(shopId, [sql`cm.model_number like ${candidate.pattern}`]);
      if (byVin.count > 0) {
        found = byVin;
        vinYear = candidate.year;
        how = `VIN ${vin.vin}`;
        break;
      }
    }
  }
  if (found.count === 0 && isModelNumber && !numberIsName && number.length >= 4) {
    found = await modelsWhere(shopId, [sql`cm.model_number like ${`${likeEscape(number)}%`}`, ...yearCondition]);
    how = `model numbers starting ${number}`;
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

  // What the VIN said, for Claude: its model code and year, and whether it
  // found the unit.
  const vinFacts = vin
    ? {
        vin: {
          vin: vin.vin,
          model_code: vinModelCode(vin.vin),
          model_year: vinYear ?? vinYears(vin.vin),
          check_digit_ok: vin.checkDigitOk,
        },
      }
    : {};
  const vinWarning = vin && !vin.checkDigitOk ? " The VIN's check digit doesn't match the rest, so a character may be off: confirm it with the tech." : "";
  const vinMissed =
    vin && vinTried && vinYear === null
      ? ` The VIN's model code ${vinModelCode(vin.vin)} (characters 4-8) with model year ${vinYears(vin.vin).join(" or ") || "unknown"} (character 10) doesn't match a model number in the shop's model list (whose characters 4-8 are that code and 2-3 the year).`
      : "";
  // The model number found the unit first: does the VIN agree with it?
  const vinAgrees =
    vin && byNumber
      ? vinMatchesModelNumber(vin.vin, number)
        ? ` The VIN agrees with model number ${number}.`
        : ` The VIN's model code ${vinModelCode(vin.vin)} and year (characters 4-8 and 10) don't agree with model number ${number} (characters 4-8 and 2-3), so one of them may be off: ask the tech.`
      : "";
  const vinResult = (found: boolean) => (vin ? { vin: { vin: vin.vin, found, checkDigitOk: vin.checkDigitOk } } : {});

  if (found.count === 0) {
    // In the model list, but with no manual in the library? The model
    // number typed, else the VIN's model numbers (all its variants: a VIN
    // can't tell them apart), for the first year that has any.
    let rows = isModelNumber ? await listedModels(shopId, sql`cm.model_number = ${number}`) : [];
    let listed = rows.length > 0 ? asListed(rows, false) : null;
    if (!listed && vin) {
      for (const candidate of vinModelNumberPatterns(vin.vin)) {
        rows = await listedModels(shopId, sql`cm.model_number like ${candidate.pattern}`);
        if (rows.length > 0) {
          listed = asListed(rows, true);
          break;
        }
      }
    }
    if (listed) {
      const name = [listed.year, listed.description].filter(Boolean).join(" ");
      const what = listed.byVin
        ? listed.number
          ? `The VIN matches ${listed.number}${name ? ` (${name})` : ""}, which is in the shop's model list, but the shop has no manual for it.`
          : `The VIN matches ${listed.numbers.length} models in the shop's model list (${someNumbers(listed.numbers)}: ${name}, variants a VIN can't tell apart), but the shop has no manual for them.`
        : `${listed.number}${name ? ` (${name})` : ""} is in the shop's model list, but the shop has no manual for it.`;
      return {
        scope: null,
        listed,
        ...vinResult(false),
        result: {
          found: true,
          narrowed: false,
          models: rows.map((row) => ({ model_number: row.number, year: row.year, description: row.description })),
          manuals_found: 0,
          ...vinFacts,
          message: `${what} Searches still use the same manuals as before. Look it up again by year and model name to use a closely related model's manuals, or work with the whole library and say so.${vinWarning}`,
        },
      };
    }
    const asked = [
      isModelNumber && !numberIsName && `model number ${number}`,
      description && `"${description}"`,
      year && `year ${year}`,
    ].filter(Boolean);
    return {
      scope: null,
      ...vinResult(false),
      result: {
        found: false,
        ...vinFacts,
        message: `${vinProblem}${asked.length > 0 ? `Nothing in the shop's model list matches ${asked.join(", ")}.` : "That doesn't identify the unit."}${vinMissed} Searches still use the same manuals as before. Ask the tech for the model number (on the frame or VIN plate), or work with the vehicle line or the whole library and say so.${vinWarning}`,
      },
    };
  }

  const titles = await manualTitles(shopId, found.manualIds);
  // One unit: one model (a year and name). A VIN found it only when it fits
  // one model number: a VIN can't tell variants apart, even ones listed
  // under the same name (A and B market versions), so it never picks one.
  const byVin = vinYear !== null;
  const oneUnit = byVin ? found.count === 1 : found.units === 1;
  const vinName = byVin ? [vinYear, sharedModelName(found.descriptions)].filter(Boolean).join(" ") : "";
  const label = oneUnit ? unitLabel(found.shown[0]) : byVin ? vinName : `${how} (${found.count} models)`;
  // A year given with a model number that the list has under another year.
  const otherYear =
    byNumber && givenYear !== null && found.shown[0]?.year !== null && found.shown[0]?.year !== givenYear
      ? ` The model list has ${number} as a ${found.shown[0].year} model, not ${givenYear}.`
      : "";
  const notes = `${otherYear}${vinAgrees}${vinMissed}${vinWarning}${vinProblem ? ` ${vinProblem.trim()}` : ""}`;
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
    ...vinFacts,
  };
  if (titles.length > DIAGNOSE_LIMITS.scopeManuals) {
    return {
      scope: null,
      ...vinResult(false),
      result: {
        found: true,
        narrowed: false,
        ...shown,
        message: `That matches ${titles.length} manuals, too many to narrow the search to. Searches still use the same manuals as before. Ask the tech for the model number${byName && year === null ? " or the year" : ""} to narrow it down.${notes}`,
      },
    };
  }
  const unit = oneUnit ? found.shown[0] : byVin ? { year: vinYear, number: null, description: sharedModelName(found.descriptions) } : null;
  const variants = someNumbers(found.shown.map((model) => model.number).filter((model): model is string => Boolean(model)));
  const manualsWord = titles.length === 1 ? "manual" : `${titles.length} manuals`;
  return {
    scope: { manualIds: titles.map((manual) => manual.id), label, unit },
    ...vinResult(vinYear !== null),
    result: {
      found: true,
      narrowed: true,
      unit: label,
      ...shown,
      message:
        vinYear !== null
          ? oneUnit
            ? `The VIN's model code and year match ${label} in the shop's list; searches and page reads now use the ${manualsWord} for it.${notes}`
            : `The VIN's model code and year match ${found.count} models in the shop's list (${variants}${found.count > found.shown.length ? `, ${found.count - found.shown.length} more` : ""}), variants of ${label} (a VIN doesn't give the paint, options or market, so it can't say which); searches and page reads now use their ${manualsWord}.${notes}`
          : oneUnit
            ? `Searches and page reads now use the ${manualsWord} for ${label}.${notes}`
            : `Several models match (${found.count}); searches and page reads now use their ${manualsWord}. If the tech can give the exact model number, look it up again.${notes}`,
    },
  };
}

const quoted = (words: string[]) => words.map((word) => (word.startsWith('"') ? word : `"${word}"`)).join(", ");

const searchResult = (hit: SearchHit, has?: string[]) => ({
  manual_id: hit.manualId,
  manual_title: hit.title,
  page: hit.pageNumber,
  page_count: hit.pageCount,
  snippet: hit.snippet.map((part) => part.text).join("").replace(/\s+/g, " ").trim(),
  ...(has ? { has_words: has } : {}),
});

// The scope's ready manuals with pages search can't find anything on
// (scanned pages OCR hasn't read, or found no words on), or the whole
// library's.
async function pagesWithoutText(shopId: string, manualIds: string[] | null) {
  const [row] = await withShop(shopId, (tx) =>
    tx
      .select({
        manuals: sql<number>`(count(*) filter (where ${manuals.pagesWithoutText} > 0))::int`,
        pages: sql<number>`coalesce(sum(${manuals.pagesWithoutText}), 0)::int`,
      })
      .from(manuals)
      .where(and(eq(manuals.status, "ready"), manualIds ? sql`${manuals.id} = any(${uuidArray(manualIds)})` : undefined)),
  );
  return row ?? { manuals: 0, pages: 0 };
}

// "1,234 pages" / "500 or more pages" / "1 page".
const pagesCounted = (count: { pages: number; capped: boolean }) =>
  count.capped ? `${count.pages.toLocaleString("en-US")} or more pages` : `${count.pages.toLocaleString("en-US")} ${count.pages === 1 ? "page" : "pages"}`;

// What's outside the manuals in use that matches: never the pages (the
// scope may be right, and they're other units'), only how many and where,
// and that they aren't confirmed for this unit (the scope may be wrong,
// too narrow, say, and leave the unit's own manual out).
// A count that stopped at its cap names some of the manuals, without their
// page counts (the pages it read first aren't a fair share).
function elsewhereNote(count: Awaited<ReturnType<typeof countMatchesElsewhere>>, what: "all" | "most") {
  const one = count.pages === 1 && !count.capped;
  const verb = `${one ? "has" : "have"} ${what === "all" ? "all of the words" : "most of these words"}`;
  const shown = count.manuals.slice(0, 5).map((manual) => (count.capped ? manual.title : `${manual.title} (${manual.pages})`));
  const more = count.manuals.length > 5 ? "; …" : "";
  const where = count.capped
    ? `in manuals including ${shown.join("; ")}${more}`
    : `in ${count.manuals.length === 1 ? "a manual" : `${count.manuals.length} manuals`}: ${shown.join("; ")}${more}`;
  return `Outside the manuals this conversation is using, ${pagesCounted(count)} in the shop's library ${verb}, ${where}. They aren't confirmed for this unit, so check one covers it before you take a spec from it; if the unit or its manuals are wrong, look it up again with find_unit_manuals.`;
}

// search_manual_pages: the library's full-text search, in the scope. When
// no page has every word, the pages with most of them (fault codes and part
// numbers first), saying so and naming any code none of them has; and
// whenever the scope has no page with every word, how many pages the rest
// of the library has with all of them (never the pages themselves: they
// aren't confirmed for this unit). When the scope has nothing at all, also
// how many have most of the words elsewhere, and whether the scope's
// manuals have pages search can't read.
export async function searchScopedPages(shopId: string, scope: ManualScope, query: unknown) {
  const q = cleanSearchQuery(typeof query === "string" ? query : "");
  if (!q) return { hits: [], result: { error: "The query is empty." } };
  const ids = scope.manualIds ?? undefined;
  const searched = scope.manualIds === null ? "the whole library" : `${scope.manualIds.length} manuals for ${scope.label ?? "this unit"}`;
  const hits = await searchManuals(shopId, q, {}, DIAGNOSE_LIMITS.searchHits, ids);
  if (hits.length > 0) return { hits, result: { query: q, searched, results: hits.map((hit) => searchResult(hit)) } };

  const [most, all] = await Promise.all([
    searchManualsWithMost(shopId, q, DIAGNOSE_LIMITS.searchHits, ids),
    scope.manualIds !== null ? countMatchesElsewhere(shopId, q, scope.manualIds) : null,
  ]);
  const allElsewhere = all && all.pages > 0 ? elsewhereNote(all, "all") : null;
  if (most.hits.length > 0) {
    // A code the search had that none of these pages has.
    const missing = most.codes.filter((code) => !most.hits.some((hit) => hit.has.includes(code)));
    return {
      hits: most.hits as SearchHit[],
      result: {
        query: q,
        searched,
        results: most.hits.map((hit) => searchResult(hit, hit.has)),
        message: [
          `No page in ${scope.manualIds === null ? "the library" : "the manuals this conversation is using"} has all of ${quoted(most.words)}; these have most of them (has_words says which)${
            missing.length > 0 ? `, and none of them has ${quoted(missing)}` : ""
          }. Check a page covers what you need before you rely on it, or search again with other words.`,
          ...(allElsewhere ? [allElsewhere] : []),
        ].join(" "),
      },
    };
  }

  const notes: string[] = [];
  if (scope.manualIds !== null) {
    const counted = all && all.pages > 0 ? null : await countMatchesElsewhere(shopId, q, scope.manualIds, { most: true });
    if (allElsewhere) notes.push(allElsewhere);
    else if (counted && counted.pages > 0) notes.push(elsewhereNote(counted, "most"));
    else notes.push("Nothing in the rest of the shop's library matches either.");
  }
  const unread = await pagesWithoutText(shopId, scope.manualIds);
  if (unread.pages > 0) {
    notes.push(
      `${
        scope.manualIds === null
          ? "The library has"
          : scope.manualIds.length === 1
            ? "This unit's manual has"
            : `${unread.manuals} of this unit's ${scope.manualIds.length} manuals ${unread.manuals === 1 ? "has" : "have"}`
      } ${unread.pages} ${unread.pages === 1 ? "page" : "pages"} with no searchable text (scanned pages the library hasn't read yet, or pictures), which no search can find; the tech can open them in the Library.`,
    );
  }
  return {
    hits: [],
    result: {
      query: q,
      searched,
      results: [],
      message: ["No pages match.", ...notes, "Try fewer or different words, the code alone, or how a manual would name the test."].join(" "),
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

// What a VIN finds, for the quick form to say before the diagnosis starts
// (see VinPreview). Null for what isn't a VIN.
export async function previewVin(shopId: string, text: string): Promise<VinPreview | null> {
  const check = checkVin(cutText(String(text ?? ""), 40));
  if (check.status !== "ok") return null;
  const lookup = await findUnitManuals(shopId, { vin: check.vin });
  if (lookup.scope) {
    return {
      status: "found",
      label: lookup.scope.label ?? "",
      models: Number(lookup.result.models_found) || 1,
      manuals: lookup.scope.manualIds.length,
    };
  }
  if (lookup.listed) return { status: "listed", label: unitLabel(lookup.listed), models: lookup.listed.numbers.length };
  if (lookup.result.found === true) {
    return { status: "many", models: Number(lookup.result.models_found) || 0, manuals: Number(lookup.result.manuals_found) || 0 };
  }
  return { status: "none" };
}
