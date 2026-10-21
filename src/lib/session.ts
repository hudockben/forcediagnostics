import "server-only";

import { eq, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { systemDb, withShop } from "@/db";
import { bayDevices, sessions, shops, users, type Role } from "@/db/schema";
import { getAuth } from "@/lib/auth";
import { BAY_COOKIE, findDeviceByToken, tokenMatches } from "@/lib/bay";
import { PIN_SESSION_MAX_MS } from "@/lib/bay-pin-plugin";
import { can, needsPasswordSession, type Capability } from "@/lib/permissions";

// The tablet locks itself after 5 idle minutes; the server ends the session
// a minute later in case the tablet couldn't (asleep, offline, closed). The
// tablet reports activity at least every BAY_HEARTBEAT_MS while in use.
export const BAY_IDLE_MS = 5 * 60 * 1000;
export const BAY_HEARTBEAT_MS = 30 * 1000;
const BAY_SERVER_IDLE_MS = BAY_IDLE_MS + 60 * 1000;
const LAST_SEEN_WRITE_EVERY_MS = 60 * 1000;

export type CurrentUser = {
  id: string;
  name: string;
  username: string;
  role: Role;
  shop: { id: string; code: string; name: string };
  // Set for PIN sessions on a bay tablet.
  bay: { deviceId: string; deviceName: string; sessionId: string } | null;
};

export type SessionLookup = { user: CurrentUser } | { redirectTo: "/" | "/bay" };

async function endSession(token: string) {
  await (await getAuth().$context).internalAdapter.deleteSession(token);
}

// Looks up the signed-in user without redirecting (for route handlers).
export const lookupCurrentUser = cache(async (): Promise<SessionLookup> => {
  // Read the request first: it ends prerendering, so the build never starts auth.
  const requestHeaders = await headers();
  const bayToken = (await cookies()).get(BAY_COOKIE)?.value;
  const signedOut = { redirectTo: bayToken ? ("/bay" as const) : ("/" as const) };

  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return signedOut;
  const deviceId = (session.session as { deviceId?: string | null }).deviceId ?? null;

  let bay: CurrentUser["bay"] = null;
  if (deviceId) {
    // A PIN session only counts on its own tablet, while that tablet is
    // paired, for at most a shift, and while someone is using it.
    const [row] = await systemDb
      .select({
        tokenHash: bayDevices.tokenHash,
        revokedAt: bayDevices.revokedAt,
        deviceName: bayDevices.name,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .innerJoin(bayDevices, eq(bayDevices.id, sessions.deviceId))
      .where(eq(sessions.id, session.session.id));
    const now = Date.now();
    const valid =
      row &&
      !row.revokedAt &&
      tokenMatches(bayToken, row.tokenHash) &&
      now - session.session.createdAt.getTime() < PIN_SESSION_MAX_MS &&
      now - row.lastSeenAt.getTime() < BAY_SERVER_IDLE_MS;
    if (!valid) {
      await endSession(session.session.token);
      return { redirectTo: "/bay" };
    }
    if (now - row.lastSeenAt.getTime() > LAST_SEEN_WRITE_EVERY_MS) {
      await systemDb
        .update(sessions)
        .set({ lastSeenAt: sql`now()` })
        .where(eq(sessions.id, session.session.id));
    }
    bay = { deviceId, deviceName: row.deviceName, sessionId: session.session.id };
  } else if (bayToken && (await findDeviceByToken(bayToken))) {
    // Bay tablets only allow PIN sessions; anything else left over ends.
    await endSession(session.session.token);
    return { redirectTo: "/bay" };
  }

  // Role and disabled state come from the database on every request, so an
  // admin's change takes effect straight away. Row-level security limits both
  // queries to the user's own shop.
  const record = await withShop(session.user.shopId, async (tx) => {
    const [shop] = await tx
      .select({ id: shops.id, code: shops.code, name: shops.name })
      .from(shops);
    const [user] = await tx
      .select({
        name: users.name,
        displayUsername: users.displayUsername,
        role: users.role,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(eq(users.id, session.user.id));
    return shop && user ? { shop, user } : null;
  });
  if (!record || record.user.disabledAt) return signedOut;

  return {
    user: {
      id: session.user.id,
      name: record.user.name,
      username: record.user.displayUsername ?? session.user.username ?? "",
      role: record.user.role,
      shop: record.shop,
      bay,
    },
  };
});

// Records that someone is using a bay tablet right now (its heartbeat).
export async function recordBayActivity(sessionId: string) {
  await systemDb.update(sessions).set({ lastSeenAt: sql`now()` }).where(eq(sessions.id, sessionId));
}

// The signed-in user and their shop. Redirects to sign-in (or the tablet's
// PIN screen) when there is no valid session, so pages and server actions can
// rely on getting a user back.
export async function getCurrentUser(): Promise<CurrentUser> {
  const result = await lookupCurrentUser();
  if ("redirectTo" in result) redirect(result.redirectTo);
  return result.user;
}

// Whether this user, signed in the way they are, may use a capability. Admin
// areas need a password sign-in, not a PIN.
export function allows(user: CurrentUser, capability: Capability) {
  if (user.bay && needsPasswordSession(capability)) return false;
  return can(user.role, capability);
}

// For pages and server actions that need a permission: sends anyone without
// it back to the Home tab.
export async function requireCapability(capability: Capability): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!allows(user, capability)) redirect("/home");
  return user;
}
