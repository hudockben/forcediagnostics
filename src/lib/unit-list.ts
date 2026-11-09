import "server-only";

import { DrizzleQueryError, and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { auditLog, manualCatalogModels, stockUnits, unitSales, users } from "@/db/schema";
import { containsPattern, listSearchWords } from "@/lib/diagnose-list-rules";
import { isUuid } from "@/lib/diagnose-rules";
import { line, parseIsoDate, shopToday, type Cents } from "@/lib/nusr-rules";
import { allows } from "@/lib/permissions";
import type { CurrentUser } from "@/lib/session";
import {
  UNIT_LIMITS,
  checkUnit,
  groupUnits,
  paintOf,
  unitChanges,
  unitName,
  unitTotals,
  withPaint,
  type NusrSale,
  type UnitFields,
  type UnitFilters,
  type UnitGroup,
  type UnitInput,
  type UnitProblem,
  type UnitTotals,
} from "@/lib/unit-list-rules";
import { modelNumberYear, vinYearCode } from "@/lib/vin";

// Unit List (the Unit List tab): the shop's units in stock, added from
// Polaris's whole goods invoices (read in the manager's browser, see
// src/lib/unit-list-rules.ts) or by hand, each with its cost and list price.
// Looking units up for the page (what the shop called the same model
// before, the last list price, whether a unit is on the list already or
// sold in the NUSR), adding them, the list by its filters, and correcting
// and removing a unit. Each checks the acting user may (sales.log: a
// manager or admin signed in with a password, as for the NUSR: it's the
// shop's costs) and keeps to their shop; every change goes in the Activity
// log.

type Problem = { error: string };

const notAllowed: Problem = { error: "Only a manager or admin signed in with a password can use the Unit List." };
const notHere: Problem = { error: "That unit isn't on the list. It may have been removed." };

// A unit on the list, with who added it and the NUSR's sale of it.
export type StockUnit = UnitFields & {
  id: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  fileName: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  nusrSale: NusrSale | null;
};

const unitColumns = {
  id: stockUnits.id,
  vin: stockUnits.vin,
  unitYear: stockUnits.unitYear,
  model: stockUnits.model,
  modelNumber: stockUnits.modelNumber,
  description: stockUnits.description,
  engineNumber: stockUnits.engineNumber,
  receivedOn: stockUnits.receivedOn,
  cost: stockUnits.costCents,
  listPrice: stockUnits.listPriceCents,
  soldOn: stockUnits.soldOn,
  notes: stockUnits.notes,
  invoiceNumber: stockUnits.invoiceNumber,
  invoiceDate: stockUnits.invoiceDate,
  fileName: stockUnits.fileName,
  createdAt: stockUnits.createdAt,
  updatedAt: stockUnits.updatedAt,
  createdBy: users.name,
};

type UnitRow = Omit<StockUnit, "nusrSale">;

const toColumns = (unit: UnitFields) => ({
  vin: unit.vin,
  unitYear: unit.unitYear,
  model: unit.model,
  modelNumber: unit.modelNumber,
  description: unit.description,
  engineNumber: unit.engineNumber,
  receivedOn: unit.receivedOn,
  costCents: unit.cost,
  listPriceCents: unit.listPrice,
  soldOn: unit.soldOn,
  notes: unit.notes,
});

const fieldsOf = (row: UnitRow): UnitFields => ({
  vin: row.vin,
  unitYear: row.unitYear,
  model: row.model,
  modelNumber: row.modelNumber,
  description: row.description,
  engineNumber: row.engineNumber,
  receivedOn: row.receivedOn,
  cost: row.cost,
  listPrice: row.listPrice,
  soldOn: row.soldOn,
  notes: row.notes,
});

async function audit(tx: ShopTransaction, actor: CurrentUser, action: string, targetId: string, details: Record<string, unknown>) {
  await tx.insert(auditLog).values({ shopId: actor.shop.id, actorUserId: actor.id, action, targetType: "stock_unit", targetId, details });
}

const isUniqueViolation = (error: unknown) => ((error instanceof DrizzleQueryError ? error.cause : error) as { code?: string } | undefined)?.code === "23505";

// The NUSR's sale of each of these VINs as new (the latest, if it was
// logged twice): a unit sold in the NUSR counts as sold on the list.
async function nusrSalesFor(tx: ShopTransaction, vins: readonly string[]): Promise<Map<string, NusrSale>> {
  const sales = new Map<string, NusrSale>();
  const distinct = [...new Set(vins)];
  for (let i = 0; i < distinct.length; i += 1000) {
    const rows = await tx
      .select({ id: unitSales.id, vin: unitSales.vin, soldOn: unitSales.soldOn, customerName: unitSales.customerName, salesperson: unitSales.salesperson })
      .from(unitSales)
      .where(and(inArray(unitSales.vin, distinct.slice(i, i + 1000)), eq(unitSales.condition, "new")))
      .orderBy(desc(unitSales.soldOn), desc(unitSales.createdAt));
    for (const { vin, ...sale } of rows) if (vin && !sales.has(vin)) sales.set(vin, sale);
  }
  return sales;
}

// Whether the NUSR has sold this unit new (inside withShop, so only the
// shop's own sales count).
const nusrSold = sql`exists (select 1 from ${unitSales} where ${unitSales.vin} = ${stockUnits.vin} and ${unitSales.condition} = 'new')`;

// What a search looks through: the model and its year, the VIN, Polaris's
// model number and description, the engine number, the notes and the
// invoice number. Every word has to be somewhere, any order and any case,
// as on the other lists.
function unitSearch(query: string): SQL | undefined {
  const words = listSearchWords(query);
  if (words.length === 0) return undefined;
  const text = sql`concat_ws(' ', ${stockUnits.unitYear}::text, ${stockUnits.model}, ${stockUnits.vin}, ${stockUnits.modelNumber},
    ${stockUnits.description}, ${stockUnits.engineNumber}, ${stockUnits.notes}, ${stockUnits.invoiceNumber})`;
  return sql`${text} ilike all (array[${sql.join(
    words.map((word) => sql`${containsPattern(word)}`),
    sql`, `,
  )}]::text[])`;
}

const inStock = sql`(${stockUnits.soldOn} is null and not ${nusrSold})`;
const sold = sql`(${stockUnits.soldOn} is not null or ${nusrSold})`;

// --- The list -------------------------------------------------------------------

// The most units the list shows at once (sold ones pile up over the years).
export const MAX_LISTED = 2000;

export type UnitList = {
  groups: UnitGroup<StockUnit>[];
  totals: UnitTotals;
  // Units the filters find (more than are shown when it's past MAX_LISTED),
  // and how many in stock and sold the search finds.
  found: number;
  shown: number;
  counts: { stock: number; sold: number };
};

// The units the filters find, by model, with their totals: what's in stock
// (not marked sold, and not sold new in the NUSR), what's sold, or both;
// the newest received first when there are more than the list shows.
export async function listStockUnits(actor: CurrentUser, filters: UnitFilters, today = shopToday()): Promise<UnitList | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  const search = unitSearch(filters.query);
  const status = filters.status === "stock" ? inStock : filters.status === "sold" ? sold : undefined;
  return withShop(actor.shop.id, async (tx) => {
    const [counts] = await tx
      .select({
        stock: sql<number>`count(*) filter (where ${inStock})::int`,
        sold: sql<number>`count(*) filter (where ${sold})::int`,
      })
      .from(stockUnits)
      .where(search);
    const rows = await tx
      .select(unitColumns)
      .from(stockUnits)
      .leftJoin(users, eq(users.id, stockUnits.createdByUserId))
      .where(and(search, status))
      .orderBy(desc(stockUnits.receivedOn), desc(stockUnits.createdAt))
      .limit(MAX_LISTED);
    const sales = await nusrSalesFor(tx, rows.map((row) => row.vin));
    const units: StockUnit[] = rows.map((row) => ({ ...row, nusrSale: sales.get(row.vin) ?? null }));
    const found = filters.status === "stock" ? counts.stock : filters.status === "sold" ? counts.sold : counts.stock + counts.sold;
    return { groups: groupUnits(units, today), totals: unitTotals(units, today), found, shown: units.length, counts };
  });
}

// One unit on the list, or null when it isn't the shop's.
export async function getStockUnit(actor: CurrentUser, id: string): Promise<StockUnit | null> {
  if (!allows(actor, "sales.log") || !isUuid(id)) return null;
  return withShop(actor.shop.id, async (tx) => {
    const [row] = await tx.select(unitColumns).from(stockUnits).leftJoin(users, eq(users.id, stockUnits.createdByUserId)).where(eq(stockUnits.id, id));
    if (!row) return null;
    const sales = await nusrSalesFor(tx, [row.vin]);
    return { ...row, nusrSale: sales.get(row.vin) ?? null };
  });
}

// --- Looking units up -----------------------------------------------------------

// What the page is told about a unit read from an invoice.
export type UnitLookup = {
  key: string;
  // The unit with its VIN on the list already.
  onList: { id: string; name: string; receivedOn: string; soldOn: string | null } | null;
  // The NUSR's sale of it (a unit presold before it came in, say).
  sold: NusrSale | null;
  // The model in the shop's own words, and where that's from: the last unit
  // on the list with the same model number ("list"), or the same model in
  // another paint ("paint"); the NUSR's last sale of the model ("nusr");
  // Polaris's model list, under System Admin > Manuals ("models").
  model: { name: string; from: "list" | "paint" | "nusr" | "models" } | null;
  // The list price the last unit with the same model number had.
  listPrice: { cents: Cents; receivedOn: string; vin: string } | null;
};

type LookupItem = { key: string; vin: string; modelNumber: string | null; description: string | null };

export const MAX_LOOKUP = 200;

function checkLookupItems(input: unknown): LookupItem[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_LOOKUP) return null;
  const items: LookupItem[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") return null;
    const { key, vin, modelNumber, description } = entry as Record<string, unknown>;
    if (typeof key !== "string" || key.length === 0 || key.length > 40) return null;
    const cleanVin = line(vin).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, UNIT_LIMITS.vin);
    const number = line(modelNumber).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, UNIT_LIMITS.modelNumber);
    items.push({ key, vin: cleanVin, modelNumber: number || null, description: line(description).slice(0, UNIT_LIMITS.description) || null });
  }
  return items;
}

// For each unit read from an invoice: whether it's on the list already or
// sold in the NUSR, the model as the shop named it before, and the list
// price the last one of its model number had (prices change, so it's
// offered, not filled in).
export async function lookUpUnits(actor: CurrentUser, input: unknown): Promise<{ units: UnitLookup[] } | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  const items = checkLookupItems(input);
  if (!items) return { error: "Those units couldn't be looked up. Drop the invoice again." };
  const vins = [...new Set(items.map((item) => item.vin).filter(Boolean))];
  const numbers = [...new Set(items.flatMap((item) => (item.modelNumber ? [item.modelNumber] : [])))];
  return withShop(actor.shop.id, async (tx) => {
    const onList = vins.length
      ? await tx
          .select({ id: stockUnits.id, vin: stockUnits.vin, unitYear: stockUnits.unitYear, model: stockUnits.model, receivedOn: stockUnits.receivedOn, soldOn: stockUnits.soldOn })
          .from(stockUnits)
          .where(inArray(stockUnits.vin, vins))
      : [];
    const sales = await nusrSalesFor(tx, vins);
    // The same model number on the list, the latest first.
    const sameNumber = numbers.length
      ? await tx
          .select({ modelNumber: stockUnits.modelNumber, model: stockUnits.model, listPrice: stockUnits.listPriceCents, receivedOn: stockUnits.receivedOn, vin: stockUnits.vin })
          .from(stockUnits)
          .where(inArray(stockUnits.modelNumber, numbers))
          .orderBy(desc(stockUnits.receivedOn), desc(stockUnits.createdAt))
      : [];
    // The same model in another paint: the model number's first eight (R27RSY99).
    const bases = [...new Set(numbers.map((number) => number.slice(0, 8)).filter((base) => base.length === 8))];
    const samePaintless = bases.length
      ? await tx
          .select({ base: sql<string>`substr(${stockUnits.modelNumber}, 1, 8)`, model: stockUnits.model, description: stockUnits.description })
          .from(stockUnits)
          .where(sql`substr(${stockUnits.modelNumber}, 1, 8) in (${sql.join(
            bases.map((base) => sql`${base}`),
            sql`, `,
          )})`)
          .orderBy(desc(stockUnits.receivedOn), desc(stockUnits.createdAt))
      : [];
    const catalog = numbers.length
      ? await tx
          .select({ modelNumber: manualCatalogModels.modelNumber, description: manualCatalogModels.modelDescription })
          .from(manualCatalogModels)
          .where(and(inArray(manualCatalogModels.modelNumber, numbers), isNotNull(manualCatalogModels.modelDescription)))
      : [];

    const units: UnitLookup[] = [];
    for (const item of items) {
      const listedUnit = onList.find((unit) => unit.vin === item.vin);
      const byNumber = item.modelNumber ? sameNumber.filter((unit) => unit.modelNumber === item.modelNumber) : [];
      const priced = byNumber.find((unit) => unit.listPrice !== null);
      let model: UnitLookup["model"] = byNumber[0] ? { name: byNumber[0].model, from: "list" } : null;
      if (!model && item.modelNumber) {
        const other = samePaintless.find((unit) => unit.base === item.modelNumber!.slice(0, 8));
        if (other) model = { name: withPaint(other.model, paintOf(item.description)), from: "paint" };
      }
      if (!model) {
        const name = await nusrModel(tx, item);
        if (name) model = { name, from: "nusr" };
      }
      if (!model && item.modelNumber) {
        const entry = catalog.find((row) => row.modelNumber === item.modelNumber);
        if (entry?.description) model = { name: line(entry.description).slice(0, UNIT_LIMITS.model), from: "models" };
      }
      units.push({
        key: item.key,
        onList: listedUnit ? { id: listedUnit.id, name: unitName(listedUnit), receivedOn: listedUnit.receivedOn, soldOn: listedUnit.soldOn } : null,
        sold: sales.get(item.vin) ?? null,
        model,
        listPrice: priced && priced.listPrice !== null ? { cents: priced.listPrice, receivedOn: priced.receivedOn, vin: priced.vin } : null,
      });
    }
    return { units };
  });
}

// The model the NUSR's last new sale of the same model and model year had
// (the VIN's characters 4-8 and 10, or the model number's code and year),
// in the shop's words.
async function nusrModel(tx: ShopTransaction, item: LookupItem): Promise<string | null> {
  let code: string | null = null;
  let year: string | null = null;
  if (item.vin.length === 17) {
    code = item.vin.slice(3, 8);
    year = item.vin[9];
  } else if (item.modelNumber && item.modelNumber.length >= 8) {
    code = item.modelNumber.slice(3, 8);
    const modelYear = modelNumberYear(item.modelNumber);
    year = modelYear === null ? null : vinYearCode(modelYear);
  }
  if (!code || !year) return null;
  const [sale] = await tx
    .select({ model: unitSales.unitModel })
    .from(unitSales)
    .where(
      and(
        eq(unitSales.unitType, "whole_good"),
        sql`length(${unitSales.vin}) = 17`,
        sql`substr(${unitSales.vin}, 4, 5) = ${code}`,
        sql`substr(${unitSales.vin}, 10, 1) = ${year}`,
        isNotNull(unitSales.unitModel),
      ),
    )
    .orderBy(desc(unitSales.soldOn), desc(unitSales.createdAt))
    .limit(1);
  return sale?.model ? line(sale.model).slice(0, UNIT_LIMITS.model) : null;
}

// --- Adding ---------------------------------------------------------------------

export const MAX_ADD = 200;

// What adding says: the units added and those on the list already (by
// their VIN), or what's wrong with any of them (nothing's added then).
export type AddResult =
  | { added: { key: string; id: string }[]; already: { key: string; id: string; name: string }[] }
  | { problems: (UnitProblem & { key: string })[] }
  | Problem;

type CheckedAdd = { key: string; unit: UnitFields; invoiceNumber: string | null; invoiceDate: string | null };

// Adds units to the list: read from an invoice and checked on the page
// (`fileName` the file dropped, each with its invoice's number and date), or
// one typed in. A unit is added as in stock; one whose VIN is on the list
// already isn't added again.
export async function addStockUnits(actor: CurrentUser, input: unknown): Promise<AddResult> {
  if (!allows(actor, "sales.log")) return notAllowed;
  const { fileName, units } = (input ?? {}) as { fileName?: unknown; units?: unknown };
  if (!Array.isArray(units) || units.length === 0 || units.length > MAX_ADD) return { error: "Those units couldn't be added. Drop the invoice again." };
  const file = line(fileName).slice(0, UNIT_LIMITS.fileName) || null;
  const problems: (UnitProblem & { key: string })[] = [];
  const checked: CheckedAdd[] = [];
  const seen = new Map<string, string>();
  for (const [index, entry] of units.entries()) {
    const fields = (entry ?? {}) as UnitInput & { key?: unknown; invoiceNumber?: unknown; invoiceDate?: unknown };
    const key = typeof fields.key === "string" && fields.key.length <= 40 ? fields.key : String(index + 1);
    const result = checkUnit({ ...fields, soldOn: null });
    if ("error" in result) {
      problems.push({ key, ...result });
      continue;
    }
    const twice = seen.get(result.unit.vin);
    if (twice !== undefined) {
      problems.push({ key, error: "Another unit here has this VIN: each unit is on the list once.", field: "vin" });
      continue;
    }
    seen.set(result.unit.vin, key);
    const invoiceNumber = line(fields.invoiceNumber).replace(/[^A-Za-z0-9-]/g, "").slice(0, UNIT_LIMITS.invoiceNumber) || null;
    checked.push({ key, unit: result.unit, invoiceNumber, invoiceDate: parseIsoDate(fields.invoiceDate) });
  }
  if (problems.length) return { problems };

  return withShop(actor.shop.id, async (tx) => {
    const inserted = await tx
      .insert(stockUnits)
      .values(
        checked.map(({ unit, invoiceNumber, invoiceDate }) => ({
          shopId: actor.shop.id,
          ...toColumns(unit),
          invoiceNumber,
          invoiceDate,
          fileName: file,
          createdByUserId: actor.id,
        })),
      )
      .onConflictDoNothing({ target: [stockUnits.shopId, stockUnits.vin] })
      .returning({ id: stockUnits.id, vin: stockUnits.vin });
    const ids = new Map(inserted.map((row) => [row.vin, row.id]));
    const added: { key: string; id: string }[] = [];
    const waiting: CheckedAdd[] = [];
    for (const one of checked) {
      const id = ids.get(one.unit.vin);
      if (!id) {
        waiting.push(one);
        continue;
      }
      added.push({ key: one.key, id });
      await audit(tx, actor, "stock_unit.added", id, {
        unit: unitName(one.unit),
        vin: one.unit.vin,
        receivedOn: one.unit.receivedOn,
        cost: one.unit.cost,
        listPrice: one.unit.listPrice,
        invoiceNumber: one.invoiceNumber,
        fileName: file,
      });
    }
    const existing = waiting.length
      ? await tx
          .select({ id: stockUnits.id, vin: stockUnits.vin, unitYear: stockUnits.unitYear, model: stockUnits.model })
          .from(stockUnits)
          .where(inArray(stockUnits.vin, waiting.map((one) => one.unit.vin)))
      : [];
    const already = waiting.flatMap((one) => {
      const unit = existing.find((row) => row.vin === one.unit.vin);
      return unit ? [{ key: one.key, id: unit.id, name: unitName(unit) }] : [];
    });
    return { added, already };
  });
}

// --- Correcting and removing ----------------------------------------------------

// Saves a unit as corrected (or marked sold, or back in stock); the
// Activity log keeps each change.
export async function updateStockUnit(actor: CurrentUser, id: string, input: UnitInput): Promise<{ ok: true; changed: boolean } | UnitProblem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  if (!isUuid(id)) return notHere;
  const checked = checkUnit(input);
  if ("error" in checked) return checked;
  const after = checked.unit;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const [row] = await tx.select(unitColumns).from(stockUnits).leftJoin(users, eq(users.id, stockUnits.createdByUserId)).where(eq(stockUnits.id, id)).for("update", { of: stockUnits });
      if (!row) return notHere;
      const changes = unitChanges(fieldsOf(row), after);
      const fields = Object.keys(changes);
      if (fields.length === 0) return { ok: true as const, changed: false };
      await tx.update(stockUnits).set(toColumns(after)).where(eq(stockUnits.id, id));
      // Notes can name a customer (a presold unit's buyer): the log says
      // they changed, not what they say, as the NUSR's does.
      const shown = { ...changes };
      delete shown.notes;
      await audit(tx, actor, "stock_unit.updated", id, { unit: unitName(after), vin: after.vin, fields, changes: shown });
      return { ok: true as const, changed: true };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: `Another unit on the list has the VIN ${after.vin}.`, field: "vin" };
    throw error;
  }
}

// Removes a unit put on the list by mistake; the Activity log keeps what
// it was.
export async function removeStockUnit(actor: CurrentUser, id: string): Promise<{ ok: true; name: string } | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  if (!isUuid(id)) return notHere;
  return withShop(actor.shop.id, async (tx) => {
    const [row] = await tx.select(unitColumns).from(stockUnits).leftJoin(users, eq(users.id, stockUnits.createdByUserId)).where(eq(stockUnits.id, id)).for("update", { of: stockUnits });
    if (!row) return notHere;
    await tx.delete(stockUnits).where(eq(stockUnits.id, id));
    await audit(tx, actor, "stock_unit.removed", id, {
      unit: unitName(row),
      vin: row.vin,
      receivedOn: row.receivedOn,
      cost: row.cost,
      listPrice: row.listPrice,
      soldOn: row.soldOn,
      invoiceNumber: row.invoiceNumber,
    });
    return { ok: true as const, name: unitName(row) };
  });
}
