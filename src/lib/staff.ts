import "server-only";

import { randomUUID } from "node:crypto";

import { DrizzleQueryError, and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { systemDb, withShop, type ShopTransaction } from "@/db";
import { ROLES, auditLog, users, type Role } from "@/db/schema";
import { getAuth } from "@/lib/auth";
import type { CurrentUser } from "@/lib/session";
import { USERNAME_PATTERN, normalizeUsername, storedUsername } from "@/lib/usernames";

// Staff account management for System Admin > Accounts. Callers must check
// the accounts.manage capability first; every function here also limits
// itself to the acting admin's shop.

export type StaffMember = {
  id: string;
  name: string;
  username: string;
  role: Role;
  disabled: boolean;
  createdAt: Date;
};

export type Result = { ok: true } | { error: string };

export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_NAME_LENGTH = 80;

const staffColumns = {
  id: users.id,
  name: users.name,
  username: users.displayUsername,
  role: users.role,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
};

function toMember(row: {
  id: string;
  name: string;
  username: string | null;
  role: Role;
  disabledAt: Date | null;
  createdAt: Date;
}): StaffMember {
  return {
    id: row.id,
    name: row.name,
    username: row.username ?? "",
    role: row.role,
    disabled: row.disabledAt !== null,
    createdAt: row.createdAt,
  };
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function checkPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return "That password is too long.";
  return null;
}

function checkName(name: string): string | null {
  if (!name) return "Enter a name.";
  if (name.length > MAX_NAME_LENGTH) return "That name is too long.";
  return null;
}

async function audit(
  tx: ShopTransaction,
  actor: CurrentUser,
  action: string,
  targetId: string,
  details: Record<string, unknown>,
) {
  await tx.insert(auditLog).values({
    shopId: actor.shop.id,
    actorUserId: actor.id,
    action,
    targetType: "user",
    targetId,
    details,
  });
}

export function listStaff(shopId: string): Promise<StaffMember[]> {
  return withShop(shopId, async (tx) => {
    const rows = await tx
      .select(staffColumns)
      .from(users)
      .orderBy(sql`${users.disabledAt} is not null`, asc(users.name));
    return rows.map(toMember);
  });
}

export function getStaffMember(shopId: string, id: string): Promise<StaffMember | null> {
  return withShop(shopId, async (tx) => {
    const [row] = await tx.select(staffColumns).from(users).where(eq(users.id, id));
    return row ? toMember(row) : null;
  });
}

export type AuditEntry = {
  id: string;
  action: string;
  actorName: string | null;
  targetId: string;
  details: Record<string, unknown>;
  createdAt: Date;
};

export function listAccountActivity(shopId: string, limit = 15): Promise<AuditEntry[]> {
  return withShop(shopId, (tx) =>
    tx
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actorName: users.name,
        targetId: auditLog.targetId,
        details: auditLog.details,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(eq(auditLog.targetType, "user"))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit),
  );
}

function isUniqueViolation(error: unknown) {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  return (cause as { code?: string } | undefined)?.code === "23505";
}

export async function createStaffMember(
  actor: CurrentUser,
  input: { name: string; username: string; role: string; password: string },
): Promise<Result & { id?: string }> {
  const name = input.name.trim();
  const username = normalizeUsername(input.username);
  const problem =
    checkName(name) ??
    (USERNAME_PATTERN.test(username)
      ? null
      : "Usernames are 2–30 letters, numbers, dots or underscores.") ??
    (isRole(input.role) ? null : "Pick a role.") ??
    checkPassword(input.password);
  if (problem) return { error: problem };

  const stored = storedUsername(actor.shop.code, username);
  const [taken] = await systemDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, stored));
  if (taken) return { error: `Someone at this shop already has the username ${username}.` };

  const auth = await getAuth().$context;
  let userId: string;
  try {
    const user = await auth.internalAdapter.createUser(
      {
        name,
        email: `${randomUUID()}@no-email.invalid`,
        emailVerified: false,
        username: stored,
        displayUsername: username,
        // Always the admin's own shop, never anything from the form.
        shopId: actor.shop.id,
        role: input.role,
      },
      { method: "admin" },
    );
    userId = user.id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { error: `Someone at this shop already has the username ${username}.` };
    }
    throw error;
  }
  try {
    await auth.internalAdapter.linkAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: await auth.password.hash(input.password),
    });
  } catch (error) {
    // Don't leave an account behind that nobody can sign in to.
    await systemDb.delete(users).where(eq(users.id, userId));
    throw error;
  }

  await withShop(actor.shop.id, (tx) =>
    audit(tx, actor, "account.created", userId, { username, role: input.role }),
  );
  return { ok: true, id: userId };
}

// Locks the shop's active admins and the target row for the rest of the
// transaction, so two admins changing each other at once can't leave the shop
// with no admin.
async function lockForChange(tx: ShopTransaction, id: string) {
  const admins = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), isNull(users.disabledAt)))
    .for("update");
  const [target] = await tx.select(staffColumns).from(users).where(eq(users.id, id)).for("update");
  return { activeAdmins: admins.map((a) => a.id), target: target ? toMember(target) : null };
}

export async function updateStaffMember(
  actor: CurrentUser,
  id: string,
  input: { name: string; role: string },
): Promise<Result> {
  const name = input.name.trim();
  const problem = checkName(name) ?? (isRole(input.role) ? null : "Pick a role.");
  if (problem) return { error: problem };
  const role = input.role as Role;

  return withShop(actor.shop.id, async (tx) => {
    const { activeAdmins, target } = await lockForChange(tx, id);
    if (!target) return { error: "That account doesn't exist." };
    if (target.role !== role) {
      if (id === actor.id) return { error: "You can't change your own role." };
      if (target.role === "admin" && !target.disabled && activeAdmins.length <= 1) {
        return { error: "The shop needs at least one admin. Make someone else an admin first." };
      }
    }
    if (target.name === name && target.role === role) return { ok: true };

    await tx.update(users).set({ name, role }).where(eq(users.id, id));
    await audit(tx, actor, "account.updated", id, {
      username: target.username,
      ...(target.name !== name && { name: { from: target.name, to: name } }),
      ...(target.role !== role && { role: { from: target.role, to: role } }),
    });
    return { ok: true };
  });
}

export async function setStaffDisabled(
  actor: CurrentUser,
  id: string,
  disabled: boolean,
): Promise<Result> {
  if (id === actor.id) return { error: "You can't disable your own account." };

  const result = await withShop(actor.shop.id, async (tx): Promise<Result> => {
    const { activeAdmins, target } = await lockForChange(tx, id);
    if (!target) return { error: "That account doesn't exist." };
    if (target.disabled === disabled) return { ok: true };
    if (disabled && target.role === "admin" && activeAdmins.length <= 1) {
      return { error: "The shop needs at least one admin. Make someone else an admin first." };
    }
    await tx
      .update(users)
      .set({ disabledAt: disabled ? new Date() : null })
      .where(eq(users.id, id));
    await audit(tx, actor, disabled ? "account.disabled" : "account.enabled", id, {
      username: target.username,
    });
    return { ok: true };
  });

  // Signs them out everywhere straight away.
  if ("ok" in result && disabled) {
    await (await getAuth().$context).internalAdapter.deleteUserSessions(id);
  }
  return result;
}

export async function resetStaffPassword(
  actor: CurrentUser,
  id: string,
  password: string,
): Promise<Result> {
  if (id === actor.id) {
    return { error: "Use Change password on the Home tab for your own password." };
  }
  const problem = checkPassword(password);
  if (problem) return { error: problem };

  const target = await getStaffMember(actor.shop.id, id);
  if (!target) return { error: "That account doesn't exist." };

  const auth = await getAuth().$context;
  await auth.internalAdapter.updatePassword(id, await auth.password.hash(password));
  // Whoever knew the old password is signed out everywhere.
  await auth.internalAdapter.deleteUserSessions(id);
  await withShop(actor.shop.id, (tx) =>
    audit(tx, actor, "account.password_reset", id, { username: target.username }),
  );
  return { ok: true };
}
