import "server-only";

import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, eq, isNotNull, ne } from "drizzle-orm";

import { systemDb } from "@/db";
import { sessions } from "@/db/schema";
import { giveBackAttempt, takeAttempt } from "@/lib/attempts";
import { BAY_COOKIE, bayCookieOptions, findDeviceByToken, touchDevice } from "@/lib/bay";
import { checkPinForSignIn } from "@/lib/pins";

export const PIN_SIGN_IN_PATH = "/sign-in/pin";

// A shift's worth; PIN sessions also end after a few idle minutes.
export const PIN_SESSION_MAX_MS = 12 * 60 * 60 * 1000;

// Wrong PINs allowed per tablet in a fixed window, across everyone. Stops one
// person working through the whole staff list; at worst it pauses PIN
// sign-in on that tablet for the rest of the window.
const DEVICE_FAILURE_LIMIT = 15;
const DEVICE_WINDOW_MS = 15 * 60 * 1000;

const PIN_PATTERN = /^\d{4,6}$/;

function fail(status: "UNAUTHORIZED" | "FORBIDDEN" | "BAD_REQUEST" | "TOO_MANY_REQUESTS" | "LOCKED", body: Record<string, unknown>) {
  return new APIError(status, body as { code: string; message: string });
}

// POST /api/auth/sign-in/pin { userId, pin }: signs a person in on a paired
// bay tablet. Works only with the tablet's cookie, and creates a normal
// Better Auth session tied to that tablet.
export const bayPinSignIn = () =>
  ({
    id: "bay-pin-sign-in",
    endpoints: {
      signInPin: createAuthEndpoint(PIN_SIGN_IN_PATH, { method: "POST" }, async (ctx) => {
        const device = await findDeviceByToken(ctx.getCookie(BAY_COOKIE) ?? undefined);
        if (!device) {
          throw fail("FORBIDDEN", {
            code: "NOT_A_BAY_TABLET",
            message: "This device isn't paired as a bay tablet.",
          });
        }

        const body = (ctx.body ?? {}) as { userId?: unknown; pin?: unknown };
        const userId = typeof body.userId === "string" ? body.userId : "";
        const pin = typeof body.pin === "string" ? body.pin : "";
        if (!userId || !PIN_PATTERN.test(pin)) {
          throw fail("BAD_REQUEST", { code: "INVALID_REQUEST", message: "Pick your name and enter your PIN." });
        }

        const deviceKey = `pin-device|${device.id}`;
        const slot = await takeAttempt(deviceKey, DEVICE_FAILURE_LIMIT, DEVICE_WINDOW_MS);
        if (!slot.allowed) {
          throw fail("TOO_MANY_REQUESTS", {
            code: "TABLET_PAUSED",
            message: "Too many wrong PINs on this tablet.",
            retryAfterMs: slot.retryAfterMs,
          });
        }

        const check = await checkPinForSignIn(device, userId, pin, (hash, password) =>
          ctx.context.password.verify({ hash, password }),
        );
        if (check.kind === "locked") {
          // Only a wrong PIN counts toward the tablet's limit; a refusal
          // because the PIN was already locked isn't a guess.
          if (!check.checked) await giveBackAttempt(deviceKey);
          throw fail("LOCKED", {
            code: "PIN_LOCKED",
            message: "This PIN is locked.",
            until: check.until?.toISOString() ?? null,
          });
        }
        if (check.kind !== "ok") {
          throw fail("UNAUTHORIZED", {
            code: "INVALID_PIN",
            message: "That PIN isn't right.",
            triesLeft: check.kind === "wrong" ? check.triesLeft : null,
          });
        }
        // Right PINs don't count toward the tablet's limit.
        await giveBackAttempt(deviceKey);

        const user = await ctx.context.internalAdapter.findUserById(check.userId);
        if (!user) throw fail("UNAUTHORIZED", { code: "INVALID_PIN", message: "That PIN isn't right." });

        // End whoever was signed in on this browser, and this person's
        // sessions on other tablets (they've moved here). Their desktop and
        // phone sessions stay.
        const current = await ctx.getSignedCookie(
          ctx.context.authCookies.sessionToken.name,
          ctx.context.secret,
        );
        if (current) await ctx.context.internalAdapter.deleteSession(current);
        await systemDb
          .delete(sessions)
          .where(and(eq(sessions.userId, user.id), isNotNull(sessions.deviceId), ne(sessions.deviceId, device.id)));

        const session = await ctx.context.internalAdapter.createSession(
          user.id,
          true, // a browser-session cookie; Better Auth then won't extend it
          { deviceId: device.id, expiresAt: new Date(Date.now() + PIN_SESSION_MAX_MS) },
          true,
        );
        await setSessionCookie(ctx, { session, user }, true);
        // Keep the tablet's own cookie from expiring while it's in use.
        ctx.setCookie(BAY_COOKIE, ctx.getCookie(BAY_COOKIE)!, bayCookieOptions);
        await touchDevice(device.id);

        return ctx.json({
          ok: true,
          warning: check.warning && {
            count: check.warning.count,
            lastAt: check.warning.lastAt.toISOString(),
            deviceName: check.warning.deviceName,
          },
        });
      }),
    },
  }) satisfies BetterAuthPlugin;
