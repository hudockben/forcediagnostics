"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { cookies, headers } from "next/headers";

import { getAuth } from "@/lib/auth";
import { BAY_COOKIE, bayCookieOptions, redeemPairingCode } from "@/lib/bay";

export type PairState = { error?: string; paired?: string };

// Pairs this browser as a bay tablet with a code from System Admin > Bay
// tablets. Whoever was signed in here is signed out first.
export async function pairTablet(_previous: PairState, form: FormData): Promise<PairState> {
  try {
    const requestHeaders = await headers();
    const ip = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (session) await (await auth.$context).internalAdapter.deleteSession(session.session.token);

    const result = await redeemPairingCode(String(form.get("code") ?? ""), ip);
    if ("error" in result) return { error: result.error };
    (await cookies()).set(BAY_COOKIE, result.token, bayCookieOptions);
    return { paired: result.device.name };
  } catch (error) {
    console.error("Couldn't pair a tablet", error instanceof DrizzleQueryError ? error.cause : error);
    return { error: "Couldn't pair right now. Check the Wi-Fi and try again." };
  }
}
