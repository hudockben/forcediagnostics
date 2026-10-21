import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { username } from "better-auth/plugins";

import { systemDb } from "@/db";
import * as schema from "@/db/schema";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  clearSignInAttempts,
  recordSignInAttempt,
} from "@/lib/sign-in-throttle";
import { MAX_STORED_USERNAME_LENGTH } from "@/lib/usernames";

const PRODUCTION_URL = "https://www.forcediagnostics.ai";

// The only Better Auth endpoints the app uses. Everything else it ships
// (email sign-in, sign-up, profile edits, password checks, social accounts…)
// answers 404, including endpoints added by future Better Auth versions.
const ALLOWED_PATHS = new Set(["/sign-in/username", "/sign-out", "/get-session", "/change-password"]);

const SIGN_IN_PATH = "/sign-in/username";

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
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!ALLOWED_PATHS.has(ctx.path)) throw new APIError("NOT_FOUND");
        if (ctx.path !== SIGN_IN_PATH || typeof ctx.body?.username !== "string") return;
        const attempts = await recordSignInAttempt(ctx.body.username);
        if (attempts > ACCOUNT_ATTEMPT_LIMIT) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many sign-in attempts for this account. Try again later.",
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_IN_PATH || typeof ctx.body?.username !== "string") return;
        if (!isAPIError(ctx.context.returned)) await clearSignInAttempts(ctx.body.username);
      }),
    },
    user: {
      additionalFields: {
        shopId: { type: "string", required: true, input: false },
        role: { type: "string", required: true, input: false },
        homeLocationId: { type: "string", required: false, input: false },
      },
    },
    // Per IP. Loose enough for a whole shop signing in from one connection at
    // shift start; the per-account limit above stops password guessing.
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: { [SIGN_IN_PATH]: { window: 60, max: 30 } },
    },
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
