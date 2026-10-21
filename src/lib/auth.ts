import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { username } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import { systemDb } from "@/db";
import * as schema from "@/db/schema";
import { BAY_COOKIE, findDeviceByToken } from "@/lib/bay";
import { PIN_SIGN_IN_PATH, bayPinSignIn } from "@/lib/bay-pin-plugin";
import { clearPinLocks } from "@/lib/pins";
import { clearSignInAttempts, takeSignInAttempt } from "@/lib/sign-in-throttle";
import { MAX_STORED_USERNAME_LENGTH } from "@/lib/usernames";

const PRODUCTION_URL = "https://www.forcediagnostics.ai";

const SIGN_IN_PATH = "/sign-in/username";
const CHANGE_PASSWORD_PATH = "/change-password";

// The only Better Auth endpoints the app uses. Everything else it ships
// (email sign-in, sign-up, profile edits, password checks, social accounts…)
// answers 404, including endpoints added by future Better Auth versions.
const ALLOWED_PATHS = new Set([
  SIGN_IN_PATH,
  PIN_SIGN_IN_PATH,
  "/sign-out",
  "/get-session",
  CHANGE_PASSWORD_PATH,
]);

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

        if (ctx.path === CHANGE_PASSWORD_PATH) {
          // A PIN is weaker than a password, so it can't be used to change one.
          const current = await getSessionFromCtx(ctx);
          if (current?.session.deviceId) {
            throw APIError.from("FORBIDDEN", {
              code: "PIN_SESSION",
              message: "Change your password from a computer or your phone.",
            });
          }
        }

        if (ctx.path !== SIGN_IN_PATH || typeof ctx.body?.username !== "string") return;
        // Bay tablets are PIN only, so no password gets typed (or saved by
        // the browser) on a shared tablet.
        if (await findDeviceByToken(ctx.getCookie(BAY_COOKIE) ?? undefined)) {
          throw APIError.from("FORBIDDEN", {
            code: "BAY_TABLET",
            message: "This is a bay tablet. Use Switch user with PIN.",
          });
        }
        const attempt = await takeSignInAttempt(ctx.body.username);
        if (!attempt.allowed) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many sign-in attempts for this account. Try again later.",
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_IN_PATH || typeof ctx.body?.username !== "string") return;
        if (isAPIError(ctx.context.returned)) return;
        await clearSignInAttempts(ctx.body.username);
        // Signing in with the password proves who you are, so a locked PIN
        // unlocks too.
        const userId = ctx.context.newSession?.user.id;
        if (userId) await clearPinLocks(userId);
      }),
    },
    user: {
      additionalFields: {
        shopId: { type: "string", required: true, input: false },
        role: { type: "string", required: true, input: false },
        homeLocationId: { type: "string", required: false, input: false },
      },
    },
    session: {
      additionalFields: {
        // The bay tablet a PIN session belongs to. No default value: Better
        // Auth would apply it over the one the PIN endpoint passes.
        deviceId: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            // Disabled accounts can't start a session by any route. Checked
            // after the password, so only someone who knows it learns the
            // account is disabled.
            const [user] = await systemDb
              .select({ disabledAt: schema.users.disabledAt })
              .from(schema.users)
              .where(eq(schema.users.id, session.userId));
            if (!user || user.disabledAt) {
              throw APIError.from("FORBIDDEN", {
                code: "ACCOUNT_DISABLED",
                message: "This account is disabled.",
              });
            }
            // On a bay tablet, every session must be a PIN session for that
            // tablet, whatever route created it.
            const device = await findDeviceByToken(context?.getCookie(BAY_COOKIE) ?? undefined);
            const deviceId = (session as { deviceId?: string | null }).deviceId ?? null;
            if (device && deviceId !== device.id) {
              throw APIError.from("FORBIDDEN", {
                code: "BAY_TABLET",
                message: "This is a bay tablet. Use Switch user with PIN.",
              });
            }
          },
        },
      },
    },
    // Per IP. Loose enough for a whole shop signing in from one connection;
    // the per-account and per-tablet limits stop guessing.
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        [SIGN_IN_PATH]: { window: 60, max: 30 },
        [PIN_SIGN_IN_PATH]: { window: 60, max: 120 },
      },
    },
    plugins: [username({ maxUsernameLength: MAX_STORED_USERNAME_LENGTH }), bayPinSignIn()],
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
