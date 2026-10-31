"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { refresh } from "next/cache";
import { RedirectType, redirect, unstable_rethrow } from "next/navigation";

import { customerForSale, decodeSaleVin, logSale, removeSale, updateSale, type SaleCustomer, type SaleInput, type VinDecode } from "@/lib/nusr";
import { SALE_LABELS, type SaleFields } from "@/lib/nusr-rules";
import { requireCapability } from "@/lib/session";
import { searchCustomersForLog, type CustomerChoice } from "@/lib/sticker-log";

// NUSR's actions. Every action re-checks the permission: server actions can
// be called directly, not just from these pages. Unexpected failures (a
// dropped database connection, say) come back as a message in the form
// instead of an error page; Next.js's own redirects pass straight through.

export type SaleFormState = { error?: string; success?: string; saved?: string; another?: boolean };

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

// Logs a new sale, or saves changes to one (an id in the form). "Log and
// start another" comes back to the form, ready for the next.
export async function saveSaleAction(_previous: SaleFormState, form: FormData): Promise<SaleFormState> {
  return attempt(
    "save the sale",
    async () => {
      const user = await requireCapability("sales.log");
      const id = field(form, "id");
      if (id) {
        const result = await updateSale(user, id, saleInput(form));
        if ("error" in result) return { error: result.error };
        refresh();
        return { success: "Saved.", saved: id };
      }
      const result = await logSale(user, saleInput(form));
      if ("error" in result) return { error: result.error };
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
      redirect(`/nusr?removed=${encodeURIComponent(result.label)}`, RedirectType.replace);
    },
    { error: "Couldn't remove that. Check the connection and try again." },
  );
}

// Customers on file for the form's customer box, by name or phone number.
export async function searchSaleCustomersAction(query: string): Promise<CustomerChoice[]> {
  const user = await requireCapability("sales.log");
  return attempt("look up customers", () => searchCustomersForLog(user.shop.id, String(query ?? "")), []);
}

// A customer's details and vehicles, to fill the sale in from.
export async function customerForSaleAction(id: string): Promise<SaleCustomer | null> {
  const user = await requireCapability("sales.log");
  return attempt("load the customer", () => customerForSale(user.shop.id, String(id ?? "")), null);
}

// What a VIN typed in says about the unit.
export async function decodeVinAction(vin: string): Promise<VinDecode | null> {
  const user = await requireCapability("sales.log");
  return attempt("read the VIN", () => decodeSaleVin(user.shop.id, String(vin ?? "")), null);
}
