"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";

import { requireCapability } from "@/lib/session";
import type { SupplierImportOutcome } from "@/lib/supplier-rules";
import { createSupplier, importSuppliers, removeSupplier, updateSupplier } from "@/lib/suppliers";

export type FormState = { error?: string; success?: string };

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

// Every action re-checks the permission: server actions can be called
// directly, not just from these pages. Unexpected failures come back as a
// message in the form; Next.js's own redirects pass straight through.
async function attempt<T extends object>(what: string, run: () => Promise<T>, failed: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return failed;
  }
}

const NOT_SAVED = { error: "Couldn't save that. Check the connection and try again." };

const supplierFields = (form: FormData) => ({
  supplierId: field(form, "supplierId"),
  supplierCode: field(form, "supplierCode"),
  supplierName: field(form, "supplierName"),
  categoryCode: field(form, "categoryCode"),
  categoryId: field(form, "categoryId"),
});

export async function addSupplierAction(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt<FormState>("add a supplier", async () => {
    const user = await requireCapability("parts.manage");
    const result = await createSupplier(user, supplierFields(form));
    if ("error" in result) return { error: result.error };
    redirect(`/admin/suppliers?added=${result.id}`);
  }, NOT_SAVED);
}

export async function saveSupplierAction(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt<FormState>("save the supplier", async () => {
    const user = await requireCapability("parts.manage");
    const result = await updateSupplier(user, field(form, "id"), supplierFields(form));
    if ("error" in result) return { error: result.error };
    refresh();
    return { success: "Saved." };
  }, NOT_SAVED);
}

export async function removeSupplierAction(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt<FormState>("remove the supplier", async () => {
    const user = await requireCapability("parts.manage");
    const result = await removeSupplier(user, field(form, "id"));
    if ("error" in result) return { error: result.error };
    redirect("/admin/suppliers?removed=1");
  }, NOT_SAVED);
}

// One batch of an import; the browser sends them one after another.
export async function importSuppliersAction(input: {
  importId: string;
  fileName: string;
  suppliers: unknown;
}): Promise<{ outcomes: SupplierImportOutcome[] } | { error: string }> {
  return attempt<{ outcomes: SupplierImportOutcome[] } | { error: string }>(
    "import suppliers",
    async () => {
      const user = await requireCapability("parts.manage");
      return importSuppliers(user, { importId: input?.importId, fileName: input?.fileName, suppliers: input?.suppliers });
    },
    { error: "Couldn't save that batch. Check the connection and try again." },
  );
}
