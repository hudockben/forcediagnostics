"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";

import type { ImportOutcome } from "@/lib/customer-import-rules";
import type { CustomerFields, VehicleFields } from "@/lib/customer-rules";
import {
  addVehicle,
  createCustomer,
  importCustomers,
  removeCustomer,
  removeVehicle,
  updateCustomer,
  updateVehicle,
} from "@/lib/customers";
import { requireCapability } from "@/lib/session";

export type FormState = { error?: string; success?: string };

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
    // A DrizzleQueryError's message lists the query parameters: the
    // customer's details. Only log the underlying database error.
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return { error: "Couldn't save that. Check the connection and try again." };
  }
}

const customerFields = (form: FormData): Record<keyof CustomerFields, string> => ({
  name: field(form, "name"),
  phone: field(form, "phone"),
  email: field(form, "email"),
  addressLine1: field(form, "addressLine1"),
  addressLine2: field(form, "addressLine2"),
  city: field(form, "city"),
  state: field(form, "state"),
  postalCode: field(form, "postalCode"),
  notes: field(form, "notes"),
});

const vehicleFields = (form: FormData): Record<keyof VehicleFields, string> => ({
  relation: field(form, "relation"),
  relationDate: field(form, "relationDate"),
  year: field(form, "year"),
  make: field(form, "make"),
  model: field(form, "model"),
  modelNumber: field(form, "modelNumber"),
  vin: field(form, "vin"),
  color: field(form, "color"),
  notes: field(form, "notes"),
});

const customerHref = (id: string) => `/admin/customers/${encodeURIComponent(id)}`;

export async function addCustomer(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("add a customer", async () => {
    const user = await requireCapability("repair_orders.intake");
    const result = await createCustomer(user, customerFields(form));
    if ("error" in result) return { error: result.error };
    redirect(`${customerHref(result.id)}?added=customer`);
  });
}

export async function saveCustomer(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("save the customer", async () => {
    const user = await requireCapability("repair_orders.intake");
    const result = await updateCustomer(user, field(form, "id"), customerFields(form));
    if ("error" in result) return { error: result.error };
    refresh();
    return { success: "Saved." };
  });
}

export async function removeCustomerAction(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("remove the customer", async () => {
    const user = await requireCapability("repair_orders.intake");
    const result = await removeCustomer(user, field(form, "id"));
    if ("error" in result) return { error: result.error };
    redirect("/admin/customers?removed=1");
  });
}

export async function addVehicleAction(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("add a vehicle", async () => {
    const user = await requireCapability("repair_orders.intake");
    const customerId = field(form, "customerId");
    const result = await addVehicle(user, customerId, vehicleFields(form));
    if ("error" in result) return { error: result.error };
    redirect(`${customerHref(customerId)}?added=vehicle`);
  });
}

export async function saveVehicle(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("save the vehicle", async () => {
    const user = await requireCapability("repair_orders.intake");
    const result = await updateVehicle(user, field(form, "customerId"), field(form, "id"), vehicleFields(form));
    if ("error" in result) return { error: result.error };
    refresh();
    return { success: "Saved." };
  });
}

export async function removeVehicleAction(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("remove the vehicle", async () => {
    const user = await requireCapability("repair_orders.intake");
    const customerId = field(form, "customerId");
    const result = await removeVehicle(user, customerId, field(form, "id"));
    if ("error" in result) return { error: result.error };
    redirect(`${customerHref(customerId)}?removed=vehicle`);
  });
}

// One batch of an import (see src/lib/customer-import-rules.ts); the browser
// sends them one after another.
export async function importCustomersAction(input: {
  importId: string;
  fileName: string;
  customers: unknown;
}): Promise<{ outcomes: ImportOutcome[] } | { error: string }> {
  try {
    const user = await requireCapability("repair_orders.intake");
    return await importCustomers(user, {
      importId: input?.importId,
      fileName: input?.fileName,
      customers: input?.customers,
    });
  } catch (error) {
    unstable_rethrow(error);
    // The query parameters are customers' details: only the database's own
    // error goes in the log.
    console.error("Couldn't import customers", error instanceof DrizzleQueryError ? error.cause : error);
    return { error: "Couldn't save that batch. Check the connection and try again." };
  }
}
