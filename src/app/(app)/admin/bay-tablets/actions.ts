"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";

import { PAIRING_CODE_TTL_MS, createPairingCode, removeDevice } from "@/lib/bay";
import { unlockPin } from "@/lib/pins";
import { requireCapability } from "@/lib/session";

export type TabletState = {
  error?: string;
  success?: string;
  pairing?: { code: string; name: string; expiresAt: string };
};

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

async function attempt(what: string, run: () => Promise<TabletState>): Promise<TabletState> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return { error: "Couldn't save that. Check the connection and try again." };
  }
}

export async function addTablet(_previous: TabletState, form: FormData): Promise<TabletState> {
  return attempt("add a tablet", async () => {
    const actor = await requireCapability("bay_tablets.manage");
    const result = await createPairingCode(actor, { name: field(form, "name") });
    if ("error" in result) return { error: result.error };
    refresh();
    return {
      pairing: { code: result.code, name: result.name, expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString() },
    };
  });
}

export async function repairTablet(_previous: TabletState, form: FormData): Promise<TabletState> {
  return attempt("make a pairing code", async () => {
    const actor = await requireCapability("bay_tablets.manage");
    const result = await createPairingCode(actor, { deviceId: field(form, "id") });
    if ("error" in result) return { error: result.error };
    return {
      pairing: { code: result.code, name: result.name, expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString() },
    };
  });
}

export async function removeTablet(_previous: TabletState, form: FormData): Promise<TabletState> {
  return attempt("remove a tablet", async () => {
    const actor = await requireCapability("bay_tablets.manage");
    const result = await removeDevice(actor, field(form, "id"));
    if ("error" in result) return { error: result.error };
    // The tablet's row goes away, so confirm at the top of the page.
    redirect(`/admin/bay-tablets?removed=${encodeURIComponent(result.name)}`);
  });
}

export async function unlockStaffPin(_previous: TabletState, form: FormData): Promise<TabletState> {
  return attempt("unlock a PIN", async () => {
    const actor = await requireCapability("bay_tablets.manage");
    const result = await unlockPin(actor, field(form, "userId"));
    if ("error" in result) return { error: result.error };
    refresh();
    return { success: "PIN unlocked." };
  });
}
