import "server-only";

import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";

import { enterShop, systemDb, withShop } from "@/db";
import { accounts, auditLog, bayDevices, sessions, staffPins, users, type Role } from "@/db/schema";
import { checkPin } from "@/lib/pin-rules";
import type { CurrentUser } from "@/lib/session";
import { clearSignInAttempts, takeSignInAttempt } from "@/lib/sign-in-throttle";
import { storedUsername } from "@/lib/usernames";

// Bay tablet PINs: setting, removing and unlocking them, and checking one at
// sign-in with the wrong-PIN limits.

export const SHORT_LOCK_AFTER = 5; // wrong PINs in a row
export const SHORT_LOCK_MS = 15 * 60 * 1000;
export const HARD_LOCK_AFTER = 10; // wrong PINs in 24 hours

export type PinStatus = {
  hasPin: boolean;
  setAt: Date | null;
  lockedUntil: Date | null; // a 15-minute lock that ends by itself
  hardLocked: boolean; // stays locked until unlocked
};

type Result = { ok: true } | { error: string };

const statusColumns = {
  userId: staffPins.userId,
  pinSetAt: staffPins.pinSetAt,
  lockedUntil: staffPins.lockedUntil,
  lockedAt: staffPins.lockedAt,
};

function toStatus(row?: { pinSetAt: Date; lockedUntil: Date | null; lockedAt: Date | null }): PinStatus {
  if (!row) return { hasPin: false, setAt: null, lockedUntil: null, hardLocked: false };
  return {
    hasPin: true,
    setAt: row.pinSetAt,
    lockedUntil: row.lockedUntil && row.lockedUntil > new Date() ? row.lockedUntil : null,
    hardLocked: row.lockedAt !== null,
  };
}

export function isLocked(status: PinStatus) {
  return status.hardLocked || status.lockedUntil !== null;
}

export async function getPinStatus(shopId: string, userId: string): Promise<PinStatus> {
  const [row] = await withShop(shopId, (tx) =>
    tx.select(statusColumns).from(staffPins).where(eq(staffPins.userId, userId)),
  );
  return toStatus(row);
}

export type LockedPin = { userId: string; name: string; role: Role; status: PinStatus };

export async function listLockedPins(shopId: string): Promise<LockedPin[]> {
  const rows = await withShop(shopId, (tx) =>
    tx
      .select({ ...statusColumns, name: users.name, role: users.role })
      .from(staffPins)
      .innerJoin(users, eq(users.id, staffPins.userId))
      .where(or(isNotNull(staffPins.lockedAt), gt(staffPins.lockedUntil, new Date())))
      .orderBy(asc(users.name)),
  );
  return rows.map((row) => ({ userId: row.userId, name: row.name, role: row.role, status: toStatus(row) }));
}

export type PinPerson = { id: string; name: string; username: string; locked: boolean };

// Active staff with a PIN, for the tablet's name buttons.
export async function listPinPeople(shopId: string): Promise<PinPerson[]> {
  const rows = await withShop(shopId, (tx) =>
    tx
      .select({ id: users.id, name: users.name, username: users.displayUsername, ...statusColumns })
      .from(staffPins)
      .innerJoin(users, eq(users.id, staffPins.userId))
      .where(isNull(users.disabledAt))
      .orderBy(asc(users.name)),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    username: row.username ?? "",
    locked: isLocked(toStatus(row)),
  }));
}

async function audit(
  tx: Parameters<Parameters<typeof systemDb.transaction>[0]>[0],
  shopId: string,
  actorUserId: string | null,
  action: string,
  targetUserId: string,
  details: Record<string, unknown>,
) {
  await tx.insert(auditLog).values({
    shopId,
    actorUserId,
    action,
    targetType: "user",
    targetId: targetUserId,
    details,
  });
}

// The target must be an account in the actor's own shop.
async function findTarget(actor: CurrentUser, userId: string) {
  const [target] = await withShop(actor.shop.id, (tx) =>
    tx
      .select({ id: users.id, username: users.displayUsername, role: users.role })
      .from(users)
      .where(eq(users.id, userId)),
  );
  return target ?? null;
}

// PIN sessions on bay tablets end whenever the PIN changes.
async function endBaySessions(tx: Parameters<Parameters<typeof systemDb.transaction>[0]>[0], userId: string) {
  await tx.delete(sessions).where(and(eq(sessions.userId, userId), isNotNull(sessions.deviceId)));
}

export async function setPin(actor: CurrentUser, userId: string, pin: string): Promise<Result> {
  const problem = checkPin(pin);
  if (problem) return { error: problem };
  const target = await findTarget(actor, userId);
  if (!target) return { error: "That account doesn't exist." };

  // Better Auth's own password hashing (scrypt with a salt), used directly so
  // this file doesn't import the auth setup, which imports it.
  const pinHash = await hashPassword(pin);
  await systemDb.transaction(async (tx) => {
    const now = new Date();
    const fresh = {
      pinHash,
      pinSetAt: now,
      consecutiveFailures: 0,
      dailyFailures: 0,
      dailyWindowStartedAt: now,
      lockedUntil: null,
      lockedAt: null,
      failuresSinceSignIn: 0,
      lastFailedAt: null,
      lastFailedDeviceId: null,
    };
    await tx
      .insert(staffPins)
      .values({ userId, shopId: actor.shop.id, ...fresh })
      .onConflictDoUpdate({
        target: staffPins.userId,
        set: fresh,
        setWhere: eq(staffPins.shopId, actor.shop.id),
      });
    await endBaySessions(tx, userId);
    await enterShop(tx, actor.shop.id);
    await audit(tx, actor.shop.id, actor.id, "pin.set", userId, {
      username: target.username,
      by: userId === actor.id ? "self" : "admin",
    });
  });
  return { ok: true };
}

export async function removePin(actor: CurrentUser, userId: string): Promise<Result> {
  const target = await findTarget(actor, userId);
  if (!target) return { error: "That account doesn't exist." };
  await systemDb.transaction(async (tx) => {
    await tx
      .delete(staffPins)
      .where(and(eq(staffPins.userId, userId), eq(staffPins.shopId, actor.shop.id)));
    await endBaySessions(tx, userId);
    await enterShop(tx, actor.shop.id);
    await audit(tx, actor.shop.id, actor.id, "pin.removed", userId, {
      username: target.username,
      by: userId === actor.id ? "self" : "admin",
    });
  });
  return { ok: true };
}

// Managers may unlock anyone but admins; admins may unlock anyone.
export async function unlockPin(actor: CurrentUser, userId: string): Promise<Result> {
  const target = await findTarget(actor, userId);
  if (!target) return { error: "That account doesn't exist." };
  if (target.role === "admin" && actor.role !== "admin") {
    return { error: "Only an admin can unlock an admin's PIN." };
  }
  await systemDb.transaction(async (tx) => {
    await tx
      .update(staffPins)
      .set({ consecutiveFailures: 0, dailyFailures: 0, lockedUntil: null, lockedAt: null })
      .where(and(eq(staffPins.userId, userId), eq(staffPins.shopId, actor.shop.id)));
    await enterShop(tx, actor.shop.id);
    await audit(tx, actor.shop.id, actor.id, "pin.unlocked", userId, { username: target.username });
  });
  return { ok: true };
}

// Signing in with the password proves who you are, so it clears PIN locks.
export async function clearPinLocks(userId: string) {
  await systemDb
    .update(staffPins)
    .set({ consecutiveFailures: 0, dailyFailures: 0, lockedUntil: null, lockedAt: null, failuresSinceSignIn: 0 })
    .where(eq(staffPins.userId, userId));
}

// Checks someone's own password before they change their PIN. Counts toward
// the same per-account limit as signing in.
export async function verifyOwnPassword(user: CurrentUser, password: string): Promise<Result> {
  const loginName = storedUsername(user.shop.code, user.username);
  const attempt = await takeSignInAttempt(loginName);
  if (!attempt.allowed) return { error: "Too many wrong passwords. Wait 15 minutes, then try again." };
  const [account] = await systemDb
    .select({ password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential")));
  const ok = account?.password ? await verifyPassword({ hash: account.password, password }) : false;
  if (!ok) return { error: "Your password is wrong." };
  await clearSignInAttempts(loginName);
  return { ok: true };
}

export type PinCheck =
  | { kind: "ok"; userId: string; warning: { count: number; lastAt: Date; deviceName: string | null } | null }
  | { kind: "wrong"; triesLeft: number }
  // `checked`: the PIN was checked (and wrong) before the lock applied.
  | { kind: "locked"; until: Date | null; checked: boolean }
  | { kind: "unknown" };

// Checks a PIN typed on a bay tablet. The attempt is counted *before* the PIN
// is checked, in the same statement that applies any lock, so even many
// requests at once get no more guesses than the limits allow.
export async function checkPinForSignIn(
  device: { id: string; shopId: string },
  userId: string,
  pin: string,
  verify: (hash: string, pin: string) => Promise<boolean>,
): Promise<PinCheck> {
  const [person] = await systemDb
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.shopId, device.shopId), isNull(users.disabledAt)));
  if (!person) return { kind: "unknown" };

  const counted = await systemDb.execute<{
    pin_hash: string;
    consecutive_failures: number;
    daily_failures: number;
  }>(sql`
    update ${staffPins} set
      daily_failures = case when daily_window_started_at <= now() - interval '24 hours' then 1
                            else daily_failures + 1 end,
      daily_window_started_at = case when daily_window_started_at <= now() - interval '24 hours' then now()
                                     else daily_window_started_at end,
      consecutive_failures = consecutive_failures + 1,
      locked_until = case when consecutive_failures + 1 >= ${SHORT_LOCK_AFTER}
                          then now() + ${`${SHORT_LOCK_MS / 1000} seconds`}::interval
                          else locked_until end,
      locked_at = case when (case when daily_window_started_at <= now() - interval '24 hours' then 1
                                  else daily_failures + 1 end) >= ${HARD_LOCK_AFTER}
                       then now() else locked_at end
    where user_id = ${userId} and shop_id = ${device.shopId}
      and locked_at is null and (locked_until is null or locked_until <= now())
    returning pin_hash, consecutive_failures, daily_failures
  `);
  const row = counted.rows[0];
  if (!row) {
    const [current] = await systemDb
      .select({ lockedUntil: staffPins.lockedUntil, lockedAt: staffPins.lockedAt })
      .from(staffPins)
      .where(and(eq(staffPins.userId, userId), eq(staffPins.shopId, device.shopId)));
    if (!current) return { kind: "unknown" };
    return { kind: "locked", until: current.lockedAt ? null : current.lockedUntil, checked: false };
  }

  if (await verify(row.pin_hash, pin)) {
    // Right PIN: this try doesn't count, and nothing stays locked. Wrong tries
    // earlier today still count toward the daily limit.
    const [before] = await systemDb
      .select({
        failuresSinceSignIn: staffPins.failuresSinceSignIn,
        lastFailedAt: staffPins.lastFailedAt,
        deviceName: bayDevices.name,
      })
      .from(staffPins)
      .leftJoin(bayDevices, eq(bayDevices.id, staffPins.lastFailedDeviceId))
      .where(eq(staffPins.userId, userId));
    await systemDb
      .update(staffPins)
      .set({
        consecutiveFailures: 0,
        dailyFailures: sql`greatest(${staffPins.dailyFailures} - 1, 0)`,
        lockedUntil: null,
        lockedAt: null,
        failuresSinceSignIn: 0,
      })
      .where(eq(staffPins.userId, userId));
    // Typos just now on this tablet are the person's own; only warn about
    // wrong tries that look like someone else's.
    const recentTypos =
      before?.lastFailedAt && Date.now() - before.lastFailedAt.getTime() < 2 * 60 * 1000;
    const warning =
      before && before.failuresSinceSignIn > 0 && before.lastFailedAt && !recentTypos
        ? { count: before.failuresSinceSignIn, lastAt: before.lastFailedAt, deviceName: before.deviceName }
        : null;
    return { kind: "ok", userId, warning };
  }

  await systemDb.transaction(async (tx) => {
    await tx
      .update(staffPins)
      .set({
        failuresSinceSignIn: sql`${staffPins.failuresSinceSignIn} + 1`,
        lastFailedAt: new Date(),
        lastFailedDeviceId: device.id,
      })
      .where(eq(staffPins.userId, userId));
    const lockedNow =
      row.daily_failures >= HARD_LOCK_AFTER
        ? "hard"
        : row.consecutive_failures >= SHORT_LOCK_AFTER
          ? "15min"
          : null;
    if (lockedNow) {
      await enterShop(tx, device.shopId);
      await audit(tx, device.shopId, null, "pin.locked", userId, { kind: lockedNow, deviceId: device.id });
    }
  });
  if (row.daily_failures >= HARD_LOCK_AFTER) return { kind: "locked", until: null, checked: true };
  if (row.consecutive_failures >= SHORT_LOCK_AFTER) {
    return { kind: "locked", until: new Date(Date.now() + SHORT_LOCK_MS), checked: true };
  }
  return {
    kind: "wrong",
    triesLeft: Math.min(SHORT_LOCK_AFTER - row.consecutive_failures, HARD_LOCK_AFTER - row.daily_failures),
  };
}
