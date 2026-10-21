"use server";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { count, eq, sql } from "drizzle-orm";

import { systemDb } from "@/db";
import { shops } from "@/db/schema";
import { getAuth } from "@/lib/auth";
import {
  COMPANY_CODE_PATTERN,
  USERNAME_PATTERN,
  normalizeCompanyCode,
  normalizeUsername,
  storedUsername,
} from "@/lib/usernames";

// SHA-256 of the one-time setup code, which was given to the owner directly.
// It only works until the first shop exists.
const SETUP_CODE_SHA256 = "256412afe622daf75f864bc0a36f0e6be0a7c6b9b57226f23c9ef0a4eb8fb257";

export type SetupState = {
  error?: string;
  done?: { companyCode: string; username: string };
};

function setupCodeMatches(input: string) {
  const normalized = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
  const actual = createHash("sha256").update(normalized).digest();
  return timingSafeEqual(actual, Buffer.from(SETUP_CODE_SHA256, "hex"));
}

// Creates the first shop and its admin account.
export async function setUpShop(_previous: SetupState, form: FormData): Promise<SetupState> {
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const shopName = field("shopName");
  const companyCode = normalizeCompanyCode(field("companyCode"));
  const name = field("name");
  const username = normalizeUsername(field("username"));
  const password = String(form.get("password") ?? "");

  if (!setupCodeMatches(field("setupCode"))) return { error: "That setup code isn't right." };
  if (!shopName || !name) return { error: "Fill in every field." };
  if (!COMPANY_CODE_PATTERN.test(companyCode)) {
    return { error: "Company code must be 2–16 letters or numbers." };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return { error: "Username must be 2–30 letters, numbers, dots or underscores." };
  }
  if (password.length < 8 || password.length > 128) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== String(form.get("confirmPassword") ?? "")) {
    return { error: "The passwords don't match." };
  }

  // The lock makes two setups submitted at once take turns, so only one wins.
  const shop = await systemDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('first-run-setup'))`);
    const [{ total }] = await tx.select({ total: count() }).from(shops);
    if (total > 0) return null;
    const [created] = await tx
      .insert(shops)
      .values({ code: companyCode, name: shopName })
      .returning({ id: shops.id });
    return created;
  });
  if (!shop) return { error: "This app is already set up. Sign in instead." };

  try {
    const auth = await getAuth().$context;
    const user = await auth.internalAdapter.createUser({
      name,
      email: `${randomUUID()}@no-email.invalid`,
      emailVerified: false,
      username: storedUsername(companyCode, username),
      displayUsername: username,
      shopId: shop.id,
      role: "admin",
    }, { method: "admin" });
    await auth.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await auth.password.hash(password),
    });
  } catch (error) {
    console.error("First-run setup couldn't create the admin account", error);
    // Deleting the shop also removes a half-created user, so setup can be retried.
    await systemDb.delete(shops).where(eq(shops.id, shop.id));
    return { error: "Couldn't create your account. Try again." };
  }

  return { done: { companyCode, username } };
}
