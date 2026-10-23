import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { auditLog, manualPageToRead, manualPages, manuals } from "@/db/schema";
import { manualDisplayTitle } from "@/lib/manual-catalog";
import { OCR_MAX_PAGES_PER_BATCH } from "@/lib/manual-ocr-rules";
import { MAX_PAGE_TEXT_LENGTH, cleanPageText, pdfFileName, type PageText } from "@/lib/manual-rules";
import { isManualId } from "@/lib/manuals";
import { allows } from "@/lib/permissions";
import type { CurrentUser } from "@/lib/session";
import type { FileStorage } from "@/lib/storage";

// Reading scanned pages with OCR (System Admin > Manuals > Scanned pages).
// The admin's browser does the reading: it draws each page with pdf.js,
// straight from the shop's storage, and reads it with Tesseract, so the
// pages never go anywhere else. These steps hand it the work and keep what
// it finds:
//
//   list -> the scanned pages left to read, by manual
//   file -> a short-lived link to a manual's PDF
//   save -> text for a batch of pages, only ever for pages with none,
//           recorded in audit_log with the pages it changed; the batch that
//           reads a manual's last page counts its pages again and says so
//
// A page OCR has read gets ocr_at, even when it found no words (a blank page,
// a photo), so it isn't read again. Every function checks the acting user may
// manage settings (an admin, signed in with a password) and keeps to their
// shop.

type Problem = { error: string };

export type OcrManual = {
  id: string;
  title: string;
  pageCount: number;
  // The pages to read, in order.
  pages: number[];
};

export type OcrWork = { manuals: OcrManual[]; pages: number };

// saved: pages read (some may have had no words). withText: those that now
// have text search can find. skipped: pages that were already read or have
// text (another tab got there first, say), left as they were. done: no
// pages of this manual are left to read.
export type OcrSaveResult = { saved: number; withText: number; skipped: number; done: boolean } | Problem;

const notAllowed = { error: "Only an admin signed in with a password can do that." };
const notFound = { error: "That manual isn't in the library." };
const badBatch = { error: "That text couldn't be saved. Retry the manual." };

const allowed = (actor: CurrentUser) => allows(actor, "settings.manage");

// The scanned pages left to read in the shop's ready manuals, A to Z by
// title. Found through the manual_pages_to_read index, so it stays quick
// however big the library is.
export async function listOcrWork(actor: CurrentUser): Promise<OcrWork | Problem> {
  if (!allowed(actor)) return notAllowed;
  // One query at a time: a transaction's queries share one connection.
  return withShop(actor.shop.id, async (tx) => {
    const pending = await tx
      .select({
        manualId: manualPages.manualId,
        pages: sql<number[]>`array_agg(${manualPages.pageNumber} order by ${manualPages.pageNumber})`,
      })
      .from(manualPages)
      .where(manualPageToRead)
      .groupBy(manualPages.manualId);
    if (pending.length === 0) return { manuals: [], pages: 0 };
    const ready = await tx
      .select({ id: manuals.id, title: manualDisplayTitle, pageCount: manuals.pageCount })
      .from(manuals)
      .where(
        and(
          eq(manuals.status, "ready"),
          inArray(
            manuals.id,
            pending.map((row) => row.manualId),
          ),
        ),
      )
      .orderBy(manualDisplayTitle, asc(manuals.id));
    const pagesOf = new Map(pending.map((row) => [row.manualId, row.pages]));
    const list = ready.map((manual) => ({
      id: manual.id,
      title: manual.title,
      pageCount: manual.pageCount ?? 0,
      pages: pagesOf.get(manual.id) ?? [],
    }));
    return { manuals: list, pages: list.reduce((total, manual) => total + manual.pages.length, 0) };
  });
}

// A link to a ready manual's PDF for the browser to read pages from. It
// lasts 15 minutes; the browser asks again when it runs out.
export async function ocrFileUrl(
  actor: CurrentUser,
  input: { manualId: string },
  storage: FileStorage,
): Promise<{ url: string } | Problem> {
  if (!allowed(actor)) return notAllowed;
  if (!isManualId(input.manualId)) return notFound;
  const [row] = await withShop(actor.shop.id, (tx) =>
    tx
      .select({ title: manualDisplayTitle, storageKey: manuals.storageKey })
      .from(manuals)
      .where(and(eq(manuals.id, input.manualId), eq(manuals.status, "ready"))),
  );
  if (!row) return notFound;
  return { url: await storage.downloadUrl(row.storageKey, pdfFileName(row.title)) };
}

// Saves what OCR read on a batch of a manual's pages, and marks them read.
// Only pages left to read take it: a page that has text (from the PDF, or
// OCR already) is never changed. Each batch that changes pages is recorded
// in audit_log (manual.ocr, with the pages), in the same transaction: its
// words are in search as soon as it's saved. When it reads the manual's last
// page, the manual's pages are counted again and that row says it's done.
export async function saveOcrPages(
  actor: CurrentUser,
  input: { manualId: string; pages: PageText[] },
): Promise<OcrSaveResult> {
  if (!allowed(actor)) return notAllowed;
  if (!isManualId(input.manualId)) return notFound;
  const { pages } = input;
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > OCR_MAX_PAGES_PER_BATCH) return badBatch;
  // Keyed by page number, so a page sent twice in one batch is saved once.
  const texts = new Map<number, string>();
  for (const page of pages) {
    if (!Number.isSafeInteger(page?.pageNumber) || typeof page?.text !== "string") return badBatch;
    texts.set(page.pageNumber, cleanPageText(page.text));
  }

  return withShop(actor.shop.id, async (tx): Promise<OcrSaveResult> => {
    // Locked, so two tabs reading the same manual count it as done once.
    const [row] = await tx
      .select({
        id: manuals.id,
        title: manuals.title,
        fileName: manuals.fileName,
        status: manuals.status,
        pageCount: manuals.pageCount,
      })
      .from(manuals)
      .where(eq(manuals.id, input.manualId))
      .for("update");
    if (!row) return notFound;
    if (row.status !== "ready" || row.pageCount === null) return { error: "That manual isn't finished being added yet." };
    for (const pageNumber of texts.keys()) {
      if (pageNumber < 1 || pageNumber > row.pageCount) {
        return { error: `Page ${pageNumber} is outside this ${row.pageCount}-page manual.` };
      }
    }

    const savedPages: number[] = [];
    let withText = 0;
    for (const [pageNumber, text] of texts) {
      // A page left to read can still have a stray mark or two from the PDF
      // (a "." search can't find); OCR's words go after it.
      const [page] = await tx
        .update(manualPages)
        .set({
          text: sql`case
            when ${manualPages.text} = '' then ${text}::text
            when ${text}::text = '' then ${manualPages.text}
            else left(${manualPages.text} || ${"\n\n"} || ${text}::text, ${MAX_PAGE_TEXT_LENGTH})
          end`,
          ocrAt: sql`now()`,
        })
        .where(and(eq(manualPages.manualId, row.id), eq(manualPages.pageNumber, pageNumber), manualPageToRead))
        .returning({ searchable: sql<boolean>`length(${manualPages.searchVector}) > 0` });
      if (!page) continue;
      savedPages.push(pageNumber);
      if (page.searchable) withText += 1;
    }
    const saved = savedPages.length;
    if (saved === 0) {
      return { saved, withText, skipped: texts.size, done: !(await anyLeftToRead(tx, row.id)) };
    }

    // Every page read had nothing search could find before, so each one
    // that has text now is one fewer without.
    await tx
      .update(manuals)
      .set({
        pagesWithoutText: sql`greatest(0, coalesce(${manuals.pagesWithoutText}, 0) - ${withText}::int)`,
        pagesReadByOcr: sql`coalesce(${manuals.pagesReadByOcr}, 0) + ${withText}::int`,
      })
      .where(eq(manuals.id, row.id));
    const done = !(await anyLeftToRead(tx, row.id));
    let finished: Record<string, number | boolean> = {};
    if (done) {
      // That was the last page: count every page again from the pages
      // themselves.
      const [counts] = await tx
        .select({
          read: sql<number>`(count(*) filter (where ${manualPages.ocrAt} is not null))::int`,
          withText: sql<number>`(count(*) filter (where ${manualPages.ocrAt} is not null and length(${manualPages.searchVector}) > 0))::int`,
          withoutText: sql<number>`(count(*) filter (where length(${manualPages.searchVector}) = 0))::int`,
        })
        .from(manualPages)
        .where(and(eq(manualPages.manualId, row.id), sql`${manualPages.pageNumber} <= ${row.pageCount}`));
      await tx
        .update(manuals)
        .set({ pagesWithoutText: counts.withoutText, pagesReadByOcr: counts.withText })
        .where(eq(manuals.id, row.id));
      finished = {
        finished: true,
        pagesRead: counts.read,
        pagesWithText: counts.withText,
        pagesWithoutText: counts.withoutText,
      };
    }
    await tx.insert(auditLog).values({
      shopId: actor.shop.id,
      actorUserId: actor.id,
      action: "manual.ocr",
      targetType: "manual",
      targetId: row.id,
      details: { title: row.title, fileName: row.fileName, pages: savedPages, pagesGainedText: withText, ...finished },
    });
    return { saved, withText, skipped: texts.size - saved, done };
  });
}

// Whether any of a manual's pages are left to read (by index).
async function anyLeftToRead(tx: ShopTransaction, manualId: string) {
  const [left] = await tx
    .select({ pageNumber: manualPages.pageNumber })
    .from(manualPages)
    .where(and(eq(manualPages.manualId, manualId), manualPageToRead))
    .limit(1);
  return Boolean(left);
}
