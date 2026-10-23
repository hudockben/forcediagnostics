import "server-only";

import { randomUUID } from "node:crypto";

import { DrizzleQueryError, and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { auditLog, manualFileNames, manualPages, manuals, users, type ManualStatus } from "@/db/schema";
import {
  manualBrands,
  manualDisplayTitle,
  manualInList,
  manualInferredBrands,
  manualModelCount,
  manualModelYears,
  manualOtherNames,
} from "@/lib/manual-catalog";
import { withoutCopyNumber } from "@/lib/manual-catalog-rules";
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
//   start   -> skip a file that's already in (linking its name to it),
//              resume an unfinished one, or add a row and hand back an
//              upload URL
//   confirm -> the file arrived in storage at the right size
//   save    -> page text, in batches
//   finish  -> every page is saved; the manual shows up in the library
//
// Each PDF is stored once per shop, whatever it's called. A copy under
// another name is linked to the manual instead (manual_file_names), so the
// model list finds it under every name Polaris lists it by.
//
// Callers must check the settings.manage capability first; every function
// here also limits itself to the acting admin's shop.

type Problem = { error: string };

export type StartResult =
  // message says what became of the file's name.
  | { next: "skip"; manualId: string; title: string; message: string }
  | { next: "upload"; manualId: string; uploadUrl: string }
  | { next: "confirm"; manualId: string }
  | Problem;

export type ConfirmResult = { next: "extract" | "done" } | Problem;
// done is true when the manual was finished elsewhere (another tab, say), so
// there's no more text to send.
export type SaveResult = { saved: number; done?: true } | Problem;
// added is false when it was already finished (in another tab, say).
// nameTaken: the name another ready manual is already known by, of this
// one's file name and that name without a browser's copy number ("X.pdf"
// for "X (1).pdf"), so the model list's entry for it stays with the other
// one; null when there's none.
export type FinishResult =
  | { added: boolean; pageCount: number; pagesWithoutText: number; nameTaken: string | null }
  | Problem;

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

async function findManual(shopId: string, id: string) {
  const [row] = await withShop(shopId, (tx) => tx.select(rowColumns).from(manuals).where(eq(manuals.id, id)));
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

// File names match whatever the case, as in the model list.
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// What became of a file's name when it turned out to be a manual already in
// the library:
//   known:  the manual already had the name
//   linked: it has it now
//   taken:  a different manual (a different file under the same name) has it
type NameLink = "known" | "linked" | "taken";

type FoundCopy = { row: ManualRow & { displayTitle: string }; name: NameLink };

// The manual known by a file name, if any.
async function ownerOfName(tx: ShopTransaction, fileName: string) {
  const [owner] = await tx
    .select({ manualId: manualFileNames.manualId })
    .from(manualFileNames)
    .where(eq(manualFileNames.fileKey, sql`lower(${fileName})`));
  return owner?.manualId ?? null;
}

// Moves a name to a ready manual from the manual that has it, if that one
// never finished (an upload that stopped and was never tried again), so an
// abandoned row can't keep a newer download out of the model list for good.
// A ready manual keeps its names. Returns whether the name moved.
async function claimName(tx: ShopTransaction, manualId: string, ownerId: string, fileName: string) {
  // Locked, so an owner finishing in another tab right now keeps its name.
  const [owner] = await tx
    .select({ status: manuals.status })
    .from(manuals)
    .where(eq(manuals.id, ownerId))
    .for("update");
  if (!owner || owner.status === "ready") return false;
  const moved = await tx
    .update(manualFileNames)
    .set({ manualId })
    .where(and(eq(manualFileNames.fileKey, sql`lower(${fileName})`), eq(manualFileNames.manualId, ownerId)))
    .returning({ manualId: manualFileNames.manualId });
  return moved.length > 0;
}

// Records that a manual is known by a file name, unless some manual already
// is: a name belongs to one manual at most, and stays with it (unless that
// one never finished and this one is ready; see claimName).
async function linkName(
  tx: ShopTransaction,
  actor: CurrentUser,
  manual: ManualRow,
  fileName: string,
): Promise<NameLink> {
  const [added] = await tx
    .insert(manualFileNames)
    .values({ shopId: actor.shop.id, manualId: manual.id, fileName })
    .onConflictDoNothing()
    .returning({ fileName: manualFileNames.fileName });
  await linkWithoutCopyNumber(tx, actor.shop.id, manual, fileName);
  let takenFrom: string | null = null;
  if (!added) {
    const owner = await ownerOfName(tx, fileName);
    if (owner === manual.id) return "known";
    if (owner === null || manual.status !== "ready" || !(await claimName(tx, manual.id, owner, fileName))) {
      return "taken";
    }
    takenFrom = owner;
  }
  // A manual's own name isn't news; another name for it is.
  if (sameName(fileName, manual.fileName)) return "linked";
  await tx.insert(auditLog).values({
    shopId: actor.shop.id,
    actorUserId: actor.id,
    action: "manual.name_linked",
    targetType: "manual",
    targetId: manual.id,
    details: { fileName, manualFileName: manual.fileName, ...(takenFrom && { takenFromManualId: takenFrom }) },
  });
  return "linked";
}

// Records that a manual is known by a file name, unless some manual already
// is; a ready manual also takes it from one that never finished (see
// claimName). Returns false when another manual keeps it.
async function addName(
  tx: ShopTransaction,
  shopId: string,
  manual: { id: string; status: ManualStatus },
  fileName: string,
) {
  const [added] = await tx
    .insert(manualFileNames)
    .values({ shopId, manualId: manual.id, fileName })
    .onConflictDoNothing()
    .returning({ fileName: manualFileNames.fileName });
  if (added) return true;
  const owner = await ownerOfName(tx, fileName);
  if (owner === manual.id) return true;
  return owner !== null && manual.status === "ready" && (await claimName(tx, manual.id, owner, fileName));
}

// Gives a ready manual (finishManual has just made it so, or found it so
// under its lock) its own file name and that name without a copy number
// (see linkWithoutCopyNumber), each if no manual has it yet or the one that
// has it never finished. Returns the first of them another ready manual (a
// different file under the same name) has, or null.
async function takeOwnName(tx: ShopTransaction, shopId: string, manual: { id: string; fileName: string }) {
  const ready = { id: manual.id, status: "ready" as const };
  const plain = withoutCopyNumber(manual.fileName);
  let taken: string | null = null;
  for (const fileName of plain ? [manual.fileName, plain] : [manual.fileName]) {
    if (!(await addName(tx, shopId, ready, fileName))) taken ??= fileName;
  }
  return taken;
}

// "X (1).pdf" is also known as "X.pdf", the name the model list has, unless
// some manual already is (see addName).
async function linkWithoutCopyNumber(
  tx: ShopTransaction,
  shopId: string,
  manual: { id: string; status: ManualStatus },
  fileName: string,
) {
  const plain = withoutCopyNumber(fileName);
  if (plain) await addName(tx, shopId, manual, plain);
}

// The manual a file's hash belongs to, if it's in the library already, with
// the file's name linked to it when it can be. One transaction, so choosing
// a whole folder again costs one short round trip per file.
function findCopy(actor: CurrentUser, sha256: string, fileName: string): Promise<FoundCopy | null> {
  return withShop(actor.shop.id, async (tx) => {
    const [found] = await tx
      .select({ ...rowColumns, displayTitle: manualDisplayTitle })
      .from(manuals)
      .where(eq(manuals.sha256, sha256));
    if (!found) return null;
    const row = found as FoundCopy["row"];
    return { row, name: await linkName(tx, actor, row, fileName) };
  });
}

function skipMessage({ row, name }: FoundCopy, fileName: string) {
  if (sameName(fileName, row.fileName)) return `Already in the library as ${row.displayTitle}`;
  const same = `Same file as ${row.fileName}, already in the library.`;
  if (name === "linked") return `${same} Linked this name to it.`;
  if (name === "known") return `${same} This name is linked to it.`;
  return `${same} A different manual is already called ${fileName}, so this name stays with that one.`;
}

// What to do with a file whose manual row already exists.
// Its name is linked already (see findCopy), finished or not.
async function resume(
  found: FoundCopy,
  input: { fileName: string; sizeBytes: number },
  storage: FileStorage,
): Promise<StartResult> {
  const { row } = found;
  if (row.status === "ready") {
    return { next: "skip", manualId: row.id, title: row.displayTitle, message: skipMessage(found, input.fileName) };
  }
  if (row.sizeBytes !== input.sizeBytes) return { error: "That file doesn't match the copy already started." };
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

  const existing = await findCopy(actor, sha256, fileName);
  if (existing) return resume(existing, { fileName, sizeBytes: input.sizeBytes }, storage);

  const id = randomUUID();
  const storageKey = storageKeyFor(actor.shop.id, id);
  try {
    await withShop(actor.shop.id, async (tx) => {
      await tx.insert(manuals).values({
        id,
        // Always the admin's own shop, never anything from the browser.
        shopId: actor.shop.id,
        title: titleFromFileName(fileName),
        fileName,
        sha256,
        sizeBytes: input.sizeBytes,
        storageKey,
        uploadedByUserId: actor.id,
      });
      // Its own name, unless another manual (a different file) has it.
      await tx.insert(manualFileNames).values({ shopId: actor.shop.id, manualId: id, fileName }).onConflictDoNothing();
      await linkWithoutCopyNumber(tx, actor.shop.id, { id, status: "uploading" }, fileName);
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another tab started the same file a moment ago; carry on with its row.
    const raced = await findCopy(actor, sha256, fileName);
    if (!raced) throw error;
    return resume(raced, { fileName, sizeBytes: input.sizeBytes }, storage);
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
  const row = await findManual(actor.shop.id, input.manualId);
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
    // Its own name and the one without a copy number, if it somehow lacks
    // them (added by an older version of the app, say, or held by a manual
    // that never finished), and which another manual has instead. Only once
    // it's ready: a finish that fails below still commits.
    if (row.status === "ready") {
      return {
        added: false,
        pageCount: row.pageCount ?? 0,
        pagesWithoutText: row.pagesWithoutText ?? 0,
        nameTaken: await takeOwnName(tx, actor.shop.id, row),
      };
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
    const nameTaken = await takeOwnName(tx, actor.shop.id, row);
    return { added: true, pageCount: row.pageCount, pagesWithoutText: pages.withoutText, nameTaken };
  });
}

export type ManualSummary = {
  id: string;
  // The model list's title when the manual is in it.
  title: string;
  fileName: string;
  // The other names it's known by: byte-identical copies added after it.
  otherNames: string[];
  // From the model list, under any of its names; inList is false when the
  // list has none of them.
  inList: boolean;
  // Brand codes, each once.
  brands: string[];
  // Those of them that were filled in from model numbers.
  inferredBrands: string[];
  modelYears: string | null;
  models: number;
  status: ManualStatus;
  sizeBytes: number;
  pageCount: number | null;
  pagesWithoutText: number | null;
  // Scanned pages OCR found text on; null until it has read any.
  pagesReadByOcr: number | null;
  uploadedByName: string | null;
  createdAt: Date;
};

// Every manual in the shop for the admin list, with its model-list details:
// unfinished ones first.
export function listManuals(shopId: string): Promise<ManualSummary[]> {
  return withShop(shopId, (tx) =>
    tx
      .select({
        id: manuals.id,
        title: manualDisplayTitle,
        fileName: manuals.fileName,
        otherNames: manualOtherNames,
        inList: manualInList,
        brands: manualBrands,
        inferredBrands: manualInferredBrands,
        modelYears: manualModelYears,
        models: manualModelCount,
        status: manuals.status,
        sizeBytes: manuals.sizeBytes,
        pageCount: manuals.pageCount,
        pagesWithoutText: manuals.pagesWithoutText,
        pagesReadByOcr: manuals.pagesReadByOcr,
        uploadedByName: users.name,
        createdAt: manuals.createdAt,
      })
      .from(manuals)
      .leftJoin(users, eq(users.id, manuals.uploadedByUserId))
      .orderBy(sql`${manuals.status} = 'ready'`, manualDisplayTitle, asc(manuals.id)),
  );
}
