import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins";

import { systemDb } from "@/db";
import * as schema from "@/db/schema";
import { MAX_STORED_USERNAME_LENGTH } from "@/lib/usernames";

const PRODUCTION_URL = "https://www.forcediagnostics.ai";

const vercelOrigins = [
  process.env.VERCEL_URL,
  process.env.VERCEL_BRANCH_URL,
  process.env.VERCEL_PROJECT_PRODUCTION_URL,
]
  .filter(Boolean)
  .map((host) => `https://${host}`);

function createAuth() {
  return betterAuth({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL:
      process.env.BETTER_AUTH_URL ??
      (process.env.VERCEL_ENV === "production"
        ? PRODUCTION_URL
        : process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000"),
    trustedOrigins: [PRODUCTION_URL, "https://forcediagnostics.ai", ...vercelOrigins],
    database: drizzleAdapter(systemDb, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        rateLimit: schema.rateLimits,
      },
    }),
    // Accounts are created by a shop admin (or first-run setup), never by
    // sign-up, and staff sign in with a username rather than an email.
    emailAndPassword: { enabled: true, disableSignUp: true },
    disabledPaths: [
      "/sign-up/email",
      "/sign-in/email",
      "/is-username-available",
      "/update-user",
      "/change-email",
      "/request-password-reset",
      "/reset-password",
    ],
    user: {
      additionalFields: {
        shopId: { type: "string", required: true, input: false },
        role: { type: "string", required: true, input: false },
        homeLocationId: { type: "string", required: false, input: false },
      },
    },
    rateLimit: { enabled: true, storage: "database" },
    plugins: [username({ maxUsernameLength: MAX_STORED_USERNAME_LENGTH })],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

// Created on first use rather than at import, so builds don't need the auth
// secret and a missing secret fails the request that needs it, not the build.
export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}
