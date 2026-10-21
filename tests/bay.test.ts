// Bay tablets end to end: pairing, PIN sign-in through the real Better Auth
// handler, the wrong-PIN limits, and that tablets, PINs and sessions stay
// inside their own shop. Needs DATABASE_URL pointing at a disposable Postgres
// database; run with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, bayPairings, sessions, shops, staffPins, users } from "../src/db/schema";
import { getAuth } from "../src/lib/auth";
import { BAY_COOKIE, createPairingCode, endDeviceSession, redeemPairingCode, removeDevice } from "../src/lib/bay";
import { removePin, setPin, unlockPin } from "../src/lib/pins";
import type { CurrentUser } from "../src/lib/session";
import { createStaffMember } from "../src/lib/staff";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-bay-tests-only-0123456789ab";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

const BASE = "http://localhost:3000";
const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
let ipCounter = 1;
const nextIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

type Reply = { status: number; body: Record<string, unknown>; cookies: Record<string, string> };

async function call(
  path: string,
  body: unknown,
  { cookie = "", origin = BASE }: { cookie?: string; origin?: string } = {},
): Promise<Reply> {
  const response = await getAuth().handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", cookie, "x-forwarded-for": nextIp() },
      body: JSON.stringify(body),
    }),
  );
  const cookies: Record<string, string> = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    cookies[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown>, cookies };
}

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
  return { id, name: "Admin", username: "boss", role: "admin", shop, bay: null };
}

async function addStaff(admin: CurrentUser, username: string, role = "tech") {
  const result = await createStaffMember(admin, { name: username, username, role, password: "starting-pass-1" });
  assert.ok("ok" in result, JSON.stringify(result));
  return result.id!;
}

async function pairTablet(admin: CurrentUser, name: string) {
  const pairing = await createPairingCode(admin, { name });
  assert.ok("code" in pairing);
  const paired = await redeemPairingCode(pairing.code, nextIp());
  assert.ok("token" in paired, JSON.stringify(paired));
  return { token: paired.token, id: paired.device.id, cookie: `${BAY_COOKIE}=${paired.token}` };
}

const pinSignIn = (cookie: string, userId: string, pin: string) => call("/sign-in/pin", { userId, pin }, { cookie });

// Stand-ins for time passing: a 15-minute lock running out, and wrong tries
// long enough ago that they aren't the person's own typos.
const lockRunsOut = (userId: string) =>
  systemDb
    .update(staffPins)
    .set({ lockedUntil: sql`case when locked_until is null then null else now() - interval '1 second' end` })
    .where(eq(staffPins.userId, userId));
const movePinFailuresBack = (userId: string) =>
  systemDb
    .update(staffPins)
    .set({
      lastFailedAt: sql`last_failed_at - interval '1 hour'`,
      earlierFailedAt: sql`earlier_failed_at - interval '1 hour'`,
    })
    .where(eq(staffPins.userId, userId));

let adminA: CurrentUser;
let adminB: CurrentUser;
let techA: string;
let techB: string;
let tablet: Awaited<ReturnType<typeof pairTablet>>;

before(async () => {
  adminA = await createShopWithAdmin(`ba${suffix}`);
  adminB = await createShopWithAdmin(`bb${suffix}`);
  techA = await addStaff(adminA, "mike");
  techB = await addStaff(adminB, "dana");
  tablet = await pairTablet(adminA, "Bay 1");
});

after(async () => {
  await systemDb.delete(shops).where(eq(shops.id, adminA.shop.id));
  await systemDb.delete(shops).where(eq(shops.id, adminB.shop.id));
  await systemDb.$client.end();
});

describe("pairing", () => {
  test("a code works once, in any case, with or without the dash", async () => {
    const pairing = await createPairingCode(adminA, { name: "Bay 2" });
    assert.ok("code" in pairing);
    const typed = pairing.code.replace("-", " ").toLowerCase();
    assert.ok("token" in (await redeemPairingCode(typed, nextIp())));
    assert.ok("error" in (await redeemPairingCode(pairing.code, nextIp())));
  });

  test("expired and wrong codes don't work", async () => {
    const pairing = await createPairingCode(adminA, { name: "Bay 3" });
    assert.ok("code" in pairing);
    await systemDb
      .update(bayPairings)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bayPairings.deviceId, pairing.deviceId));
    assert.ok("error" in (await redeemPairingCode(pairing.code, nextIp())));
    assert.ok("error" in (await redeemPairingCode("ZZZZ-ZZZZ", nextIp())));
  });

  test("guessing codes from one address is limited", async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++) await redeemPairingCode("ZZZZ-ZZZZ", ip);
    const pairing = await createPairingCode(adminA, { name: "Bay 4" });
    assert.ok("code" in pairing);
    const result = await redeemPairingCode(pairing.code, ip);
    assert.ok("error" in result && result.error.startsWith("Too many"));
  });

  test("an admin can't make codes for, or remove, another shop's tablet", async () => {
    assert.ok("error" in (await createPairingCode(adminB, { deviceId: tablet.id })));
    assert.ok("error" in (await removeDevice(adminB, tablet.id)));
  });
});

describe("PIN sign-in", () => {
  before(async () => {
    assert.ok("ok" in (await setPin(adminA, techA, "4829")));
    assert.ok("ok" in (await setPin(adminB, techB, "7316")));
  });

  test("signs in with the tablet cookie and ties the session to the tablet", async () => {
    const reply = await pinSignIn(tablet.cookie, techA, "4829");
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const sessionCookie = Object.keys(reply.cookies).find((name) => name.includes("session_token"));
    assert.ok(sessionCookie, "sets a session cookie");
    assert.ok(reply.cookies[BAY_COOKIE], "renews the tablet cookie");

    const rows = await systemDb.select().from(sessions).where(eq(sessions.userId, techA));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].deviceId, tablet.id);
    assert.equal(reply.body.sessionId, rows[0].id, "tells the page its session");
    const hours = (rows[0].expiresAt.getTime() - Date.now()) / 3_600_000;
    assert.ok(hours > 11.9 && hours <= 12, `expires in ${hours}h`);
  });

  test("needs the tablet cookie and our own origin", async () => {
    assert.equal((await pinSignIn("", techA, "4829")).body.code, "NOT_A_BAY_TABLET");
    assert.equal((await pinSignIn(`${BAY_COOKIE}=nope`, techA, "4829")).body.code, "NOT_A_BAY_TABLET");
    const foreign = await call("/sign-in/pin", { userId: techA, pin: "4829" }, { cookie: tablet.cookie, origin: "https://evil.example" });
    assert.equal(foreign.status, 403);
  });

  test("someone from another shop can't sign in on this tablet", async () => {
    const reply = await pinSignIn(tablet.cookie, techB, "7316");
    assert.equal(reply.status, 401);
    assert.equal(reply.body.code, "INVALID_PIN");
  });

  test("password sign-in is refused on a bay tablet", async () => {
    const reply = await call(
      "/sign-in/username",
      { username: `${adminA.shop.code}.mike`, password: "starting-pass-1" },
      { cookie: tablet.cookie },
    );
    assert.equal(reply.status, 403);
    assert.equal(reply.body.code, "BAY_TABLET");
  });

  test("a PIN session can't change the password", async () => {
    const signedIn = await pinSignIn(tablet.cookie, techA, "4829");
    const sessionCookie = Object.entries(signedIn.cookies)
      .filter(([name]) => name.includes("session_token") || name.includes("dont_remember"))
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    const reply = await call(
      "/change-password",
      { currentPassword: "starting-pass-1", newPassword: "another-pass-2" },
      { cookie: `${tablet.cookie}; ${sessionCookie}` },
    );
    assert.equal(reply.status, 403);
    assert.equal(reply.body.code, "PIN_SESSION");
  });
});

describe("wrong PINs", () => {
  test("five in a row lock the PIN for 15 minutes; then even the right PIN waits", async () => {
    const id = await addStaff(adminA, "wrong5");
    await setPin(adminA, id, "3071");
    // Its own tablet: each tablet has its own wrong-PIN limit.
    const tablet = await pairTablet(adminA, "Wrong5 tablet");
    for (let i = 1; i <= 4; i++) {
      const reply = await pinSignIn(tablet.cookie, id, "9999");
      assert.equal(reply.body.code, "INVALID_PIN");
      assert.equal(reply.body.triesLeft, 5 - i);
    }
    const fifth = await pinSignIn(tablet.cookie, id, "9999");
    assert.equal(fifth.body.code, "PIN_LOCKED");
    const minutes = (new Date(String(fifth.body.until)).getTime() - Date.now()) / 60000;
    assert.ok(minutes > 14 && minutes <= 15);
    assert.equal((await pinSignIn(tablet.cookie, id, "3071")).body.code, "PIN_LOCKED");
  });

  test("after a 15-minute lock runs out, the count starts again", async () => {
    const id = await addStaff(adminA, "relock");
    await setPin(adminA, id, "3071");
    const tablet = await pairTablet(adminA, "Relock tablet");
    for (let i = 0; i < 5; i++) await pinSignIn(tablet.cookie, id, "9999");
    await lockRunsOut(id);
    const next = await pinSignIn(tablet.cookie, id, "9999");
    assert.equal(next.body.code, "INVALID_PIN");
    assert.equal(next.body.triesLeft, 4);
  });

  test("ten in a day lock it until someone unlocks it, even across right PINs", async () => {
    const id = await addStaff(adminA, "wrong10");
    await setPin(adminA, id, "3071");
    // Its own tablet: each tablet has its own wrong-PIN limit.
    const tablet = await pairTablet(adminA, "Wrong10 tablet");
    for (let i = 0; i < 4; i++) await pinSignIn(tablet.cookie, id, "9999");
    assert.equal((await pinSignIn(tablet.cookie, id, "3071")).status, 200);
    // Five more in a row (nine today) lock it for 15 minutes...
    for (let i = 0; i < 5; i++) await pinSignIn(tablet.cookie, id, "9999");
    await lockRunsOut(id);
    // ...and the tenth locks it until someone unlocks it.
    const tenth = await pinSignIn(tablet.cookie, id, "9999");
    assert.equal(tenth.body.code, "PIN_LOCKED");
    assert.equal(tenth.body.until, null);
    await lockRunsOut(id);
    assert.equal((await pinSignIn(tablet.cookie, id, "3071")).body.code, "PIN_LOCKED");
    assert.ok("ok" in (await unlockPin(adminA, id)));
    assert.equal((await pinSignIn(tablet.cookie, id, "3071")).status, 200);
  });

  test("a PIN lock in the activity log names the person", async () => {
    const id = await addStaff(adminA, "lognamed");
    await setPin(adminA, id, "3071");
    const tablet = await pairTablet(adminA, "Lognamed tablet");
    for (let i = 0; i < 5; i++) await pinSignIn(tablet.cookie, id, "9999");
    const [entry] = await systemDb
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.action, "pin.locked"), eq(auditLog.targetId, id)));
    assert.equal(entry?.details.username, "lognamed");
  });

  test("many guesses at once get no more than five checks", async () => {
    const id = await addStaff(adminA, "burst");
    await setPin(adminA, id, "3071");
    const other = await pairTablet(adminA, "Burst tablet");
    const replies = await Promise.all(Array.from({ length: 12 }, () => pinSignIn(other.cookie, id, "9999")));
    const checked = replies.filter((r) => r.body.code === "INVALID_PIN").length;
    assert.ok(checked <= 4, `${checked} wrong replies`);
    const [row] = await systemDb.select().from(staffPins).where(eq(staffPins.userId, id));
    assert.ok(row.consecutiveFailures <= 5, `${row.consecutiveFailures} counted`);
  });

  test("a tablet pauses after 15 wrong PINs across everyone", async () => {
    const pausing = await pairTablet(adminA, "Pausing tablet");
    const people = await Promise.all([1, 2, 3, 4].map((n) => addStaff(adminA, `spray${n}`)));
    for (const id of people) await setPin(adminA, id, "3071");
    for (const id of people.slice(0, 3)) {
      for (let i = 0; i < 5; i++) await pinSignIn(pausing.cookie, id, "9999");
    }
    const reply = await pinSignIn(pausing.cookie, people[3], "3071");
    assert.equal(reply.body.code, "TABLET_PAUSED");
    // Other tablets keep working.
    assert.equal((await pinSignIn(tablet.cookie, people[3], "3071")).status, 200);
  });

  test("wrong tries by someone else are reported at the next sign-in", async () => {
    const id = await addStaff(adminA, "warned");
    await setPin(adminA, id, "3071");
    // Its own tablet: each tablet has its own wrong-PIN limit.
    const tablet = await pairTablet(adminA, "Warned tablet");
    await pinSignIn(tablet.cookie, id, "9999");
    await pinSignIn(tablet.cookie, id, "9998");
    await systemDb
      .update(staffPins)
      .set({ lastFailedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(staffPins.userId, id));
    const reply = await pinSignIn(tablet.cookie, id, "3071");
    assert.equal(reply.status, 200);
    assert.equal((reply.body.warning as { count: number }).count, 2);
    assert.equal((await pinSignIn(tablet.cookie, id, "3071")).body.warning, null);
  });

  test("your own typo just before signing in doesn't hide earlier wrong tries", async () => {
    const other = await pairTablet(adminA, "Typo other tablet");
    const here = await pairTablet(adminA, "Typo tablet");
    // Someone tried two PINs a while ago, on another tablet or on this one.
    for (const [n, earlier] of [other, here].entries()) {
      const id = await addStaff(adminA, `typo${n}`);
      await setPin(adminA, id, "3071");
      await pinSignIn(earlier.cookie, id, "9999");
      await pinSignIn(earlier.cookie, id, "9998");
      await movePinFailuresBack(id);
      // Now the person mistypes here, then gets it right.
      assert.equal((await pinSignIn(here.cookie, id, "9997")).body.code, "INVALID_PIN");
      const reply = await pinSignIn(here.cookie, id, "3071");
      const warning = reply.body.warning as { count: number; deviceName: string } | null;
      assert.equal(warning?.count, 2, "the earlier tries, not the typo");
      assert.equal(warning?.deviceName, earlier === other ? "Typo other tablet" : "Typo tablet");
    }
  });

  test("a wrong try on another tablet just before is still reported", async () => {
    const id = await addStaff(adminA, "nearby");
    await setPin(adminA, id, "3071");
    const other = await pairTablet(adminA, "Nearby other tablet");
    const here = await pairTablet(adminA, "Nearby tablet");
    await pinSignIn(other.cookie, id, "9999");
    const reply = await pinSignIn(here.cookie, id, "3071");
    assert.equal((reply.body.warning as { count: number })?.count, 1);
  });

  test("a password sign-in doesn't erase the wrong-try report", async () => {
    const id = await addStaff(adminA, "reported");
    await setPin(adminA, id, "3071");
    const tablet = await pairTablet(adminA, "Reported tablet");
    await pinSignIn(tablet.cookie, id, "9999");
    await pinSignIn(tablet.cookie, id, "9998");
    await movePinFailuresBack(id);
    const signIn = await call("/sign-in/username", { username: `${adminA.shop.code}.reported`, password: "starting-pass-1" });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
    const reply = await pinSignIn(tablet.cookie, id, "3071");
    assert.equal((reply.body.warning as { count: number })?.count, 2);
  });

  test("a password sign-in elsewhere unlocks the PIN", async () => {
    const id = await addStaff(adminA, "unlockme");
    await setPin(adminA, id, "3071");
    // Its own tablet: each tablet has its own wrong-PIN limit.
    const tablet = await pairTablet(adminA, "Unlockme tablet");
    for (let i = 0; i < 5; i++) await pinSignIn(tablet.cookie, id, "9999");
    const signIn = await call("/sign-in/username", { username: `${adminA.shop.code}.unlockme`, password: "starting-pass-1" });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
    assert.equal((await pinSignIn(tablet.cookie, id, "3071")).status, 200);
  });
});

describe("keeping shops and secrets apart", () => {
  test("PIN changes only reach the admin's own shop", async () => {
    assert.ok("error" in (await setPin(adminA, techB, "4829")));
    assert.ok("error" in (await removePin(adminA, techB)));
    assert.ok("error" in (await unlockPin(adminA, techB)));
    const [row] = await systemDb.select().from(staffPins).where(eq(staffPins.userId, techB));
    assert.ok(row, "shop B's PIN is still there");
  });

  test("a PIN row can't point at another shop", async () => {
    await assert.rejects(
      systemDb.insert(staffPins).values({ userId: techB, shopId: adminA.shop.id, pinHash: "x" }),
    );
  });

  test("PIN rules apply when setting a PIN", async () => {
    assert.ok("error" in (await setPin(adminA, techA, "1234")));
  });

  test("managers can't unlock an admin's PIN", async () => {
    const managerId = await addStaff(adminA, "manny", "manager");
    const manager: CurrentUser = { ...adminA, id: managerId, name: "manny", username: "manny", role: "manager" };
    assert.ok("error" in (await unlockPin(manager, adminA.id)));
  });

  test("app code can't read PIN hashes or tablet tokens", async () => {
    for (const statement of ["select pin_hash from staff_pins", "select token_hash from bay_devices"]) {
      await assert.rejects(
        withShop(adminA.shop.id, (tx) => tx.execute(sql.raw(statement))),
        (error: Error & { cause?: { code?: string } }) => error.cause?.code === "42501",
        statement,
      );
    }
    const statuses = await withShop(adminA.shop.id, (tx) =>
      tx.select({ userId: staffPins.userId, shopId: staffPins.shopId }).from(staffPins),
    );
    assert.ok(statuses.length > 0);
    assert.ok(statuses.every((s) => s.shopId === adminA.shop.id));
  });

  test("ending a session by id only ends that session, on its own tablet", async () => {
    const mine = await pairTablet(adminA, "End mine tablet");
    const other = await pairTablet(adminA, "End other tablet");
    const first = await pinSignIn(mine.cookie, techA, "4829");
    const sessionId = String(first.body.sessionId);
    await endDeviceSession(other.id, sessionId);
    assert.equal((await systemDb.select().from(sessions).where(eq(sessions.id, sessionId))).length, 1);
    await endDeviceSession(mine.id, sessionId);
    assert.equal((await systemDb.select().from(sessions).where(eq(sessions.id, sessionId))).length, 0);
  });

  test("removing a tablet signs everyone out of it and stops its cookie", async () => {
    const doomed = await pairTablet(adminA, "Doomed tablet");
    assert.equal((await pinSignIn(doomed.cookie, techA, "4829")).status, 200);
    assert.ok("ok" in (await removeDevice(adminA, doomed.id)));
    const left = await systemDb.select().from(sessions).where(and(eq(sessions.deviceId, doomed.id)));
    assert.equal(left.length, 0);
    assert.equal((await pinSignIn(doomed.cookie, techA, "4829")).body.code, "NOT_A_BAY_TABLET");
  });
});
