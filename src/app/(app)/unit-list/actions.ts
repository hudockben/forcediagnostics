"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";

import { requireCapability } from "@/lib/session";
import type { UnitImportOutcome } from "@/lib/unit-import-rules";
import { addStockUnits, importStockUnits, lookUpUnits, putStockUnitOnLoc, removeStockUnit, updateStockUnit, type AddResult, type LocOutcome, type UnitLookup } from "@/lib/unit-list";
import { UNIT_LABELS, type UnitFields, type UnitInput } from "@/lib/unit-list-rules";

// Every action re-checks the permission: server actions can be called
// directly, not just from these pages. Unexpected failures (a dropped
// database connection, say) come back as a message instead of an error
// page; Next.js's own redirects pass straight through.
async function attempt<T extends object>(what: string, run: () => Promise<T>, failed: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    // A DrizzleQueryError's message lists the query parameters: only the
    // database's own error goes in the log.
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return failed;
  }
}

// For units read from an invoice: on the list already, sold in the NUSR,
// the model as the shop named it before, the last list price.
export async function lookUpUnitsAction(items: unknown): Promise<{ units: UnitLookup[] } | { error: string }> {
  return attempt<{ units: UnitLookup[] } | { error: string }>(
    "look units up for the Unit List",
    async () => lookUpUnits(await requireCapability("sales.log"), items),
    { error: "Couldn't look the units up. Check the connection and try again." },
  );
}

// Adds the units read from an invoice, as checked on the page.
export async function addStockUnitsAction(input: unknown): Promise<AddResult> {
  return attempt<AddResult>(
    "add units to the Unit List",
    async () => addStockUnits(await requireCapability("sales.log"), input),
    { error: "Couldn't add the units. Check the connection and try again." },
  );
}

export type FormState = { error?: string; field?: keyof UnitFields; success?: string };

const fieldsOf = (form: FormData): UnitInput =>
  Object.fromEntries((Object.keys(UNIT_LABELS) as (keyof UnitFields)[]).map((key) => [key, String(form.get(key) ?? "")]));

async function formAttempt(what: string, run: () => Promise<FormState>): Promise<FormState> {
  return attempt<FormState>(what, run, { error: "Couldn't save that. Check the connection and try again." });
}

// A unit typed in by hand (one that came without an invoice, or was in
// stock before the list).
export async function addUnitAction(_previous: FormState, form: FormData): Promise<FormState> {
  return formAttempt("add a unit to the Unit List", async () => {
    const user = await requireCapability("sales.log");
    const fields = fieldsOf(form);
    const loc = form.get("loc") === "loc" ? { loc: "loc", freeFloorEnds: String(form.get("freeFloorEnds") ?? "") } : {};
    const result = await addStockUnits(user, { units: [{ key: "1", ...fields, ...loc }] });
    if ("error" in result) return { error: result.error };
    if ("problems" in result) return { error: result.problems[0].error, field: result.problems[0].field };
    if (result.already.length) return { error: `A unit with this VIN is on the list already: ${result.already[0].name}.`, field: "vin" };
    // The whole VIN of a unit from the shop's sheet, which had only its end.
    if (result.completed.length) redirect(`/unit-list?filled=${encodeURIComponent(result.completed[0].name.slice(0, 200))}`);
    const name = [fields.unitYear, fields.model].map((part) => String(part ?? "").trim()).filter(Boolean).join(" ");
    const onLoc = result.loc[0];
    const locNote = onLoc ? `&loc=${encodeURIComponent(locWords(onLoc).slice(0, 300))}` : "";
    redirect(`/unit-list?added=${encodeURIComponent(name.slice(0, 200))}${locNote}`);
  });
}

// What putting a unit on the LOC did, in words.
function locWords(outcome: LocOutcome) {
  if (outcome.error) return `Not put on the LOC: ${outcome.error}`;
  const stock = outcome.stockNumber ? ` as stock # ${outcome.stockNumber}` : "";
  return outcome.already ? `The LOC has it already${stock}.` : `Put on the LOC${stock}.`;
}

// A unit on the list put on the LOC from its page: floored, or the shop's
// own, with its free floor's last day.
export async function putOnLocAction(_previous: FormState, form: FormData): Promise<FormState> {
  return formAttempt("put a unit on the LOC", async () => {
    const user = await requireCapability("sales.log");
    const result = await putStockUnitOnLoc(user, String(form.get("id") ?? ""), { loc: form.get("loc"), freeFloorEnds: form.get("freeFloorEnds") });
    if (!("key" in result)) return { error: result.error };
    if (result.error) return { error: locWords(result) };
    refresh();
    return { success: locWords(result) };
  });
}

export async function saveUnitAction(_previous: FormState, form: FormData): Promise<FormState> {
  return formAttempt("save a unit on the Unit List", async () => {
    const user = await requireCapability("sales.log");
    const result = await updateStockUnit(user, String(form.get("id") ?? ""), fieldsOf(form));
    if ("error" in result) return { error: result.error, field: result.field };
    refresh();
    return { success: result.changed ? "Saved." : "Nothing changed." };
  });
}

export async function removeUnitAction(_previous: FormState, form: FormData): Promise<FormState> {
  return formAttempt("remove a unit from the Unit List", async () => {
    const user = await requireCapability("sales.log");
    const result = await removeStockUnit(user, String(form.get("id") ?? ""));
    if ("error" in result) return { error: result.error };
    redirect(`/unit-list?removed=${encodeURIComponent(result.name.slice(0, 200))}`);
  });
}

// One batch of an import of the shop's sheet (see src/lib/unit-import-rules.ts);
// the browser sends them one after another.
export async function importStockUnitsAction(input: { importId: unknown; fileName: unknown; units: unknown }): Promise<{ outcomes: UnitImportOutcome[] } | { error: string }> {
  return attempt<{ outcomes: UnitImportOutcome[] } | { error: string }>(
    "import units onto the Unit List",
    async () => importStockUnits(await requireCapability("sales.log"), { importId: input?.importId, fileName: input?.fileName, units: input?.units }),
    { error: "Couldn't save that batch. Check the connection and try again." },
  );
}
