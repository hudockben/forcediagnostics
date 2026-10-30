// The Activity log (System Admin > Activity log): what its entries say and
// its CSV (src/lib/audit-log-rules.ts); audit_log itself, which nobody can
// change or delete, not even the database's owner, each entry sealed to the
// one before it as it's saved (drizzle/0035_audit_log_locked.sql); the check
// that finds an entry changed, taken out or slipped in behind the triggers'
// back, and the log's pages and download (src/lib/audit-log.ts); and
// deleting a diagnosis, which only managers and admins can and which the log
// keeps (deleteConversation in src/lib/diagnose.ts).
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";

import { systemDb, withShop, type ShopTransaction } from "../src/db";
import { auditLog, diagnosisConversations, diagnosisTurns, shops, users } from "../src/db/schema";
import { exportAuditLog, listAuditLog, verifyAuditLog } from "../src/lib/audit-log";
import {
  areaOf,
  auditLogCsv,
  authorOf,
  checkInWords,
  describeAuditEntry,
  parseAreaFilter,
  type AuditLogEntry,
} from "../src/lib/audit-log-rules";
import { addVehicle, createCustomer, removeVehicle } from "../src/lib/customers";
import { STALE_AFTER_MS, deleteConversation, getConversation, isProblem, listConversations, prepareTurn, runTurn } from "../src/lib/diagnose";
import { ADMIN_SECTIONS, allows, can, needsPasswordSession } from "../src/lib/permissions";
import { ROLES } from "../src/lib/roles";
import type { CurrentUser } from "../src/lib/session";

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
const shopIds: string[] = [];
let shopsMade = 0;

async function createShop(): Promise<CurrentUser["shop"]> {
  const code = `al${suffix}${++shopsMade}`;
  const [shop] = await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name });
  shopIds.push(shop.id);
  return shop;
}

async function createUser(shop: CurrentUser["shop"], role: CurrentUser["role"], name: string): Promise<CurrentUser> {
  const id = randomUUID();
  const username = `${name.toLowerCase()}${randomUUID().slice(0, 4)}`;
  await systemDb.insert(users).values({ id, shopId: shop.id, role, name, username: `${shop.code}.${username}`, displayUsername: username, email: `${randomUUID()}@no-email.invalid` });
  return { id, name, username, role, shop, bay: null };
}

// An entry, as the app's code adds one: as app_user, inside withShop.
async function addEntry(actor: CurrentUser, action: string, details: Record<string, unknown> = {}, values: Partial<typeof auditLog.$inferInsert> = {}) {
  await withShop(actor.shop.id, (tx) =>
    tx.insert(auditLog).values({ shopId: actor.shop.id, actorUserId: actor.id, action, targetType: "thing", targetId: randomUUID(), details, ...values }),
  );
}

const entriesOf = (shopId: string) => systemDb.select().from(auditLog).where(eq(auditLog.shopId, shopId)).orderBy(auditLog.seq);

// Changes the log behind the triggers' back, as an owner who turned them off
// could. In one transaction, so nobody else ever finds them off.
async function behindTheTriggers(run: (tx: ShopTransaction) => Promise<unknown>, triggers = ["audit_log_unchangeable"]) {
  await systemDb.transaction(async (tx) => {
    for (const trigger of triggers) await tx.execute(sql.raw(`alter table audit_log disable trigger ${trigger}`));
    await run(tx);
    for (const trigger of triggers) await tx.execute(sql.raw(`alter table audit_log enable trigger ${trigger}`));
  });
}

// What a database error's code is (42501: permission denied, or the log's
// triggers refusing).
const code = (error: unknown) => (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;

after(async () => {
  for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
  await systemDb.$client.end();
});

describe("what the log says", () => {
  const entry = (action: string, details: Record<string, unknown>, targetType = "thing") => describeAuditEntry({ action, targetType, targetId: "t1", details });

  test("each kind of entry in words, without who", () => {
    assert.equal(entry("account.created", { username: "sam", role: "service_writer" }).summary, "Added sam as Service writer");
    assert.equal(
      entry("account.updated", { username: "sam", role: { from: "tech", to: "manager" }, name: { from: "Sam", to: "Sam Ortiz" } }).summary,
      "Changed sam from Tech to Manager and renamed sam from Sam to Sam Ortiz",
    );
    assert.equal(entry("pin.set", { username: "sam", by: "self" }).summary, "Set their own bay tablet PIN");
    assert.equal(entry("pin.locked", { username: "sam", kind: "hard" }).summary, "sam's PIN locked until unlocked (too many wrong PINs today)");
    assert.equal(entry("device.paired", { name: "Bay 3" }).summary, "Bay 3 was paired");
    assert.equal(entry("customer.updated", { name: "Dana Whitfield", fields: ["phone", "addressLine1"] }).summary, "Changed Dana Whitfield's phone number and address");
    assert.equal(entry("customer.removed", { name: "Dana Whitfield", vehicles: 2 }).summary, "Removed the customer Dana Whitfield and 2 vehicles");
    assert.deepEqual(entry("vehicle.added", { vehicle: "2021 Polaris Sportsman 850", relation: "bought" }), {
      summary: "Added the 2021 Polaris Sportsman 850 to a customer's record",
      facts: [{ label: "Deal", value: "Bought from us" }],
    });
    assert.equal(entry("sticker.updated", { stickerNumber: "PA-1002", fields: ["stickerNumber", "plateClass"], was: "PA-1001" }).summary, "Corrected sticker PA-1002: its number and classification (it was PA-1001)");
    assert.equal(entry("supplier.updated", { supplierId: "V100", fields: ["supplierName", "categoryCode"] }).summary, "Changed supplier V100: Supplier Name and Category Code");
    assert.equal(entry("manual.ocr", { title: "RZR XP 1000 Service Manual", pages: [3, 4, 5], pagesGainedText: 2 }).summary, "Read 3 scanned pages of RZR XP 1000 Service Manual");
  });

  test("a deleted diagnosis says what it was, and why", () => {
    assert.deepEqual(
      entry(
        "diagnosis.deleted",
        {
          title: "Misfires under load",
          unit: "2019 RZR XP 1000 EPS — Z19VDE99AM",
          vin: "3NSVDE997KF123456",
          startedByName: "Mike",
          startedAt: "2026-10-03T14:05:00.000Z",
          messages: 4,
          status: "solved",
          fix: "Fouled plug",
          customerName: null,
          reason: "Started on the wrong unit",
        },
        "diagnosis",
      ),
      {
        summary: "Deleted the diagnosis “Misfires under load”",
        facts: [
          { label: "Unit", value: "2019 RZR XP 1000 EPS — Z19VDE99AM · VIN 3NSVDE997KF123456" },
          { label: "Started by", value: "Mike" },
          { label: "Started", value: "2026-10-03T14:05:00.000Z", time: true },
          { label: "Messages", value: "4" },
          { label: "Status", value: "Solved: Fouled plug" },
          { label: "Reason", value: "Started on the wrong unit" },
        ],
      },
    );
  });

  test("a kind it doesn't know says what it was on", () => {
    assert.equal(entry("estimate.sent", { total: 100 }, "estimate").summary, "estimate.sent on estimate t1");
  });

  test("who: the name then, someone since removed, or the app itself", () => {
    assert.equal(authorOf({ actorUserId: "u1", actorName: "Sam" }), "Sam");
    assert.equal(authorOf({ actorUserId: "u1", actorName: null }), "An account since removed");
    assert.equal(authorOf({ actorUserId: null, actorName: null }), "The app");
  });

  test("its areas", () => {
    assert.equal(parseAreaFilter("diagnoses"), "diagnoses");
    assert.equal(parseAreaFilter("toString"), null);
    assert.equal(parseAreaFilter(["diagnoses"]), null);
    assert.equal(areaOf("customer_vehicle"), "customers");
    assert.equal(areaOf("user"), "accounts");
    assert.equal(areaOf("estimate"), null);
  });

  test("the check, in words", () => {
    const last = { seq: 3, hash: "f".repeat(64), createdAt: new Date() };
    assert.deepEqual(checkInWords({ entries: 3, broken: null, unsealed: 0, last }), {
      ok: true,
      text: "The log checks out: all 3 entries are as written, with none taken out.",
    });
    assert.equal(checkInWords({ entries: 0, broken: null, unsealed: 0, last: null }).text, "Nothing in the log yet.");
    assert.deepEqual(checkInWords({ entries: 3, broken: { seq: 2, reason: "changed" }, unsealed: 0, last }), {
      ok: false,
      text: "The log doesn't check out: entry #2 was changed after it was written: it no longer matches its seal.",
    });
    assert.equal(checkInWords({ entries: 3, broken: null, unsealed: 1, last }).ok, false);
  });

  test("the CSV: the time in the shop's zone, each entry in words and as stored, nothing Excel would run", () => {
    const row: AuditLogEntry = {
      id: "e1",
      seq: 7,
      createdAt: new Date("2026-10-30T03:04:05Z"),
      actorUserId: "u1",
      actorName: "Sam",
      action: "customer.created",
      targetType: "customer",
      targetId: "c1",
      details: { name: "=HYPERLINK(\"x\")" },
      hash: "a".repeat(64),
      prevHash: "b".repeat(64),
    };
    assert.equal(
      auditLogCsv([row], "America/New_York"),
      "﻿#,When,Who,What,Details,Area,Action,Record,Fingerprint,Previous fingerprint,Data\r\n" +
        `7,2026-10-29 23:04:05,Sam,"Added the customer =HYPERLINK(""x"")",,Customers,customer.created,customer c1,${"a".repeat(64)},${"b".repeat(64)},"{""name"":""=HYPERLINK(\\""x\\"")""}"\r\n`,
    );
    const deleted = auditLogCsv([{ ...row, action: "diagnosis.deleted", targetType: "diagnosis", details: { title: "No start", startedAt: "2026-10-03T14:05:00.000Z", messages: 1 } }]);
    assert.ok(deleted.includes("Started: 2026-10-03 10:05:00; Messages: 1; Status: Open"), deleted);
  });

  test("it's a System Admin section for managers and admins, signed in with a password", () => {
    const section = ADMIN_SECTIONS.find((entry) => entry.href === "/admin/activity-log");
    assert.equal(section?.label, "Activity log");
    assert.equal(section?.capability, "audit.read");
    assert.deepEqual(
      ROLES.filter((role) => can(role, "audit.read")),
      ["manager", "admin"],
    );
    assert.ok(needsPasswordSession("audit.read"));
  });
});

describe("the log can't be altered", () => {
  let admin: CurrentUser;

  before(async () => {
    admin = await createUser(await createShop(), "admin", "Pat");
  });

  test("each entry is sealed as it's saved: numbered, timed, its author's name and hashed after the one before", async () => {
    const before = new Date();
    await withShop(admin.shop.id, async (tx) => {
      await tx.insert(auditLog).values({ shopId: admin.shop.id, actorUserId: admin.id, action: "test.first", targetType: "thing", targetId: "1" });
      await tx.insert(auditLog).values({ shopId: admin.shop.id, actorUserId: null, action: "test.second", targetType: "thing", targetId: "2" });
      // Inside the transaction that adds them they aren't sealed yet.
      const [own] = await tx.select({ seq: auditLog.seq, hash: auditLog.hash }).from(auditLog).where(eq(auditLog.action, "test.first"));
      assert.deepEqual(own, { seq: null, hash: null });
    });
    await addEntry(admin, "test.third");
    const entries = await entriesOf(admin.shop.id);
    assert.deepEqual(
      entries.map((entry) => [entry.seq, entry.action, entry.actorName]),
      [
        [1, "test.first", "Pat"],
        [2, "test.second", null],
        [3, "test.third", "Pat"],
      ],
    );
    assert.equal(entries[0].prevHash, null);
    assert.equal(entries[1].prevHash, entries[0].hash);
    assert.equal(entries[2].prevHash, entries[1].hash);
    assert.ok(entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.hash ?? "")));
    assert.ok(entries.every((entry) => entry.createdAt >= new Date(before.getTime() - 1000)));
    // Each shop has its own numbers.
    const other = await createUser(await createShop(), "admin", "Lee");
    await addEntry(other, "test.elsewhere");
    assert.deepEqual((await entriesOf(other.shop.id)).map((entry) => [entry.seq, entry.prevHash]), [[1, null]]);
  });

  test("an insert can't fill in the chain itself", async () => {
    const shopAdmin = await createUser(await createShop(), "admin", "Ali");
    await addEntry(shopAdmin, "test.forged", {}, { seq: 999, hash: "f".repeat(64), prevHash: "e".repeat(64), actorName: "Someone else" });
    const [entry] = await entriesOf(shopAdmin.shop.id);
    assert.deepEqual([entry.seq, entry.prevHash, entry.actorName], [1, null, "Ali"]);
    assert.notEqual(entry.hash, "f".repeat(64));
    assert.equal((await verifyAuditLog(shopAdmin.shop.id)).broken, null);
  });

  test("the app can't change or delete an entry", async () => {
    await assert.rejects(
      withShop(admin.shop.id, (tx) => tx.update(auditLog).set({ action: "test.changed" }).where(eq(auditLog.shopId, admin.shop.id))),
      (error) => code(error) === "42501",
    );
    await assert.rejects(
      withShop(admin.shop.id, (tx) => tx.delete(auditLog).where(eq(auditLog.shopId, admin.shop.id))),
      (error) => code(error) === "42501",
    );
  });

  test("nor can the database's owner: no change, no delete, no emptying it", async () => {
    const refused = (error: unknown) => code(error) === "42501" && /can't be changed or deleted/.test(String((error as { cause?: Error }).cause?.message ?? error));
    await assert.rejects(systemDb.update(auditLog).set({ action: "test.changed" }).where(eq(auditLog.shopId, admin.shop.id)), refused);
    await assert.rejects(systemDb.update(auditLog).set({ details: { a: 1 } }).where(eq(auditLog.shopId, admin.shop.id)), refused);
    await assert.rejects(systemDb.delete(auditLog).where(eq(auditLog.shopId, admin.shop.id)), refused);
    await assert.rejects(systemDb.execute(sql`truncate audit_log`), refused);
    // Not even by filling in a sealed entry's chain again.
    await assert.rejects(systemDb.update(auditLog).set({ hash: "0".repeat(64), prevHash: null }).where(and(eq(auditLog.shopId, admin.shop.id), eq(auditLog.seq, 2))), refused);
    assert.equal((await entriesOf(admin.shop.id)).length, 3);
  });

  test("an account in the log can't be deleted out from under it", async () => {
    const leaving = await createUser(admin.shop, "tech", "Leaving");
    await addEntry(leaving, "test.by_leaving");
    await assert.rejects(systemDb.delete(users).where(eq(users.id, leaving.id)));
    const [entry] = await systemDb.select().from(auditLog).where(eq(auditLog.action, "test.by_leaving"));
    assert.deepEqual([entry.actorUserId, entry.actorName], [leaving.id, "Leaving"]);
  });

  test("an entry only goes with its whole shop", async () => {
    const shop = await createShop();
    const gone = await createUser(shop, "admin", "Gone");
    await addEntry(gone, "test.gone");
    await systemDb.delete(shops).where(eq(shops.id, shop.id));
    assert.equal((await entriesOf(shop.id)).length, 0);
  });
});

describe("checking the seals", () => {
  // A shop of its own for each, with a log of five entries.
  async function logOfFive() {
    const admin = await createUser(await createShop(), "admin", "Kim");
    for (let n = 1; n <= 5; n++) await addEntry(admin, `test.entry${n}`, { n });
    return admin;
  }
  const at = (shopId: string, seq: number) => and(eq(auditLog.shopId, shopId), eq(auditLog.seq, seq));

  test("an untouched log checks out, and its latest hash stands for it", async () => {
    const admin = await logOfFive();
    const check = await verifyAuditLog(admin.shop.id);
    const entries = await entriesOf(admin.shop.id);
    assert.deepEqual([check.entries, check.broken, check.unsealed, check.last?.seq, check.last?.hash], [5, null, 0, 5, entries[4].hash]);
    const empty = await verifyAuditLog((await createShop()).id);
    assert.deepEqual([empty.entries, empty.broken, empty.last], [0, null, null]);
  });

  test("an entry changed behind the triggers' back no longer matches its seal", async () => {
    const admin = await logOfFive();
    await behindTheTriggers((tx) => tx.update(auditLog).set({ details: { n: 30 } }).where(at(admin.shop.id, 3)));
    assert.deepEqual((await verifyAuditLog(admin.shop.id)).broken, { seq: 3, reason: "changed" });
  });

  test("one changed and its hash worked out again is caught by the entry after it", async () => {
    const admin = await logOfFive();
    await behindTheTriggers(async (tx) => {
      await tx.update(auditLog).set({ actorUserId: null }).where(at(admin.shop.id, 2));
      await tx.execute(sql`update audit_log set hash = audit_log_hash(audit_log) where shop_id = ${admin.shop.id} and seq = 2`);
    });
    assert.deepEqual((await verifyAuditLog(admin.shop.id)).broken, { seq: 3, reason: "relinked" });
  });

  test("one taken out leaves a gap", async () => {
    const admin = await logOfFive();
    await behindTheTriggers((tx) => tx.delete(auditLog).where(at(admin.shop.id, 4)));
    assert.deepEqual((await verifyAuditLog(admin.shop.id)).broken, { seq: 5, reason: "missing" });
  });

  test("one slipped in without its seal is found", async () => {
    const admin = await logOfFive();
    await behindTheTriggers(
      (tx) => tx.insert(auditLog).values({ shopId: admin.shop.id, actorUserId: admin.id, action: "test.slipped", targetType: "thing", targetId: "x" }),
      ["audit_log_seal"],
    );
    const check = await verifyAuditLog(admin.shop.id);
    assert.deepEqual([check.broken, check.unsealed], [null, 1]);
    assert.equal(checkInWords(check).ok, false);
  });
});

describe("the log's pages and download", () => {
  let manager: CurrentUser;

  before(async () => {
    const shop = await createShop();
    manager = await createUser(shop, "manager", "Morgan");
    const blank = { phone: "", email: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", notes: "" };
    for (const name of ["Dana Whitfield", "Rhett Carver", "Walt Ostrowski"]) {
      const made = await createCustomer(manager, { name, ...blank });
      assert.ok("id" in made);
    }
    await addEntry(manager, "device.pairing_code", { name: "Bay 3" }, { targetType: "device" });
  });

  test("newest first, by area and by what it says, a page at a time", async () => {
    const all = await listAuditLog(manager.shop.id);
    assert.deepEqual(
      all.items.map((entry) => [entry.seq, entry.action]),
      [
        [4, "device.pairing_code"],
        [3, "customer.created"],
        [2, "customer.created"],
        [1, "customer.created"],
      ],
    );
    assert.equal(all.total, 4);
    const customers = await listAuditLog(manager.shop.id, { area: "customers" });
    assert.equal(customers.total, 3);
    const found = await listAuditLog(manager.shop.id, { query: "carver" });
    assert.deepEqual(found.items.map((entry) => entry.seq), [2]);
    assert.deepEqual((await listAuditLog(manager.shop.id, { query: "morgan bay" })).items.map((entry) => entry.seq), [4]);
    const second = await listAuditLog(manager.shop.id, { page: 2, perPage: 3 });
    assert.deepEqual([second.page, second.pages, second.items.map((entry) => entry.seq)], [2, 2, [1]]);
  });

  test("the download is oldest first, and only the shop's own", async () => {
    const rows = await exportAuditLog(manager.shop.id, { area: "customers" });
    assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3]);
    const csv = auditLogCsv(rows);
    assert.ok(csv.includes(",Morgan,Added the customer Dana Whitfield,,Customers,customer.created,"), csv);
    const elsewhere = await createUser(await createShop(), "manager", "Elsewhere");
    assert.equal((await listAuditLog(elsewhere.shop.id)).total, 0);
    assert.equal((await exportAuditLog(elsewhere.shop.id)).length, 0);
  });
});

describe("deleting a diagnosis", () => {
  let tech: CurrentUser;
  let manager: CurrentUser;
  let otherManager: CurrentUser;

  before(async () => {
    const shop = await createShop();
    tech = await createUser(shop, "tech", "Mike");
    manager = await createUser(shop, "manager", "Morgan");
    otherManager = await createUser(await createShop(), "manager", "Elsewhere");
  });

  // A diagnosis with one message, Claude's answer to it done.
  async function diagnosis(complaint: string, start: Record<string, string> = {}) {
    const prepared = await prepareTurn(tech, { start: { complaint, ...start } });
    assert.ok(!isProblem(prepared), JSON.stringify(prepared));
    await systemDb
      .update(diagnosisTurns)
      .set({ status: "done", history: [], finishedAt: new Date() })
      .where(eq(diagnosisTurns.id, prepared.turn.id));
    return prepared;
  }

  test("only managers and admins can, signed in with a password", () => {
    assert.deepEqual(
      ROLES.filter((role) => can(role, "diagnostics.delete")),
      ["manager", "admin"],
    );
    assert.ok(needsPasswordSession("diagnostics.delete"));
    assert.equal(allows({ role: "manager", bay: null }, "diagnostics.delete"), true);
    assert.equal(allows({ role: "manager", bay: { deviceId: "d", deviceName: "Bay 1", sessionId: "s" } }, "diagnostics.delete"), false);
  });

  test("a manager deletes one, its messages with it, and the log keeps what it was", async () => {
    const shop = manager.shop.id;
    const blank = { phone: "", email: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", notes: "" };
    const customer = await createCustomer(manager, { name: "Dana Whitfield", ...blank });
    assert.ok("id" in customer);
    const vehicle = await addVehicle(manager, customer.id, {
      relation: "bought",
      relationDate: "",
      year: "2021",
      make: "Polaris",
      model: "Sportsman 850",
      modelNumber: "",
      vin: "",
      color: "",
      notes: "",
    });
    assert.ok("id" in vehicle);
    const prepared = await diagnosis("Belt squeal at idle", { customerVehicle: vehicle.id });
    const id = prepared.conversation.id;

    // The vehicle stays on the record while a diagnosis is tied to it.
    assert.ok("error" in (await removeVehicle(manager, customer.id, vehicle.id)));

    const deleted = await deleteConversation(manager, { conversationId: id, reason: "  Started on the wrong unit  " });
    assert.deepEqual(deleted, { title: "Belt squeal at idle" });
    assert.equal(await getConversation(manager, id), null);
    assert.equal((await systemDb.select().from(diagnosisTurns).where(eq(diagnosisTurns.conversationId, id))).length, 0);
    assert.ok(!(await listConversations(shop, { perPage: 100 })).items.some((item) => item.id === id));

    const [entry] = await systemDb.select().from(auditLog).where(and(eq(auditLog.action, "diagnosis.deleted"), eq(auditLog.targetId, id)));
    assert.equal(entry.actorUserId, manager.id);
    assert.equal(entry.actorName, "Morgan");
    assert.equal(entry.targetType, "diagnosis");
    assert.equal(typeof entry.seq, "number");
    const details = entry.details as Record<string, unknown>;
    assert.deepEqual(
      [details.title, details.status, details.startedBy, details.startedByName, details.messages, details.customerName, details.customerVehicleId, details.reason],
      ["Belt squeal at idle", "open", tech.id, "Mike", 1, "Dana Whitfield", vehicle.id, "Started on the wrong unit"],
    );
    assert.equal(details.startedAt, prepared.conversation.createdAt.toISOString());

    // It shows in the Activity log, and the log still checks out.
    const log = await listAuditLog(shop, { area: "diagnoses" });
    assert.deepEqual(log.items.map((item) => item.targetId), [id]);
    assert.equal(describeAuditEntry(log.items[0]).summary, "Deleted the diagnosis “Belt squeal at idle”");
    assert.equal((await verifyAuditLog(shop)).broken, null);

    // With its diagnosis gone the vehicle can come off the record.
    assert.deepEqual(await removeVehicle(manager, customer.id, vehicle.id), { ok: true });

    // Deleting it again finds nothing.
    assert.deepEqual(await deleteConversation(manager, { conversationId: id }), { error: "That diagnosis isn't in this shop." });
  });

  test("not while Claude is answering; a message whose server went quiet doesn't hold it up", async () => {
    const prepared = await prepareTurn(tech, { start: { complaint: "Won't idle" } });
    assert.ok(!isProblem(prepared));
    const id = prepared.conversation.id;
    const refused = await deleteConversation(manager, { conversationId: id });
    assert.ok("error" in refused && /still answering/.test(refused.error), JSON.stringify(refused));
    assert.ok(await getConversation(manager, id));

    await systemDb
      .update(diagnosisTurns)
      .set({ heartbeatAt: new Date(Date.now() - STALE_AFTER_MS - 5000) })
      .where(eq(diagnosisTurns.id, prepared.turn.id));
    assert.deepEqual(await deleteConversation(manager, { conversationId: id }), { title: "Won't idle" });

    // That message's server, if it was still going after all, finds nothing
    // to save it to, and says so.
    await assert.rejects(
      runTurn(prepared, {
        client: async () => {
          throw new Anthropic.APIUserAbortError();
        },
        emit: () => {},
      }),
      /deleted while Claude was answering/,
    );
  });

  test("not another shop's, whatever the code does", async () => {
    const prepared = await diagnosis("Hard start cold");
    const id = prepared.conversation.id;
    assert.deepEqual(await deleteConversation(otherManager, { conversationId: id }), { error: "That diagnosis isn't in this shop." });
    const gone = await withShop(otherManager.shop.id, (tx) => tx.delete(diagnosisConversations).where(eq(diagnosisConversations.id, id)).returning());
    assert.equal(gone.length, 0);
    assert.ok(await getConversation(tech, id));
    assert.deepEqual(await deleteConversation(manager, { conversationId: "not-an-id" }), { error: "That diagnosis isn't in this shop." });
  });

  test("a message can't be deleted on its own", async () => {
    const prepared = await diagnosis("Clunk in reverse");
    await assert.rejects(
      withShop(tech.shop.id, (tx) => tx.delete(diagnosisTurns).where(eq(diagnosisTurns.id, prepared.turn.id))),
      (error) => code(error) === "42501",
    );
  });

  test("a long reason is cut to fit", async () => {
    const prepared = await diagnosis("Overheats on trail");
    assert.ok("title" in (await deleteConversation(manager, { conversationId: prepared.conversation.id, reason: "x".repeat(500) })));
    const [entry] = await systemDb.select().from(auditLog).where(and(eq(auditLog.action, "diagnosis.deleted"), eq(auditLog.targetId, prepared.conversation.id)));
    assert.equal((entry.details as { reason: string }).reason.length, 200);
  });
});
