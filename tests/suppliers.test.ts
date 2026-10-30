// System Admin > Supplier: the rules for a supplier and for reading a
// supplier list (src/lib/supplier-rules.ts), and the list itself
// (src/lib/suppliers.ts): a Supplier ID once per shop (without case),
// searching and filtering, corrections and removals in audit_log, importing
// a list that's matched on Supplier ID (again, it changes nothing), and
// nothing reaching another shop.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { eq } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, shops, suppliers, users } from "../src/db/schema";
import { parseCsv } from "../src/lib/csv";
import { detectDelimiter } from "../src/lib/customer-import-rules";
import { ADMIN_SECTIONS, can } from "../src/lib/permissions";
import type { CurrentUser } from "../src/lib/session";
import {
  checkSupplier,
  findSupplierHeader,
  nextSupplierId,
  planSupplierImport,
  supplierColumns,
  suppliersCsv,
  type SupplierImportRow,
} from "../src/lib/supplier-rules";
import {
  createSupplier,
  exportSuppliers,
  getSupplier,
  importSuppliers,
  listCategories,
  listSuppliers,
  removeSupplier,
  suggestSupplierId,
  updateSupplier,
} from "../src/lib/suppliers";

// The headings as they were asked for, copied from a spreadsheet.
const HEADINGS = "Supplier ID\tSupplier Code\tSupplier Name\tCategory Code\tCategory ID";

const pasted = (lines: string[]) => {
  const text = lines.join("\n");
  return parseCsv(text, detectDelimiter(text));
};

describe("the rules for a supplier", () => {
  test("a Supplier ID and a Supplier Name are needed; the rest is tidied, blank is null", () => {
    assert.deepEqual(checkSupplier({ supplierId: " 1001 ", supplierName: "Polaris  Industries", supplierCode: "POL", categoryCode: "", categoryId: "" }), {
      supplier: { supplierId: "1001", supplierCode: "POL", supplierName: "Polaris Industries", categoryCode: null, categoryId: null },
    });
    assert.deepEqual(checkSupplier({ supplierName: "No ID" }), { error: "Enter the Supplier ID." });
    assert.deepEqual(checkSupplier({ supplierId: "1" }), { error: "Enter the Supplier Name." });
    assert.ok("error" in checkSupplier({ supplierId: "x".repeat(41), supplierName: "Long" }));
    assert.deepEqual(checkSupplier({ supplierId: 1002, supplierName: "Tab\there" }), {
      supplier: { supplierId: "1002", supplierCode: null, supplierName: "Tab here", categoryCode: null, categoryId: null },
    });
  });

  test("the next Supplier ID follows the highest number, keeping leading zeros", () => {
    assert.equal(nextSupplierId([]), "1");
    assert.equal(nextSupplierId(["1", "2", "10"]), "11");
    assert.equal(nextSupplierId(["0007", "0010"]), "0011");
    assert.equal(nextSupplierId(["V100", "2"]), null);
  });

  test("the headings asked for, pasted from Excel, map every column", () => {
    const rows = pasted([HEADINGS, "1001\tPOL\tPolaris Industries\tOEM\t1"]);
    assert.equal(findSupplierHeader(rows), 0);
    assert.deepEqual(supplierColumns(rows[0]), ["supplierId", "supplierCode", "supplierName", "categoryCode", "categoryId"]);
    assert.deepEqual(supplierColumns(["Vendor #", "Vendor Code", "Vendor Name", "Category", "Cat ID"]), [
      "supplierId",
      "supplierCode",
      "supplierName",
      "categoryCode",
      "categoryId",
    ]);
  });

  test("a list is planned one supplier per ID, the later row winning, with notes", () => {
    const rows = pasted([
      "Supplier list",
      HEADINGS,
      "1001\tPOL\tPolaris Industries\tOEM\t1",
      "1002\tTUS\tTucker Powersports\tDIST\t2",
      "\t\t\t\t",
      "1003\t\t\tAFT\t3",
      "v4\tPC\tParts Canada\tDIST\t2",
      "V4\tPCU\tParts Canada Unlimited\tDIST\t2",
    ]);
    const header = findSupplierHeader(rows);
    assert.equal(header, 1);
    const plan = planSupplierImport(rows, header, supplierColumns(rows[header]));
    assert.deepEqual(
      plan.suppliers.map((supplier) => [supplier.row, supplier.supplierId, supplier.supplierName]),
      [
        [3, "1001", "Polaris Industries"],
        [4, "1002", "Tucker Powersports"],
        [8, "V4", "Parts Canada Unlimited"],
      ],
    );
    assert.deepEqual(plan.notes, [
      { row: 6, message: "Enter the Supplier Name: row left out." },
      { row: 8, message: "Supplier ID V4 is also on row 7: this row is the one used." },
    ]);
    assert.equal(plan.rowsRead, 5);
  });

  test("rows pasted from a spreadsheet are read by tabs, whatever commas a name has", () => {
    const rows = pasted(["Supplier ID\tSupplier Name", "1\tPolaris", "2\tAmerican Honda Motor Co., Inc.", "3\tTucker Rocky, Inc."]);
    const plan = planSupplierImport(rows, findSupplierHeader(rows), supplierColumns(rows[0]));
    assert.deepEqual(
      plan.suppliers.map((supplier) => supplier.supplierName),
      ["Polaris", "American Honda Motor Co., Inc.", "Tucker Rocky, Inc."],
    );
  });

  test("the list's own CSV imports back as it was: the apostrophe kept as text comes off", () => {
    const list = [
      { supplierId: "-5", supplierCode: "-", supplierName: "@Home Powersports", categoryCode: "+1", categoryId: "=2" },
      { supplierId: "6", supplierCode: null, supplierName: "'Quoted' Cycles", categoryCode: null, categoryId: null },
    ];
    const rows = parseCsv(suppliersCsv(list).replace(/^\uFEFF/, ""));
    const plan = planSupplierImport(rows, findSupplierHeader(rows), supplierColumns(rows[0]));
    assert.deepEqual(
      plan.suppliers.map((supplier) => ({ ...supplier, row: undefined })),
      list.map((supplier) => ({ ...supplier, row: undefined })),
    );
  });

  test("the CSV has the list's headings and nothing Excel would run", () => {
    assert.equal(
      suppliersCsv([
        { supplierId: "1001", supplierCode: "POL", supplierName: "Polaris, Inc.", categoryCode: "OEM", categoryId: "1" },
        { supplierId: "1002", supplierCode: null, supplierName: "=cmd()", categoryCode: null, categoryId: null },
      ]),
      '﻿Supplier ID,Supplier Code,Supplier Name,Category Code,Category ID\r\n1001,POL,"Polaris, Inc.",OEM,1\r\n1002,,\'=cmd(),,\r\n',
    );
  });

  test("it's a System Admin section called Supplier, for parts staff, managers and admins", () => {
    const section = ADMIN_SECTIONS.find((entry) => entry.href === "/admin/suppliers");
    assert.equal(section?.label, "Supplier");
    assert.equal(section?.capability, "parts.manage");
    assert.ok(can("parts", "parts.manage") && can("manager", "parts.manage") && can("admin", "parts.manage"));
    assert.ok(!can("tech", "parts.manage") && !can("service_writer", "parts.manage"));
  });
});

describe("the supplier list", () => {
  const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
  const shopIds: string[] = [];
  let parts: CurrentUser;
  let other: CurrentUser;

  async function createUser(code: string): Promise<CurrentUser> {
    const [shop] = await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name });
    shopIds.push(shop.id);
    const id = randomUUID();
    await systemDb.insert(users).values({ id, shopId: shop.id, role: "parts", name: "Pat", username: `${code}.pat`, displayUsername: "pat", email: `${randomUUID()}@no-email.invalid` });
    return { id, name: "Pat", username: "pat", role: "parts", shop, bay: null };
  }

  before(async () => {
    parts = await createUser(`su${suffix}`);
    other = await createUser(`sx${suffix}`);
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  const add = async (actor: CurrentUser, supplierId: string, supplierName: string, extra: Record<string, string> = {}) => {
    const made = await createSupplier(actor, { supplierId, supplierName, ...extra });
    assert.ok("id" in made, JSON.stringify(made));
    return made.id;
  };

  test("a supplier is added, its Supplier ID once (without case), corrected and removed, all audited", async () => {
    const id = await add(parts, "V100", "Tucker Powersports", { supplierCode: "TUS", categoryCode: "DIST", categoryId: "2" });
    assert.deepEqual(await createSupplier(parts, { supplierId: "v100", supplierName: "Someone else" }), { error: "Supplier ID v100 is already Tucker Powersports." });
    assert.deepEqual(await updateSupplier(parts, id, { supplierId: "V100", supplierName: "Tucker Rocky", supplierCode: "TUS", categoryCode: "DIST", categoryId: "2" }), { ok: true });
    assert.equal((await getSupplier(parts.shop.id, id))?.supplierName, "Tucker Rocky");
    const second = await add(parts, "V101", "Parts Unlimited");
    assert.deepEqual(await updateSupplier(parts, second, { supplierId: "v100", supplierName: "Parts Unlimited" }), { error: "Supplier ID v100 is already Tucker Rocky." });
    assert.deepEqual(await removeSupplier(parts, second), { ok: true, supplierName: "Parts Unlimited" });
    assert.equal(await getSupplier(parts.shop.id, second), null);
    const history = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, id)).orderBy(auditLog.createdAt);
    assert.deepEqual(history.map((entry) => entry.action), ["supplier.created", "supplier.updated"]);
    assert.deepEqual(history[1].details, { supplierId: "V100", fields: ["supplierName"] });
    const [removed] = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, second));
    assert.ok(removed);
  });

  test("the list goes by Supplier ID (2 before 10), searches every field and filters by category", async () => {
    const shop = await createUser(`sl${suffix}`);
    for (const [supplierId, supplierName, categoryCode, categoryId] of [
      ["10", "Western Power Sports", "DIST", "2"],
      ["2", "Polaris Industries", "OEM", "1"],
      ["1", "Kimpex", "dist", "2"],
      ["A7", "Local Welding", "", ""],
    ]) {
      await add(shop, supplierId, supplierName, { categoryCode, categoryId });
    }
    const all = await listSuppliers(shop.shop.id);
    assert.deepEqual(all.items.map((supplier) => supplier.supplierId), ["1", "2", "10", "A7"]);
    const ids = async (options: Parameters<typeof listSuppliers>[1]) => (await listSuppliers(shop.shop.id, options)).items.map((supplier) => supplier.supplierId);
    assert.deepEqual(await ids({ query: "power" }), ["10"]);
    assert.deepEqual(await ids({ category: "DIST" }), ["1", "10"]);
    assert.deepEqual(await ids({ category: "dist", query: "kim" }), ["1"]);
    assert.deepEqual(await listCategories(shop.shop.id), [
      { code: "DIST", id: "2", suppliers: 2 },
      { code: "OEM", id: "1", suppliers: 1 },
    ]);
    assert.equal(await suggestSupplierId(shop.shop.id), null, "A7 isn't a number");
    assert.deepEqual((await exportSuppliers(shop.shop.id, { category: "OEM" })).map((supplier) => supplier.supplierName), ["Polaris Industries"]);
  });

  test("importing a list adds and updates by Supplier ID; again, it changes nothing", async () => {
    const shop = await createUser(`si${suffix}`);
    await add(shop, "1001", "Polaris", { supplierCode: "POL", categoryCode: "OEM", categoryId: "1" });
    const rows = pasted([
      HEADINGS,
      "1001\tPOL\tPolaris Industries\tOEM\t",
      "1002\tTUS\tTucker Powersports\tDIST\t2",
      "1003\tKPX\tKimpex\tDIST\t2",
    ]);
    const plan = planSupplierImport(rows, 0, supplierColumns(rows[0]));
    const importId = randomUUID();
    const first = await importSuppliers(shop, { importId, fileName: "suppliers.xlsx", suppliers: plan.suppliers });
    assert.ok("outcomes" in first, JSON.stringify(first));
    assert.deepEqual(first.outcomes.map((outcome) => [outcome.row, outcome.result]), [
      [2, "updated"],
      [3, "created"],
      [4, "created"],
    ]);
    const polaris = (await listSuppliers(shop.shop.id, { query: "1001" })).items[0];
    assert.deepEqual([polaris.supplierName, polaris.categoryId], ["Polaris Industries", "1"], "a blank cell leaves what's on file");
    const [entry] = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, importId));
    const { createdIds, ...counts } = entry.details as { createdIds: string[] };
    assert.deepEqual([entry.action, counts], ["suppliers.imported", { fileName: "suppliers.xlsx", created: 2, updated: 1, unchanged: 0, failed: 0 }]);
    assert.deepEqual(
      new Set(createdIds),
      new Set((await listSuppliers(shop.shop.id)).items.filter((supplier) => supplier.supplierId !== "1001").map((supplier) => supplier.id)),
    );
    const again = await importSuppliers(shop, { importId: randomUUID(), fileName: "suppliers.xlsx", suppliers: plan.suppliers });
    assert.ok("outcomes" in again);
    assert.ok(again.outcomes.every((outcome) => outcome.result === "unchanged"));
    assert.equal((await listSuppliers(shop.shop.id)).total, 3);
    // The server checks every row again, whatever the browser sent.
    const odd = await importSuppliers(shop, {
      importId: randomUUID(),
      fileName: "x",
      suppliers: [{ row: 9, supplierId: "", supplierName: "No ID" }, { row: 10, supplierId: "1004", supplierName: "Fine" }, null] as unknown as SupplierImportRow[],
    });
    assert.ok("outcomes" in odd);
    assert.deepEqual(odd.outcomes.map((outcome) => outcome.result), ["failed", "created", "failed"]);
    assert.ok("error" in (await importSuppliers(shop, { importId: "nope", fileName: "x", suppliers: plan.suppliers })));
    assert.ok("error" in (await importSuppliers(shop, { importId: randomUUID(), fileName: "x", suppliers: Array.from({ length: 501 }, (_, index) => ({ row: index, supplierId: `B${index}`, supplierName: "Bulk" })) })));
  });

  test("two imports of the same list at once add each supplier once", async () => {
    const shop = await createUser(`sc${suffix}`);
    const list = Array.from({ length: 50 }, (_, index) => ({ row: index + 2, supplierId: String(5000 + index), supplierCode: null, supplierName: `Supplier ${index}`, categoryCode: null, categoryId: null }));
    const [a, b] = await Promise.all([
      importSuppliers(shop, { importId: randomUUID(), fileName: "a", suppliers: list }),
      importSuppliers(shop, { importId: randomUUID(), fileName: "b", suppliers: list }),
    ]);
    assert.ok("outcomes" in a && "outcomes" in b);
    assert.equal([...a.outcomes, ...b.outcomes].filter((outcome) => outcome.result === "created").length, 50);
    assert.equal((await listSuppliers(shop.shop.id)).total, 50);
  });

  const row = (at: number, supplierId: string, supplierName: string) => ({ row: at, supplierId, supplierCode: null, supplierName, categoryCode: null, categoryId: null });
  const results = (outcome: Awaited<ReturnType<typeof importSuppliers>>) => {
    assert.ok("outcomes" in outcome, JSON.stringify(outcome));
    return outcome.outcomes.map((entry) => entry.result);
  };

  test("the list's own CSV, imported back, changes nothing", async () => {
    const shop = await createUser(`sr${suffix}`);
    await add(shop, "-5", "@Home Powersports", { supplierCode: "-", categoryCode: "+1", categoryId: "=2" });
    await add(shop, "0042", "Kimpex");
    // As a spreadsheet saves it: 0042 read as the number 42.
    const rows = parseCsv(suppliersCsv(await exportSuppliers(shop.shop.id)).replace(/^\uFEFF/, "").replace("\r\n0042,", "\r\n42,"));
    const plan = planSupplierImport(rows, 0, supplierColumns(rows[0]));
    assert.deepEqual(results(await importSuppliers(shop, { importId: randomUUID(), fileName: "suppliers.csv", suppliers: plan.suppliers })), ["unchanged", "unchanged"]);
    assert.deepEqual((await listSuppliers(shop.shop.id)).items.map((supplier) => [supplier.supplierId, supplier.supplierName, supplier.supplierCode]), [
      ["0042", "Kimpex", null],
      ["-5", "@Home Powersports", "-"],
    ]);
  });

  test("an all-digit Supplier ID matches the one on file with the same number, only when there's one", async () => {
    const shop = await createUser(`sn${suffix}`);
    await add(shop, "0042", "Kimpex");
    await add(shop, "07", "Parts Canada");
    await add(shop, "007", "Parts Canada (old)");
    await add(shop, "9", "Nine");
    const outcome = await importSuppliers(shop, {
      importId: randomUUID(),
      fileName: "x",
      suppliers: [row(2, "42", "Kimpex Inc."), row(3, "7", "Seven"), row(4, "09", "Nine"), row(5, "9", "Nine again")],
    });
    // 42 is 0042 (its ID stays); 7 could be 07 or 007, so it's added; 09
    // isn't 9, which the file names exactly (and updates).
    assert.deepEqual(results(outcome), ["updated", "created", "created", "updated"]);
    assert.deepEqual((await listSuppliers(shop.shop.id)).items.map((supplier) => [supplier.supplierId, supplier.supplierName]), [
      ["007", "Parts Canada (old)"],
      ["07", "Parts Canada"],
      ["7", "Seven"],
      ["09", "Nine"],
      ["9", "Nine again"],
      ["0042", "Kimpex Inc."],
    ]);
  });

  test("Supplier IDs are matched as Postgres lower-cases them, so one that JavaScript lower-cases otherwise can't sink the batch", async () => {
    const shop = await createUser(`sk${suffix}`);
    await add(shop, "İ1", "Dotted");
    await add(shop, "ΑΣ", "Sigma");
    const outcome = results(await importSuppliers(shop, { importId: randomUUID(), fileName: "x", suppliers: [row(2, "i1", "Dotted"), row(3, "ασ", "Sigma"), row(4, "Z9", "Fine")] }));
    // Whether these are the suppliers on file depends on the database's
    // collation; either way each is saved, never refused.
    assert.ok(outcome.every((result) => result !== "failed"), String(outcome));
    assert.equal(outcome[2], "created");
  });

  test("the same supplier twice in one batch: the later row is used, the earlier left out with a note, the counts agree", async () => {
    const shop = await createUser(`sd${suffix}`);
    await add(shop, "0005", "Five");
    const importId = randomUUID();
    const outcome = await importSuppliers(shop, { importId, fileName: "x", suppliers: [row(2, "x1", "First"), row(3, "X1", "Second"), row(4, "5", "Five A"), row(5, "05", "Five B")] });
    assert.ok("outcomes" in outcome);
    assert.deepEqual(
      outcome.outcomes.map((entry) => [entry.row, entry.result, entry.error]),
      [
        [2, "failed", "Supplier ID x1 is the same supplier as row 3, which is the one used."],
        [3, "created", null],
        [4, "failed", "Supplier ID 5 is the same supplier as row 5, which is the one used."],
        [5, "updated", null],
      ],
    );
    assert.deepEqual((await listSuppliers(shop.shop.id)).items.map((supplier) => [supplier.supplierId, supplier.supplierName]), [
      ["0005", "Five B"],
      ["X1", "Second"],
    ]);
    const [entry] = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, importId));
    assert.deepEqual({ ...entry.details, createdIds: undefined }, { fileName: "x", created: 1, updated: 1, unchanged: 0, failed: 2, createdIds: undefined });
  });

  test("Carry on sending a batch the server had saved reports its suppliers as added", async () => {
    const shop = await createUser(`sa${suffix}`);
    const batch = [row(2, "C1", "One"), row(3, "C2", "Two")];
    const importId = randomUUID();
    assert.deepEqual(results(await importSuppliers(shop, { importId, fileName: "x", suppliers: batch })), ["created", "created"]);
    // The answer was lost: the same batch again, in the same import.
    assert.deepEqual(results(await importSuppliers(shop, { importId, fileName: "x", suppliers: batch })), ["created", "created"]);
    assert.equal((await listSuppliers(shop.shop.id)).total, 2);
    // Another import of the same list finds them already there.
    assert.deepEqual(results(await importSuppliers(shop, { importId: randomUUID(), fileName: "x", suppliers: batch })), ["unchanged", "unchanged"]);
  });

  // Waits until a statement in another session is waiting on a lock.
  async function blocked() {
    for (let tries = 0; tries < 200; tries++) {
      const { rows } = await systemDb.$client.query("select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()");
      if (rows[0].waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("nothing waited on the lock");
  }

  test("a supplier added by someone else during an import is left out with a note, the rest of the batch saved", async () => {
    const shop = await createUser(`sw${suffix}`);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const ready = new Promise<void>((resolve) => (inserted = resolve));
    const racer = withShop(shop.shop.id, async (tx) => {
      await tx.insert(suppliers).values({ shopId: shop.shop.id, supplierId: "R1", supplierName: "Got there first" });
      inserted();
      await held;
    });
    await ready;
    const importing = importSuppliers(shop, { importId: randomUUID(), fileName: "x", suppliers: [row(2, "r1", "From the file"), row(3, "R2", "Also from the file")] });
    await blocked();
    release();
    await racer;
    const outcome = await importing;
    assert.ok("outcomes" in outcome, JSON.stringify(outcome));
    assert.deepEqual(outcome.outcomes.map((entry) => entry.result), ["failed", "created"]);
    assert.match(outcome.outcomes[0].error ?? "", /added by someone else during the import/);
    assert.equal((await listSuppliers(shop.shop.id)).total, 2);
  });

  test("a supplier removed or renumbered while an import waits is added again, not reported updated and lost", async () => {
    const shop = await createUser(`sv${suffix}`);
    const gone = await add(shop, "G1", "Removed meanwhile");
    const moved = await add(shop, "G2", "Renumbered meanwhile");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => (locked = resolve));
    const editor = withShop(shop.shop.id, async (tx) => {
      await tx.delete(suppliers).where(eq(suppliers.id, gone));
      await tx.update(suppliers).set({ supplierId: "G3" }).where(eq(suppliers.id, moved));
      locked();
      await held;
    });
    await ready;
    const importing = importSuppliers(shop, { importId: randomUUID(), fileName: "x", suppliers: [row(2, "G1", "Removed meanwhile"), row(3, "G2", "From the file")] });
    await blocked();
    release();
    await editor;
    assert.deepEqual(results(await importing), ["created", "created"]);
    assert.deepEqual((await listSuppliers(shop.shop.id)).items.map((supplier) => [supplier.supplierId, supplier.supplierName]), [
      ["G1", "Removed meanwhile"],
      ["G2", "From the file"],
      ["G3", "Renumbered meanwhile"],
    ]);
  });

  test("another shop can't see, change or remove the list; the same IDs are fine there", async () => {
    const mine = await add(parts, "X1", "Mine Only");
    assert.equal(await getSupplier(other.shop.id, mine), null);
    assert.equal((await listSuppliers(other.shop.id, { query: "mine" })).total, 0);
    assert.ok("error" in (await updateSupplier(other, mine, { supplierId: "X1", supplierName: "Hijacked" })));
    assert.ok("error" in (await removeSupplier(other, mine)));
    assert.equal((await getSupplier(parts.shop.id, mine))?.supplierName, "Mine Only");
    await add(other, "X1", "Theirs");
    const seen = await withShop(other.shop.id, (tx) => tx.select({ shopId: suppliers.shopId }).from(suppliers));
    assert.ok(seen.every((row) => row.shopId === other.shop.id));
    await assert.rejects(
      withShop(parts.shop.id, (tx) => tx.update(suppliers).set({ shopId: other.shop.id }).where(eq(suppliers.id, mine))),
      (error: unknown) => /permission denied/.test(String((error as { cause?: unknown }).cause)),
    );
  });
});
