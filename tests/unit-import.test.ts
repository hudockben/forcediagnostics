// Unit List: importing the shop's spreadsheet (src/lib/unit-import-rules.ts)
// and the VINs it keeps only the end of. Reading the sheet: the headings
// (and the count column with none), each row as a unit (the year off the
// front of the model, the VIN's last 7, dates and amounts as cells and
// typed), and what's left out and why: the blank rows, a model's heading,
// the totals, a 0 in the count column, a VIN twice. Matching a VIN's end
// (src/lib/unit-list-rules.ts): to a whole VIN, to the NUSR's sales (of the
// unit's model year, not long before it came in), and to the unit an
// invoice fills in. On the server (src/lib/unit-list.ts): the import's
// batches (added, on the list already, left out), the Activity log, a NUSR
// sale of the whole VIN marking an imported unit sold, an invoice filling
// one in, kept to the shop and to sales.log. Made-up units and VINs only.
// The database tests need DATABASE_URL pointing at a disposable Postgres
// database; run with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { and, asc, eq } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, shops, users } from "../src/db/schema";
import { describeAuditEntry } from "../src/lib/audit-log-rules";
import { logSale } from "../src/lib/nusr";
import { blankSaleValues, type SaleValues } from "../src/lib/nusr-rules";
import type { CurrentUser } from "../src/lib/session";
import { MAX_UNIT_IMPORT_BATCH, findUnitHeader, planUnitImport, unitImportColumns, unitsInWords } from "../src/lib/unit-import-rules";
import { addStockUnits, getStockUnit, importStockUnits, listStockUnits, lookUpUnits } from "../src/lib/unit-list";
import { listedAs, nusrSaleOf, sameUnit, sameVin, vinTails } from "../src/lib/unit-list-rules";
import { vinCheckDigit } from "../src/lib/vin";

// A whole VIN from its other 16 characters, "_" where the check digit goes.
const whole = (pattern: string) => pattern.replace("_", vinCheckDigit(pattern.replace("_", "0"))!);

const TODAY = "2026-11-09";

// The shop's sheet, as Google Sheets exports it: dates as date cells,
// numbers plainly, a hidden column (I) and the count (J) with no headings,
// blank rows between the models and the total under them.
const HEADINGS = ["Model", "VIN", "Received", "Cost", "List", "Online $", "Tax", "Total", "", ""];
const unitRow = (model: string, vin: string, received: string, cost: string, list: string, count = "1") => [model, vin, received, cost, list, "1", "2", "3", "", count];
const SHEET = [
  HEADINGS,
  unitRow("2027 Rngr 1000 XP NSU Crew - Blue Lab", "8000101", "2026-09-01", "34893", "37399"),
  unitRow("2027 Rngr 1000 XP NSU Crew - Blue Lab", "8000102", "2026-10-20", "34893", "37399"),
  [],
  unitRow("2026 General XP 1000 Premium", "F000201", "2026-08-12", "29639", "31999"),
  [],
  ["", "", "", "", "", "", "", "", "", "3"],
];

describe("reading the shop's sheet", () => {
  test("the headings, and the count column that has none", () => {
    assert.equal(findUnitHeader(SHEET), 0);
    assert.deepEqual(unitImportColumns(SHEET, 0), ["model", "vin", "receivedOn", "cost", "listPrice", null, null, null, null, "count"]);
    // A title line over the headings, and other words for them.
    const other = [["Units in stock, November"], ["Unit", "Serial #", "Rec'd", "Dealer Cost", "List Price", "Year", "Notes", "Model #"], ["Rngr", "8000101", "9/1/26", "1", "2", "2027", "", "R27RSY99AA"]];
    assert.equal(findUnitHeader(other), 1);
    assert.deepEqual(unitImportColumns(other, 1), ["model", "vin", "receivedOn", "cost", "listPrice", "unitYear", "notes", "modelNumber"]);
    assert.equal(findUnitHeader([["Nothing"], ["here"]]), -1);
    // A blank-headed column that isn't 1s isn't the count.
    assert.deepEqual(unitImportColumns([["Model", "VIN", ""], ["A", "8000101", "x"], ["B", "8000102", "y"]], 0), ["model", "vin", null]);
  });

  test("each unit: the year off the front of the model, the VIN's end, the dates and amounts", () => {
    const plan = planUnitImport(SHEET, 0, unitImportColumns(SHEET, 0), { today: TODAY });
    assert.deepEqual(
      plan.units.map(({ row, unit }) => [row, unit.unitYear, unit.model, unit.vin, unit.receivedOn, unit.cost, unit.listPrice, unit.soldOn]),
      [
        [2, 2027, "Rngr 1000 XP NSU Crew - Blue Lab", "8000101", "2026-09-01", 3489300, 3739900, null],
        [3, 2027, "Rngr 1000 XP NSU Crew - Blue Lab", "8000102", "2026-10-20", 3489300, 3739900, null],
        [5, 2026, "General XP 1000 Premium", "F000201", "2026-08-12", 2963900, 3199900, null],
      ],
    );
    // The total under them isn't a unit, and says nothing.
    assert.deepEqual(plan.notes, []);
    assert.equal(plan.rowsRead, 4);
    assert.equal(unitsInWords(plan.units), "3 units (all have only the end of the VIN)");
    assert.equal(unitsInWords(plan.units.slice(0, 1)), "1 unit (it has only the end of the VIN)");
  });

  test("what's left out, or put right, and why", () => {
    const today = TODAY;
    const rows = [
      ["Model", "VIN", "Received", "Cost", "List", "Year", "Sold", "#"],
      // A model's heading: no VIN, nothing to say.
      ["RANGERS", "", "", "", "", "", "", ""],
      // Typed dates, money as typed, a 2-digit year in its own column.
      ["Rngr 1000 XP", " 8000301 ", "9/1/26", "$34,893.00", "37,399", "27", "", "1"],
      // Looks like a unit, but no VIN.
      ["Rngr 1000 XP", "", "9/2/26", "34893", "", "", "", "1"],
      ["Rngr 1000 XP", "80003", "9/3/26", "34893", "", "2027", "", "1"],
      ["Rngr 1000 XP", "8000-302!", "9/3/26", "34893", "", "2027", "", "1"],
      // 0 in the count: the sheet doesn't count it.
      ["Rngr 1000 XP", "8000303", "9/4/26", "34893", "", "2027", "", "0"],
      ["Rngr 1000 XP", "8000304", "9/5/26", "34893", "", "2027", "", "2"],
      // The same VIN again.
      ["Rngr 1000 XP", "8000301", "9/6/26", "34893", "", "2027", "", "1"],
      // No date, a date that isn't one, one after today.
      ["Rngr 1000 XP", "8000305", "", "34893", "", "2027", "", "1"],
      ["Rngr 1000 XP", "8000306", "soon", "34893", "", "2027", "", "1"],
      ["Rngr 1000 XP", "8000307", "12/25/26", "34893", "", "2027", "", "1"],
      // An amount that isn't one: left out, keeping the unit.
      ["Rngr 1000 XP", "8000308", "9/7/26", "call", "-5", "2027", "", "1"],
      // No model.
      ["", "8000309", "9/7/26", "34893", "", "2027", "", "1"],
      // A whole VIN gives the year; sold on the sheet.
      ["General XP 1000", whole("3NSGMK99_TF000456"), "8/1/26", "29639", "31999", "", "10/30/26", "1"],
      // The headings again (a sheet printed in pages).
      ["Model", "VIN", "Received", "Cost", "List", "Year", "Sold", "#"],
    ];
    const mapping = unitImportColumns(rows, 0);
    assert.deepEqual(mapping, ["model", "vin", "receivedOn", "cost", "listPrice", "unitYear", "soldOn", "count"]);
    const plan = planUnitImport(rows, 0, mapping, { today });
    assert.deepEqual(
      plan.units.map(({ row, unit }) => [row, unit.vin, unit.unitYear, unit.receivedOn, unit.cost, unit.listPrice, unit.soldOn]),
      [
        [3, "8000301", 2027, "2026-09-01", 3489300, 3739900, null],
        [8, "8000304", 2027, "2026-09-05", 3489300, null, null],
        [10, "8000305", 2027, today, 3489300, null, null],
        [11, "8000306", 2027, today, 3489300, null, null],
        [12, "8000307", 2027, "2026-12-25", 3489300, null, null],
        [13, "8000308", 2027, "2026-09-07", null, null, null],
        [15, whole("3NSGMK99_TF000456"), 2026, "2026-08-01", 2963900, 3199900, "2026-10-30"],
      ],
    );
    assert.deepEqual(
      plan.notes.map((note) => note.row),
      [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 13, 14],
    );
    const said = (row: number) => plan.notes.filter((note) => note.row === row).map((note) => note.message);
    assert.deepEqual(said(4), ["No VIN for “Rngr 1000 XP”: left out."]);
    assert.match(said(5)[0], /too short to know the unit by/);
    assert.match(said(6)[0], /isn't letters and figures/);
    assert.match(said(7)[0], /0 in the unit count/);
    assert.match(said(8)[0], /2 in the unit count, but one VIN: imported once/);
    assert.deepEqual(said(9), ["VIN 8000301 is on row 3 too: imported once."]);
    assert.match(said(10)[0], /No Received date .*: imported as received today/);
    assert.match(said(11)[0], /Received “soon” isn't a date/);
    assert.match(said(12)[0], /12\/25\/2026, after today: check it/);
    assert.deepEqual(said(13), ["Cost “call” for “Rngr 1000 XP” (8000308) isn't an amount: left out.", "List Price “-5” for “Rngr 1000 XP” (8000308) isn't an amount: left out."]);
    assert.deepEqual(said(14), ["No model for VIN 8000309: left out."]);
  });
});

describe("a VIN's end", () => {
  const RANGER = whole("4XARSY99_V8000101");

  test("matches the whole VIN, from 6 characters", () => {
    assert.ok(sameVin("8000101", RANGER));
    assert.ok(sameVin(RANGER, "000101"));
    assert.ok(sameVin(RANGER, RANGER));
    assert.ok(!sameVin("00101", RANGER));
    assert.ok(!sameVin("8000102", RANGER));
    assert.ok(!sameVin(whole("3NSGMK99_TF000456"), RANGER));
    assert.equal(vinTails(RANGER).length, 11);
    assert.equal(vinTails(RANGER).at(-1), "000101");
    assert.deepEqual(vinTails("8000101"), []);
    // Of the same model year, when the whole VIN says it.
    assert.ok(sameUnit({ vin: "8000101", unitYear: 2027 }, { vin: RANGER, unitYear: null }));
    assert.ok(!sameUnit({ vin: "8000101", unitYear: 2026 }, { vin: RANGER, unitYear: null }));
    // The same VIN is one unit, whatever years are typed (the list has a VIN once).
    assert.ok(sameUnit({ vin: "8000101", unitYear: 2026 }, { vin: "8000101", unitYear: 2027 }));
    assert.ok(!sameUnit({ vin: "8000101", unitYear: 2027 }, { vin: "8000102", unitYear: 2027 }));
    const listed = [
      { id: "a", vin: "8000101", unitYear: 2027 },
      { id: "b", vin: RANGER, unitYear: 2027 },
    ];
    assert.equal(listedAs({ vin: RANGER, unitYear: 2027 }, listed)?.id, "b");
    assert.equal(listedAs({ vin: whole("4XARSY99_V9000101"), unitYear: 2027 }, listed), null);
  });

  test("finds the NUSR's sale of the unit: its model year, not long before it came in", () => {
    const sale = (vin: string, soldOn: string, id = soldOn) => ({ id, vin, soldOn, customerName: "Someone", salesperson: null });
    const unit = { vin: "8000101", unitYear: 2027, receivedOn: "2026-09-01" };
    assert.equal(nusrSaleOf(unit, [sale(RANGER, "2026-11-02")])?.soldOn, "2026-11-02");
    // Presold months before it came in.
    assert.equal(nusrSaleOf(unit, [sale(RANGER, "2026-06-15")])?.soldOn, "2026-06-15");
    // Another model year's VIN ending the same, or a sale years before.
    assert.equal(nusrSaleOf(unit, [sale(whole("4XARSY99_T8000101"), "2026-11-02")]), null);
    assert.equal(nusrSaleOf(unit, [sale(RANGER, "2024-05-01")]), null);
    // The latest of two; its own VIN first.
    assert.equal(nusrSaleOf(unit, [sale(RANGER, "2026-11-02", "x"), sale(RANGER, "2026-12-01", "y")])?.id, "y");
    assert.equal(nusrSaleOf({ ...unit, vin: RANGER }, [sale(RANGER, "2026-11-02", "own"), sale("8000101", "2026-12-01", "end")])?.id, "own");
    // The NUSR with only the end, the list with the whole VIN.
    assert.equal(nusrSaleOf({ ...unit, vin: RANGER }, [sale("8000101", "2026-12-01")])?.soldOn, "2026-12-01");
  });
});

// --- On the server ----------------------------------------------------------------

describe("on the server: importing the sheet, and its VINs' ends", () => {
  const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
  const shopIds: string[] = [];
  let manager: CurrentUser;
  let other: CurrentUser;
  let writer: CurrentUser;
  const ids: Record<string, string> = {};
  const RANGER = whole("4XARSY99_V8000101");
  const SOLD = whole("4XARRA99_V8000102");

  async function person(code: string, role: "manager" | "service_writer", shop?: CurrentUser["shop"]): Promise<CurrentUser> {
    const created = shop ?? (await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name }))[0];
    if (!shop) shopIds.push(created.id);
    const id = randomUUID();
    await systemDb.insert(users).values({ id, shopId: created.id, role, name: "Morgan", username: `${created.code}.${role}`, displayUsername: role, email: `${randomUUID()}@no-email.invalid` });
    return { id, name: "Morgan", username: role, role, shop: created, bay: null };
  }

  async function sell(actor: CurrentUser, values: Partial<SaleValues>) {
    const result = await logSale(actor, { ...blankSaleValues({ soldOn: "2026-11-02", holdbackRateBp: 400, bonusRateBp: 1000 }), ...values });
    assert.ok("id" in result, JSON.stringify(result));
    return result.id;
  }

  const sheetUnits = () => {
    const plan = planUnitImport(SHEET, 0, unitImportColumns(SHEET, 0), { today: TODAY });
    return plan.units.map((entry) => ({ row: entry.row, ...entry.fields }));
  };

  before(async () => {
    manager = await person(`ui${suffix}`, "manager");
    other = await person(`uj${suffix}`, "manager");
    writer = await person("", "service_writer", manager.shop);
    // The NUSR has the second Ranger sold, by its whole VIN.
    ids.sale = await sell(manager, { customerName: "Sam Teague", salesperson: "Lee", unitYear: "2027", unitModel: "Ranger XP", vin: SOLD, msrp: "37399", category: "UTV" });
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  test("importing: each unit added once, the batch in the Activity log", async () => {
    const importId = randomUUID();
    const result = await importStockUnits(manager, { importId, fileName: "Unit List.xlsx", units: sheetUnits() });
    assert.ok("outcomes" in result, JSON.stringify(result));
    assert.deepEqual(
      result.outcomes.map((outcome) => [outcome.row, outcome.result, outcome.message]),
      [
        [2, "added", null],
        [3, "added", null],
        [5, "added", null],
      ],
    );
    ids.first = result.outcomes[0].id!;
    const unit = await getStockUnit(manager, ids.first);
    assert.deepEqual(unit && [unit.vin, unit.unitYear, unit.model, unit.receivedOn, unit.cost, unit.listPrice, unit.fileName, unit.invoiceNumber], ["8000101", 2027, "Rngr 1000 XP NSU Crew - Blue Lab", "2026-09-01", 3489300, 3739900, "Unit List.xlsx", null]);
    const [entry] = await withShop(manager.shop.id, (tx) =>
      tx
        .select({ action: auditLog.action, targetType: auditLog.targetType, targetId: auditLog.targetId, details: auditLog.details })
        .from(auditLog)
        .where(and(eq(auditLog.action, "stock_units.imported"), eq(auditLog.targetId, importId))),
    );
    const said = describeAuditEntry(entry);
    assert.equal(said.summary, "Imported units onto the Unit List from Unit List.xlsx");
    assert.deepEqual(
      said.facts.map((fact) => [fact.label, fact.value]),
      [
        ["Added", "3"],
        ["Already on the list", "0"],
      ],
    );

    // Imported again: nothing twice. A unit wrong on the server's check is
    // left out, with why.
    const again = await importStockUnits(manager, { importId: randomUUID(), fileName: "Unit List.xlsx", units: [...sheetUnits(), { row: 9, vin: "8000199", model: "", receivedOn: TODAY }] });
    assert.ok("outcomes" in again);
    assert.deepEqual(
      again.outcomes.map((outcome) => [outcome.row, outcome.result]),
      [
        [2, "already"],
        [3, "already"],
        [5, "already"],
        [9, "failed"],
      ],
    );
    assert.equal(again.outcomes[3].message, "Give the unit its model, as the list should show it.");
    // Two rows in one batch with the same unit's VIN: once.
    const twice = await importStockUnits(manager, { importId: randomUUID(), fileName: "x.csv", units: [{ row: 2, vin: "8000150", model: "A", receivedOn: TODAY }, { row: 3, vin: "8000150", model: "A", receivedOn: TODAY }] });
    assert.ok("outcomes" in twice);
    assert.deepEqual(twice.outcomes.map((outcome) => outcome.result), ["added", "already"]);
  });

  test("an imported unit the NUSR sold, by its whole VIN, is sold", async () => {
    const list = await listStockUnits(manager, { status: "sold", query: "" }, "2026-12-01");
    assert.ok(!("error" in list));
    const sold = list.groups.flatMap((group) => group.units);
    assert.deepEqual(
      sold.map((unit) => [unit.vin, unit.nusrSale?.id, unit.nusrSale?.customerName]),
      [["8000102", ids.sale, "Sam Teague"]],
    );
    const stock = await listStockUnits(manager, { status: "stock", query: "" }, "2026-12-01");
    assert.ok(!("error" in stock));
    assert.deepEqual(stock.counts, { stock: 3, sold: 1 });
  });

  test("its whole goods invoice fills in an imported unit, and a VIN typed finds it", async () => {
    const lookup = await lookUpUnits(manager, [{ key: "a", vin: RANGER, modelNumber: "R27RSY99AA", description: "RGR-27,1K,XP,NSULT,CR,BLUELAB" }]);
    assert.ok(!("error" in lookup));
    assert.deepEqual(lookup.units[0].onList, { id: ids.first, name: "2027 Rngr 1000 XP NSU Crew - Blue Lab", vin: "8000101", receivedOn: "2026-09-01", soldOn: null, partial: true });
    const filled = await addStockUnits(manager, {
      fileName: "polaris.pdf",
      units: [{ key: "a", vin: RANGER, unitYear: "2027", model: "RGR 1K XP NSULT CR BLUELAB", modelNumber: "R27RSY99AA", description: "RGR-27,1K,XP,NSULT,CR,BLUELAB", engineNumber: "1209000000101", receivedOn: TODAY, cost: "34,900.00", listPrice: "", invoiceNumber: "380101", invoiceDate: "2026-08-28" }],
    });
    assert.ok("completed" in filled, JSON.stringify(filled));
    assert.deepEqual(filled, { added: [], already: [], completed: [{ key: "a", id: ids.first, name: "2027 Rngr 1000 XP NSU Crew - Blue Lab" }], loc: [] });
    const unit = await getStockUnit(manager, ids.first);
    // The whole VIN and what the list hadn't; the shop's model, day and prices kept.
    assert.deepEqual(
      unit && [unit.vin, unit.model, unit.modelNumber, unit.description, unit.engineNumber, unit.receivedOn, unit.cost, unit.listPrice],
      [RANGER, "Rngr 1000 XP NSU Crew - Blue Lab", "R27RSY99AA", "RGR-27,1K,XP,NSULT,CR,BLUELAB", "1209000000101", "2026-09-01", 3489300, 3739900],
    );
    const entries = await withShop(manager.shop.id, (tx) =>
      tx
        .select({ action: auditLog.action, targetType: auditLog.targetType, targetId: auditLog.targetId, details: auditLog.details })
        .from(auditLog)
        .where(and(eq(auditLog.targetType, "stock_unit"), eq(auditLog.targetId, ids.first)))
        .orderBy(asc(auditLog.seq)),
    );
    const said = describeAuditEntry(entries.at(-1)!);
    assert.equal(said.summary, "Filled in 2027 Rngr 1000 XP NSU Crew - Blue Lab on the Unit List from invoice 380101");
    assert.ok(said.facts.some((fact) => fact.label === "VIN" && fact.value === `8000101 → ${RANGER}`));
    // Dropped again: on the list as it is now.
    const again = await addStockUnits(manager, { units: [{ key: "a", vin: RANGER, unitYear: "2027", model: "X", receivedOn: TODAY }] });
    assert.deepEqual(again, { added: [], already: [{ key: "a", id: ids.first, name: "2027 Rngr 1000 XP NSU Crew - Blue Lab" }], completed: [], loc: [] });
    // The sheet's end of it, imported again, is the same unit.
    const reimport = await importStockUnits(manager, { importId: randomUUID(), fileName: "Unit List.xlsx", units: sheetUnits().slice(0, 1) });
    assert.ok("outcomes" in reimport);
    assert.deepEqual(reimport.outcomes.map((outcome) => [outcome.result, outcome.id]), [["already", ids.first]]);
    assert.match(reimport.outcomes[0].message ?? "", /On the list already as 2027 Rngr 1000 XP NSU Crew - Blue Lab, VIN 4XARSY99/);
  });

  test("kept to the shop and to managers and admins signed in with a password", async () => {
    const theirs = await importStockUnits(other, { importId: randomUUID(), fileName: "Unit List.xlsx", units: sheetUnits() });
    assert.ok("outcomes" in theirs);
    // Another shop's list is its own: the same sheet adds every unit there.
    assert.deepEqual(theirs.outcomes.map((outcome) => outcome.result), ["added", "added", "added"]);
    const notAllowed = { error: "Only a manager or admin signed in with a password can use the Unit List." };
    assert.deepEqual(await importStockUnits(writer, { importId: randomUUID(), fileName: "x", units: sheetUnits() }), notAllowed);
    assert.deepEqual(await importStockUnits({ ...manager, bay: { deviceId: "d", deviceName: "Bay 1", sessionId: "s" } }, { importId: randomUUID(), fileName: "x", units: sheetUnits() }), notAllowed);
    assert.deepEqual(await importStockUnits(manager, { importId: "nope", fileName: "x", units: sheetUnits() }), { error: "That import couldn't be read. Choose the file again." });
    assert.deepEqual(await importStockUnits(manager, { importId: randomUUID(), fileName: "x", units: [] }), { error: "There were no units in that batch." });
    const many = Array.from({ length: MAX_UNIT_IMPORT_BATCH + 1 }, (_, i) => ({ row: i + 2, vin: `9${String(i).padStart(6, "0")}`, model: "A", receivedOn: TODAY }));
    assert.deepEqual(await importStockUnits(manager, { importId: randomUUID(), fileName: "x", units: many }), { error: "That batch is too big. Reload the page and try again." });
  });
});
