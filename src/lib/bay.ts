import "server-only";

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { enterShop, systemDb, withShop } from "@/db";
import { auditLog, bayDevices, bayPairings, sessions, users } from "@/db/schema";
import { takeAttempt } from "@/lib/attempts";
import type { CurrentUser } from "@/lib/session";

// Shared bay tablets. A manager pairs a tablet by typing a one-time code
// (made on their own screen) into the tablet. The tablet then holds a random
// token in an HttpOnly cookie, and only PIN sign-in works on it.

// Secure cookies need https, which Vercel always has; local runs use http.
const secure = process.env.VERCEL === "1" || (process.env.BETTER_AUTH_URL ?? "").startsWith("https://");

export const BAY_COOKIE = secure ? "__Host-fd-bay" : "fd-bay";

// Browsers cap cookie lifetime at 400 days; it's renewed on every PIN sign-in.
export const BAY_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export const bayCookieOptions = {
  httpOnly: true,
  secure,
  sameSite: "lax" as const,
  path: "/",
  maxAge: BAY_COOKIE_MAX_AGE,
};

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PAIRING_ATTEMPT_LIMIT = 10;
const PAIRING_WINDOW_MS = 15 * 60 * 1000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export type BayDevice = { id: string; shopId: string; name: string };

// The tablet a cookie token belongs to, if it's paired and not removed.
export async function findDeviceByToken(token: string | undefined): Promise<BayDevice | null> {
  if (!token || token.length > 200) return null;
  const [device] = await systemDb
    .select({ id: bayDevices.id, shopId: bayDevices.shopId, name: bayDevices.name })
    .from(bayDevices)
    .where(and(eq(bayDevices.tokenHash, sha256(token)), isNull(bayDevices.revokedAt)));
  return device ?? null;
}

// Whether a cookie token belongs to this device (constant-time comparison).
export function tokenMatches(token: string | undefined, tokenHash: string | null) {
  if (!token || !tokenHash) return false;
  const a = Buffer.from(sha256(token), "hex");
  const b = Buffer.from(tokenHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Crockford base32: no I, L, O or U, so codes are easy to read out and type.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newPairingCode() {
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function normalizePairingCode(input: string) {
  return input
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[^0-9A-Z]/g, "");
}

async function audit(
  tx: Parameters<Parameters<typeof systemDb.transaction>[0]>[0],
  actor: { shopId: string; userId: string | null },
  action: string,
  deviceId: string,
  details: Record<string, unknown>,
) {
  await tx.insert(auditLog).values({
    shopId: actor.shopId,
    actorUserId: actor.userId,
    action,
    targetType: "device",
    targetId: deviceId,
    details,
  });
}

// Makes a one-time pairing code for a new tablet, or for re-pairing an
// existing one (a replaced tablet, or one whose browser lost its cookie).
// Any earlier unused code for that tablet stops working.
export async function createPairingCode(
  actor: CurrentUser,
  target: { name: string } | { deviceId: string },
): Promise<{ code: string; deviceId: string; name: string } | { error: string }> {
  const code = newPairingCode();
  return systemDb.transaction(async (tx) => {
    let device: { id: string; name: string } | undefined;
    if ("name" in target) {
      const name = target.name.trim();
      if (!name || name.length > 40) return { error: "Give the tablet a short name, like Bay 3." };
      [device] = await tx
        .insert(bayDevices)
        .values({ shopId: actor.shop.id, name, createdByUserId: actor.id })
        .returning({ id: bayDevices.id, name: bayDevices.name });
    } else {
      [device] = await tx
        .select({ id: bayDevices.id, name: bayDevices.name })
        .from(bayDevices)
        .where(
          and(
            eq(bayDevices.id, target.deviceId),
            eq(bayDevices.shopId, actor.shop.id),
            isNull(bayDevices.revokedAt),
          ),
        );
      if (!device) return { error: "That tablet doesn't exist." };
    }
    await tx.delete(bayPairings).where(eq(bayPairings.deviceId, device.id));
    await tx.insert(bayPairings).values({
      deviceId: device.id,
      codeHash: sha256(normalizePairingCode(code)),
      expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS),
    });
    await enterShop(tx, actor.shop.id);
    await audit(tx, { shopId: actor.shop.id, userId: actor.id }, "device.pairing_code", device.id, {
      name: device.name,
    });
    return { code, deviceId: device.id, name: device.name };
  });
}

export type PairResult = { token: string; device: BayDevice } | { error: string };

// Uses up a pairing code and gives the tablet its token. Limited per address
// so codes can't be guessed.
export async function redeemPairingCode(input: string, ip: string): Promise<PairResult> {
  const attempt = await takeAttempt(`bay-pair|${ip}`, PAIRING_ATTEMPT_LIMIT, PAIRING_WINDOW_MS);
  if (!attempt.allowed) {
    return { error: "Too many tries. Wait a few minutes, then try again." };
  }
  const code = normalizePairingCode(input);
  if (code.length !== 8) return { error: "Pairing codes are 8 letters and numbers, like ABCD-1234." };

  const token = randomBytes(32).toString("base64url");
  return systemDb.transaction(async (tx): Promise<PairResult> => {
    const [pairing] = await tx
      .delete(bayPairings)
      .where(and(eq(bayPairings.codeHash, sha256(code)), gt(bayPairings.expiresAt, new Date())))
      .returning({ deviceId: bayPairings.deviceId });
    if (!pairing) return { error: "That code isn't right or has expired. Ask for a new one." };

    const [device] = await tx
      .update(bayDevices)
      .set({ tokenHash: sha256(token), pairedAt: new Date() })
      .where(and(eq(bayDevices.id, pairing.deviceId), isNull(bayDevices.revokedAt)))
      .returning({ id: bayDevices.id, shopId: bayDevices.shopId, name: bayDevices.name });
    if (!device) return { error: "That tablet was removed. Ask for a new code." };

    // Re-pairing replaces the old token, so anything signed in with it ends.
    await tx.delete(sessions).where(eq(sessions.deviceId, device.id));
    await enterShop(tx, device.shopId);
    await audit(tx, { shopId: device.shopId, userId: null }, "device.paired", device.id, {
      name: device.name,
    });
    return { token, device };
  });
}

export type DeviceSummary = {
  id: string;
  name: string;
  createdByName: string | null;
  createdAt: Date;
  pairedAt: Date | null;
  lastUsedAt: Date | null;
};

export function listDevices(shopId: string): Promise<DeviceSummary[]> {
  return withShop(shopId, (tx) =>
    tx
      .select({
        id: bayDevices.id,
        name: bayDevices.name,
        createdByName: users.name,
        createdAt: bayDevices.createdAt,
        pairedAt: bayDevices.pairedAt,
        lastUsedAt: bayDevices.lastUsedAt,
      })
      .from(bayDevices)
      .leftJoin(users, eq(users.id, bayDevices.createdByUserId))
      .where(isNull(bayDevices.revokedAt))
      .orderBy(asc(bayDevices.name)),
  );
}

export type DeviceActivity = {
  id: string;
  action: string;
  actorName: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
};

export function listDeviceActivity(shopId: string, limit = 10): Promise<DeviceActivity[]> {
  return withShop(shopId, (tx) =>
    tx
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actorName: users.name,
        details: auditLog.details,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(eq(auditLog.targetType, "device"))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit),
  );
}

// Removes a tablet: its token stops working and anyone signed in on it is
// signed out. Only finds tablets in the actor's shop.
export async function removeDevice(
  actor: CurrentUser,
  id: string,
): Promise<{ ok: true; name: string } | { error: string }> {
  return systemDb.transaction(async (tx) => {
    await enterShop(tx, actor.shop.id);
    const [device] = await tx
      .update(bayDevices)
      .set({ revokedAt: new Date() })
      .where(and(eq(bayDevices.id, id), isNull(bayDevices.revokedAt)))
      .returning({ id: bayDevices.id, name: bayDevices.name });
    if (!device) return { error: "That tablet doesn't exist." };
    await audit(tx, { shopId: actor.shop.id, userId: actor.id }, "device.removed", device.id, {
      name: device.name,
    });
    // Back to the owner role for the tables app_user can't touch.
    await tx.execute(sql`reset role`);
    await tx.delete(sessions).where(eq(sessions.deviceId, device.id));
    await tx.delete(bayPairings).where(eq(bayPairings.deviceId, device.id));
    return { ok: true as const, name: device.name };
  });
}

// Ends one session on this tablet, if it's still there. Unlike signing out,
// it names the session, so it can't end whoever signed in after it.
export async function endDeviceSession(deviceId: string, sessionId: string) {
  await systemDb
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.deviceId, deviceId)));
}

// Records that a tablet was just used, and renews nothing else.
export async function touchDevice(id: string) {
  await systemDb.update(bayDevices).set({ lastUsedAt: new Date() }).where(eq(bayDevices.id, id));
}
