// Checks staff account management: everything stays inside the admin's shop,
// the shop always keeps an admin, and disabling or resetting signs people
// out. Needs DATABASE_URL pointing at a disposable Postgres database; run
// with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { accounts, sessions, shops, users } from "../src/db/schema";
import type { CurrentUser } from "../src/lib/session";
import {
  createStaffMember,
  endSessionsStartedBefore,
  getStaffMember,
  listAccountActivity,
  listStaff,
  resetStaffPassword,
  setStaffDisabled,
  updateStaffMember,
} from "../src/lib/staff";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-staff-tests-only-0123456789";

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
let adminA: CurrentUser;
let adminB: CurrentUser;

async function createShopWithAdmin(code: string): Promise<CurrentUser> {
  const [shop] = await systemDb
    .insert(shops)
    .values({ code, name: `Shop ${code}` })
    .returning({ id: shops.id, code: shops.code, name: shops.name });
  const id = randomUUID();
  await systemDb.insert(users).values({
    id,
    shopId: shop.id,
    role: "admin",
    name: "Admin",
    username: `${code}.boss`,
    displayUsername: "boss",
    email: `${randomUUID()}@no-email.invalid`,
  });
  return { id, name: "Admin", username: "boss", role: "admin", shop };
}

async function addSession(userId: string) {
  await systemDb.insert(sessions).values({
    id: randomUUID(),
    userId,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  });
}

async function sessionCount(userId: string) {
  const rows = await systemDb.select().from(sessions).where(eq(sessions.userId, userId));
  return rows.length;
}

async function addTech(admin: CurrentUser, username: string) {
  const result = await createStaffMember(admin, {
    name: `Tech ${username}`,
    username,
    role: "tech",
    password: "starting-pass-1",
  });
  assert.ok("ok" in result, JSON.stringify(result));
  return result.id!;
}

before(async () => {
  adminA = await createShopWithAdmin(`sa${suffix}`);
  adminB = await createShopWithAdmin(`sb${suffix}`);
});

after(async () => {
  await systemDb.delete(shops).where(eq(shops.id, adminA.shop.id));
  await systemDb.delete(shops).where(eq(shops.id, adminB.shop.id));
  await systemDb.$client.end();
});

describe("adding staff", () => {
  test("adds them to the admin's own shop with a password", async () => {
    const id = await addTech(adminA, "Mike");
    const [row] = await systemDb.select().from(users).where(eq(users.id, id));
    assert.equal(row.shopId, adminA.shop.id);
    assert.equal(row.username, `${adminA.shop.code}.mike`);
    assert.equal(row.displayUsername, "mike");
    const [account] = await systemDb.select().from(accounts).where(eq(accounts.userId, id));
    assert.equal(account.providerId, "credential");
    assert.ok(account.password && account.password !== "starting-pass-1");

    assert.ok((await listStaff(adminA.shop.id)).some((m) => m.id === id));
    assert.ok(!(await listStaff(adminB.shop.id)).some((m) => m.id === id));
  });

  test("usernames only have to be unique within a shop", async () => {
    const again = await createStaffMember(adminA, {
      name: "Other Mike",
      username: "MIKE",
      role: "tech",
      password: "starting-pass-1",
    });
    assert.ok("error" in again);
    await addTech(adminB, "mike");
  });

  test("two admins adding the same username at once get a clear message", async () => {
    const results = await Promise.all(
      [1, 2].map((n) =>
        createStaffMember(adminA, {
          name: `Racer ${n}`,
          username: "racer",
          role: "tech",
          password: "starting-pass-1",
        }),
      ),
    );
    assert.equal(results.filter((r) => "ok" in r).length, 1);
    assert.match(JSON.stringify(results), /already has the username racer/);
  });

  test("rejects bad input", async () => {
    for (const input of [
      { name: "", username: "ok", role: "tech", password: "starting-pass-1" },
      { name: "X", username: "no spaces", role: "tech", password: "starting-pass-1" },
      { name: "X", username: "fine", role: "owner", password: "starting-pass-1" },
      { name: "X", username: "fine", role: "tech", password: "short" },
    ]) {
      assert.ok("error" in (await createStaffMember(adminA, input)), JSON.stringify(input));
    }
  });
});

describe("changing accounts", () => {
  test("can't reach accounts in another shop", async () => {
    const otherTech = await addTech(adminB, "dana");
    assert.equal(await getStaffMember(adminA.shop.id, otherTech), null);
    assert.ok("error" in (await updateStaffMember(adminA, otherTech, { name: "Hacked", role: "admin" })));
    assert.ok("error" in (await setStaffDisabled(adminA, otherTech, true)));
    assert.ok("error" in (await resetStaffPassword(adminA, otherTech, "new-password-1")));
    const member = await getStaffMember(adminB.shop.id, otherTech);
    assert.equal(member?.name, "Tech dana");
    assert.equal(member?.role, "tech");
    assert.equal(member?.disabled, false);
  });

  test("updates name and role and records it", async () => {
    const id = await addTech(adminA, "sam");
    assert.ok("ok" in (await updateStaffMember(adminA, id, { name: "Sam Smith", role: "parts" })));
    const member = await getStaffMember(adminA.shop.id, id);
    assert.equal(member?.name, "Sam Smith");
    assert.equal(member?.role, "parts");

    const activity = await listAccountActivity(adminA.shop.id, 50);
    assert.ok(activity.some((e) => e.action === "account.updated" && e.targetId === id));
    const otherShop = await listAccountActivity(adminB.shop.id, 50);
    assert.ok(!otherShop.some((e) => e.targetId === id));
  });

  test("admins can't change their own role or disable themselves", async () => {
    assert.ok("error" in (await updateStaffMember(adminA, adminA.id, { name: "Admin", role: "tech" })));
    assert.ok("error" in (await setStaffDisabled(adminA, adminA.id, true)));
    assert.ok("error" in (await resetStaffPassword(adminA, adminA.id, "new-password-1")));
  });

  test("two admins demoting each other at once still leaves one admin", async () => {
    const secondId = await addTech(adminA, "second");
    await updateStaffMember(adminA, secondId, { name: "Second", role: "admin" });
    const second: CurrentUser = { ...adminA, id: secondId, name: "Second", username: "second" };

    // Hold the table until both changes are under way, so they really
    // overlap instead of happening to run one after the other.
    const blocker = await systemDb.$client.connect();
    await blocker.query("begin");
    await blocker.query("lock table users in exclusive mode");
    const racing = Promise.all([
      updateStaffMember(adminA, secondId, { name: "Second", role: "tech" }),
      updateStaffMember(second, adminA.id, { name: "Admin", role: "tech" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await blocker.query("commit");
    blocker.release();
    const results = await racing;
    assert.equal(results.filter((r) => "ok" in r).length, 1);
    const admins = (await listStaff(adminA.shop.id)).filter((m) => m.role === "admin");
    assert.equal(admins.length, 1);

    // Put shop A back to adminA as its only admin for the remaining tests.
    if (admins[0].id !== adminA.id) {
      await systemDb.update(users).set({ role: "admin" }).where(eq(users.id, adminA.id));
      await systemDb.update(users).set({ role: "tech" }).where(eq(users.id, secondId));
    }
  });

  test("disabling signs them out and blocks them; enabling restores", async () => {
    const id = await addTech(adminA, "pat");
    await addSession(id);
    assert.ok("ok" in (await setStaffDisabled(adminA, id, true)));
    assert.equal((await getStaffMember(adminA.shop.id, id))?.disabled, true);
    assert.equal(await sessionCount(id), 0);

    assert.ok("ok" in (await setStaffDisabled(adminA, id, false)));
    assert.equal((await getStaffMember(adminA.shop.id, id))?.disabled, false);
  });

  test("resetting a password changes it, signs them out and records it", async () => {
    const id = await addTech(adminA, "lee");
    const [before] = await systemDb.select().from(accounts).where(eq(accounts.userId, id));
    await addSession(id);
    assert.ok("ok" in (await resetStaffPassword(adminA, id, "brand-new-pass-2")));
    const [afterReset] = await systemDb.select().from(accounts).where(eq(accounts.userId, id));
    assert.notEqual(afterReset.password, before.password);
    assert.equal(await sessionCount(id), 0);
    const activity = await listAccountActivity(adminA.shop.id, 50);
    assert.ok(activity.some((e) => e.action === "account.password_reset" && e.targetId === id));
  });

  test("the follow-up sweep ends only sessions that started before the cutoff", async () => {
    const id = await addTech(adminA, "sweep");
    const cutoff = new Date();
    await systemDb.insert(sessions).values([
      { id: randomUUID(), userId: id, token: randomUUID(), expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(cutoff.getTime() - 1000) },
      { id: randomUUID(), userId: id, token: randomUUID(), expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(cutoff.getTime() + 1000) },
    ]);
    await endSessionsStartedBefore(id, cutoff);
    assert.equal(await sessionCount(id), 1);
  });
});

describe("database rules for app code", () => {
  test("can't move an account to another shop", async () => {
    const id = await addTech(adminA, "mover");
    await assert.rejects(
      withShop(adminA.shop.id, (tx) =>
        tx.update(users).set({ shopId: adminB.shop.id }).where(eq(users.id, id)),
      ),
      (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501",
    );
  });

  test("can't change or delete the activity log", async () => {
    for (const statement of [`update "audit_log" set "action" = 'x'`, `delete from "audit_log"`]) {
      await assert.rejects(
        withShop(adminA.shop.id, (tx) => tx.execute(sql.raw(statement))),
        (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501",
        statement,
      );
    }
  });
});
