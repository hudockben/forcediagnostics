import "server-only";

import { and, asc, count, eq, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { auditLog, manualCatalogDocuments, manualCatalogModels, manuals } from "@/db/schema";
import {
  CATALOG_LIMITS,
  MAX_CATALOG_FILES_PER_BATCH,
  MAX_CATALOG_MODELS_PER_BATCH,
  brandWords,
  catalogKey,
  cleanCatalogText,
  inferBrands,
  normalizeCatalogFile,
  type CatalogFile,
} from "@/lib/manual-catalog-rules";
import type { CurrentUser } from "@/lib/session";

// The shop's model list (System Admin > Manuals): which models each manual
// covers, by file name. The browser reads the CSV and sends it in batches:
//
//   save   -> each batch replaces its files' entries and models
//   finish -> fills in blank brands from the rest of the list, records the import
//
// Entries are kept by file name, apart from manuals, so the list can come
// before or after the PDFs. Callers must check settings.manage first; every
// function here also limits itself to the acting admin's shop.

type Problem = { error: string };

export type CatalogSaveResult = { saved: number; models: number } | Problem;
export type CatalogFinishResult = { manuals: number; models: number; brandsInferred: number } | Problem;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODELS_PER_INSERT = 1000;

const unsaved = { error: "That part of the model list couldn't be saved. Import it again." };

// A manual's model-list entry, for joins from manuals: same shop, same file
// name whatever the case.
export const catalogEntryOfManual = and(
  eq(manualCatalogDocuments.shopId, manuals.shopId),
  eq(manualCatalogDocuments.fileKey, sql`lower(${manuals.fileName})`),
);

// What a manual is called in the app: Polaris's subject line from the model
// list when there is one ("2027 RZR Pro R Boost / Pro R Boost 4"), which says
// far more than its file name ("9942508").
export const manualDisplayTitle = sql<string>`coalesce(${manualCatalogDocuments.title}, ${manuals.title})`;

// One import at a time per shop, so two tabs can't interleave their writes.
async function lockCatalog(tx: ShopTransaction, shopId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('manual_catalog'), hashtext(${shopId}))`);
}

// Saves a batch of entries. Each file's entry and models replace whatever an
// earlier import saved for that file, in one transaction, so importing the
// same list again changes nothing and a later list wins.
export async function saveCatalogBatch(
  actor: CurrentUser,
  input: { importId: string; files: unknown },
): Promise<CatalogSaveResult> {
  const { importId, files } = input;
  if (!UUID_PATTERN.test(importId)) return unsaved;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_CATALOG_FILES_PER_BATCH) return unsaved;
  const entries: CatalogFile[] = [];
  const keys = new Set<string>();
  let modelCount = 0;
  for (const value of files) {
    const result = normalizeCatalogFile(value);
    if ("problem" in result) {
      const named = (value as { fileName?: unknown } | null)?.fileName;
      const name = typeof named === "string" ? named.slice(0, CATALOG_LIMITS.fileName) : "An entry";
      return { error: `${name}: ${result.problem}` };
    }
    const key = catalogKey(result.file.fileName);
    if (keys.has(key)) return { error: `${result.file.fileName} is in this batch twice.` };
    keys.add(key);
    entries.push(result.file);
    modelCount += result.file.models.length;
  }
  if (modelCount > MAX_CATALOG_MODELS_PER_BATCH) return unsaved;

  const shopId = actor.shop.id;
  return withShop(shopId, async (tx) => {
    await lockCatalog(tx, shopId);
    // Their models go with them (on delete cascade).
    const fileKeys = sql.join(
      entries.map((entry) => sql`lower(${entry.fileName})`),
      sql`, `,
    );
    await tx.delete(manualCatalogDocuments).where(sql`${manualCatalogDocuments.fileKey} in (${fileKeys})`);
    const written = await tx
      .insert(manualCatalogDocuments)
      .values(
        entries.map((entry) => ({
          // Always the admin's own shop, never anything from the browser.
          shopId,
          fileName: entry.fileName,
          brand: entry.brand,
          article: entry.article,
          title: entry.title,
          postedOn: entry.postedOn,
          modelYears: entry.modelYears,
          importId,
        })),
      )
      .returning({ fileName: manualCatalogDocuments.fileName, fileKey: manualCatalogDocuments.fileKey });
    // The keys Postgres worked out, so models point at exactly those rows.
    const keyByName = new Map(written.map((row) => [row.fileName, row.fileKey]));
    const rows = entries.flatMap((entry) =>
      entry.models.map(([modelYear, modelNumber, modelDescription]) => ({
        shopId,
        fileKey: keyByName.get(entry.fileName)!,
        modelYear,
        modelNumber,
        modelDescription,
      })),
    );
    for (let at = 0; at < rows.length; at += MODELS_PER_INSERT) {
      await tx.insert(manualCatalogModels).values(rows.slice(at, at + MODELS_PER_INSERT));
    }
    return { saved: entries.length, models: rows.length };
  });
}

// Works out the brand of every entry the model list left blank, from the
// whole shop's list as it now stands (see inferBrands). Returns how many
// entries changed.
async function fillInBrands(tx: ShopTransaction) {
  const entries = await tx
    .select({
      key: manualCatalogDocuments.fileKey,
      brand: manualCatalogDocuments.brand,
      inferred: manualCatalogDocuments.inferredBrand,
      title: manualCatalogDocuments.title,
    })
    .from(manualCatalogDocuments);
  const letters = await tx
    .select({
      key: manualCatalogModels.fileKey,
      letter: sql<string>`left(${manualCatalogModels.modelNumber}, 1)`,
      models: sql<number>`count(*)::int`,
    })
    .from(manualCatalogModels)
    .where(isNotNull(manualCatalogModels.modelNumber))
    .groupBy(manualCatalogModels.fileKey, sql`2`);
  const lettersByKey = new Map<string, Record<string, number>>();
  for (const { key, letter, models } of letters) {
    const counts = lettersByKey.get(key) ?? {};
    counts[letter] = models;
    lettersByKey.set(key, counts);
  }
  const descriptions = await tx
    .selectDistinct({ key: manualCatalogModels.fileKey, description: manualCatalogModels.modelDescription })
    .from(manualCatalogModels)
    .where(isNotNull(manualCatalogModels.modelDescription));
  const descriptionsByKey = new Map<string, string[]>();
  for (const { key, description } of descriptions) {
    descriptionsByKey.set(key, [...(descriptionsByKey.get(key) ?? []), description ?? ""]);
  }
  const inferred = inferBrands(
    entries.map((entry) => ({
      key: entry.key,
      // A brand filled in last time is worked out again from scratch.
      brand: entry.inferred ? null : entry.brand,
      words: brandWords(entry.title, ...(descriptionsByKey.get(entry.key) ?? [])),
      firstLetters: lettersByKey.get(entry.key) ?? {},
    })),
  );

  // Changes, grouped by the brand they get (null: back to blank).
  const changes = new Map<string | null, string[]>();
  for (const entry of entries) {
    if (entry.brand && !entry.inferred) continue;
    const brand = inferred.get(entry.key) ?? null;
    if (brand === entry.brand) continue;
    changes.set(brand, [...(changes.get(brand) ?? []), entry.key]);
  }
  for (const [brand, keys] of changes) {
    await tx
      .update(manualCatalogDocuments)
      .set({ brand, inferredBrand: brand !== null })
      .where(inArray(manualCatalogDocuments.fileKey, keys));
  }
  return [...changes.values()].reduce((total, keys) => total + keys.length, 0);
}

// After the last batch: fills in blank brands and records the import once.
export async function finishCatalogImport(
  actor: CurrentUser,
  input: { importId: string; fileName: string; leftOut: number; rowsWithoutFile: number },
): Promise<CatalogFinishResult> {
  const { importId } = input;
  if (!UUID_PATTERN.test(importId)) return unsaved;
  const fileName = cleanCatalogText(String(input.fileName ?? ""))?.slice(0, CATALOG_LIMITS.fileName) ?? "";
  const tally = (value: number) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

  const shopId = actor.shop.id;
  return withShop(shopId, async (tx): Promise<CatalogFinishResult> => {
    await lockCatalog(tx, shopId);
    await fillInBrands(tx);

    const [entries] = await tx
      .select({
        manuals: count(),
        brandsInferred: sql<number>`(count(*) filter (where ${manualCatalogDocuments.inferredBrand}))::int`,
      })
      .from(manualCatalogDocuments)
      .where(eq(manualCatalogDocuments.importId, importId));
    const [models] = await tx
      .select({ models: count() })
      .from(manualCatalogModels)
      .innerJoin(
        manualCatalogDocuments,
        and(
          eq(manualCatalogDocuments.shopId, manualCatalogModels.shopId),
          eq(manualCatalogDocuments.fileKey, manualCatalogModels.fileKey),
        ),
      )
      .where(eq(manualCatalogDocuments.importId, importId));
    const result = { manuals: entries.manuals, models: models.models, brandsInferred: entries.brandsInferred };

    // A retried finish doesn't record the import twice.
    const [recorded] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "manual_catalog.imported"), eq(auditLog.targetId, importId)));
    if (!recorded) {
      await tx.insert(auditLog).values({
        shopId,
        actorUserId: actor.id,
        action: "manual_catalog.imported",
        targetType: "manual_catalog",
        targetId: importId,
        details: {
          fileName,
          ...result,
          leftOut: tally(input.leftOut),
          rowsWithoutFile: tally(input.rowsWithoutFile),
        },
      });
    }
    return result;
  });
}

export type CatalogSummary = {
  // Manuals added (or being added), with or without an entry.
  manuals: number;
  entries: number;
  models: number;
  lastImportedAt: Date | null;
  // Manuals whose file name isn't in the model list.
  notListed: { id: string; title: string; fileName: string }[];
  // Model-list entries whose PDF hasn't been added yet.
  missingPdfs: { fileName: string; title: string | null }[];
};

// How the model list and the manuals line up, for the admin page.
export function catalogSummary(shopId: string): Promise<CatalogSummary> {
  // One query at a time: a transaction's queries share one connection.
  return withShop(shopId, async (tx) => {
    const [manualCount] = await tx.select({ n: count() }).from(manuals);
    const [entries] = await tx
      .select({ n: count(), lastImportedAt: max(manualCatalogDocuments.importedAt) })
      .from(manualCatalogDocuments);
    const [models] = await tx.select({ n: count() }).from(manualCatalogModels);
    const notListed = await tx
      .select({ id: manuals.id, title: manuals.title, fileName: manuals.fileName })
      .from(manuals)
      .leftJoin(manualCatalogDocuments, catalogEntryOfManual)
      .where(isNull(manualCatalogDocuments.fileKey))
      .orderBy(asc(manuals.fileName));
    const missingPdfs = await tx
      .select({ fileName: manualCatalogDocuments.fileName, title: manualCatalogDocuments.title })
      .from(manualCatalogDocuments)
      .leftJoin(manuals, catalogEntryOfManual)
      .where(isNull(manuals.id))
      .orderBy(asc(manualCatalogDocuments.fileName));
    return {
      manuals: manualCount.n,
      entries: entries.n,
      models: models.n,
      lastImportedAt: entries.lastImportedAt,
      notListed,
      missingPdfs,
    };
  });
}
