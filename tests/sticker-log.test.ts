// The Sticker & Plate log tab: the rules for a sticker number and the
// CSV (src/lib/sticker-log-rules.ts), and the log itself (src/lib/sticker-
// log.ts): each entry tied to one of the shop's customers (or a new one
// added from the form), a sticker logged once, searching and filtering,
// corrections and removals in audit_log, a customer with stickers kept, and
// nothing reaching another shop. Importing a log (src/lib/sticker-import-
// rules.ts and importStickers): reading the columns and classes, each
// sticker once, its customer found or added, and the file's order kept.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, customers, shops, stickerPlateLog, users } from "../src/db/schema";
import { parseCsv } from "../src/lib/csv";
import { detectDelimiter, readSpreadsheet } from "../src/lib/customer-import-rules";
import { createCustomer, removeCustomer } from "../src/lib/customers";
import { ADMIN_SECTIONS, needsPasswordSession } from "../src/lib/permissions";
import type { CurrentUser } from "../src/lib/session";
import {
  checkStickerImport,
  findStickerHeader,
  parsePlateClass,
  planStickerImport,
  stickerColumns,
  type StickerImportRow,
} from "../src/lib/sticker-import-rules";
import {
  exportStickerLog,
  getStickerEntry,
  importStickers,
  listStickerLog,
  logSticker,
  removeSticker,
  searchCustomersForLog,
  stickersForCustomer,
  updateSticker,
} from "../src/lib/sticker-log";
import { checkStickerEntry, normalizeSticker, parseClassFilter, stickerLogCsv } from "../src/lib/sticker-log-rules";

const pasted = (lines: string[]) => {
  const text = lines.join("\n");
  return parseCsv(text, detectDelimiter(text));
};

describe("the rules for a sticker", () => {
  test("sticker numbers are tidied, so one typed two ways is one", () => {
    assert.equal(normalizeSticker(" #a 12-345 "), "A 12-345");
    assert.equal(normalizeSticker("No. 778812"), "778812");
    assert.equal(normalizeSticker("pa\t 00412"), "PA 00412");
    assert.equal(normalizeSticker(undefined), "");
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

  test("it's its own tab, for those who handle customers, signed in with a password", () => {
    assert.ok(!ADMIN_SECTIONS.some((section) => section.capability === "repair_orders.intake"));
    assert.ok(needsPasswordSession("repair_orders.intake"));
  });
});

describe("importing a log: the rules", () => {
  test("the log's own headings, and other names for them, map the columns", () => {
    assert.deepEqual(stickerColumns(["Sticker #", "Customer Name", "Plate Classification", "Logged", "Logged by"]), [
      "stickerNumber",
      "customerName",
      "plateClass",
      null,
      null,
    ]);
    assert.deepEqual(stickerColumns(["Decal #", "Owner", "Cell Phone", "Class"]), ["stickerNumber", "customerName", "phone", "plateClass"]);
    // Each field from one column: its best heading wins.
    assert.deepEqual(stickerColumns(["Name", "Customer Name", "Sticker", "Sticker #"]), [null, "customerName", null, "stickerNumber"]);
    assert.equal(findStickerHeader(pasted(["Stickers handed out, 2025", "", "Sticker #\tCustomer Name\tPlate Classification", "1001\tDana Whitfield\t1"])), 2);
    assert.equal(findStickerHeader(pasted(["1001\tDana Whitfield\t1"])), -1);
  });

  test("a plate classification is 1 or 2, however it's written", () => {
    for (const [text, plateClass] of [["1", 1], ["2", 2], ["Class 1", 1], ["CLASS II", 2], ["I", 1], ["Plate class #2", 2], ["2.0", 2], ["one", 1]] as const) {
      assert.equal(parsePlateClass(text), plateClass, text);
    }
    for (const text of ["", "3", "1.5", "12", "Class 1 ATV", "x"]) assert.equal(parsePlateClass(text), null, text);
  });

  test("a log is planned one sticker per row, the first of a number kept, with notes", () => {
    const rows = pasted([
      "Sticker log",
      "Sticker #\tCustomer Name\tPhone\tPlate Classification",
      "pa-1001\tDana  Whitfield\t814.555.0199\t1",
      "#PA-1001\tdana whitfield\t\tClass I",
      "PA-1002\tRhett Carver\tcall his wife\t2",
      "\t\t\t",
      "PA-1003\t\t\t1",
      "\tWalt Ostrowski\t\t1",
      "PA-1004\tWalt Ostrowski\t\t3",
      "PA-1005\tWalt Ostrowski\t\t",
      "=1+1\tWalt Ostrowski\t\t1",
      "PA-1001\tRhett Carver\t\t2",
      "PA-1006\tWalt Ostrowski\t\tII",
    ]);
    const header = findStickerHeader(rows);
    assert.equal(header, 1);
    const plan = planStickerImport(rows, header, stickerColumns(rows[header]));
    assert.equal(plan.rowsRead, 10, "the blank row isn't one");
    assert.deepEqual(plan.stickers, [
      { row: 3, stickerNumber: "PA-1001", customerName: "Dana Whitfield", phone: "(814) 555-0199", plateClass: 1 },
      { row: 5, stickerNumber: "PA-1002", customerName: "Rhett Carver", phone: null, plateClass: 2 },
      { row: 13, stickerNumber: "PA-1006", customerName: "Walt Ostrowski", phone: null, plateClass: 2 },
    ]);
    assert.deepEqual(plan.notes, [
      { row: 4, message: "Sticker PA-1001 is on row 3 too: logged once." },
      { row: 5, message: "Phone “call his wife” left out: A phone number is digits, with spaces, dashes or brackets if you like." },
      { row: 7, message: "No Customer Name: row left out." },
      { row: 8, message: "No Sticker #: row left out." },
      { row: 9, message: "Plate Classification “3” isn't 1 or 2: row left out." },
      { row: 10, message: "No Plate Classification: row left out." },
      { row: 11, message: "Sticker # “=1+1”: A sticker number is letters and digits (dashes, dots and slashes are fine). Row left out." },
      { row: 12, message: "Sticker PA-1001 is also on row 3, for Dana Whitfield (Class 1): only row 3 is logged." },
    ]);
  });

  test("the log's own Download CSV comes back in as it went out", async () => {
    const csv = stickerLogCsv([
      { stickerNumber: "1001", customerName: "Whitfield, Dana", plateClass: 1, createdAt: new Date("2026-10-30T15:00:00Z"), createdBy: "Sam" },
      { stickerNumber: "1002", customerName: "Rhett Carver", plateClass: 2, createdAt: new Date("2026-10-30T16:00:00Z"), createdBy: null },
    ]);
    const read = await readSpreadsheet("sticker-plate-log-2026-10-30.csv", new TextEncoder().encode(csv));
    assert.ok("sheets" in read, JSON.stringify(read));
    const rows = read.sheets[0].rows;
    const plan = planStickerImport(rows, findStickerHeader(rows), stickerColumns(rows[0]));
    assert.deepEqual(
      plan.stickers.map((sticker) => [sticker.stickerNumber, sticker.customerName, sticker.plateClass]),
      [
        ["1001", "Whitfield, Dana", 1],
        ["1002", "Rhett Carver", 2],
      ],
    );
    assert.deepEqual(plan.notes, []);
  });

  test("the server checks each row again, as the form would", () => {
    const checked = checkStickerImport({ stickerNumber: " #pa-7 ", customerName: " Dana  Whitfield ", phone: "8145550199", plateClass: 2 });
    assert.ok("entry" in checked, JSON.stringify(checked));
    assert.deepEqual(
      [checked.entry.stickerNumber, checked.entry.plateClass, checked.entry.customer.name, checked.entry.customer.phone],
      ["PA-7", 2, "Dana Whitfield", "(814) 555-0199"],
    );
    assert.ok("error" in checkStickerImport({ stickerNumber: "PA-8", customerName: "", plateClass: 1 }));
    assert.ok("error" in checkStickerImport({ stickerNumber: "PA-8", customerName: "Dana Whitfield", plateClass: 3 }));
    assert.ok("error" in checkStickerImport({ stickerNumber: "PA-8", customerName: "Dana Whitfield", phone: "call me", plateClass: 1 }));
    assert.ok("error" in checkStickerImport(null));
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
    const history = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, logged.id)).orderBy(auditLog.createdAt);
    assert.deepEqual(
      history.map((row) => row.action),
      ["sticker.logged", "sticker.updated", "sticker.removed"],
    );
    assert.deepEqual(history[1].details, { stickerNumber: "3002", fields: ["stickerNumber", "plateClass", "customerId"], was: "3001" });
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

  const row = (n: number, stickerNumber: string, customerName: string, plateClass: 1 | 2, phone: string | null = null): StickerImportRow => ({
    row: n,
    stickerNumber,
    customerName,
    phone,
    plateClass,
  });
  const named = (shopId: string, name: string) => systemDb.select().from(customers).where(and(eq(customers.shopId, shopId), eq(customers.name, name)));

  test("an import logs each sticker once, in the file's order, finding each customer or adding them", async () => {
    const importId = randomUUID();
    const batch = [
      row(2, "IMP-1", "dana whitfield", 1),
      row(3, "IMP-2", "Nora Kessler", 2, "(814) 555-0170"),
      row(4, "IMP-3", "Nora Kessler", 1),
      row(5, "PA-1001", "Dana Whitfield", 1),
      row(6, "2001", "Dana Whitfield", 2),
      row(7, "", "Nobody", 1),
    ];
    const result = await importStickers(writer, { importId, fileName: "old sticker log.xlsx", stickers: batch });
    assert.ok("outcomes" in result, JSON.stringify(result));
    assert.deepEqual(result.outcomes, [
      { row: 2, result: "logged", customer: "found", message: null },
      { row: 3, result: "logged", customer: "added", message: null },
      { row: 4, result: "logged", customer: "found", message: null },
      { row: 5, result: "already", customer: null, message: null },
      { row: 6, result: "already", customer: null, message: "Sticker 2001 is in the log already, for Rhett Carver (Class 1): left as it is." },
      { row: 7, result: "failed", customer: null, message: "Enter the sticker number." },
    ]);
    // The newest first: the file's last row, logged by whoever imported it.
    const imported = await listStickerLog(writer.shop.id, { query: "IMP" });
    assert.deepEqual(
      imported.items.map((entry) => [entry.stickerNumber, entry.customerName, entry.plateClass, entry.createdBy]),
      [
        ["IMP-3", "Nora Kessler", 1, "Sam"],
        ["IMP-2", "Nora Kessler", 2, "Sam"],
        ["IMP-1", "Dana Whitfield", 1, "Sam"],
      ],
    );
    assert.equal(imported.items[2].customerId, dana, "Dana as she's on file, whatever the case");
    assert.deepEqual(
      (await named(writer.shop.id, "Nora Kessler")).map((nora) => [nora.phone, nora.createdByUserId]),
      [["(814) 555-0170", writer.id]],
      "Nora added once, with her phone number",
    );
    const [entry] = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, importId));
    assert.deepEqual(
      [entry.action, entry.targetType, entry.details],
      ["stickers.imported", "sticker", { fileName: "old sticker log.xlsx", logged: 3, already: 2, customersAdded: 1, failed: 1 }],
    );
    // The same file again logs and adds nothing.
    const again = await importStickers(writer, { importId: randomUUID(), fileName: "old sticker log.xlsx", stickers: batch });
    assert.ok("outcomes" in again);
    assert.deepEqual(
      again.outcomes.map((outcome) => outcome.result),
      ["already", "already", "already", "already", "already", "failed"],
    );
    assert.equal((await listStickerLog(writer.shop.id, { query: "IMP" })).total, 3);
    assert.equal((await named(writer.shop.id, "Nora Kessler")).length, 1);
  });

  test("an import leaves out a name two customers share, unless a phone number says which", async () => {
    const first = await customer(writer, "Casey Morgan", "814-555-0181");
    await customer(writer, "Casey Morgan", "814-555-0182");
    const result = await importStickers(writer, {
      importId: randomUUID(),
      fileName: "stickers.csv",
      stickers: [row(2, "IMP-20", "Casey Morgan", 1), row(3, "IMP-21", "Casey Morgan", 2, "(814) 555-0181"), row(4, "IMP-22", "Casey Morgan", 1, "(814) 555-0183")],
    });
    assert.ok("outcomes" in result);
    assert.deepEqual(result.outcomes, [
      {
        row: 2,
        result: "failed",
        customer: null,
        message: "2 customers are called Casey Morgan, and nothing in the file says which: log sticker IMP-20 on the log's form, picking them.",
      },
      { row: 3, result: "logged", customer: "found", message: null },
      // A third phone number is a third Casey Morgan.
      { row: 4, result: "logged", customer: "added", message: null },
    ]);
    assert.equal((await listStickerLog(writer.shop.id, { query: "IMP-21" })).items[0].customerId, first);
    assert.equal((await named(writer.shop.id, "Casey Morgan")).length, 3);
  });

  test("a sticker logged on the form while an import runs is left as it is, and nobody is added for it", async () => {
    const started: ReturnType<typeof importStickers>[] = [];
    await systemDb.transaction(async (tx) => {
      await tx.insert(stickerPlateLog).values({ shopId: writer.shop.id, customerId: dana, stickerNumber: "IMP-30", plateClass: 1 });
      started.push(importStickers(writer, { importId: randomUUID(), fileName: "stickers.csv", stickers: [row(2, "IMP-30", "Brand New Person", 2)] }));
      // The import waits on this sticker until it's saved (or, if it's slow
      // to start, finds it saved): either way it's left as it is.
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const result = await started[0];
    assert.ok("outcomes" in result, JSON.stringify(result));
    assert.deepEqual(
      result.outcomes.map((outcome) => [outcome.result, outcome.customer]),
      [["already", null]],
    );
    assert.deepEqual(await named(writer.shop.id, "Brand New Person"), []);
    assert.equal((await listStickerLog(writer.shop.id, { query: "IMP-30" })).items[0].customerId, dana);
  });

  test("two imports of the same log at once log each sticker, and add each customer, once", async () => {
    const batch = Array.from({ length: 40 }, (_, index) => row(index + 2, `IMP-5${String(index).padStart(2, "0")}`, `Bulk Customer ${index % 10}`, 1));
    const [a, b] = await Promise.all([
      importStickers(writer, { importId: randomUUID(), fileName: "a.csv", stickers: batch }),
      importStickers(writer, { importId: randomUUID(), fileName: "b.csv", stickers: batch }),
    ]);
    assert.ok("outcomes" in a && "outcomes" in b);
    const both = [...a.outcomes, ...b.outcomes];
    assert.equal(both.filter((outcome) => outcome.result === "logged").length, 40);
    assert.equal(both.filter((outcome) => outcome.customer === "added").length, 10);
    const bulk = await systemDb
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.shopId, writer.shop.id), sql`${customers.name} like 'Bulk Customer %'`));
    assert.equal(bulk.length, 10);
  });

  test("an import reaches only its own shop's customers and stickers", async () => {
    const result = await importStickers(other, { importId: randomUUID(), fileName: "stickers.csv", stickers: [row(2, "PA-1001", "Dana Whitfield", 2)] });
    assert.ok("outcomes" in result);
    assert.deepEqual(result.outcomes, [{ row: 2, result: "logged", customer: "added", message: null }]);
    const [theirs] = (await listStickerLog(other.shop.id, { query: "PA-1001" })).items;
    assert.notEqual(theirs.customerId, dana, "a Dana of their own, not this shop's");
    const [mine] = (await listStickerLog(writer.shop.id, { query: "PA-1001" })).items;
    assert.deepEqual([mine.customerId, mine.plateClass], [dana, 1]);
  });

  test("an import batch that can't be read is refused", async () => {
    const batch = [row(2, "IMP-90", "Dana Whitfield", 1)];
    assert.ok("error" in (await importStickers(writer, { importId: "nope", fileName: "x", stickers: batch })));
    assert.ok("error" in (await importStickers(writer, { importId: randomUUID(), fileName: "x", stickers: [] })));
    assert.ok("error" in (await importStickers(writer, { importId: randomUUID(), fileName: "x", stickers: "IMP-90" })));
    const tooMany = Array.from({ length: 501 }, (_, index) => row(index + 2, `B${index}`, "Bulk", 1));
    assert.ok("error" in (await importStickers(writer, { importId: randomUUID(), fileName: "x", stickers: tooMany })));
    assert.equal((await listStickerLog(writer.shop.id, { query: "IMP-90" })).total, 0);
  });
});
