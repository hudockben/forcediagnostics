"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";

import { requireCapability } from "@/lib/session";
import type { StickerImportOutcome } from "@/lib/sticker-import-rules";
import { addStock, importStickers, logSticker, removeSticker, searchCustomersForLog, updateSticker, type CustomerChoice } from "@/lib/sticker-log";

export type FormState = { error?: string; success?: string; logged?: string; fromStock?: boolean };

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

// Every action re-checks the permission: server actions can be called
// directly, not just from these pages. Unexpected failures (a dropped
// database connection, say) come back as a message in the form instead of
// an error page; Next.js's own redirects pass straight through.
async function attempt(what: string, run: () => Promise<FormState>): Promise<FormState> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return { error: "Couldn't save that. Check the connection and try again." };
  }
}

const entryFields = (form: FormData) => ({
  stickerNumber: field(form, "stickerNumber"),
  plateClass: field(form, "plateClass"),
  customerId: field(form, "customerId"),
  newCustomerName: field(form, "newCustomerName"),
});

export async function logStickerAction(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("log a sticker", async () => {
    const user = await requireCapability("repair_orders.intake");
    const result = await logSticker(user, entryFields(form));
    if ("error" in result) return { error: result.error };
    refresh();
    return { success: "Logged.", logged: result.id, fromStock: result.fromStock };
  });
}

export async function saveStickerAction(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("save the sticker", async () => {
    const user = await requireCapability("repair_orders.intake");
    const result = await updateSticker(user, field(form, "id"), entryFields(form));
    if ("error" in result) return { error: result.error };
    refresh();
    return { success: "Saved." };
  });
}

export async function removeStickerAction(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("remove the sticker", async () => {
    const user = await requireCapability("repair_orders.intake");
    const result = await removeSticker(user, field(form, "id"));
    if ("error" in result) return { error: result.error };
    redirect(`/sticker-plate-log?removed=${encodeURIComponent(result.stickerNumber)}`);
  });
}

// A delivery added to stock: one number, or a run of them. The refresh
// brings the tab's badge and the log's warning up to date.
export async function addStockAction(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("add to stock", async () => {
    const user = await requireCapability("repair_orders.intake");
    const result = await addStock(user, { kind: field(form, "kind"), from: field(form, "from"), to: field(form, "to") });
    if ("error" in result) return { error: result.error };
    refresh();
    return result.added > 0 ? { success: result.message } : { error: result.message };
  });
}

// One batch of an import (see src/lib/sticker-import-rules.ts); the browser
// sends them one after another.
export async function importStickersAction(input: {
  importId: string;
  fileName: string;
  stickers: unknown;
}): Promise<{ outcomes: StickerImportOutcome[] } | { error: string }> {
  try {
    const user = await requireCapability("repair_orders.intake");
    return await importStickers(user, { importId: input?.importId, fileName: input?.fileName, stickers: input?.stickers });
  } catch (error) {
    unstable_rethrow(error);
    // The query parameters are customers' names: only the database's own
    // error goes in the log.
    console.error("Couldn't import stickers", error instanceof DrizzleQueryError ? error.cause : error);
    return { error: "Couldn't save that batch. Check the connection and try again." };
  }
}

// Customers for the form's customer box.
export async function searchLogCustomersAction(query: string): Promise<CustomerChoice[]> {
  const user = await requireCapability("repair_orders.intake");
  try {
    return await searchCustomersForLog(user.shop.id, String(query ?? ""));
  } catch (error) {
    unstable_rethrow(error);
    console.error("Couldn't look up customers", error instanceof DrizzleQueryError ? error.cause : error);
    return [];
  }
}
