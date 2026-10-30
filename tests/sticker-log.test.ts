// System Admin > Sticker & Plate log: the rules for a sticker number and the
// CSV (src/lib/sticker-log-rules.ts), and the log itself (src/lib/sticker-
// log.ts): each entry tied to one of the shop's customers (or a new one
// added from the form), a sticker logged once, searching and filtering,
// corrections and removals in audit_log, a customer with stickers kept, and
// nothing reaching another shop.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, customers, shops, stickerPlateLog, users } from "../src/db/schema";
import { createCustomer, removeCustomer } from "../src/lib/customers";
import { ADMIN_SECTIONS, needsPasswordSession } from "../src/lib/permissions";
import type { CurrentUser } from "../src/lib/session";
import {
  exportStickerLog,
  getStickerEntry,
  listStickerLog,
  logSticker,
  recentlyRemoved,
  removeSticker,
  searchCustomersForLog,
  stickersForCustomer,
  updateSticker,
} from "../src/lib/sticker-log";
import { checkStickerEntry, normalizeSticker, parseClassFilter, stickerKey, stickerLogCsv } from "../src/lib/sticker-log-rules";

describe("the rules for a sticker", () => {
  test("sticker numbers are tidied, so one typed two ways is one", () => {
    assert.equal(normalizeSticker(" #a 12-345 "), "A 12-345");
    assert.equal(normalizeSticker("No. 778812"), "778812");
    assert.equal(normalizeSticker("pa\t 00412"), "PA 00412");
    assert.equal(normalizeSticker(undefined), "");
    // "No" before a number is a label only with its dot, or a space and a
    // digit after it; letters that are part of the number stay.
    assert.equal(normalizeSticker("No 77001"), "77001");
    assert.equal(normalizeSticker("NOR-1234"), "NOR-1234");
    assert.equal(normalizeSticker("nov-1001"), "NOV-1001");
    assert.equal(normalizeSticker("NO-2024-1"), "NO-2024-1");
    assert.equal(normalizeSticker("NO1234"), "NO1234");
    assert.ok("entry" in checkStickerEntry({ stickerNumber: "NO-2024-1", plateClass: "1" }));
  });

  test("a sticker typed with other spaces or dashes is the same sticker", () => {
    assert.equal(stickerKey("A 12-345"), "A12345");
    assert.equal(stickerKey("a-12.345"), "A12345");
    assert.equal(stickerKey("#A12345"), "A12345");
    assert.notEqual(stickerKey("NOR-77"), stickerKey("R-77"));
  });

  test("a sticker number and a class of 1 or 2 are needed", () => {
    assert.deepEqual(checkStickerEntry({ stickerNumber: "a-1001", plateClass: "2" }), { entry: { stickerNumber: "A-1001", plateClass: 2 } });
    assert.deepEqual(checkStickerEntry({ stickerNumber: "  ", plateClass: "1" }), { error: "Enter the sticker number." });
    assert.ok("error" in checkStickerEntry({ stickerNumber: "1001", plateClass: "3" }));
    assert.ok("error" in checkStickerEntry({ stickerNumber: "1001", plateClass: "" }));
    assert.ok("error" in checkStickerEntry({ stickerNumber: "1001", plateClass: "1.5" }));
    assert.ok("error" in checkStickerEntry({ stickerNumber: "=1+1", plateClass: "1" }));
    assert.ok("error" in checkStickerEntry({ stickerNumber: "x".repeat(41), plateClass: "1" }));
  });

  test("the class filter is 1, 2 or every class", () => {
    assert.equal(parseClassFilter("1"), 1);
    assert.equal(parseClassFilter("2"), 2);
    assert.equal(parseClassFilter("3"), null);
    assert.equal(parseClassFilter(undefined), null);
    assert.equal(parseClassFilter(["1"]), null);
  });

  test("the CSV has the log's headings, the shop's dates and nothing Excel would run", () => {
    const csv = stickerLogCsv(
      [
        { stickerNumber: "1001", customerName: "Whitfield, Dana", plateClass: 1, createdAt: new Date("2026-10-30T03:00:00Z"), createdBy: "Sam" },
        { stickerNumber: "1002", customerName: "=HYPERLINK(\"x\")", plateClass: 2, createdAt: new Date("2026-10-30T15:00:00Z"), createdBy: null },
      ],
      "America/New_York",
    );
    assert.equal(
      csv,
      '﻿Sticker #,Customer Name,Plate Classification,Logged,Logged by\r\n1001,"Whitfield, Dana",1,10/29/2026,Sam\r\n1002,"\'=HYPERLINK(""x"")",2,10/30/2026,\r\n',
    );
  });

  test("it's a System Admin section for those who handle customers, signed in with a password", () => {
    const section = ADMIN_SECTIONS.find((entry) => entry.href === "/admin/sticker-plate-log");
    assert.equal(section?.label, "Sticker & Plate log");
    assert.equal(section?.capability, "repair_orders.intake");
    assert.ok(needsPasswordSession("repair_orders.intake"));
  });
});

describe("the log", () => {
  const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
  const shopIds: string[] = [];
  let writer: CurrentUser;
  let other: CurrentUser;
  let dana: string;
  let rhett: string;

  async function createWriter(code: string): Promise<CurrentUser> {
    const [shop] = await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name });
    shopIds.push(shop.id);
    const id = randomUUID();
    await systemDb.insert(users).values({
      id,
      shopId: shop.id,
      role: "service_writer",
      name: "Sam",
      username: `${code}.sam`,
      displayUsername: "sam",
      email: `${randomUUID()}@no-email.invalid`,
    });
    return { id, name: "Sam", username: "sam", role: "service_writer", shop, bay: null };
  }

  const customer = async (actor: CurrentUser, name: string, phone = "") => {
    const made = await createCustomer(actor, { name, phone, email: "", addressLine1: "", addressLine2: "", city: "Altoona", state: "", postalCode: "", notes: "" });
    assert.ok("id" in made, JSON.stringify(made));
    return made.id;
  };

  before(async () => {
    writer = await createWriter(`sl${suffix}`);
    other = await createWriter(`so${suffix}`);
    dana = await customer(writer, "Dana Whitfield", "814-555-0199");
    rhett = await customer(writer, "Rhett Carver", "814-555-0123");
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  test("a sticker is logged for a customer, once", async () => {
    const logged = await logSticker(writer, { stickerNumber: "pa-1001", plateClass: "1", customerId: dana });
    assert.ok("id" in logged, JSON.stringify(logged));
    const entry = await getStickerEntry(writer.shop.id, logged.id);
    assert.deepEqual(
      entry && [entry.stickerNumber, entry.plateClass, entry.customerName, entry.createdBy],
      ["PA-1001", 1, "Dana Whitfield", "Sam"],
    );
    // The same sticker again, however it's typed.
    assert.deepEqual(await logSticker(writer, { stickerNumber: " #PA-1001", plateClass: "2", customerId: rhett }), {
      error: "Sticker PA-1001 is already in the log, for Dana Whitfield.",
    });
    const [entryAudit] = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, logged.id));
    assert.equal(entryAudit.action, "sticker.logged");
    assert.deepEqual(entryAudit.details, { stickerNumber: "PA-1001", plateClass: 1, customerId: dana });
  });

  test("a customer who isn't on file yet is added from the form", async () => {
    const logged = await logSticker(writer, { stickerNumber: "1002", plateClass: "2", newCustomerName: "  Walt   Ostrowski " });
    assert.ok("id" in logged, JSON.stringify(logged));
    const [walt] = await systemDb.select().from(customers).where(eq(customers.id, logged.customerId));
    assert.equal(walt.name, "Walt Ostrowski");
    assert.equal(walt.shopId, writer.shop.id);
    const [made] = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, logged.customerId));
    assert.deepEqual([made.action, made.details], ["customer.created", { name: "Walt Ostrowski", from: "sticker log" }]);
    // Nothing is saved without a customer, or with a bad class.
    assert.ok("error" in (await logSticker(writer, { stickerNumber: "1003", plateClass: "1" })));
    assert.ok("error" in (await logSticker(writer, { stickerNumber: "1003", plateClass: "9", customerId: dana })));
    assert.ok("error" in (await logSticker(writer, { stickerNumber: "1003", plateClass: "1", customerId: "not-an-id" })));
    assert.equal((await listStickerLog(writer.shop.id, { query: "1003" })).total, 0);
  });

  test("the log lists the newest first, and finds by sticker, name or phone, and by class", async () => {
    for (const [number, plateClass, customerId] of [["2001", "1", rhett], ["2002", "2", rhett], ["2003", "1", dana]] as const) {
      assert.ok("id" in (await logSticker(writer, { stickerNumber: number, plateClass, customerId })));
    }
    const all = await listStickerLog(writer.shop.id, { perPage: 100 });
    assert.deepEqual(all.items.slice(0, 3).map((entry) => entry.stickerNumber), ["2003", "2002", "2001"]);
    const numbers = async (options: Parameters<typeof listStickerLog>[1]) =>
      (await listStickerLog(writer.shop.id, { perPage: 100, ...options })).items.map((entry) => entry.stickerNumber).sort();
    assert.deepEqual(await numbers({ query: "carver" }), ["2001", "2002"]);
    assert.deepEqual(await numbers({ query: "8145550123" }), ["2001", "2002"]);
    assert.deepEqual(await numbers({ query: "pa-10" }), ["PA-1001"]);
    assert.deepEqual(await numbers({ query: "carver", plateClass: 2 }), ["2002"]);
    assert.deepEqual(await numbers({ plateClass: 1 }), ["2001", "2003", "PA-1001"]);
    const page = await listStickerLog(writer.shop.id, { perPage: 2, page: 99 });
    assert.equal(page.page, page.pages, "a page past the end shows the last");
    // The download has the same entries, oldest first.
    const rows = await exportStickerLog(writer.shop.id, { query: "carver" });
    assert.deepEqual(rows.map((row) => [row.stickerNumber, row.customerName, row.plateClass]), [
      ["2001", "Rhett Carver", 1],
      ["2002", "Rhett Carver", 2],
    ]);
    assert.deepEqual((await stickersForCustomer(writer.shop.id, rhett)).map((entry) => entry.stickerNumber), ["2002", "2001"]);
    assert.deepEqual((await searchCustomersForLog(writer.shop.id, "5550199")).map((choice) => [choice.name, choice.detail]), [
      ["Dana Whitfield", "(814) 555-0199 · Altoona"],
    ]);
  });

  test("an entry is corrected and removed, with each change audited", async () => {
    const logged = await logSticker(writer, { stickerNumber: "3001", plateClass: "1", customerId: dana });
    assert.ok("id" in logged);
    assert.deepEqual(await updateSticker(writer, logged.id, { stickerNumber: "3002", plateClass: "2", customerId: rhett }), { ok: true });
    const entry = await getStickerEntry(writer.shop.id, logged.id);
    assert.deepEqual(entry && [entry.stickerNumber, entry.plateClass, entry.customerName], ["3002", 2, "Rhett Carver"]);
    // Not to a number that's logged already.
    assert.deepEqual(await updateSticker(writer, logged.id, { stickerNumber: "2001", plateClass: "2", customerId: rhett }), {
      error: "Sticker 2001 is already in the log, for Rhett Carver.",
    });
    // Saving it as it is changes nothing.
    assert.deepEqual(await updateSticker(writer, logged.id, { stickerNumber: "3002", plateClass: "2", customerId: rhett }), { ok: true });
    assert.deepEqual(await removeSticker(writer, logged.id), { ok: true, stickerNumber: "3002" });
    assert.equal(await getStickerEntry(writer.shop.id, logged.id), null);
    // The notice after it names only what the audit log shows was removed,
    // by this user.
    assert.equal(await recentlyRemoved(writer, "3002"), "3002");
    assert.equal(await recentlyRemoved(writer, "#3002"), "3002");
    assert.equal(await recentlyRemoved(writer, "3002 and call 555"), null);
    assert.equal(await recentlyRemoved(writer, "2001"), null, "never removed");
    assert.equal(await recentlyRemoved(other, "3002"), null, "another shop");
    const history = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, logged.id)).orderBy(auditLog.createdAt);
    assert.deepEqual(
      history.map((row) => row.action),
      ["sticker.logged", "sticker.updated", "sticker.removed"],
    );
    assert.deepEqual(history[1].details, { stickerNumber: "3002", fields: ["stickerNumber", "plateClass", "customerId"], was: "3001" });
  });

  test("one sticker once, however it's spaced or dashed, and found the same way", async () => {
    assert.ok("id" in (await logSticker(writer, { stickerNumber: "B 12-345", plateClass: "1", customerId: dana })));
    assert.deepEqual(await logSticker(writer, { stickerNumber: "b12345", plateClass: "2", customerId: rhett }), {
      error: "Sticker B12345 is already in the log (as B 12-345), for Dana Whitfield.",
    });
    assert.ok("id" in (await logSticker(writer, { stickerNumber: "NOR-77", plateClass: "1", customerId: rhett })));
    assert.ok("id" in (await logSticker(writer, { stickerNumber: "R-77", plateClass: "1", customerId: rhett })), "NOR-77 and R-77 are two stickers");
    assert.ok("id" in (await logSticker(writer, { stickerNumber: "77001", plateClass: "1", customerId: dana })));
    const found = async (query: string) => (await listStickerLog(writer.shop.id, { query, perPage: 100 })).items.map((entry) => entry.stickerNumber).sort();
    assert.deepEqual(await found("No. 77001"), ["77001"]);
    assert.deepEqual(await found("B12345"), ["B 12-345"]);
    assert.deepEqual(await found("nor-77"), ["NOR-77"]);
    // The database holds to it too, whatever the code does.
    await assert.rejects(
      withShop(writer.shop.id, (tx) => tx.insert(stickerPlateLog).values({ shopId: writer.shop.id, customerId: dana, stickerNumber: "B-12345", plateClass: 1 })),
    );
  });

  test("two clerks logging one sticker at once: the second hears who has it", async () => {
    const results = await Promise.all([
      logSticker(writer, { stickerNumber: "RACE-1", plateClass: "1", customerId: dana }),
      logSticker(writer, { stickerNumber: "RACE-1", plateClass: "2", customerId: rhett }),
    ]);
    const refused = results.filter((result) => "error" in result);
    assert.equal(refused.length, 1);
    assert.match((refused[0] as { error: string }).error, /^Sticker RACE-1 is already in the log, for (Dana Whitfield|Rhett Carver)\.$/);
  });

  test("a sticker for a customer removed a moment ago says so", async () => {
    const goner = await customer(writer, "Gone Soon");
    const client = await systemDb.$client.connect();
    await client.query("begin");
    await client.query("delete from customers where id = $1", [goner]);
    const logging = logSticker(writer, { stickerNumber: "GONE-1", plateClass: "1", customerId: goner });
    await sleep(300);
    await client.query("commit");
    client.release();
    assert.deepEqual(await logging, { error: "That customer was removed a moment ago. Pick the customer again." });
  });

  test("a customer with stickers logged stays on file", async () => {
    const result = await removeCustomer(writer, dana);
    assert.ok("error" in result && result.error.includes("logged for Dana Whitfield"), JSON.stringify(result));
    const spare = await customer(writer, "Spare Customer");
    assert.ok("ok" in (await removeCustomer(writer, spare)));
  });

  test("another shop can't see, change or remove the log, or log against this shop's customers", async () => {
    const mine = await logSticker(writer, { stickerNumber: "4001", plateClass: "1", customerId: dana });
    assert.ok("id" in mine);
    assert.equal(await getStickerEntry(other.shop.id, mine.id), null);
    assert.equal((await listStickerLog(other.shop.id)).total, 0);
    assert.deepEqual(await stickersForCustomer(other.shop.id, dana), []);
    assert.deepEqual(await searchCustomersForLog(other.shop.id, "whitfield"), []);
    assert.ok("error" in (await updateSticker(other, mine.id, { stickerNumber: "4001", plateClass: "2", customerId: dana })));
    assert.ok("error" in (await removeSticker(other, mine.id)));
    assert.ok("error" in (await logSticker(other, { stickerNumber: "4002", plateClass: "1", customerId: dana })));
    // The same number is fine in another shop: each shop has its own stickers.
    const theirs = await customer(other, "Their Customer");
    assert.ok("id" in (await logSticker(other, { stickerNumber: "4001", plateClass: "2", customerId: theirs })));
    // And the database refuses a cross-shop entry whatever the code does.
    await assert.rejects(
      withShop(other.shop.id, (tx) => tx.insert(stickerPlateLog).values({ shopId: other.shop.id, customerId: dana, stickerNumber: "4003", plateClass: 1 })),
    );
    const seen = await withShop(other.shop.id, (tx) => tx.select({ shopId: stickerPlateLog.shopId }).from(stickerPlateLog));
    assert.ok(seen.every((row) => row.shopId === other.shop.id));
    await assert.rejects(
      withShop(writer.shop.id, (tx) => tx.update(stickerPlateLog).set({ shopId: other.shop.id }).where(eq(stickerPlateLog.id, mine.id))),
      (error: unknown) => /permission denied/.test(String((error as { cause?: unknown }).cause)),
    );
    const [{ count }] = await systemDb.select({ count: sql<number>`count(*)::int` }).from(stickerPlateLog).where(eq(stickerPlateLog.shopId, writer.shop.id));
    assert.ok(count >= 6);
  });
});
