"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";

import { removePin, setPin, verifyOwnPassword } from "@/lib/pins";
import { getCurrentUser } from "@/lib/session";

export type PinFormState = { error?: string; success?: string };

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

async function attempt(what: string, run: () => Promise<PinFormState>): Promise<PinFormState> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return { error: "Couldn't save that. Check the connection and try again." };
  }
}

// Setting or removing your own PIN needs your password, and isn't possible
// from a PIN session on a bay tablet.
async function signedInWithPassword() {
  const user = await getCurrentUser();
  return user.bay ? null : user;
}

export async function setOwnPin(_previous: PinFormState, form: FormData): Promise<PinFormState> {
  return attempt("set a PIN", async () => {
    const user = await signedInWithPassword();
    if (!user) return { error: "Change your PIN from a computer or your phone." };
    const pin = field(form, "pin");
    if (pin !== field(form, "confirmPin")) return { error: "The PINs don't match." };
    const password = await verifyOwnPassword(user, field(form, "password"));
    if ("error" in password) return password;
    const result = await setPin(user, user.id, pin);
    if ("error" in result) return result;
    refresh();
    return { success: "PIN saved. Use it to switch in on any bay tablet." };
  });
}

export async function removeOwnPin(_previous: PinFormState, form: FormData): Promise<PinFormState> {
  return attempt("remove a PIN", async () => {
    const user = await signedInWithPassword();
    if (!user) return { error: "Remove your PIN from a computer or your phone." };
    const password = await verifyOwnPassword(user, field(form, "password"));
    if ("error" in password) return password;
    const result = await removePin(user, user.id);
    if ("error" in result) return result;
    refresh();
    return { success: "PIN removed." };
  });
}
