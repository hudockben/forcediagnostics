"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { unstable_rethrow } from "next/navigation";

import {
  findRebateSales,
  removeSavedInvoice,
  saveRebateInvoice,
  searchRebateSales,
  type RebateLookup,
  type RebateSaleSummary,
  type SaveResult,
} from "@/lib/rebates";
import { requireCapability } from "@/lib/session";

// Every action re-checks the permission: server actions can be called
// directly, not just from this page. Unexpected failures (a dropped
// database connection, say) come back as a message instead of an error
// page; Next.js's own redirects pass straight through.
async function attempt<T extends object>(what: string, run: () => Promise<T>, failed: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    // A DrizzleQueryError's message lists the query parameters: customers'
    // names. Only log the database's own error.
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return failed;
  }
}

// An invoice's units found in the NUSR (see src/lib/rebate-rules.ts).
export async function findRebateSalesAction(items: unknown): Promise<RebateLookup | { error: string }> {
  return attempt<RebateLookup | { error: string }>(
    "find an invoice's units in the NUSR",
    async () => findRebateSales(await requireCapability("sales.log"), items),
    { error: "Couldn't look the units up in the NUSR. Check the connection and try again." },
  );
}

// Sales to pick from for a line that wasn't found, by anything about it.
export async function searchRebateSalesAction(query: unknown): Promise<{ sales: RebateSaleSummary[] } | { error: string }> {
  return attempt<{ sales: RebateSaleSummary[] } | { error: string }>(
    "search the NUSR for a rebate",
    async () => searchRebateSales(await requireCapability("sales.log"), query),
    { error: "Couldn't search the NUSR. Check the connection and try again." },
  );
}

// Saves an invoice as checked on the page, or says it's saved already (to
// save it in its place when that's meant: `replace`).
export async function saveRebateInvoiceAction(input: unknown): Promise<SaveResult> {
  return attempt<SaveResult>(
    "save a rebate invoice",
    async () => saveRebateInvoice(await requireCapability("sales.log"), input),
    { error: "Couldn't save the invoice. Check the connection and try again." },
  );
}

// Removes a saved invoice and its lines.
export async function removeSavedInvoiceAction(id: unknown): Promise<{ ok: true; number: string | null } | { error: string }> {
  return attempt<{ ok: true; number: string | null } | { error: string }>(
    "remove a saved rebate invoice",
    async () => removeSavedInvoice(await requireCapability("sales.log"), id),
    { error: "Couldn't remove the invoice. Check the connection and try again." },
  );
}
