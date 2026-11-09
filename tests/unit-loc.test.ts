// The Unit List and the LOC tab, connected (src/lib/unit-loc.ts and the
// rules in src/lib/unit-list-rules.ts): the stock # a VIN (or the end of
// one, as the shop's sheet kept it) gives; which LOC unit a Unit List unit
// is (its VIN, the end of it, or its stock #, of the same model year); a
// unit on the Unit List as the LOC's form takes it; the Unit List counting
// a unit the LOC marked sold, and the LOC's figures on it. On the server:
// each tab showing the other's, units put on the LOC as they're added from
// an invoice (or from a unit's page), once, and the Activity log; kept to
// the shop and to sales.log. Made-up units and VINs only.
// The database tests need DATABASE_URL pointing at a disposable Postgres
// database; run with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { and, eq } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, shops, users } from "../src/db/schema";
import { describeAuditEntry } from "../src/lib/audit-log-rules";
import { addLocUnit, getLocUnit, listLocUnits, markLocUnits } from "../src/lib/loc";
import { blankLocValues, checkLocUnit, parseLocFilters, stockFromVin } from "../src/lib/loc-rules";
import type { CurrentUser } from "../src/lib/session";
import { addStockUnits, getStockUnit, importStockUnits, listStockUnits, putStockUnitOnLoc, updateStockUnit } from "../src/lib/unit-list";
import { checkUnit, isLocUnitOf, locInputOf, locUnitOf, soldOf, stockOfVin, unitTotals, unitValues } from "../src/lib/unit-list-rules";
import { vinCheckDigit } from "../src/lib/vin";

// A whole VIN from its other 16 characters, "_" where the check digit goes.
const whole = (pattern: string) => pattern.replace("_", vinCheckDigit(pattern.replace("_", "0"))!);

// A Ranger whose plant is a digit (a seven-digit stock #), and one whose
// plant is a letter (six).
const RANGER = whole("4XARSY99_V8000101");
const RANGER_PS = whole("3NSTAU99_VH000077");
const TODAY = "2026-11-09";

describe("which LOC unit a Unit List unit is", () => {
  test("the stock # a VIN, or the end of one, gives", () => {
    assert.equal(stockOfVin(RANGER), "8000101");
    assert.equal(stockOfVin(RANGER), stockFromVin(RANGER));
    assert.equal(stockOfVin(RANGER_PS), "000077");
    assert.equal(stockOfVin(RANGER_PS), stockFromVin(RANGER_PS));
    // As the shop's sheet kept them.
    assert.equal(stockOfVin("8000101"), "8000101");
    assert.equal(stockOfVin("H000077"), "000077");
    assert.equal(stockOfVin("00101"), null);
  });

  test("by its VIN, the end of it, or its stock #, of the same model year", () => {
    const loc = (fields: { vin?: string | null; stockNumber?: string | null; unitYear?: number | null; soldOn?: string | null; onLoc?: boolean; receivedOn?: string | null }) => ({
      vin: null,
      stockNumber: null,
      unitYear: null,
      soldOn: null,
      onLoc: true,
      receivedOn: null,
      ...fields,
    });
    // The same VIN, whatever years were typed.
    assert.ok(isLocUnitOf({ vin: RANGER, unitYear: 2027 }, loc({ vin: RANGER, unitYear: 2026 })));
    // The LOC without a VIN, by the stock # (the sheet's end of a VIN too).
    assert.ok(isLocUnitOf({ vin: RANGER, unitYear: 2027 }, loc({ stockNumber: "8000101", unitYear: 2027 })));
    assert.ok(isLocUnitOf({ vin: "8000101", unitYear: 2027 }, loc({ stockNumber: "8000101" })));
    assert.ok(isLocUnitOf({ vin: "H000077", unitYear: null }, loc({ stockNumber: "000077" })));
    // The LOC's whole VIN ending with the sheet's end of it.
    assert.ok(isLocUnitOf({ vin: "8000101", unitYear: 2027 }, loc({ vin: RANGER })));
    // Another model year, or another whole VIN with the same stock #.
    assert.ok(!isLocUnitOf({ vin: RANGER, unitYear: 2027 }, loc({ stockNumber: "8000101", unitYear: 2026 })));
    assert.ok(!isLocUnitOf({ vin: RANGER, unitYear: 2027 }, loc({ vin: whole("4XARRA99_V8000101"), stockNumber: "8000101" })));
    assert.ok(!isLocUnitOf({ vin: RANGER, unitYear: 2027 }, loc({ stockNumber: "8000102" })));
    // One still on the LOC's list before one sold and paid off long ago.
    const gone = loc({ stockNumber: "8000101", soldOn: "2024-05-01", onLoc: false, receivedOn: "2024-01-02" });
    const here = loc({ stockNumber: "8000101", receivedOn: "2026-10-01" });
    assert.equal(locUnitOf({ vin: RANGER, unitYear: null }, [gone, here]), here);
    assert.equal(locUnitOf({ vin: RANGER, unitYear: null }, []), null);
  });

  test("a unit on the Unit List as the LOC's form takes it", () => {
    const checked = checkUnit({ vin: RANGER, unitYear: "2027", model: "Rngr 1000 XP NSU Crew - Army Green", receivedOn: "2026-11-07", cost: "34,893.00", listPrice: "37,399" });
    assert.ok("unit" in checked);
    const floored = checkLocUnit(locInputOf(checked.unit, { freeFloorEnds: "2027-03-06", section: "loc" }));
    assert.ok("unit" in floored, JSON.stringify(floored));
    assert.deepEqual(floored.unit, {
      stockNumber: "8000101",
      vin: RANGER,
      unitYear: 2027,
      model: "Rngr 1000 XP NSU Crew - Army Green",
      category: "UTV",
      condition: "new",
      cost: 3489300,
      freeFloorEnds: "2027-03-06",
      receivedOn: "2026-11-07",
      onLoc: true,
      paidOffOn: null,
      soldOn: null,
      notes: null,
    });
    // The end of a VIN stays the stock #; the LOC needs a cost.
    const partial = checkUnit({ vin: "8000101", model: "Rngr", receivedOn: TODAY });
    assert.ok("unit" in partial);
    assert.deepEqual(checkLocUnit(locInputOf(partial.unit, { freeFloorEnds: null, section: "owned" })), { error: "Enter what it cost.", field: "cost" });
    const costed = checkLocUnit(locInputOf({ ...partial.unit, cost: 100 }, { freeFloorEnds: null, section: "owned" }));
    assert.ok("unit" in costed);
    assert.deepEqual([costed.unit.stockNumber, costed.unit.vin, costed.unit.onLoc], ["8000101", null, false]);
  });

  test("the LOC's word on the Unit List: sold there, and where the units stand on it", () => {
    assert.deepEqual(soldOf({ soldOn: null, nusrSale: null, loc: { soldOn: "2026-11-20" } }), { on: "2026-11-20", how: "loc" });
    const unit = (loc: { onLoc: boolean; freeFloorEnds: string | null; soldOn: string | null } | null) => ({ unitYear: 2027, model: "A", receivedOn: "2026-09-01", vin: "8000101", cost: 1, listPrice: 1, soldOn: null, nusrSale: null, loc });
    assert.deepEqual(
      unitTotals(
        [
          unit({ onLoc: true, freeFloorEnds: "2026-11-01", soldOn: null }),
          unit({ onLoc: true, freeFloorEnds: "2026-11-20", soldOn: null }),
          unit({ onLoc: true, freeFloorEnds: "2027-03-06", soldOn: null }),
          unit({ onLoc: false, freeFloorEnds: null, soldOn: null }),
          unit(null),
        ],
        TODAY,
      ).loc,
      { onLoc: 3, owned: 1, none: 1, ended: 1, soon: 1 },
    );
  });
});

// --- On the server ----------------------------------------------------------------

describe("on the server: the Unit List and the LOC, connected", () => {
  const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
  const shopIds: string[] = [];
  let manager: CurrentUser;
  let other: CurrentUser;
  let writer: CurrentUser;
  const ids: Record<string, string> = {};

  async function person(code: string, role: "manager" | "service_writer", shop?: CurrentUser["shop"]): Promise<CurrentUser> {
    const created = shop ?? (await systemDb.insert(shops).values({ code, name: `Shop ${code}` }).returning({ id: shops.id, code: shops.code, name: shops.name }))[0];
    if (!shop) shopIds.push(created.id);
    const id = randomUUID();
    await systemDb.insert(users).values({ id, shopId: created.id, role, name: "Morgan", username: `${created.code}.${role}`, displayUsername: role, email: `${randomUUID()}@no-email.invalid` });
    return { id, name: "Morgan", username: role, role, shop: created, bay: null };
  }

  async function onLoc(actor: CurrentUser, fields: Record<string, string>) {
    const result = await addLocUnit(actor, { ...blankLocValues("2026-09-01"), ...fields });
    assert.ok("id" in result, JSON.stringify(result));
    return result.id;
  }

  const invoiceUnit = (vin: string, fields: Record<string, string> = {}) => ({
    key: vin,
    vin,
    unitYear: "2027",
    model: "Rngr 1000 XP NSU Crew - Army Green",
    modelNumber: "R27RSY99AA",
    receivedOn: TODAY,
    cost: "34,893.00",
    listPrice: "37,399",
    invoiceNumber: "380201",
    invoiceDate: "2026-11-06",
    loc: "loc",
    freeFloorEnds: "2027-03-06",
    ...fields,
  });

  before(async () => {
    manager = await person(`uk${suffix}`, "manager");
    other = await person(`um${suffix}`, "manager");
    writer = await person("", "service_writer", manager.shop);
    // The LOC as its sheet was imported: stock #s, no VINs.
    ids.locBlueLab = await onLoc(manager, { stockNumber: "8000201", unitYear: "2027", model: "Rngr 1000 XP NSU Crew - Blue Lab", cost: "34893", freeFloorEnds: "2026-11-20" });
    ids.locOwned = await onLoc(manager, { stockNumber: "8000202", unitYear: "2027", model: "Rngr 1000 XP NSU Crew - PPC", cost: "35247", section: "owned", paidOffOn: "2026-10-30" });
    // Another shop's LOC with the same stock #.
    await onLoc(other, { stockNumber: "8000201", unitYear: "2027", model: "Not ours", cost: "1" });
  });

  after(async () => {
    for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
    await systemDb.$client.end();
  });

  test("units imported from the sheet find theirs on the LOC by stock #, and the LOC finds them", async () => {
    const result = await importStockUnits(manager, {
      importId: randomUUID(),
      fileName: "Unit List.xlsx",
      units: [
        { row: 2, vin: "8000201", unitYear: "2027", model: "Rngr 1000 XP NSU Crew - Blue Lab", receivedOn: "2026-09-01", cost: "34893", listPrice: "37399" },
        { row: 3, vin: "8000202", unitYear: "2027", model: "Rngr 1000 XP NSU Crew - PPC", receivedOn: "2026-10-20", cost: "35247", listPrice: "37799" },
        { row: 4, vin: "8000203", unitYear: "2027", model: "Rngr 1000 XP NSU Crew - PPC", receivedOn: "2026-10-29", cost: "35247" },
      ],
    });
    assert.ok("outcomes" in result);
    [ids.blueLab, ids.owned, ids.notOnLoc] = result.outcomes.map((outcome) => outcome.id!);
    const list = await listStockUnits(manager, { status: "stock", query: "" }, TODAY);
    assert.ok(!("error" in list));
    const units = list.groups.flatMap((group) => group.units);
    const byVin = (vin: string) => units.find((unit) => unit.vin === vin)!;
    assert.deepEqual(
      [byVin("8000201").loc?.id, byVin("8000201").loc?.onLoc, byVin("8000201").loc?.freeFloorEnds, byVin("8000202").loc?.id, byVin("8000202").loc?.onLoc, byVin("8000203").loc],
      [ids.locBlueLab, true, "2026-11-20", ids.locOwned, false, null],
    );
    assert.deepEqual(list.totals.loc, { onLoc: 1, owned: 1, none: 1, ended: 0, soon: 1 });

    // The LOC shows each one's list price, the other shop's LOC nothing.
    const loc = await listLocUnits(manager.shop.id, parseLocFilters({}), TODAY);
    const blueLab = loc.units.find((unit) => unit.id === ids.locBlueLab)!;
    assert.deepEqual(blueLab.unitList, { id: ids.blueLab, name: "2027 Rngr 1000 XP NSU Crew - Blue Lab", listPrice: 3739900, soldOn: null });
    const theirs = await listLocUnits(other.shop.id, parseLocFilters({}), TODAY);
    assert.equal(theirs.units[0].unitList, null);
  });

  test("a unit sold on one is sold on the other: the LOC's Sold counts on the Unit List, the Unit List's is offered on the LOC", async () => {
    // Marked sold on the LOC: sold on the Unit List.
    const marked = await markLocUnits(manager, { ids: [ids.locBlueLab], mark: "sold", on: "2026-11-05" });
    assert.deepEqual(marked, { marked: 1, skipped: 0, stillOwed: 1 });
    const unit = await getStockUnit(manager, ids.blueLab);
    assert.ok(unit);
    assert.deepEqual(soldOf(unit), { on: "2026-11-05", how: "loc" });
    const stock = await listStockUnits(manager, { status: "stock", query: "" }, TODAY);
    assert.ok(!("error" in stock));
    assert.deepEqual(stock.counts, { stock: 2, sold: 1 });
    // Marked sold on the Unit List: the LOC sees it (and offers to mark it).
    const owned = await getStockUnit(manager, ids.owned);
    assert.ok(owned);
    assert.deepEqual(await updateStockUnit(manager, ids.owned, { ...unitValues(owned), soldOn: "2026-11-08" }), { ok: true, changed: true });
    const loc = await getLocUnit(manager.shop.id, ids.locOwned);
    assert.deepEqual(loc?.unitList, { id: ids.owned, name: "2027 Rngr 1000 XP NSU Crew - PPC", listPrice: 3779900, soldOn: "2026-11-08" });
    assert.equal(loc?.soldOn, null);
  });

  test("units added from an invoice go on the LOC too, once, with the Activity log", async () => {
    const result = await addStockUnits(manager, {
      fileName: "polaris.pdf",
      units: [
        invoiceUnit(RANGER),
        // On the LOC already, by the stock # its VIN gives.
        invoiceUnit(whole("4XARSY99_V8000203"), { key: "onLoc", model: "Rngr", loc: "loc" }),
        // No cost: added to the list, not to the LOC.
        invoiceUnit(whole("4XARSY99_V8000301"), { key: "noCost", cost: "" }),
        // Not asked for.
        invoiceUnit(whole("4XARSY99_V8000302"), { key: "notAsked", loc: "" }),
      ],
    });
    assert.ok("added" in result, JSON.stringify(result));
    // 8000203 was on the list from the sheet: the invoice fills it in.
    assert.deepEqual(result.completed.map((one) => one.key), ["onLoc"]);
    assert.deepEqual(result.added.map((one) => one.key), [RANGER, "noCost", "notAsked"]);
    const outcome = (key: string) => result.loc.find((one) => one.key === key);
    assert.equal(outcome("notAsked"), undefined);
    assert.match(outcome("noCost")?.error ?? "", /no cost/);
    // The sheet's 8000203 wasn't on the LOC: it goes on now, as stock # 8000203.
    assert.deepEqual([outcome("onLoc")?.already, outcome("onLoc")?.stockNumber, outcome("onLoc")?.error], [false, "8000203", null]);
    const ranger = outcome(RANGER);
    assert.deepEqual([ranger?.already, ranger?.stockNumber, ranger?.error], [false, "8000101", null]);
    const loc = await getLocUnit(manager.shop.id, ranger!.id!);
    assert.deepEqual(
      loc && [loc.stockNumber, loc.vin, loc.unitYear, loc.model, loc.category, loc.condition, loc.cost, loc.freeFloorEnds, loc.receivedOn, loc.onLoc],
      ["8000101", RANGER, 2027, "Rngr 1000 XP NSU Crew - Army Green", "UTV", "new", 3489300, "2027-03-06", TODAY, true],
    );
    const [entry] = await withShop(manager.shop.id, (tx) =>
      tx
        .select({ action: auditLog.action, targetType: auditLog.targetType, targetId: auditLog.targetId, details: auditLog.details })
        .from(auditLog)
        .where(and(eq(auditLog.targetType, "loc_unit"), eq(auditLog.targetId, ranger!.id!))),
    );
    assert.equal(describeAuditEntry(entry).summary, "Put 2027 Rngr 1000 XP NSU Crew - Army Green (stock # 8000101) on the LOC from the Unit List");

    // Dropped again: on the Unit List and the LOC already, nothing twice.
    const again = await addStockUnits(manager, { units: [invoiceUnit(RANGER)] });
    assert.ok("added" in again);
    assert.deepEqual([again.added.length, again.already.length, again.loc.length], [0, 1, 0]);
  });

  test("a unit put on the LOC from its page, once", async () => {
    const notAsked = (await listStockUnits(manager, { status: "all", query: "8000302" })) as { groups: { units: { id: string }[] }[] };
    const id = notAsked.groups[0].units[0].id;
    const put = await putStockUnitOnLoc(manager, id, { loc: "owned", freeFloorEnds: "" });
    assert.ok("key" in put && put.id, JSON.stringify(put));
    assert.deepEqual([put.already, put.stockNumber, put.error], [false, "8000302", null]);
    const loc = await getLocUnit(manager.shop.id, put.id!);
    assert.deepEqual([loc?.onLoc, loc?.cost], [false, 3489300]);
    const again = await putStockUnitOnLoc(manager, id, { loc: "loc", freeFloorEnds: "" });
    assert.ok("key" in again);
    assert.deepEqual([again.already, again.id], [true, put.id]);
    // A free floor that isn't a date says so.
    const noCost = (await listStockUnits(manager, { status: "all", query: "8000301" })) as { groups: { units: { id: string }[] }[] };
    const wrong = await putStockUnitOnLoc(manager, noCost.groups[0].units[0].id, { loc: "loc", freeFloorEnds: "soon" });
    assert.ok("key" in wrong);
    assert.ok(wrong.error);
  });

  test("kept to managers and admins signed in with a password", async () => {
    const notAllowed = { error: "Only a manager or admin signed in with a password can use the Unit List." };
    assert.deepEqual(await putStockUnitOnLoc(writer, ids.notOnLoc, { loc: "loc" }), notAllowed);
    assert.deepEqual(await putStockUnitOnLoc({ ...manager, bay: { deviceId: "d", deviceName: "Bay 1", sessionId: "s" } }, ids.notOnLoc, { loc: "loc" }), notAllowed);
    // Another shop's unit isn't found.
    assert.deepEqual(await putStockUnitOnLoc(other, ids.notOnLoc, { loc: "loc" }), { error: "That unit isn't on the list. It may have been removed." });
  });
});
