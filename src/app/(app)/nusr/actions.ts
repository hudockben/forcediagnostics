"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { refresh } from "next/cache";
import { RedirectType, redirect, unstable_rethrow } from "next/navigation";

import {
  customerForSale,
  decodeSaleVin,
  logSale,
  markPaid,
  removeSale,
  searchSaleBuyers,
  updateSale,
  type BuyerChoice,
  type SaleCustomer,
  type SaleInput,
  type VinDecode,
} from "@/lib/nusr";
import { SALE_LABELS, logSearch, shopYear, type SaleFields } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";

// NUSR's actions. Every action re-checks the permission: server actions can
// be called directly, not just from these pages. Unexpected failures (a
// dropped database connection, say) come back as a message in the form
// instead of an error page; Next.js's own redirects pass straight through.

// What came back: a problem (and the box it's about), or what was done.
export type SaleFormState = { error?: string; field?: string; success?: string; saved?: string; another?: boolean };

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

async function attempt<T>(what: string, run: () => Promise<T>, failed: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    // A DrizzleQueryError's message lists the query's parameters, which
    // include customers' details: only the database's own error is logged.
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return failed;
  }
}

const FAILED_SAVE = { error: "Couldn't save that. Check the connection and try again." };

function saleInput(form: FormData): SaleInput {
  const input = Object.fromEntries(Object.keys(SALE_LABELS).map((key) => [key, field(form, key)])) as Record<keyof SaleFields, unknown>;
  return {
    ...input,
    customerId: field(form, "customerId"),
    addCustomer: field(form, "addCustomer"),
    addVehicle: field(form, "addVehicle"),
  };
}

// Logs a new sale, or saves changes to one (an id in the form), then shows
// it again saying so (the log it was opened from kept for the way back).
// "Log and start another" comes back to the form, ready for the next.
export async function saveSaleAction(_previous: SaleFormState, form: FormData): Promise<SaleFormState> {
  return attempt<SaleFormState>(
    "save the sale",
    async () => {
      const user = await requireCapability("sales.log");
      const id = field(form, "id");
      if (id) {
        const result = await updateSale(user, id, saleInput(form));
        if ("error" in result) return { error: result.error, field: result.field };
        const back = logSearch(field(form, "back"), shopYear());
        redirect(`/nusr/${encodeURIComponent(id)}?saved=1${back ? `&back=${encodeURIComponent(back)}` : ""}`, RedirectType.replace);
      }
      const result = await logSale(user, saleInput(form));
      if ("error" in result) return { error: result.error, field: result.field };
      if (field(form, "next") === "another") {
        refresh();
        return { success: "Logged. Ready for the next one.", saved: result.id, another: true };
      }
      redirect(`/nusr?logged=${result.id}`);
    },
    FAILED_SAVE,
  );
}

export async function removeSaleAction(_previous: SaleFormState, form: FormData): Promise<SaleFormState> {
  return attempt(
    "remove the sale",
    async () => {
      const user = await requireCapability("sales.log");
      const result = await removeSale(user, field(form, "id"));
      if ("error" in result) return { error: result.error };
      // Back to the log it was opened from, saying what went.
      const back = logSearch(field(form, "back"), shopYear());
      redirect(`/nusr${back}${back ? "&" : "?"}removed=${encodeURIComponent(result.label)}`, RedirectType.replace);
    },
    { error: "Couldn't remove that. Check the connection and try again." },
  );
}

// Marks the ticked units paid off together (one floorplan payment), then
// shows the log again, saying how many.
export async function markPaidAction(_previous: SaleFormState, form: FormData): Promise<SaleFormState> {
  return attempt<SaleFormState>(
    "mark the units paid off",
    async () => {
      const user = await requireCapability("sales.log");
      const result = await markPaid(user, { ids: form.getAll("ids"), paidOn: field(form, "paidOn"), comsNumber: field(form, "comsNumber") });
      if ("error" in result) return { error: result.error, field: result.field };
      const back = logSearch(field(form, "back"), shopYear());
      redirect(`/nusr${back}${back ? "&" : "?"}paid=${result.marked}${result.skipped ? `&unchanged=${result.skipped}` : ""}`, RedirectType.replace);
    },
    { error: "Couldn't mark them paid off. Check the connection and try again." },
  );
}

// Customers on file, then past buyers who aren't, for the form's customer
// box, by name or phone number.
export async function searchSaleCustomersAction(query: string): Promise<BuyerChoice[]> {
  const user = await requireCapability("sales.log");
  return attempt("look up customers", () => searchSaleBuyers(user.shop.id, String(query ?? "")), []);
}

// A customer's details and vehicles, to fill the sale in from.
export async function customerForSaleAction(id: string): Promise<SaleCustomer | null> {
  const user = await requireCapability("sales.log");
  return attempt("load the customer", () => customerForSale(user.shop.id, String(id ?? "")), null);
}

// What a VIN typed in says about the unit (the sale being corrected, if
// one is, left out of its earlier sales).
export async function decodeVinAction(vin: string, saleId = ""): Promise<VinDecode | null> {
  const user = await requireCapability("sales.log");
  return attempt("read the VIN", () => decodeSaleVin(user.shop.id, String(vin ?? ""), typeof saleId === "string" ? saleId : null), null);
}
