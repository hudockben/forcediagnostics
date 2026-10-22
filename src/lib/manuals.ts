import "server-only";

import { randomUUID } from "node:crypto";

import { DrizzleQueryError, and, asc, count, eq, inArray, lte, sql } from "drizzle-orm";

import { withShop } from "@/db";
import {
  auditLog,
  manualCatalogDocuments,
  manualCatalogModels,
  manualPages,
  manuals,
  users,
  type ManualStatus,
} from "@/db/schema";
import { catalogEntryOfManual, manualDisplayTitle } from "@/lib/manual-catalog";
import {
  MAX_MANUAL_BYTES,
  MAX_MANUAL_PAGES,
  MAX_PAGES_PER_BATCH,
  cleanPageText,
  formatBytes,
  titleFromFileName,
  type PageText,
} from "@/lib/manual-rules";
import type { CurrentUser } from "@/lib/session";
import type { FileStorage } from "@/lib/storage";

// Adding manuals to a shop's library (System Admin > Manuals). The browser
// does the heavy lifting: it hashes the PDF, uploads it straight to storage
// and reads its text with pdf.js. These steps check and record each stage:
//
//   start   -> skip a file that's already in, resume an unfinished one, or
//              add a row and hand back an upload URL
//   confirm -> the file arrived in storage at the right size
//   save    -> page text, in batches
//   finish  -> every page is saved; the manual shows up in the library
//
// Callers must check the settings.manage capability first; every function
// here also limits itself to the acting admin's shop.

type Problem = { error: string };

export type StartResult =
  | { next: "skip"; manualId: string; title: string }
  | { next: "upload"; manualId: string; uploadUrl: string }
  | { next: "confirm"; manualId: string }
  | Problem;

export type ConfirmResult = { next: "extract" | "done" } | Problem;
// done is true when the manual was finished elsewhere (another tab, say), so
// there's no more text to send.
export type SaveResult = { saved: number; done?: true } | Problem;
// added is false when it was already finished (in another tab, say).
export type FinishResult = { added: boolean; pageCount: number; pagesWithoutText: number } | Problem;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_FILE_NAME_LENGTH = 255;

const notFound = { error: "That manual isn't in the library. Add the file again." };

export const isManualId = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

// Where a manual's PDF lives in storage. Always built here from IDs, never
// from anything the browser sends.
export function storageKeyFor(shopId: string, manualId: string) {
  return `shops/${shopId}/manuals/${manualId}.pdf`;
}

const rowColumns = {
  id: manuals.id,
  title: manuals.title,
  fileName: manuals.fileName,
  sizeBytes: manuals.sizeBytes,
  storageKey: manuals.storageKey,
  status: manuals.status,
  pageCount: manuals.pageCount,
  pagesWithoutText: manuals.pagesWithoutText,
};

type ManualRow = {
  id: string;
  title: string;
  fileName: string;
  sizeBytes: number;
  storageKey: string;
  status: ManualStatus;
  pageCount: number | null;
  pagesWithoutText: number | null;
};

async function findManual(shopId: string, where: { id: string } | { sha256: string }) {
  const [row] = await withShop(shopId, (tx) =>
    tx
      .select(rowColumns)
      .from(manuals)
      .where("id" in where ? eq(manuals.id, where.id) : eq(manuals.sha256, where.sha256)),
  );
  return (row as ManualRow | undefined) ?? null;
}

function isUniqueViolation(error: unknown) {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  return (cause as { code?: string } | undefined)?.code === "23505";
}

function checkFile(input: { fileName: string; sizeBytes: number; sha256: string }): string | null {
  if (!/\.pdf$/i.test(input.fileName)) return "Only PDF files can be added.";
  if (input.fileName.length > MAX_FILE_NAME_LENGTH) return "That file name is too long. Rename it and try again.";
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) return "That file is empty.";
  if (input.sizeBytes > MAX_MANUAL_BYTES) {
    return `That file is over ${formatBytes(MAX_MANUAL_BYTES)}, the most a manual can be.`;
  }
  if (!SHA256_PATTERN.test(input.sha256)) return "That file couldn't be checked. Try again.";
  return null;
}

// What to do with a file whose manual row already exists.
async function resume(row: ManualRow, sizeBytes: number, storage: FileStorage): Promise<StartResult> {
  if (row.status === "ready") return { next: "skip", manualId: row.id, title: row.title };
  if (row.sizeBytes !== sizeBytes) return { error: "That file doesn't match the copy already started." };
  // An earlier try may have got the file into storage before it stopped.
  if ((await storage.size(row.storageKey)) === row.sizeBytes) {
    return { next: "confirm", manualId: row.id };
  }
  return { next: "upload", manualId: row.id, uploadUrl: await storage.uploadUrl(row.storageKey) };
}

export async function startManualUpload(
  actor: CurrentUser,
  input: { fileName: string; sizeBytes: number; sha256: string },
  storage: FileStorage,
): Promise<StartResult> {
  const fileName = input.fileName.trim();
  const sha256 = input.sha256.toLowerCase();
  const problem = checkFile({ fileName, sizeBytes: input.sizeBytes, sha256 });
  if (problem) return { error: problem };

  const existing = await findManual(actor.shop.id, { sha256 });
  if (existing) return resume(existing, input.sizeBytes, storage);

  const id = randomUUID();
  const storageKey = storageKeyFor(actor.shop.id, id);
  try {
    await withShop(actor.shop.id, (tx) =>
      tx.insert(manuals).values({
        id,
        // Always the admin's own shop, never anything from the browser.
        shopId: actor.shop.id,
        title: titleFromFileName(fileName),
        fileName,
        sha256,
        sizeBytes: input.sizeBytes,
        storageKey,
        uploadedByUserId: actor.id,
      }),
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another tab started the same file a moment ago; carry on with its row.
    const raced = await findManual(actor.shop.id, { sha256 });
    if (!raced) throw error;
    return resume(raced, input.sizeBytes, storage);
  }
  return { next: "upload", manualId: id, uploadUrl: await storage.uploadUrl(storageKey) };
}

export async function confirmManualUpload(
  actor: CurrentUser,
  input: { manualId: string; pageCount: number },
  storage: FileStorage,
): Promise<ConfirmResult> {
  if (!isManualId(input.manualId)) return notFound;
  const { pageCount } = input;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_MANUAL_PAGES) {
    return { error: "That PDF's page count doesn't look right." };
  }
  const row = await findManual(actor.shop.id, { id: input.manualId });
  if (!row) return notFound;
  if (row.status === "ready") return { next: "done" };
  if (row.pageCount !== null && row.pageCount !== pageCount) {
    return { error: "That file doesn't match the copy already started." };
  }

  const stored = await storage.size(row.storageKey);
  if (stored === null) return { error: "The file didn't reach storage. Retry it." };
  if (stored !== row.sizeBytes) return { error: "Only part of the file reached storage. Retry it." };

  const updated = await withShop(actor.shop.id, (tx) =>
    tx
      .update(manuals)
      .set({ status: "extracting", pageCount })
      .where(and(eq(manuals.id, row.id), inArray(manuals.status, ["uploading", "extracting"])))
      .returning({ id: manuals.id }),
  );
  // Finished in another tab in the meantime.
  return { next: updated.length ? "extract" : "done" };
}

// Saves a batch of page text. Retried batches replace what was there.
export async function saveManualPages(
  actor: CurrentUser,
  input: { manualId: string; pages: PageText[] },
): Promise<SaveResult> {
  if (!isManualId(input.manualId)) return notFound;
  const { pages } = input;
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_PAGES_PER_BATCH) {
    return { error: "Those pages couldn't be saved. Retry the file." };
  }
  // Keyed by page number, so a page sent twice in one batch is saved once.
  const texts = new Map<number, string>();
  for (const page of pages) {
    if (!Number.isSafeInteger(page?.pageNumber) || typeof page?.text !== "string") {
      return { error: "Those pages couldn't be saved. Retry the file." };
    }
    texts.set(page.pageNumber, cleanPageText(page.text));
  }

  return withShop(actor.shop.id, async (tx): Promise<SaveResult> => {
    const [row] = await tx
      .select({ status: manuals.status, pageCount: manuals.pageCount })
      .from(manuals)
      .where(eq(manuals.id, input.manualId));
    if (!row) return notFound;
    // Finished in another tab in the meantime. Its text stays as it is.
    if (row.status === "ready") return { saved: 0, done: true };
    if (row.status !== "extracting" || row.pageCount === null) {
      return { error: "That manual isn't ready for its text. Retry the file." };
    }
    for (const pageNumber of texts.keys()) {
      if (pageNumber < 1 || pageNumber > row.pageCount) {
        return { error: `Page ${pageNumber} is outside this ${row.pageCount}-page manual.` };
      }
    }
    await tx
      .insert(manualPages)
      .values(
        [...texts].map(([pageNumber, text]) => ({
          manualId: input.manualId,
          shopId: actor.shop.id,
          pageNumber,
          text,
        })),
      )
      .onConflictDoUpdate({
        target: [manualPages.manualId, manualPages.pageNumber],
        set: { text: sql`excluded.text` },
      });
    return { saved: texts.size };
  });
}

export async function finishManual(
  actor: CurrentUser,
  input: { manualId: string },
): Promise<FinishResult> {
  if (!isManualId(input.manualId)) return notFound;
  return withShop(actor.shop.id, async (tx): Promise<FinishResult> => {
    // Locked, so two tabs finishing the same manual record it once.
    const [row] = await tx.select(rowColumns).from(manuals).where(eq(manuals.id, input.manualId)).for("update");
    if (!row) return notFound;
    if (row.status === "ready") {
      return { added: false, pageCount: row.pageCount ?? 0, pagesWithoutText: row.pagesWithoutText ?? 0 };
    }
    if (row.status !== "extracting" || row.pageCount === null) {
      return { error: "That manual's file hasn't been checked yet. Retry it." };
    }

    const [pages] = await tx
      .select({
        saved: sql<number>`count(*)::int`,
        // Nothing search can find: usually a scanned page with no text layer.
        withoutText: sql<number>`(count(*) filter (where length(${manualPages.searchVector}) = 0))::int`,
      })
      .from(manualPages)
      .where(and(eq(manualPages.manualId, row.id), lte(manualPages.pageNumber, row.pageCount)));
    if (pages.saved < row.pageCount) {
      return { error: `Only ${pages.saved} of ${row.pageCount} pages were saved. Retry the file.` };
    }

    await tx
      .update(manuals)
      .set({ status: "ready", readyAt: new Date(), pagesWithoutText: pages.withoutText })
      .where(eq(manuals.id, row.id));
    await tx.insert(auditLog).values({
      shopId: actor.shop.id,
      actorUserId: actor.id,
      action: "manual.added",
      targetType: "manual",
      targetId: row.id,
      details: {
        title: row.title,
        fileName: row.fileName,
        pages: row.pageCount,
        pagesWithoutText: pages.withoutText,
        sizeBytes: row.sizeBytes,
      },
    });
    return { added: true, pageCount: row.pageCount, pagesWithoutText: pages.withoutText };
  });
}

export type ManualSummary = {
  id: string;
  // The model list's title when the manual is in it.
  title: string;
  fileName: string;
  // From the model list; inList is false when the manual isn't in it.
  inList: boolean;
  brand: string | null;
  inferredBrand: boolean;
  modelYears: string | null;
  models: number;
  status: ManualStatus;
  sizeBytes: number;
  pageCount: number | null;
  pagesWithoutText: number | null;
  uploadedByName: string | null;
  createdAt: Date;
};

// Every manual in the shop for the admin list, with its model-list details:
// unfinished ones first.
export function listManuals(shopId: string): Promise<ManualSummary[]> {
  return withShop(shopId, (tx) => {
    const modelCounts = tx
      .select({ fileKey: manualCatalogModels.fileKey, models: count().as("models") })
      .from(manualCatalogModels)
      .groupBy(manualCatalogModels.fileKey)
      .as("model_counts");
    return tx
      .select({
        id: manuals.id,
        title: manualDisplayTitle,
        fileName: manuals.fileName,
        inList: sql<boolean>`${manualCatalogDocuments.fileKey} is not null`,
        brand: manualCatalogDocuments.brand,
        inferredBrand: sql<boolean>`coalesce(${manualCatalogDocuments.inferredBrand}, false)`,
        modelYears: manualCatalogDocuments.modelYears,
        models: sql<number>`coalesce(${modelCounts.models}, 0)::int`,
        status: manuals.status,
        sizeBytes: manuals.sizeBytes,
        pageCount: manuals.pageCount,
        pagesWithoutText: manuals.pagesWithoutText,
        uploadedByName: users.name,
        createdAt: manuals.createdAt,
      })
      .from(manuals)
      .leftJoin(users, eq(users.id, manuals.uploadedByUserId))
      .leftJoin(manualCatalogDocuments, catalogEntryOfManual)
      .leftJoin(modelCounts, eq(modelCounts.fileKey, manualCatalogDocuments.fileKey))
      .orderBy(sql`${manuals.status} = 'ready'`, manualDisplayTitle, asc(manuals.id));
  });
}
