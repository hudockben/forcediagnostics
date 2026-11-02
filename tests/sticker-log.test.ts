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
import { detectDelimiter, pastedDelimiter, readSpreadsheet } from "../src/lib/customer-import-rules";
import { createCustomer, removeCustomer } from "../src/lib/customers";
import { ADMIN_SECTIONS, needsPasswordSession } from "../src/lib/permissions";
import type { CurrentUser } from "../src/lib/session";
import {
  checkStickerImport,
  countByKind,
  findStickerHeader,
  parseKind,
  parsePlateClass,
  personKey,
  planStickerImport,
  stickerColumns,
  stickerLists,
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
import { checkStickerEntry, entryLabel, normalizeSticker, parseKindFilter, stickerLogCsv, type EntryKind } from "../src/lib/sticker-log-rules";

const pasted = (lines: string[]) => {
  const text = lines.join("\n");
  return parseCsv(text, detectDelimiter(text));
};

describe("the rules for a sticker or plate", () => {
  test("numbers are tidied, so one typed two ways is one", () => {
    assert.equal(normalizeSticker(" #a 12-345 "), "A 12-345");
    assert.equal(normalizeSticker("No. 778812"), "778812");
    assert.equal(normalizeSticker("pa\t 00412"), "PA 00412");
    assert.equal(normalizeSticker(undefined), "");
  });

  test("a number is needed, and what it is: a sticker, or a Class 1 or Class 2 plate", () => {
    assert.deepEqual(checkStickerEntry({ stickerNumber: "a-1001", plateClass: "2" }), { entry: { stickerNumber: "A-1001", plateClass: 2 } });
    assert.deepEqual(checkStickerEntry({ stickerNumber: "t280377", plateClass: "sticker" }), { entry: { stickerNumber: "T280377", plateClass: null } });
    // An import sends null for a sticker.
    assert.deepEqual(checkStickerEntry({ stickerNumber: "T280377", plateClass: null }), { entry: { stickerNumber: "T280377", plateClass: null } });
    assert.deepEqual(checkStickerEntry({ stickerNumber: "  ", plateClass: "1" }), { error: "Enter the sticker or plate number." });
    assert.deepEqual(checkStickerEntry({ stickerNumber: "1001", plateClass: "" }), { error: "Pick what it is: a sticker, or a Class 1 or Class 2 plate." });
    assert.ok("error" in checkStickerEntry({ stickerNumber: "1001", plateClass: "3" }));
    assert.ok("error" in checkStickerEntry({ stickerNumber: "1001", plateClass: undefined }));
    assert.ok("error" in checkStickerEntry({ stickerNumber: "1001", plateClass: "1.5" }));
    assert.ok("error" in checkStickerEntry({ stickerNumber: "=1+1", plateClass: "1" }));
    assert.ok("error" in checkStickerEntry({ stickerNumber: "x".repeat(41), plateClass: "1" }));
  });

  test("the filter is stickers, one class of plates, or everything", () => {
    assert.equal(parseKindFilter("sticker"), "sticker");
    assert.equal(parseKindFilter("1"), "1");
    assert.equal(parseKindFilter("2"), "2");
    assert.equal(parseKindFilter("3"), null);
    assert.equal(parseKindFilter(undefined), null);
    assert.equal(parseKindFilter(["1"]), null);
    assert.deepEqual([entryLabel(null), entryLabel(1), entryLabel(2)], ["Sticker", "Class 1 plate", "Class 2 plate"]);
  });

  test("the CSV has the log's headings, what each is, the shop's dates and nothing Excel would run", () => {
    const csv = stickerLogCsv(
      [
        { stickerNumber: "T280377", customerName: "Henry, Michael", plateClass: null, createdAt: new Date("2026-10-30T03:00:00Z"), createdBy: "Sam" },
        { stickerNumber: "90W14", customerName: "=HYPERLINK(\"x\")", plateClass: 1, createdAt: new Date("2026-10-30T15:00:00Z"), createdBy: null },
        { stickerNumber: "93Y67", customerName: "Austin, Matt", plateClass: 2, createdAt: new Date("2026-10-30T15:00:00Z"), createdBy: null },
      ],
      "America/New_York",
    );
    assert.equal(
      csv,
      "﻿Sticker / Plate #,Customer Name,Type,Logged,Logged by\r\n" +
        'T280377,"Henry, Michael",Sticker,10/29/2026,Sam\r\n' +
        '90W14,"\'=HYPERLINK(""x"")",Class 1 plate,10/30/2026,\r\n' +
        '93Y67,"Austin, Matt",Class 2 plate,10/30/2026,\r\n',
    );
  });

  test("it's its own tab, for those who handle customers, signed in with a password", () => {
    assert.ok(!ADMIN_SECTIONS.some((section) => section.capability === "repair_orders.intake"));
    assert.ok(needsPasswordSession("repair_orders.intake"));
  });
});

// The shop's own sheet, as Excel copies it: stickers, Class 1 plates and
// Class 2 plates side by side, a blank column between each, a row's
// sticker and plates nothing to do with each other.
const SHEET = [
  "Sticker #\tCustomer Name\t\tClass 1 Plate\tCustomer Name\t\tClass 2 Plate\tCustomer Name",
  "\t\t\t\t\t\t\t",
  "T280377\tHenry, Michael\t\t\t\t\t\t",
  "T280391\tAustin, Matt\t\t90W14\tElkin, Tyler\t\t93Y67\tAustin, Matt",
  "T280397\tShick, Jessica\t\t\t\t\t93Y73\tShick, Jessica",
  "T280409\tHohman, Dennis\t\t4A774\tBenanti, Anthony - returned\t\t93Y39\tNeiderhiser, Charles",
  "\t\t\t\t\t\t93Y83\tPowell & Associates",
].join("\n");

describe("importing a log: the rules", () => {
  test("headings name the lists and their columns, side by side", () => {
    assert.deepEqual(stickerColumns(["Sticker #", "Customer Name", "", "Class 1 Plate", "Customer Name", "", "Class 2 Plate", "Customer Name"]), [
      "sticker",
      "customerName",
      null,
      "plate1",
      "customerName",
      null,
      "plate2",
      "customerName",
    ]);
    // The log's own Download CSV.
    assert.deepEqual(stickerColumns(["Sticker / Plate #", "Customer Name", "Type", "Logged", "Logged by"]), ["number", "customerName", "type", null, null]);
    assert.deepEqual(stickerColumns(["Decal #", "Owner", "Cell Phone", "Class"]), ["sticker", "customerName", "phone", "type"]);
    assert.equal(findStickerHeader(pasted(["Stickers handed out, 2025", "", "Sticker #\tCustomer Name", "1001\tDana Whitfield"])), 2);
    assert.equal(findStickerHeader(pasted(["1001\tDana Whitfield\t1"])), -1);
  });

  test("each number column is a list, with the name, phone and type columns after it", () => {
    // A name before every number column is the first list's; a second name
    // in one list isn't read.
    assert.deepEqual(stickerLists(stickerColumns(["Customer Name", "Sticker #", "Phone", "Class 1 Plate", "Customer Name", "Customer Name"])), [
      { column: 1, field: "sticker", name: 0, phone: 2, type: null },
      { column: 3, field: "plate1", name: 4, phone: null, type: null },
    ]);
    assert.deepEqual(stickerLists(stickerColumns(["Customer Name"])), []);
  });

  test("what an entry is, however it's written", () => {
    for (const [text, plateClass] of [["1", 1], ["2", 2], ["Class 1", 1], ["CLASS II", 2], ["I", 1], ["Plate class #2", 2], ["2.0", 2], ["one", 1]] as const) {
      assert.equal(parsePlateClass(text), plateClass, text);
    }
    for (const text of ["", "3", "1.5", "12", "Class 1 ATV", "x"]) assert.equal(parsePlateClass(text), null, text);
    for (const [text, kind] of [["Sticker", "sticker"], ["decal", "sticker"], ["Class 1 Plate", "1"], ["class 2 plates", "2"], ["2", "2"], ["Class II", "2"]] as const) {
      assert.equal(parseKind(text), kind, text);
    }
    for (const text of ["plate", "Class 3", "x"]) assert.equal(parseKind(text), null, text);
  });

  test("the shop's sheet: its stickers and both classes of plates, each list with its own customers", () => {
    const rows = parseCsv(SHEET, pastedDelimiter(SHEET));
    const header = findStickerHeader(rows);
    assert.equal(header, 0);
    const plan = planStickerImport(rows, header, stickerColumns(rows[header]));
    assert.equal(plan.rowsRead, 5, "the blank row isn't one");
    assert.deepEqual(
      plan.stickers.map((entry) => [entry.row, entryLabel(entry.plateClass), entry.stickerNumber, entry.customerName]),
      [
        [3, "Sticker", "T280377", "Henry, Michael"],
        [4, "Sticker", "T280391", "Austin, Matt"],
        [5, "Sticker", "T280397", "Shick, Jessica"],
        [6, "Sticker", "T280409", "Hohman, Dennis"],
        [4, "Class 1 plate", "90W14", "Elkin, Tyler"],
        [4, "Class 2 plate", "93Y67", "Austin, Matt"],
        [5, "Class 2 plate", "93Y73", "Shick, Jessica"],
        [6, "Class 2 plate", "93Y39", "Neiderhiser, Charles"],
        [7, "Class 2 plate", "93Y83", "Powell & Associates"],
      ],
    );
    // A plate given back isn't anyone's; a row with nothing in a list is no note.
    assert.deepEqual(plan.notes, [{ row: 6, message: "Class 1 plate 4A774 is marked returned: left out." }]);
    assert.equal(countByKind(plan.stickers), "4 stickers, 1 Class 1 plate and 4 Class 2 plates");
  });

  test("a list is planned one entry per number, the first of a number kept, with notes", () => {
    const rows = pasted([
      "Sticker log",
      "Sticker #\tCustomer Name\tPhone",
      "t-1001\tDana  Whitfield\t814.555.0199",
      "#T-1001\tdana whitfield\t",
      "T-1002\tRhett Carver\tcall his wife",
      "\t\t",
      "T-1003\t\t",
      "\tWalt Ostrowski\t",
      "=1+1\tWalt Ostrowski\t",
      "T-1001\tRhett Carver\t",
      "T-1006\tWalt Ostrowski\t",
    ]);
    const header = findStickerHeader(rows);
    assert.equal(header, 1);
    const plan = planStickerImport(rows, header, stickerColumns(rows[header]));
    assert.equal(plan.rowsRead, 8, "the blank row isn't one");
    assert.deepEqual(plan.stickers, [
      { row: 3, stickerNumber: "T-1001", customerName: "Dana Whitfield", phone: "(814) 555-0199", plateClass: null },
      { row: 5, stickerNumber: "T-1002", customerName: "Rhett Carver", phone: null, plateClass: null },
      { row: 11, stickerNumber: "T-1006", customerName: "Walt Ostrowski", phone: null, plateClass: null },
    ]);
    assert.deepEqual(plan.notes, [
      { row: 4, message: "Sticker T-1001 is on row 3 too: logged once." },
      { row: 5, message: "Phone “call his wife” left out: A phone number is digits, with spaces, dashes or brackets if you like." },
      { row: 7, message: "No Customer Name for sticker T-1003: left out." },
      { row: 8, message: "No Sticker # for “Walt Ostrowski”: left out." },
      { row: 9, message: "Sticker “=1+1”: A sticker or plate number is letters and digits (dashes, dots and slashes are fine). Left out." },
      { row: 10, message: "T-1001 is also on row 3, as a sticker for Dana Whitfield: only that one is logged." },
    ]);
  });

  test("a list that doesn't say what it is takes what's picked; a Type column says for each row", () => {
    const text = ["Number\tCustomer Name", "90W14\tElkin, Tyler", "90W15\t", "90W16\tHenry, Ashley"].join("\n");
    const rows = parseCsv(text, pastedDelimiter(text));
    const mapping = stickerColumns(rows[0]);
    assert.deepEqual(mapping, ["number", "customerName"]);
    assert.deepEqual(planStickerImport(rows, 0, mapping).stickers, [], "nothing picked: nothing says what they are");
    const plan = planStickerImport(rows, 0, mapping, { kind: "1" });
    assert.deepEqual(
      plan.stickers.map((entry) => [entry.row, entry.stickerNumber, entry.customerName, entry.plateClass]),
      [
        [2, "90W14", "Elkin, Tyler", 1],
        [4, "90W16", "Henry, Ashley", 1],
      ],
    );
    assert.deepEqual(plan.notes, [{ row: 3, message: "No Customer Name for Class 1 plate 90W15: left out." }]);
    // A Type column says for each row; what's picked is for rows without one.
    const typed = pasted(["Sticker / Plate #\tCustomer Name\tType", "A1\tDana Whitfield\tSticker", "A2\tDana Whitfield\tClass 2 plate", "A3\tDana Whitfield\t", "A4\tDana Whitfield\tClass 3"]);
    const typedPlan = planStickerImport(typed, 0, stickerColumns(typed[0]), { kind: "1" });
    assert.deepEqual(
      typedPlan.stickers.map((entry) => [entry.stickerNumber, entry.plateClass]),
      [
        ["A1", null],
        ["A2", 2],
        ["A3", 1],
      ],
    );
    assert.deepEqual(typedPlan.notes, [{ row: 5, message: "Type “Class 3” isn't a sticker or a Class 1 or Class 2 plate: A4 left out." }]);
  });

  test("a name written last name first is the same person either way round", () => {
    assert.equal(personKey("Rudd, Benjamin"), "benjamin rudd");
    assert.equal(personKey("  Benjamin   RUDD "), "benjamin rudd");
    assert.equal(personKey("Van Dyke, Ann Marie"), "ann marie van dyke");
    assert.equal(personKey("Smith, John, Jr."), "smith, john, jr.", "two commas: as written");
    assert.equal(personKey("Rudd,"), "rudd,");
  });

  test("the log's own Download CSV comes back in as it went out", async () => {
    const csv = stickerLogCsv([
      { stickerNumber: "T280377", customerName: "Henry, Michael", plateClass: null, createdAt: new Date("2026-10-30T15:00:00Z"), createdBy: "Sam" },
      { stickerNumber: "90W14", customerName: "Elkin, Tyler", plateClass: 1, createdAt: new Date("2026-10-30T16:00:00Z"), createdBy: null },
      { stickerNumber: "93Y67", customerName: "Austin, Matt", plateClass: 2, createdAt: new Date("2026-10-30T17:00:00Z"), createdBy: null },
    ]);
    const read = await readSpreadsheet("sticker-plate-log-2026-10-30.csv", new TextEncoder().encode(csv));
    assert.ok("sheets" in read, JSON.stringify(read));
    const rows = read.sheets[0].rows;
    const plan = planStickerImport(rows, findStickerHeader(rows), stickerColumns(rows[0]));
    assert.deepEqual(
      plan.stickers.map((entry) => [entry.stickerNumber, entry.customerName, entry.plateClass]),
      [
        ["T280377", "Henry, Michael", null],
        ["90W14", "Elkin, Tyler", 1],
        ["93Y67", "Austin, Matt", 2],
      ],
    );
    assert.deepEqual(plan.notes, []);
  });

  test("the server checks each entry again, as the form would", () => {
    const checked = checkStickerImport({ stickerNumber: " #pa-7 ", customerName: " Dana  Whitfield ", phone: "8145550199", plateClass: 2 });
    assert.ok("entry" in checked, JSON.stringify(checked));
    assert.deepEqual(
      [checked.entry.stickerNumber, checked.entry.plateClass, checked.entry.customer.name, checked.entry.customer.phone],
      ["PA-7", 2, "Dana Whitfield", "(814) 555-0199"],
    );
    const sticker = checkStickerImport({ stickerNumber: "T280377", customerName: "Henry, Michael", plateClass: null });
    assert.ok("entry" in sticker && sticker.entry.plateClass === null);
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

  test("a plate, or a sticker, is logged for a customer, once", async () => {
    const logged = await logSticker(writer, { stickerNumber: "pa-1001", plateClass: "1", customerId: dana });
    assert.ok("id" in logged, JSON.stringify(logged));
    const entry = await getStickerEntry(writer.shop.id, logged.id);
    assert.deepEqual(
      entry && [entry.stickerNumber, entry.plateClass, entry.customerName, entry.createdBy],
      ["PA-1001", 1, "Dana Whitfield", "Sam"],
    );
    // The same number again, however it's typed.
    assert.deepEqual(await logSticker(writer, { stickerNumber: " #PA-1001", plateClass: "2", customerId: rhett }), {
      error: "PA-1001 is already in the log, as a Class 1 plate for Dana Whitfield.",
    });
    const [entryAudit] = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, logged.id));
    assert.equal(entryAudit.action, "sticker.logged");
    assert.deepEqual(entryAudit.details, { stickerNumber: "PA-1001", plateClass: 1, customerId: dana });
    // A sticker has no class.
    const sticker = await logSticker(writer, { stickerNumber: "t-5001", plateClass: "sticker", customerId: dana });
    assert.ok("id" in sticker, JSON.stringify(sticker));
    assert.equal((await getStickerEntry(writer.shop.id, sticker.id))?.plateClass, null);
    assert.deepEqual(await logSticker(writer, { stickerNumber: "T-5001", plateClass: "1", customerId: rhett }), {
      error: "T-5001 is already in the log, as a sticker for Dana Whitfield.",
    });
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
    assert.deepEqual(await numbers({ query: "carver", kind: "2" }), ["2002"]);
    assert.deepEqual(await numbers({ kind: "1" }), ["2001", "2003", "PA-1001"]);
    assert.deepEqual(await numbers({ kind: "sticker" }), ["T-5001"]);
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
      error: "2001 is already in the log, as a Class 1 plate for Rhett Carver.",
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
    assert.ok("error" in result && result.error.includes("stickers and plates are logged for Dana Whitfield"), JSON.stringify(result));
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

  const row = (n: number, stickerNumber: string, customerName: string, plateClass: 1 | 2 | null, phone: string | null = null): StickerImportRow => ({
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
      { row: 6, result: "already", customer: null, message: "2001 is in the log already, as a Class 1 plate for Rhett Carver: left as it is." },
      { row: 7, result: "failed", customer: null, message: "Enter the sticker or plate number." },
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
        message: "2 customers are called Casey Morgan, and nothing in the file says which: log Class 1 plate IMP-20 on the log's form, picking them.",
      },
      { row: 3, result: "logged", customer: "found", message: null },
      // A third phone number is a third Casey Morgan.
      { row: 4, result: "logged", customer: "added", message: null },
    ]);
    assert.equal((await listStickerLog(writer.shop.id, { query: "IMP-21" })).items[0].customerId, first);
    assert.equal((await named(writer.shop.id, "Casey Morgan")).length, 3);
  });

  test("an import finds a customer on file whichever way round the name is written", async () => {
    const benjamin = await customer(writer, "Benjamin Rudd");
    const colin = await customer(writer, "Kirkpatrick, Colin");
    const result = await importStickers(writer, {
      importId: randomUUID(),
      fileName: "stickers.txt",
      stickers: [row(2, "IMP-40", "Rudd, Benjamin", 1), row(3, "IMP-41", "Colin Kirkpatrick", 1), row(4, "IMP-42", "Mahlon, John", 2), row(5, "IMP-43", "John Mahlon", 2)],
    });
    assert.ok("outcomes" in result, JSON.stringify(result));
    assert.deepEqual(
      result.outcomes.map((outcome) => [outcome.row, outcome.result, outcome.customer]),
      [
        [2, "logged", "found"],
        [3, "logged", "found"],
        [4, "logged", "added"],
        [5, "logged", "found"],
      ],
    );
    const entry = async (number: string) => (await listStickerLog(writer.shop.id, { query: number })).items[0];
    assert.equal((await entry("IMP-40")).customerId, benjamin);
    assert.equal((await entry("IMP-41")).customerId, colin);
    // Someone new is added once, as the file writes them.
    assert.equal((await named(writer.shop.id, "Mahlon, John")).length, 1);
    assert.deepEqual(await named(writer.shop.id, "John Mahlon"), []);
    assert.equal((await entry("IMP-43")).customerName, "Mahlon, John");
    // In the log for Benjamin Rudd, the file's "Rudd, Benjamin" is him: no note.
    const again = await importStickers(writer, { importId: randomUUID(), fileName: "stickers.txt", stickers: [row(2, "IMP-40", "Rudd, Benjamin", 1)] });
    assert.ok("outcomes" in again);
    assert.deepEqual(again.outcomes, [{ row: 2, result: "already", customer: null, message: null }]);
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

  test("an import logs the shop's sheet: each list's stickers or plates, with its own customers", async () => {
    const rows = parseCsv(SHEET, pastedDelimiter(SHEET));
    const plan = planStickerImport(rows, 0, stickerColumns(rows[0]));
    const importId = randomUUID();
    const result = await importStickers(writer, { importId, fileName: "Sticker & Plate log.xlsx", stickers: plan.stickers });
    assert.ok("outcomes" in result, JSON.stringify(result));
    assert.ok(result.outcomes.every((outcome) => outcome.result === "logged"), JSON.stringify(result.outcomes));
    const of = async (kind: EntryKind, query: string) =>
      (await listStickerLog(writer.shop.id, { kind, query, perPage: 100 })).items.map((entry) => [entry.stickerNumber, entry.customerName]).sort();
    assert.deepEqual(await of("sticker", "T280"), [
      ["T280377", "Henry, Michael"],
      ["T280391", "Austin, Matt"],
      ["T280397", "Shick, Jessica"],
      ["T280409", "Hohman, Dennis"],
    ]);
    assert.deepEqual(await of("1", "90W"), [["90W14", "Elkin, Tyler"]]);
    assert.deepEqual(await of("2", "93Y"), [
      ["93Y39", "Neiderhiser, Charles"],
      ["93Y67", "Austin, Matt"],
      ["93Y73", "Shick, Jessica"],
      ["93Y83", "Powell & Associates"],
    ]);
    // Matt Austin's sticker and plate are one customer's; nobody "returned".
    assert.equal((await named(writer.shop.id, "Austin, Matt")).length, 1);
    assert.deepEqual(await named(writer.shop.id, "Benanti, Anthony - returned"), []);
    const [entry] = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, importId));
    assert.deepEqual(entry.details, { fileName: "Sticker & Plate log.xlsx", logged: 9, already: 0, customersAdded: 7, failed: 0 });
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
