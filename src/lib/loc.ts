import "server-only";

import { DrizzleQueryError, and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { auditLog, locUnits, unitSales, users } from "@/db/schema";
import { containsPattern, listSearchWords } from "@/lib/diagnose-list-rules";
import { isUuid } from "@/lib/diagnose-rules";
import { MAX_LOC_IMPORT_BATCH, importedUnitInput, type LocImportOutcome } from "@/lib/loc-import-rules";
import {
  LOC_SECTION_LABELS,
  MAX_LOC_MARKED,
  SOON_DAYS,
  checkLocUnit,
  locTotals,
  locUnitLabel,
  nusrNews,
  nusrSaleFor,
  sectionOf,
  stockFromVin,
  stockKey,
  tradeInUnit,
  type LocFilters,
  type LocMark,
  type LocProblem,
  type LocTotals,
  type LocUnitFields,
  type LocValueKey,
  type NusrNews,
  type NusrSaleSeen,
  type TradeIn,
} from "@/lib/loc-rules";
import { cutText } from "@/lib/manual-rules";
import { formatMoney, parseIsoDate, shopToday, unitLabel } from "@/lib/nusr-rules";
import type { CurrentUser } from "@/lib/session";

// The LOC tab: the units on the shop's line of credit and the ones it
// owns. Callers check sales.log first (it has the shop's costs);
// everything here runs inside withShop for the user's own shop, and every
// change is written to audit_log, which the Activity log shows.

export type LocUnit = LocUnitFields & {
  id: string;
  // The NUSR sale it was traded in on, if it was: when, to whom, and the
  // unit they bought.
  tradeSaleId: string | null;
  trade: { soldOn: string; customerName: string; unit: string } | null;
  // The NUSR's sale of the unit, if it has one (see nusrSaleFor), and
  // what it says that the LOC doesn't know yet.
  nusrSale: NusrSaleSeen | null;
  nusr: NusrNews | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LocList = { units: LocUnit[]; totals: LocTotals; capped: boolean };

const NOT_HERE = { error: "That unit isn't on this shop's LOC." };

const columns = {
  id: locUnits.id,
  stockNumber: locUnits.stockNumber,
  vin: locUnits.vin,
  unitYear: locUnits.unitYear,
  model: locUnits.model,
  category: locUnits.category,
  condition: locUnits.condition,
  cost: locUnits.costCents,
  freeFloorEnds: locUnits.freeFloorEnds,
  receivedOn: locUnits.receivedOn,
  onLoc: locUnits.onLoc,
  paidOffOn: locUnits.paidOffOn,
  soldOn: locUnits.soldOn,
  notes: locUnits.notes,
  tradeSaleId: locUnits.tradeSaleId,
  tradeSoldOn: unitSales.soldOn,
  tradeCustomer: unitSales.customerName,
  tradeYear: unitSales.unitYear,
  tradeModel: unitSales.unitModel,
  tradeVin: unitSales.vin,
  createdBy: users.name,
  createdAt: locUnits.createdAt,
  updatedAt: locUnits.updatedAt,
};

const selectUnits = (tx: ShopTransaction) =>
  tx.select(columns).from(locUnits).leftJoin(unitSales, eq(unitSales.id, locUnits.tradeSaleId)).leftJoin(users, eq(users.id, locUnits.createdByUserId));

type Row = Awaited<ReturnType<typeof selectUnits>>[number];

function toUnit(row: Row, sales: readonly NusrSaleSeen[]): LocUnit {
  const { tradeSoldOn, tradeCustomer, tradeYear, tradeModel, tradeVin, ...unit } = row;
  const nusrSale = nusrSaleFor(unit, sales);
  return {
    ...unit,
    trade:
      unit.tradeSaleId && tradeSoldOn && tradeCustomer
        ? { soldOn: tradeSoldOn, customerName: tradeCustomer, unit: unitLabel({ unitYear: tradeYear, unitModel: tradeModel, vin: tradeVin }) }
        : null,
    nusrSale,
    nusr: nusrNews(unit, nusrSale),
  };
}

// A unit's fields as its row's columns.
function toColumns(unit: LocUnitFields) {
  return {
    stockNumber: unit.stockNumber,
    vin: unit.vin,
    unitYear: unit.unitYear,
    model: unit.model,
    category: unit.category,
    condition: unit.condition,
    costCents: unit.cost,
    freeFloorEnds: unit.freeFloorEnds,
    receivedOn: unit.receivedOn,
    onLoc: unit.onLoc,
    paidOffOn: unit.paidOffOn,
    soldOn: unit.soldOn,
    notes: unit.notes,
  };
}

async function audit(tx: ShopTransaction, actor: CurrentUser, action: string, targetId: string, details: Record<string, unknown>) {
  await tx.insert(auditLog).values({ shopId: actor.shop.id, actorUserId: actor.id, action, targetType: "loc_unit", targetId, details });
}

// What the log says about a unit: enough to know it again.
const unitSummary = (unit: LocUnitFields) => ({ unit: locUnitLabel(unit), stockNumber: unit.stockNumber });

const isStockTaken = (error: unknown) => {
  const cause = (error instanceof DrizzleQueryError ? error.cause : error) as { code?: string; constraint?: string } | undefined;
  return cause?.code === "23505" && cause.constraint === "loc_units_shop_stock";
};

// A unit on the list (in stock, or sold and still owed) with this stock #
// (without case), other than one being corrected.
const ON_THE_LIST = or(isNull(locUnits.soldOn), eq(locUnits.onLoc, true));

async function stockHolder(tx: ShopTransaction, stockNumber: string | null, except: string | null = null) {
  if (!stockNumber) return null;
  const [holder] = await tx
    .select({ id: locUnits.id, unitYear: locUnits.unitYear, model: locUnits.model })
    .from(locUnits)
    .where(and(sql`lower(${locUnits.stockNumber}) = lower(${stockNumber})`, ON_THE_LIST, except ? sql`${locUnits.id} <> ${except}` : undefined))
    .limit(1);
  return holder ?? null;
}

const stockTakenProblem = (stockNumber: string, holder: { unitYear: number | null; model: string } | null): LocProblem => ({
  field: "stockNumber",
  error: `Stock # ${stockNumber} is already on the LOC${holder ? `: ${locUnitLabel(holder)}` : ""}.`,
});

// --- What the NUSR has ---------------------------------------------------------------

// The NUSR's sales that may be these units (see nusrSaleFor): the same
// VIN, or for a unit without one, a VIN its stock # ends.
async function nusrSalesFor(tx: ShopTransaction, units: readonly Pick<LocUnitFields, "vin" | "stockNumber">[]): Promise<NusrSaleSeen[]> {
  const vins = [...new Set(units.flatMap((unit) => (unit.vin?.length === 17 ? [unit.vin] : [])))];
  const stocks = [...new Set(units.flatMap((unit) => (unit.vin?.length !== 17 && unit.stockNumber && /^\d{5,}$/.test(unit.stockNumber) ? [unit.stockNumber] : [])))];
  if ((vins.length === 0 && stocks.length === 0) || vins.length + stocks.length > 10_000) return [];
  const list = (values: string[]) => sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
  return tx
    .select({
      id: unitSales.id,
      vin: unitSales.vin,
      soldOn: unitSales.soldOn,
      customerName: unitSales.customerName,
      condition: unitSales.condition,
      unitYear: unitSales.unitYear,
      paidOn: unitSales.paidOn,
      comsNumber: unitSales.comsNumber,
    })
    .from(unitSales)
    .where(
      and(
        sql`length(${unitSales.vin}) = 17`,
        or(
          vins.length > 0 ? inArray(unitSales.vin, vins) : undefined,
          stocks.length > 0 ? sql`exists (select 1 from unnest(${list(stocks)}) as s(stock) where right(${unitSales.vin}, length(s.stock)) = s.stock)` : undefined,
        ),
      ),
    );
}

// --- Reading -------------------------------------------------------------------------

// "2026-11-09" and 30 -> "2026-12-09".
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// What a search looks through: the stock #, VIN, year, model, category and
// notes. Every word has to be somewhere, any order and any case, as on the
// other lists.
function locSearch(query: string): SQL | undefined {
  const words = listSearchWords(query);
  if (words.length === 0) return undefined;
  const text = sql`concat_ws(' ', ${locUnits.stockNumber}, ${locUnits.vin}, ${locUnits.unitYear}::text, ${locUnits.model}, ${locUnits.category}, ${locUnits.notes})`;
  return sql`${text} ilike all (array[${sql.join(
    words.map((word) => sql`${containsPattern(word)}`),
    sql`, `,
  )}]::text[])`;
}

function locWhere(filters: LocFilters, today: string): SQL | undefined {
  const soon = addDays(today, SOON_DAYS);
  return and(
    filters.show === "loc"
      ? eq(locUnits.onLoc, true)
      : filters.show === "owned"
        ? and(eq(locUnits.onLoc, false), isNull(locUnits.soldOn))
        : filters.show === "sold"
          ? isNotNull(locUnits.soldOn)
          : ON_THE_LIST,
    filters.floor === "ended"
      ? sql`${locUnits.freeFloorEnds} < ${today}`
      : filters.floor === "soon"
        ? sql`${locUnits.freeFloorEnds} between ${today} and ${soon}`
        : filters.floor === "free"
          ? sql`${locUnits.freeFloorEnds} > ${soon}`
          : filters.floor === "none"
            ? isNull(locUnits.freeFloorEnds)
            : undefined,
    filters.condition ? eq(locUnits.condition, filters.condition) : undefined,
    filters.category ? sql`lower(${locUnits.category}) = lower(${filters.category})` : undefined,
    filters.year !== null ? eq(locUnits.unitYear, filters.year) : undefined,
    locSearch(filters.query),
  );
}

export const MAX_LOC_ROWS = 5_000;

// The units the filters find, with their totals: as the sheet lists them,
// the ones we own first and then the ones on the LOC, each by when its
// free floor ends; sold ones the latest sold first.
export async function listLocUnits(shopId: string, filters: LocFilters, today = shopToday()): Promise<LocList> {
  const { rows, sales } = await withShop(shopId, async (tx) => {
    const rows = await selectUnits(tx)
      .where(locWhere(filters, today))
      .orderBy(
        ...(filters.show === "sold"
          ? [desc(locUnits.soldOn), desc(locUnits.createdAt)]
          : [asc(locUnits.onLoc), sql`${locUnits.freeFloorEnds} asc nulls last`, sql`lower(${locUnits.stockNumber}) asc nulls last`, asc(locUnits.createdAt)]),
        asc(locUnits.id),
      )
      .limit(MAX_LOC_ROWS + 1);
    return { rows, sales: await nusrSalesFor(tx, rows) };
  });
  const capped = rows.length > MAX_LOC_ROWS;
  let units = rows.slice(0, MAX_LOC_ROWS).map((row) => toUnit(row, sales));
  // What the NUSR has sold that the LOC doesn't know of yet.
  if (filters.show === "nusr") units = units.filter((unit) => unit.nusr !== null);
  return { units, totals: locTotals(units, today), capped };
}

export async function getLocUnit(shopId: string, id: string): Promise<LocUnit | null> {
  if (!isUuid(id)) return null;
  return withShop(shopId, async (tx) => {
    const [row] = await selectUnits(tx).where(eq(locUnits.id, id));
    if (!row) return null;
    return toUnit(row, await nusrSalesFor(tx, [row]));
  });
}

// The trade-ins a NUSR sale brought in, for the sale's page.
export async function tradeInsForSale(shopId: string, saleId: string): Promise<LocUnit[]> {
  if (!isUuid(saleId)) return [];
  return withShop(shopId, async (tx) => {
    const rows = await selectUnits(tx).where(eq(locUnits.tradeSaleId, saleId)).orderBy(asc(locUnits.createdAt));
    const sales = await nusrSalesFor(tx, rows);
    return rows.map((row) => toUnit(row, sales));
  });
}

export type LocSuggestions = { models: string[]; categories: string[]; years: number[] };

// What the filters and the form offer: the categories and model years on
// the list, and the models the shop has written (the latest first).
export async function locSuggestions(shopId: string): Promise<LocSuggestions> {
  return withShop(shopId, async (tx) => {
    const categories = await tx
      .select({ value: sql<string>`min(${locUnits.category})` })
      .from(locUnits)
      .where(isNotNull(locUnits.category))
      .groupBy(sql`lower(${locUnits.category})`)
      .orderBy(sql`count(*) desc`)
      .limit(40);
    const years = await tx
      .select({ year: locUnits.unitYear })
      .from(locUnits)
      .where(and(isNotNull(locUnits.unitYear), ON_THE_LIST))
      .groupBy(locUnits.unitYear)
      .orderBy(desc(locUnits.unitYear));
    const models = await tx
      .select({ value: sql<string>`min(${locUnits.model})` })
      .from(locUnits)
      .groupBy(sql`lower(${locUnits.model})`)
      .orderBy(sql`max(${locUnits.createdAt}) desc`)
      .limit(300);
    return {
      categories: categories.map((row) => row.value),
      years: years.flatMap((row) => (row.year === null ? [] : [row.year])),
      models: models.map((row) => row.value),
    };
  });
}

// A unit on the list with this VIN, or without a VIN and with the stock #
// the VIN gives: for the NUSR's form, so a sale of a unit on the LOC, or a
// trade-in that's on it already, says so.
export async function locUnitForVin(shopId: string, vin: string): Promise<{ id: string; label: string; stockNumber: string | null; onLoc: boolean; cost: number } | null> {
  if (vin.length !== 17) return null;
  const stock = stockFromVin(vin);
  const [found] = await withShop(shopId, (tx) =>
    tx
      .select({ id: locUnits.id, unitYear: locUnits.unitYear, model: locUnits.model, stockNumber: locUnits.stockNumber, onLoc: locUnits.onLoc, cost: locUnits.costCents })
      .from(locUnits)
      .where(and(ON_THE_LIST, or(eq(locUnits.vin, vin), stock ? and(isNull(locUnits.vin), sql`lower(${locUnits.stockNumber}) = lower(${stock})`) : undefined)))
      .orderBy(sql`(${locUnits.vin} is null)`, desc(locUnits.createdAt))
      .limit(1),
  );
  return found ? { id: found.id, label: locUnitLabel(found), stockNumber: found.stockNumber, onLoc: found.onLoc, cost: found.cost } : null;
}

// --- Changing units ------------------------------------------------------------------

export type LocUnitInput = Partial<Record<LocValueKey, unknown>>;

// A new unit: one that's come in, on the LOC as it's floored, or one the
// shop owns.
export async function addLocUnit(actor: CurrentUser, input: LocUnitInput): Promise<{ id: string } | LocProblem> {
  const checked = checkLocUnit(input);
  if ("error" in checked) return checked;
  const unit = checked.unit;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const holder = await stockHolder(tx, unit.stockNumber);
      if (holder && unit.stockNumber) return stockTakenProblem(unit.stockNumber, holder);
      const [row] = await tx
        .insert(locUnits)
        .values({ ...toColumns(unit), shopId: actor.shop.id, createdByUserId: actor.id })
        .returning({ id: locUnits.id });
      await audit(tx, actor, "loc_unit.added", row.id, { ...unitSummary(unit), cost: unit.cost, section: sectionOf(unit), freeFloorEnds: unit.freeFloorEnds });
      return { id: row.id };
    });
  } catch (error) {
    if (isStockTaken(error) && unit.stockNumber) return stockTakenProblem(unit.stockNumber, null);
    throw error;
  }
}

// How an edit changed a unit, for the Activity log: each amount, date and
// choice from what to what; the notes by name only.
function changesOf(before: LocUnitFields, after: LocUnitFields) {
  const changes: Record<string, { from: string | number | null; to: string | number | null }> = {};
  const fields: string[] = [];
  const show = (key: keyof LocUnitFields, value: unknown): string | number | null => {
    if (value === null || value === undefined) return null;
    if (key === "cost") return formatMoney(value as number);
    if (key === "onLoc") return LOC_SECTION_LABELS[value ? "loc" : "owned"];
    if (key === "condition") return value === "new" ? "New" : "Used";
    return value as string | number;
  };
  for (const key of Object.keys(after) as (keyof LocUnitFields)[]) {
    if (before[key] === after[key]) continue;
    fields.push(key);
    if (key === "notes") continue;
    changes[key] = { from: show(key, before[key]), to: show(key, after[key]) };
  }
  return { fields, changes };
}

const fieldsOf = (row: Row): LocUnitFields => ({
  stockNumber: row.stockNumber,
  vin: row.vin,
  unitYear: row.unitYear,
  model: row.model,
  category: row.category,
  condition: row.condition,
  cost: row.cost,
  freeFloorEnds: row.freeFloorEnds,
  receivedOn: row.receivedOn,
  onLoc: row.onLoc,
  paidOffOn: row.paidOffOn,
  soldOn: row.soldOn,
  notes: row.notes,
});

export async function updateLocUnit(actor: CurrentUser, id: string, input: LocUnitInput): Promise<{ ok: true } | LocProblem> {
  if (!isUuid(id)) return NOT_HERE;
  const checked = checkLocUnit(input);
  if ("error" in checked) return checked;
  const unit = checked.unit;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const [row] = await selectUnits(tx).where(eq(locUnits.id, id)).for("update", { of: locUnits });
      if (!row) return NOT_HERE;
      const before = fieldsOf(row);
      const { fields, changes } = changesOf(before, unit);
      if (fields.length === 0) return { ok: true as const };
      // Back on the list (or with another stock #), it can't take one
      // another unit has.
      if (unit.stockNumber && (unit.soldOn === null || unit.onLoc)) {
        const holder = await stockHolder(tx, unit.stockNumber, id);
        if (holder) return stockTakenProblem(unit.stockNumber, holder);
      }
      await tx.update(locUnits).set(toColumns(unit)).where(eq(locUnits.id, id));
      await audit(tx, actor, "loc_unit.updated", id, { ...unitSummary(unit), fields, changes });
      return { ok: true as const };
    });
  } catch (error) {
    if (isStockTaken(error) && unit.stockNumber) return stockTakenProblem(unit.stockNumber, null);
    throw error;
  }
}

// Ticked units marked together: paid off the LOC (one payoff often covers
// several; each is then ours, and a sold one is off the list) or sold (a
// unit still owed stays on the list until it's paid off). Units it doesn't
// fit (paid off already, sold already, or sold before they came in) are
// left as they are. Each is written to the Activity log.
export async function markLocUnits(
  actor: CurrentUser,
  input: { ids: unknown; mark: unknown; on: unknown },
): Promise<{ marked: number; skipped: number; stillOwed: number } | { error: string; field?: "on" }> {
  const ids = [...new Set(Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === "string" && isUuid(id)) : [])];
  const mark = input.mark === "paid" || input.mark === "sold" ? (input.mark as LocMark) : null;
  if (!mark) return { error: "Pick paid off or sold." };
  if (ids.length === 0) return { error: mark === "paid" ? "Tick the units the payoff covered." : "Tick the units that sold." };
  if (ids.length > MAX_LOC_MARKED) return { error: `That's more than ${MAX_LOC_MARKED} units at once: mark them a few at a time.` };
  const on = parseIsoDate(input.on);
  if (!on) return { error: mark === "paid" ? "Enter the day they were paid off." : "Enter the day they sold.", field: "on" };
  return withShop(actor.shop.id, async (tx) => {
    const rows = await selectUnits(tx).where(inArray(locUnits.id, ids)).orderBy(asc(locUnits.createdAt), asc(locUnits.id)).for("update", { of: locUnits });
    let marked = 0;
    let stillOwed = 0;
    for (const row of rows) {
      const unit = fieldsOf(row);
      if (mark === "paid") {
        if (!unit.onLoc) continue;
        await tx.update(locUnits).set({ onLoc: false, paidOffOn: on }).where(eq(locUnits.id, row.id));
        await audit(tx, actor, "loc_unit.paid_off", row.id, { ...unitSummary(unit), cost: unit.cost, paidOffOn: on, sold: unit.soldOn !== null });
      } else {
        if (unit.soldOn !== null || (unit.receivedOn !== null && on < unit.receivedOn)) continue;
        await tx.update(locUnits).set({ soldOn: on }).where(eq(locUnits.id, row.id));
        await audit(tx, actor, "loc_unit.sold", row.id, { ...unitSummary(unit), cost: unit.cost, soldOn: on, section: sectionOf(unit) });
        if (unit.onLoc) stillOwed++;
      }
      marked++;
    }
    return { marked, skipped: ids.length - marked, stillOwed };
  });
}

// Removes a unit added by mistake; the Activity log keeps what it was.
export async function removeLocUnit(actor: CurrentUser, id: string): Promise<{ ok: true; label: string } | { error: string }> {
  if (!isUuid(id)) return NOT_HERE;
  return withShop(actor.shop.id, async (tx) => {
    const [row] = await selectUnits(tx).where(eq(locUnits.id, id)).for("update", { of: locUnits });
    if (!row) return NOT_HERE;
    const unit = fieldsOf(row);
    await tx.delete(locUnits).where(eq(locUnits.id, id));
    await audit(tx, actor, "loc_unit.removed", id, {
      ...unitSummary(unit),
      cost: unit.cost,
      section: sectionOf(unit),
      ...(row.tradeSaleId ? { tradeSaleId: row.tradeSaleId } : {}),
    });
    return { ok: true as const, label: [locUnitLabel(unit), unit.stockNumber && `stock # ${unit.stockNumber}`].filter(Boolean).join(", ") };
  });
}

// Saves one batch of an import. Each unit is checked as the form checks
// it; one whose stock # (without case) or whole VIN is on the list
// already is left as it is, so importing the same sheet again, or the
// lender's next list, adds only what's new. One import at a time per shop
// (a lock to the end of the batch). The batch is recorded in audit_log as
// loc_units.imported, with its counts.
export async function importLocUnits(
  actor: CurrentUser,
  input: { importId: unknown; fileName: unknown; units: unknown },
): Promise<{ outcomes: LocImportOutcome[] } | { error: string }> {
  if (!isUuid(input.importId)) return { error: "That import couldn't be read. Choose the file again." };
  const list = Array.isArray(input.units) ? (input.units as unknown[]) : null;
  if (!list || list.length === 0) return { error: "There were no units in that batch." };
  if (list.length > MAX_LOC_IMPORT_BATCH) return { error: "That batch is too big. Reload the page and try again." };
  const fileName = cutText(typeof input.fileName === "string" ? input.fileName.replace(/\u0000/g, "") : "", 255);
  const checked = list.map((entry) => {
    const row = entry && typeof entry === "object" && Number.isInteger((entry as { row?: unknown }).row) ? Number((entry as { row: number }).row) : 0;
    return { row, unit: checkLocUnit(importedUnitInput(entry)) };
  });

  return withShop(actor.shop.id, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('loc-import'), hashtext(${actor.shop.id}))`);
    const onList = await tx.select({ stockNumber: locUnits.stockNumber, vin: locUnits.vin }).from(locUnits).where(ON_THE_LIST);
    const stocks = new Set(onList.flatMap((unit) => (unit.stockNumber ? [stockKey(unit.stockNumber)] : [])));
    const vins = new Set(onList.flatMap((unit) => (unit.vin?.length === 17 ? [unit.vin] : [])));
    const outcomes: LocImportOutcome[] = [];
    const added: (typeof locUnits.$inferInsert)[] = [];
    for (const entry of checked) {
      if ("error" in entry.unit) {
        outcomes.push({ row: entry.row, result: "failed", error: entry.unit.error });
        continue;
      }
      // Sold and paid off, a unit isn't the LOC's any more: it isn't imported.
      const unit = { ...entry.unit.unit, soldOn: null, paidOffOn: null };
      if ((unit.stockNumber && stocks.has(stockKey(unit.stockNumber))) || (unit.vin?.length === 17 && vins.has(unit.vin))) {
        outcomes.push({ row: entry.row, result: "already", error: null });
        continue;
      }
      if (unit.stockNumber) stocks.add(stockKey(unit.stockNumber));
      if (unit.vin?.length === 17) vins.add(unit.vin);
      added.push({ ...toColumns(unit), shopId: actor.shop.id, createdByUserId: actor.id });
      outcomes.push({ row: entry.row, result: "added", error: null });
    }
    for (let at = 0; at < added.length; at += 500) await tx.insert(locUnits).values(added.slice(at, at + 500));
    const count = (result: LocImportOutcome["result"]) => outcomes.filter((outcome) => outcome.result === result).length;
    await audit(tx, actor, "loc_units.imported", String(input.importId), {
      fileName,
      added: added.length,
      already: count("already"),
      failed: count("failed"),
      cost: added.reduce((sum, unit) => sum + (unit.costCents ?? 0), 0),
    });
    return { outcomes };
  });
}

// --- Trade-ins, from the NUSR -----------------------------------------------------------

// Why a trade-in can't go on the LOC as it is (its stock # is on the list
// already), checked before the sale's logged so nothing's half done.
export async function tradeInProblem(tx: ShopTransaction, tradeIn: TradeIn): Promise<string | null> {
  const holder = await stockHolder(tx, tradeIn.stockNumber);
  return holder && tradeIn.stockNumber ? `The trade-in's stock # ${tradeIn.stockNumber} is already on the LOC: ${locUnitLabel(holder)}. Give it a stock # of its own.` : null;
}

// A trade-in logged with a NUSR sale, onto the LOC as a unit we own, tied
// to the sale; inside the sale's own transaction, so the two go together.
export async function addTradeIn(
  tx: ShopTransaction,
  actor: CurrentUser,
  sale: { id: string; soldOn: string; label: string },
  tradeIn: TradeIn,
): Promise<{ id: string; label: string }> {
  const unit = tradeInUnit(tradeIn, sale.soldOn);
  const [row] = await tx
    .insert(locUnits)
    .values({ ...toColumns(unit), tradeSaleId: sale.id, shopId: actor.shop.id, createdByUserId: actor.id })
    .returning({ id: locUnits.id });
  await audit(tx, actor, "loc_unit.added", row.id, {
    ...unitSummary(unit),
    cost: unit.cost,
    section: "owned",
    from: "NUSR",
    saleId: sale.id,
    sale: sale.label,
  });
  return { id: row.id, label: locUnitLabel(unit) };
}

// A sale being removed from the NUSR: its trade-ins stay on the LOC (they
// came in all the same), no longer tied to it. What stays, for saying so.
export async function untieTradeIns(tx: ShopTransaction, saleId: string): Promise<{ id: string; label: string; stockNumber: string | null }[]> {
  const rows = await tx
    .update(locUnits)
    .set({ tradeSaleId: null })
    .where(eq(locUnits.tradeSaleId, saleId))
    .returning({ id: locUnits.id, unitYear: locUnits.unitYear, model: locUnits.model, stockNumber: locUnits.stockNumber });
  return rows.map((row) => ({ id: row.id, label: locUnitLabel(row), stockNumber: row.stockNumber }));
}
