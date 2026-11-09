"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { refresh } from "next/cache";
import { RedirectType, redirect, unstable_rethrow } from "next/navigation";

import { addLocUnit, importLocUnits, markLocUnits, removeLocUnit, updateLocUnit } from "@/lib/loc";
import type { LocImportOutcome } from "@/lib/loc-import-rules";
import { LOC_VALUE_KEYS, locBack } from "@/lib/loc-rules";
import { decodeSaleVin, type VinDecode } from "@/lib/nusr";
import { requireCapability } from "@/lib/session";

// The LOC tab's actions. Every action re-checks the permission (the LOC
// has the shop's costs): server actions can be called directly, not just
// from these pages. Unexpected failures (a dropped database connection,
// say) come back as a message in the form instead of an error page;
// Next.js's own redirects pass straight through.

// What came back: a problem (and the box it's about), or what was done.
export type LocFormState = { error?: string; field?: string; success?: string; another?: boolean };

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

async function attempt<T>(what: string, run: () => Promise<T>, failed: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    // A DrizzleQueryError's message lists the query's parameters: only
    // the database's own error is logged.
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return failed;
  }
}

const FAILED_SAVE = { error: "Couldn't save that. Check the connection and try again." };

const unitInput = (form: FormData) => Object.fromEntries(LOC_VALUE_KEYS.map((key) => [key, field(form, key)]));

// The list with what was done added to its address.
const listWith = (back: string, what: Record<string, string | number>) => {
  const params = new URLSearchParams(back.replace(/^\?/, ""));
  for (const [key, value] of Object.entries(what)) params.set(key, String(value));
  return `/loc?${params.toString()}`;
};

// Adds a unit, or saves changes to one (an id in the form). "Add and start
// another" comes back to the form, ready for the next unit off the truck.
export async function saveLocUnitAction(_previous: LocFormState, form: FormData): Promise<LocFormState> {
  return attempt<LocFormState>(
    "save the unit",
    async () => {
      const user = await requireCapability("sales.log");
      const id = field(form, "id");
      const back = locBack(field(form, "back"));
      if (id) {
        const result = await updateLocUnit(user, id, unitInput(form));
        if ("error" in result) return { error: result.error, field: result.field };
        redirect(`/loc/${encodeURIComponent(id)}?saved=1${back ? `&back=${encodeURIComponent(back)}` : ""}`, RedirectType.replace);
      }
      const result = await addLocUnit(user, unitInput(form));
      if ("error" in result) return { error: result.error, field: result.field };
      if (field(form, "next") === "another") {
        refresh();
        return { success: "Added. Ready for the next one.", another: true };
      }
      redirect(listWith(back, { added: result.id }));
    },
    FAILED_SAVE,
  );
}

export async function removeLocUnitAction(_previous: LocFormState, form: FormData): Promise<LocFormState> {
  return attempt(
    "remove the unit",
    async () => {
      const user = await requireCapability("sales.log");
      const result = await removeLocUnit(user, field(form, "id"));
      if ("error" in result) return { error: result.error };
      redirect(listWith(locBack(field(form, "back")), { removed: result.label }), RedirectType.replace);
    },
    { error: "Couldn't remove that. Check the connection and try again." },
  );
}

// Marks the ticked units (or one, from what the NUSR says of it) paid off
// or sold, then shows the list again saying how many.
export async function markLocUnitsAction(_previous: LocFormState, form: FormData): Promise<LocFormState> {
  return attempt<LocFormState>(
    "mark the units",
    async () => {
      const user = await requireCapability("sales.log");
      const mark = field(form, "mark");
      const result = await markLocUnits(user, { ids: form.getAll("ids"), mark, on: field(form, "on") });
      if ("error" in result) return { error: result.error, field: result.field };
      redirect(
        listWith(locBack(field(form, "back")), {
          marked: result.marked,
          mark,
          ...(result.skipped ? { unchanged: result.skipped } : {}),
          ...(result.stillOwed ? { owed: result.stillOwed } : {}),
        }),
        RedirectType.replace,
      );
    },
    { error: "Couldn't mark them. Check the connection and try again." },
  );
}

// One batch of an import; the browser sends them one after another.
export async function importLocUnitsAction(input: { importId: string; fileName: string; units: unknown }): Promise<{ outcomes: LocImportOutcome[] } | { error: string }> {
  return attempt<{ outcomes: LocImportOutcome[] } | { error: string }>(
    "import units onto the LOC",
    async () => {
      const user = await requireCapability("sales.log");
      return importLocUnits(user, { importId: input?.importId, fileName: input?.fileName, units: input?.units });
    },
    { error: "Couldn't save that batch. Check the connection and try again." },
  );
}

// What a VIN typed on the unit form says: its year and model (the shop's
// last sale of the model, or the model list), what the last one cost, and
// whether it's on the LOC already.
export async function decodeLocVinAction(vin: string): Promise<VinDecode | null> {
  const user = await requireCapability("sales.log");
  return attempt("read the VIN", () => decodeSaleVin(user.shop.id, String(vin ?? "")), null);
}
