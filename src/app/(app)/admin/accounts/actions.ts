"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { after } from "next/server";

import { removePin, setPin, unlockPin } from "@/lib/pins";
import { requireCapability } from "@/lib/session";
import {
  SIGN_IN_GRACE_MS,
  createStaffMember,
  endSessionsStartedBefore,
  resetStaffPassword,
  setStaffDisabled,
  updateStaffMember,
} from "@/lib/staff";

export type FormState = { error?: string; success?: string };

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

// Every action re-checks the permission: server actions can be called
// directly, not just from these pages. Unexpected failures (a dropped
// database connection, say) come back as a message in the form instead of an
// error page; Next.js's own redirects pass straight through.
async function attempt(what: string, run: () => Promise<FormState>): Promise<FormState> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    // A DrizzleQueryError's message lists the query parameters, which can
    // include password hashes, so only log the underlying database error.
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return { error: "Couldn't save that. Check the connection and try again." };
  }
}

export async function addStaff(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("add a staff member", async () => {
    const admin = await requireCapability("accounts.manage");
    const result = await createStaffMember(admin, {
      name: field(form, "name"),
      username: field(form, "username"),
      role: field(form, "role"),
      password: field(form, "password"),
    });
    if ("error" in result) return { error: result.error };
    redirect(`/admin/accounts?added=${encodeURIComponent(result.id ?? "")}`);
  });
}

export async function saveDetails(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("save account details", async () => {
    const admin = await requireCapability("accounts.manage");
    const result = await updateStaffMember(admin, field(form, "id"), {
      name: field(form, "name"),
      role: field(form, "role"),
    });
    if ("error" in result) return { error: result.error };
    refresh();
    return { success: "Saved." };
  });
}

export async function resetPassword(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("reset a password", async () => {
    const admin = await requireCapability("accounts.manage");
    const id = field(form, "id");
    const result = await resetStaffPassword(admin, id, field(form, "password"));
    if ("error" in result) return { error: result.error };
    // Catch a sign-in with the old password that was mid-way when we reset.
    const cutoff = new Date(Date.now() + SIGN_IN_GRACE_MS);
    after(async () => {
      await new Promise((resolve) => setTimeout(resolve, SIGN_IN_GRACE_MS));
      await endSessionsStartedBefore(id, cutoff);
    });
    return {
      success: "Password reset. They've been signed out everywhere. Their bay tablet PIN still works; remove it below if needed.",
    };
  });
}

export async function setDisabled(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("change account access", async () => {
    const admin = await requireCapability("accounts.manage");
    const disable = field(form, "disable") === "true";
    const result = await setStaffDisabled(admin, field(form, "id"), disable);
    if ("error" in result) return { error: result.error };
    refresh();
    return { success: disable ? "Account disabled and signed out." : "Account turned back on." };
  });
}

export async function adminSetPin(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("set a PIN", async () => {
    const admin = await requireCapability("accounts.manage");
    const pin = field(form, "pin");
    if (pin !== field(form, "confirmPin")) return { error: "The PINs don't match." };
    const result = await setPin(admin, field(form, "id"), pin);
    if ("error" in result) return { error: result.error };
    refresh();
    return { success: "PIN saved. Tell them what it is; they can change it on their account page." };
  });
}

export async function adminRemovePin(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("remove a PIN", async () => {
    const admin = await requireCapability("accounts.manage");
    const result = await removePin(admin, field(form, "id"));
    if ("error" in result) return { error: result.error };
    refresh();
    return { success: "PIN removed." };
  });
}

export async function adminUnlockPin(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt("unlock a PIN", async () => {
    const admin = await requireCapability("accounts.manage");
    const result = await unlockPin(admin, field(form, "id"));
    if ("error" in result) return { error: result.error };
    refresh();
    return { success: "PIN unlocked." };
  });
}
