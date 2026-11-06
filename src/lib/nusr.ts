import "server-only";

import { DrizzleQueryError, and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { withShop, type ShopTransaction } from "@/db";
import { auditLog, customerVehicles, customers, unitSales, users } from "@/db/schema";
import { checkCustomer, vehicleLabel } from "@/lib/customer-rules";
import { containsPattern, listPage, listSearchWords, type ListPage } from "@/lib/diagnose-list-rules";
import { isUuid } from "@/lib/diagnose-rules";
import { brandInfo } from "@/lib/manual-catalog-rules";
import {
  DEFAULT_HOLDBACK_RATE_BP,
  MONEY_FIELDS,
  SALE_LABELS,
  SALE_LIMITS,
  checkSale,
  formatDay,
  formatMoney,
  formatRate,
  line,
  monthlyComparison,
  parseIsoDate,
  saleTotals,
  unitLabel,
  withFigures,
  type FiguredSale,
  type MonthlyComparison,
  type MoneyField,
  type SaleFields,
  type SaleFilters,
  type SaleProblem,
  type SaleTotals,
  type UnitCondition,
  type UnitType,
} from "@/lib/nusr-rules";
import type { CurrentUser } from "@/lib/session";
import { searchCustomersForLog } from "@/lib/sticker-log";
import { checkVin, sharedModelName, vinModelCode, vinModelNumberPatterns, vinYears } from "@/lib/vin";

// NUSR, the unit sales log (the NUSR tab). Callers check sales.log first;
// everything here runs inside withShop for the user's own shop, and every
// change is written to audit_log, which the Activity log shows.

export type Sale = FiguredSale & {
  id: string;
  customerId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SaleLog = ListPage & { items: Sale[]; total: number; totals: SaleTotals };

const NOT_HERE = { error: "That sale isn't in this shop's NUSR." };
const NO_CUSTOMER = { error: "That customer isn't in this shop." };

// Each amount and the column it's kept in.
const AMOUNT_COLUMNS = {
  msrp: unitSales.msrpCents,
  salesPrice: unitSales.salesPriceCents,
  dealerCost: unitSales.dealerCostCents,
  unitLabor: unitSales.unitLaborCents,
  rebate: unitSales.rebateCents,
  accPrice: unitSales.accPriceCents,
  accCost: unitSales.accCostCents,
  accLabor: unitSales.accLaborCents,
  escPrice: unitSales.escPriceCents,
  escCost: unitSales.escCostCents,
  rewards: unitSales.rewardsCents,
  amountFinanced: unitSales.amountFinancedCents,
  downPayment: unitSales.downPaymentCents,
  bonusAdjustment: unitSales.bonusAdjustmentCents,
} satisfies Record<MoneyField, unknown>;

const saleColumns = {
  id: unitSales.id,
  customerId: unitSales.customerId,
  soldOn: unitSales.soldOn,
  salesperson: unitSales.salesperson,
  customerName: unitSales.customerName,
  customerAddress: unitSales.customerAddress,
  customerPhone: unitSales.customerPhone,
  unitYear: unitSales.unitYear,
  unitModel: unitSales.unitModel,
  condition: unitSales.condition,
  unitType: unitSales.unitType,
  vin: unitSales.vin,
  category: unitSales.category,
  ...AMOUNT_COLUMNS,
  holdbackRateBp: unitSales.holdbackRateBp,
  bonusRateBp: unitSales.bonusRateBp,
  notes: unitSales.notes,
  financeCompany: unitSales.financeCompany,
  fundingReceivedOn: unitSales.fundingReceivedOn,
  paidOn: unitSales.paidOn,
  comsNumber: unitSales.comsNumber,
  createdBy: users.name,
  createdAt: unitSales.createdAt,
  updatedAt: unitSales.updatedAt,
};

const toSale = (row: Omit<Sale, "figures">): Sale => withFigures(row);

// A sale's fields as its row's columns.
function toColumns(sale: SaleFields) {
  return {
    soldOn: sale.soldOn,
    salesperson: sale.salesperson,
    customerName: sale.customerName,
    customerAddress: sale.customerAddress,
    customerPhone: sale.customerPhone,
    unitYear: sale.unitYear,
    unitModel: sale.unitModel,
    condition: sale.condition,
    unitType: sale.unitType,
    vin: sale.vin,
    category: sale.category,
    msrpCents: sale.msrp,
    salesPriceCents: sale.salesPrice,
    dealerCostCents: sale.dealerCost,
    unitLaborCents: sale.unitLabor,
    rebateCents: sale.rebate,
    accPriceCents: sale.accPrice,
    accCostCents: sale.accCost,
    accLaborCents: sale.accLabor,
    escPriceCents: sale.escPrice,
    escCostCents: sale.escCost,
    rewardsCents: sale.rewards,
    holdbackRateBp: sale.holdbackRateBp,
    bonusRateBp: sale.bonusRateBp,
    notes: sale.notes,
    financeCompany: sale.financeCompany,
    amountFinancedCents: sale.amountFinanced,
    downPaymentCents: sale.downPayment,
    bonusAdjustmentCents: sale.bonusAdjustment,
    fundingReceivedOn: sale.fundingReceivedOn,
    paidOn: sale.paidOn,
    comsNumber: sale.comsNumber,
  };
}

async function audit(tx: ShopTransaction, actor: CurrentUser, action: string, targetId: string, details: Record<string, unknown>) {
  await tx.insert(auditLog).values({ shopId: actor.shop.id, actorUserId: actor.id, action, targetType: "unit_sale", targetId, details });
}

const isUniqueViolation = (error: unknown) =>
  ((error instanceof DrizzleQueryError ? error.cause : error) as { code?: string } | undefined)?.code === "23505";

const alreadyLogged = (sale: SaleFields): SaleProblem => ({
  field: "vin",
  error: `The unit with VIN ${sale.vin} is already in the NUSR as sold on ${sale.soldOn}.`,
});

// --- Reading -----------------------------------------------------------------

// What a search looks through: the customer's name, phone (also as bare
// digits) and address, the unit, its VIN, the salesman, finance company,
// COMS # and notes. Every word has to be somewhere, any order and any case,
// as on the other lists.
function saleSearch(query: string): SQL | undefined {
  const words = listSearchWords(query);
  if (words.length === 0) return undefined;
  const text = sql`concat_ws(' ', ${unitSales.customerName}, ${unitSales.customerPhone},
    regexp_replace(coalesce(${unitSales.customerPhone}, ''), '[^0-9]', '', 'g'), ${unitSales.customerAddress},
    ${unitSales.unitYear}::text, ${unitSales.unitModel}, ${unitSales.vin}, ${unitSales.category}, ${unitSales.salesperson},
    ${unitSales.financeCompany}, ${unitSales.comsNumber}, ${unitSales.notes})`;
  return sql`${text} ilike all (array[${sql.join(
    words.map((word) => sql`${containsPattern(word)}`),
    sql`, `,
  )}]::text[])`;
}

function saleWhere(filters: SaleFilters): SQL | undefined {
  const { year, month } = filters;
  const from = year === null ? null : month === null ? `${year}-01-01` : `${year}-${String(month).padStart(2, "0")}-01`;
  const to = year === null ? null : month === null ? `${year + 1}-01-01` : month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return and(
    from && to ? and(gte(unitSales.soldOn, from), lt(unitSales.soldOn, to)) : undefined,
    filters.condition ? eq(unitSales.condition, filters.condition) : undefined,
    filters.unitType ? eq(unitSales.unitType, filters.unitType) : undefined,
    filters.category ? sql`lower(${unitSales.category}) = lower(${filters.category})` : undefined,
    filters.salesperson ? sql`lower(${unitSales.salesperson}) = lower(${filters.salesperson})` : undefined,
    filters.status === "funding"
      ? and(sql`coalesce(${unitSales.amountFinancedCents}, 0) > 0`, isNull(unitSales.fundingReceivedOn))
      : filters.status === "unpaid"
        ? and(eq(unitSales.condition, "new"), isNull(unitSales.paidOn))
        : undefined,
    saleSearch(filters.query),
  );
}

export const MAX_LOG_ROWS = 20_000;

// Every sale the filters find, the newest first, or the oldest first as
// the spreadsheet read (the download and the printout).
export async function findSales(shopId: string, filters: SaleFilters, order: "newest" | "oldest" = "newest"): Promise<Sale[]> {
  // The newest MAX_LOG_ROWS either way, so a cap would leave out the oldest.
  const rows = await withShop(shopId, (tx) =>
    tx
      .select(saleColumns)
      .from(unitSales)
      .leftJoin(users, eq(users.id, unitSales.createdByUserId))
      .where(saleWhere(filters))
      .orderBy(desc(unitSales.soldOn), desc(unitSales.createdAt), desc(unitSales.id))
      .limit(MAX_LOG_ROWS),
  );
  const sales = rows.map(toSale);
  return order === "newest" ? sales : sales.reverse();
}

// Every sale counted from `from` to `to` (days, both included) by the day
// it was sold, or by the day its funding came in (a sale not funded yet
// has none), the oldest first: for Reports.
export async function salesBetween(shopId: string, from: string, to: string, by: "sold" | "funded" = "sold"): Promise<Sale[]> {
  const day = by === "funded" ? unitSales.fundingReceivedOn : unitSales.soldOn;
  const rows = await withShop(shopId, (tx) =>
    tx
      .select(saleColumns)
      .from(unitSales)
      .leftJoin(users, eq(users.id, unitSales.createdByUserId))
      .where(and(gte(day, from), lte(day, to)))
      .orderBy(asc(day), asc(unitSales.soldOn), asc(unitSales.createdAt), asc(unitSales.id))
      .limit(MAX_LOG_ROWS),
  );
  return rows.map(toSale);
}

// How many sales sold from `from` to `to` have no Funding Rec'd yet.
export async function unfundedBetween(shopId: string, from: string, to: string): Promise<number> {
  const [row] = await withShop(shopId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(unitSales)
      .where(and(gte(unitSales.soldOn, from), lte(unitSales.soldOn, to), isNull(unitSales.fundingReceivedOn))),
  );
  return row?.count ?? 0;
}

export const LOG_PAGE_SIZE = 50;

// One page of the log, with the totals of everything the filters find.
export async function listSales(shopId: string, filters: SaleFilters, { page = 1, perPage = LOG_PAGE_SIZE } = {}): Promise<SaleLog> {
  const sales = await findSales(shopId, filters);
  const at = listPage(sales.length, page, perPage);
  return { ...at, total: sales.length, items: sales.slice(at.offset, at.offset + perPage), totals: saleTotals(sales) };
}

export async function getSale(shopId: string, id: string): Promise<Sale | null> {
  if (!isUuid(id)) return null;
  const [row] = await withShop(shopId, (tx) =>
    tx.select(saleColumns).from(unitSales).leftJoin(users, eq(users.id, unitSales.createdByUserId)).where(eq(unitSales.id, id)),
  );
  return row ? toSale(row) : null;
}

// A customer's sales, the newest first, for their record.
export async function salesForCustomer(shopId: string, customerId: string): Promise<Sale[]> {
  if (!isUuid(customerId)) return [];
  const rows = await withShop(shopId, (tx) =>
    tx
      .select(saleColumns)
      .from(unitSales)
      .leftJoin(users, eq(users.id, unitSales.createdByUserId))
      .where(eq(unitSales.customerId, customerId))
      .orderBy(desc(unitSales.soldOn), desc(unitSales.createdAt)),
  );
  return rows.map(toSale);
}

// The years with sales, the newest first, for the year filter.
export async function saleYears(shopId: string): Promise<number[]> {
  const rows = await withShop(shopId, (tx) =>
    tx
      .select({ year: sql<number>`extract(year from ${unitSales.soldOn})::int` })
      .from(unitSales)
      .groupBy(sql`1`)
      .orderBy(sql`1 desc`),
  );
  return rows.map((row) => row.year);
}

// Units sold each month of every year with sales: of the sales the log's
// filters find, every year (a salesman's or the used units' own counts),
// or of all of them.
export async function unitsByMonth(shopId: string, filters: SaleFilters | null = null): Promise<MonthlyComparison> {
  const rows = await withShop(shopId, (tx) =>
    tx
      .select({
        year: sql<number>`extract(year from ${unitSales.soldOn})::int`,
        month: sql<number>`extract(month from ${unitSales.soldOn})::int`,
        units: sql<number>`count(*)::int`,
      })
      .from(unitSales)
      .where(filters ? saleWhere({ ...filters, year: null, month: null }) : undefined)
      .groupBy(sql`1`, sql`2`),
  );
  return monthlyComparison(rows);
}

export type SaleSuggestions = {
  salespeople: string[];
  financeCompanies: string[];
  categories: string[];
  models: string[];
  // The rates of the latest sale, which a new one starts from.
  latest: { holdbackRateBp: number; bonusRateBp: number } | null;
  // The COMS #s entered last (a payoff covers several units, paid off
  // after they're sold), the newest first.
  comsNumbers: string[];
};

// What the form offers as it's typed: the names, lenders, categories and
// models the log already has, the most used first.
export async function saleSuggestions(shopId: string): Promise<SaleSuggestions> {
  return withShop(shopId, async (tx) => {
    const distinct = async (column: AnyPgColumn, limit: number) => {
      const rows = await tx
        .select({ value: sql<string>`min(${column})`, uses: sql<number>`count(*)::int`, last: sql<string>`max(${unitSales.soldOn})` })
        .from(unitSales)
        .where(sql`${column} is not null`)
        .groupBy(sql`lower(${column})`)
        .orderBy(sql`max(${unitSales.soldOn}) desc`, sql`count(*) desc`)
        .limit(limit);
      return rows.map((row) => row.value);
    };
    const [salespeople, financeCompanies, categories, models] = [
      await distinct(unitSales.salesperson, 40),
      await distinct(unitSales.financeCompany, 40),
      await distinct(unitSales.category, 40),
      await distinct(unitSales.unitModel, 300),
    ];
    const [latest] = await tx
      .select({ bonusRateBp: unitSales.bonusRateBp })
      .from(unitSales)
      .orderBy(desc(unitSales.soldOn), desc(unitSales.createdAt))
      .limit(1);
    const coms = await tx
      .select({ value: sql<string>`min(${unitSales.comsNumber})` })
      .from(unitSales)
      .where(sql`${unitSales.comsNumber} is not null`)
      .groupBy(sql`lower(${unitSales.comsNumber})`)
      .orderBy(sql`max(coalesce(${unitSales.paidOn}, ${unitSales.soldOn})) desc`, sql`max(${unitSales.updatedAt}) desc`)
      .limit(5);
    // The holdback of the latest new whole good that had one.
    const [holdback] = await tx
      .select({ holdbackRateBp: unitSales.holdbackRateBp })
      .from(unitSales)
      .where(and(eq(unitSales.unitType, "whole_good"), sql`${unitSales.holdbackRateBp} > 0`))
      .orderBy(desc(unitSales.soldOn), desc(unitSales.createdAt))
      .limit(1);
    return {
      salespeople,
      financeCompanies,
      categories,
      models,
      latest: latest ? { ...latest, holdbackRateBp: holdback?.holdbackRateBp ?? DEFAULT_HOLDBACK_RATE_BP } : null,
      comsNumbers: coms.map((row) => row.value),
    };
  });
}

// Someone to fill a sale in from: a customer on file, or someone the NUSR
// has sold to who isn't on file (an import brings years of them), with the
// name, phone and address of the latest sale to them.
export type BuyerChoice =
  | { kind: "customer"; id: string; name: string; detail: string | null }
  | { kind: "buyer"; id: string; name: string; detail: string | null; phone: string | null; address: string | null };

const BUYER_SUGGESTIONS = 6;

// Customers on file by name or phone number (A to Z), then past buyers
// who aren't, the latest first: a buyer with a customer of the same name
// and phone number on file is that customer.
export async function searchSaleBuyers(shopId: string, query: string): Promise<BuyerChoice[]> {
  const words = listSearchWords(query);
  if (words.length === 0) return [];
  const onFile = await searchCustomersForLog(shopId, query);
  const digits = (column: SQL | AnyPgColumn) => sql`regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g')`;
  const text = sql`concat_ws(' ', ${unitSales.customerName}, ${unitSales.customerPhone}, ${digits(unitSales.customerPhone)})`;
  const rows = await withShop(shopId, (tx) =>
    tx.execute<{ name: string; phone: string | null; address: string | null; sold_on: string }>(sql`
      select name, phone, address, sold_on from (
        select distinct on (lower(${unitSales.customerName}), ${digits(unitSales.customerPhone)})
          ${unitSales.customerName} as name, ${unitSales.customerPhone} as phone, ${unitSales.customerAddress} as address, to_char(${unitSales.soldOn}, 'YYYY-MM-DD') as sold_on
        from ${unitSales}
        where ${unitSales.customerId} is null
          and ${text} ilike all (array[${sql.join(
            words.map((word) => sql`${containsPattern(word)}`),
            sql`, `,
          )}]::text[])
          and not exists (
            select 1 from ${customers}
            where lower(${customers.name}) = lower(${unitSales.customerName}) and ${digits(customers.phone)} = ${digits(unitSales.customerPhone)}
          )
        order by lower(${unitSales.customerName}), ${digits(unitSales.customerPhone)}, ${unitSales.soldOn} desc, ${unitSales.createdAt} desc
      ) latest
      order by sold_on desc, lower(name)
      limit ${BUYER_SUGGESTIONS}
    `),
  );
  return [
    ...onFile.map((choice): BuyerChoice => ({ kind: "customer", ...choice })),
    ...rows.rows.map(
      (row): BuyerChoice => ({
        kind: "buyer",
        id: `buyer:${row.name.toLowerCase()}|${row.phone ?? ""}`,
        name: row.name,
        phone: row.phone,
        address: row.address,
        detail: [`Bought ${formatDay(row.sold_on)}`, row.phone].filter(Boolean).join(" · "),
      }),
    ),
  ];
}

// --- Changing sales -----------------------------------------------------------

// What the form sends besides the sale: the customer on file it's for (or
// none), whether to add a buyer who isn't on file yet to Customers, and
// whether to add the unit to the customer's vehicles.
export type SaleInput = Record<keyof SaleFields, unknown> & {
  customerId?: unknown;
  addCustomer?: unknown;
  addVehicle?: unknown;
};

// "77 Foxglove Rd, Elmwood, PA 15999" -> its parts, as far as commas
// tell them apart; all of it on the first line when they don't.
export function splitAddress(address: string | null) {
  const empty = { addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "" };
  if (!address) return empty;
  const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { ...empty, addressLine1: address };
  const last = parts.at(-1)!;
  const stateZip = /^([A-Za-z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/.exec(last);
  if (stateZip && parts.length >= 3) {
    return { ...empty, addressLine1: parts.slice(0, -2).join(", "), city: parts.at(-2)!, state: stateZip[1].toUpperCase(), postalCode: stateZip[2] ?? "" };
  }
  if (stateZip) return { ...empty, addressLine1: parts[0], state: stateZip[1].toUpperCase(), postalCode: stateZip[2] ?? "" };
  return { ...empty, addressLine1: parts.slice(0, -1).join(", "), city: last };
}

// The customer a sale is for: one on file (checked to be the shop's), a
// new one added from the sale's details, or none.
async function customerFor(tx: ShopTransaction, actor: CurrentUser, sale: SaleFields, input: SaleInput): Promise<{ id: string | null } | { error: string }> {
  if (typeof input.customerId === "string" && input.customerId) {
    if (!isUuid(input.customerId)) return NO_CUSTOMER;
    const [found] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId));
    return found ? { id: found.id } : NO_CUSTOMER;
  }
  if (input.addCustomer !== true && input.addCustomer !== "on" && input.addCustomer !== "true") return { id: null };
  const checked = checkCustomer({ name: sale.customerName, phone: sale.customerPhone ?? "", email: "", ...splitAddress(sale.customerAddress), notes: "" });
  if ("error" in checked) return checked;
  const [made] = await tx
    .insert(customers)
    .values({ ...checked.customer, shopId: actor.shop.id, createdByUserId: actor.id })
    .returning({ id: customers.id });
  await tx.insert(auditLog).values({
    shopId: actor.shop.id,
    actorUserId: actor.id,
    action: "customer.created",
    targetType: "customer",
    targetId: made.id,
    details: { name: checked.customer.name, from: "NUSR" },
  });
  return { id: made.id };
}

// The unit on the customer's record as bought from the shop, unless it's
// there already (by its VIN): so Customers and Diagnose know it's theirs.
async function addBoughtVehicle(tx: ShopTransaction, actor: CurrentUser, customerId: string, sale: SaleFields) {
  if (!sale.vin || sale.vin.length !== 17) return;
  const [known] = await tx
    .select({ id: customerVehicles.id })
    .from(customerVehicles)
    .where(and(eq(customerVehicles.customerId, customerId), eq(customerVehicles.vin, sale.vin)));
  if (known) return;
  const vehicle = { relation: "bought" as const, relationDate: sale.soldOn, year: sale.unitYear, make: null, model: sale.unitModel, modelNumber: null, vin: sale.vin, color: null, notes: null };
  const [row] = await tx.insert(customerVehicles).values({ ...vehicle, customerId, shopId: actor.shop.id }).returning({ id: customerVehicles.id });
  await tx.insert(auditLog).values({
    shopId: actor.shop.id,
    actorUserId: actor.id,
    action: "vehicle.added",
    targetType: "customer_vehicle",
    targetId: row.id,
    details: { customerId, vehicle: vehicleLabel(vehicle), relation: "bought", from: "NUSR" },
  });
}

const wanted = (value: unknown) => value === true || value === "on" || value === "true";

// What the log says about a sale: enough to know it again, not every
// amount (an edit says which changed, and how).
const saleSummary = (sale: SaleFields) => ({
  customerName: sale.customerName,
  unit: unitLabel(sale),
  vin: sale.vin,
  soldOn: sale.soldOn,
  salesperson: sale.salesperson,
});

export async function logSale(actor: CurrentUser, input: SaleInput): Promise<{ id: string } | SaleProblem> {
  const checked = checkSale(input);
  if ("error" in checked) return checked;
  const sale = checked.sale;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const customer = await customerFor(tx, actor, sale, input);
      if ("error" in customer) return customer;
      const [row] = await tx
        .insert(unitSales)
        .values({ ...toColumns(sale), customerId: customer.id, shopId: actor.shop.id, createdByUserId: actor.id })
        .returning({ id: unitSales.id });
      if (customer.id && wanted(input.addVehicle)) await addBoughtVehicle(tx, actor, customer.id, sale);
      await audit(tx, actor, "unit_sale.logged", row.id, { ...saleSummary(sale), salesPrice: sale.salesPrice, customerId: customer.id });
      return { id: row.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return alreadyLogged(sale);
    throw error;
  }
}

// How an edit changed a sale, for the Activity log: each amount, rate,
// date and choice from what to what; the customer's contact details and
// the notes by name only.
function changesOf(before: SaleFields, after: SaleFields) {
  const changes: Record<string, { from: string | number | null; to: string | number | null }> = {};
  const fields: string[] = [];
  for (const key of Object.keys(SALE_LABELS) as (keyof SaleFields)[]) {
    if (before[key] === after[key]) continue;
    fields.push(key);
    if (key === "customerAddress" || key === "customerPhone" || key === "notes") continue;
    const show = (value: unknown) =>
      value === null || value === undefined
        ? null
        : (MONEY_FIELDS as readonly string[]).includes(key)
          ? formatMoney(value as number)
          : key === "holdbackRateBp" || key === "bonusRateBp"
            ? formatRate(value as number)
            : (value as string | number);
    changes[key] = { from: show(before[key]), to: show(after[key]) };
  }
  return { fields, changes };
}

export async function updateSale(actor: CurrentUser, id: string, input: SaleInput): Promise<{ ok: true } | SaleProblem> {
  if (!isUuid(id)) return NOT_HERE;
  const checked = checkSale(input);
  if ("error" in checked) return checked;
  const sale = checked.sale;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const [before] = await tx.select(saleColumns).from(unitSales).leftJoin(users, eq(users.id, unitSales.createdByUserId)).where(eq(unitSales.id, id)).for("update", { of: unitSales });
      if (!before) return NOT_HERE;
      const customer = await customerFor(tx, actor, sale, input);
      if ("error" in customer) return customer;
      const { fields, changes } = changesOf(before as SaleFields, sale);
      const relinked = before.customerId !== customer.id;
      if (fields.length === 0 && !relinked) return { ok: true as const };
      await tx.update(unitSales).set({ ...toColumns(sale), customerId: customer.id }).where(eq(unitSales.id, id));
      if (customer.id && wanted(input.addVehicle)) await addBoughtVehicle(tx, actor, customer.id, sale);
      await audit(tx, actor, "unit_sale.updated", id, {
        ...saleSummary(sale),
        fields: relinked ? [...fields, "customerId"] : fields,
        changes,
        ...(relinked ? { customerId: { from: before.customerId, to: customer.id } } : {}),
      });
      return { ok: true as const };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return alreadyLogged(sale);
    throw error;
  }
}

export const MAX_MARKED_PAID = 200;

// Marks new units paid off together, as one floorplan payment pays off
// several: the same Date Paid on each, and the payment's COMS # when it's
// given. Only new units of this shop not marked paid yet are changed; each
// is written to the Activity log as a correction, from what to what.
export async function markPaid(
  actor: CurrentUser,
  input: { ids: unknown; paidOn: unknown; comsNumber: unknown },
): Promise<{ marked: number; skipped: number } | { error: string; field?: "paidOn" | "comsNumber" }> {
  const ids = [...new Set(Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === "string" && isUuid(id)) : [])];
  if (ids.length === 0) return { error: "Tick the units the payment paid off." };
  if (ids.length > MAX_MARKED_PAID) return { error: `That's more than ${MAX_MARKED_PAID} units at once: mark them a page at a time.` };
  const paidOn = parseIsoDate(input.paidOn);
  if (!paidOn) return { error: "Enter the date they were paid off.", field: "paidOn" };
  const comsNumber = line(input.comsNumber);
  if (comsNumber.length > SALE_LIMITS.comsNumber) return { error: `${SALE_LABELS.comsNumber} is too long.`, field: "comsNumber" };
  return withShop(actor.shop.id, async (tx) => {
    const rows = await tx
      .select(saleColumns)
      .from(unitSales)
      .leftJoin(users, eq(users.id, unitSales.createdByUserId))
      .where(inArray(unitSales.id, ids))
      .orderBy(unitSales.soldOn, unitSales.id)
      .for("update", { of: unitSales });
    let marked = 0;
    for (const before of rows) {
      if (before.condition !== "new" || before.paidOn !== null) continue;
      const after: SaleFields = { ...(before as SaleFields), paidOn, comsNumber: comsNumber || before.comsNumber };
      const { fields, changes } = changesOf(before as SaleFields, after);
      await tx.update(unitSales).set({ paidOn: after.paidOn, comsNumber: after.comsNumber }).where(eq(unitSales.id, before.id));
      await audit(tx, actor, "unit_sale.updated", before.id, { ...saleSummary(after), fields, changes });
      marked++;
    }
    return { marked, skipped: ids.length - marked };
  });
}

// Removes a sale logged by mistake; the Activity log keeps what it was,
// and the sheet and row an import brought it in from, so importing the
// workbook again doesn't bring it back (importSales in nusr-import.ts).
export async function removeSale(actor: CurrentUser, id: string): Promise<{ ok: true; label: string } | { error: string }> {
  if (!isUuid(id)) return NOT_HERE;
  return withShop(actor.shop.id, async (tx) => {
    const [found] = await tx
      .select({ ...saleColumns, importRef: unitSales.importRef, importRow: unitSales.importRow })
      .from(unitSales)
      .leftJoin(users, eq(users.id, unitSales.createdByUserId))
      .where(eq(unitSales.id, id))
      .for("update", { of: unitSales });
    if (!found) return NOT_HERE;
    const { importRef, importRow, ...row } = found;
    // Where an import found it, even when that row was another sale's.
    const from = importRow ?? importRef;
    const sale = toSale(row);
    await tx.delete(unitSales).where(eq(unitSales.id, id));
    await audit(tx, actor, "unit_sale.removed", id, {
      ...saleSummary(sale),
      salesPrice: sale.salesPrice,
      totalProfit: sale.figures.totalProfit,
      customerId: sale.customerId,
      ...(from ? { importRef: from } : {}),
    });
    return { ok: true as const, label: `${unitLabel(sale)} to ${sale.customerName}` };
  });
}

// --- For the form ----------------------------------------------------------------

export type SaleCustomer = {
  id: string;
  name: string;
  phone: string | null;
  // On one line, as the NUSR keeps it.
  address: string | null;
  vehicles: { id: string; label: string; year: number | null; model: string | null; vin: string | null; relation: string }[];
};

// A customer's details and vehicles, to fill a sale in from.
export async function customerForSale(shopId: string, id: string): Promise<SaleCustomer | null> {
  if (!isUuid(id)) return null;
  return withShop(shopId, async (tx) => {
    const [customer] = await tx
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        addressLine1: customers.addressLine1,
        addressLine2: customers.addressLine2,
        city: customers.city,
        state: customers.state,
        postalCode: customers.postalCode,
      })
      .from(customers)
      .where(eq(customers.id, id));
    if (!customer) return null;
    const vehicles = await tx
      .select({
        id: customerVehicles.id,
        relation: customerVehicles.relation,
        year: customerVehicles.year,
        make: customerVehicles.make,
        model: customerVehicles.model,
        modelNumber: customerVehicles.modelNumber,
        vin: customerVehicles.vin,
      })
      .from(customerVehicles)
      .where(eq(customerVehicles.customerId, id))
      .orderBy(desc(customerVehicles.createdAt));
    const place = [customer.city, [customer.state, customer.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      address: [customer.addressLine1, customer.addressLine2, place].filter(Boolean).join(", ") || null,
      vehicles: vehicles.map((vehicle) => ({
        id: vehicle.id,
        label: vehicleLabel(vehicle),
        year: vehicle.year,
        model: [vehicle.make, vehicle.model].filter(Boolean).join(" ") || vehicle.modelNumber,
        vin: vehicle.vin,
        relation: vehicle.relation,
      })),
    };
  });
}

export type VinDecode = {
  vin: string;
  checkDigitOk: boolean;
  year: number | null;
  // The model as the shop's model list names it, when the VIN finds it.
  model: string | null;
  modelNumber: string | null;
  category: string | null;
  // The unit on a customer's record already (traded in, say), the latest.
  onFile: { label: string; year: number | null; model: string | null; customerName: string; relation: string } | null;
  // The unit in the NUSR already, the latest sale of it: a trade coming
  // back, or a sale logged twice.
  sold: {
    id: string;
    soldOn: string;
    condition: UnitCondition;
    unitType: UnitType;
    year: number | null;
    model: string | null;
    category: string | null;
    customerName: string;
  } | null;
  // The latest new whole good the shop sold of the same model and model
  // year (the VIN's characters 4-8 and 10): its model as the shop writes
  // it, and its prices to offer (they change, so they're offered, not
  // filled in).
  sameModel: {
    soldOn: string;
    model: string | null;
    category: string | null;
    msrp: number | null;
    dealerCost: number | null;
    rebate: number | null;
  } | null;
};

// What a VIN says about the unit: its model year (character 10); from the
// shop's model list (Polaris's, imported under System Admin > Manuals) its
// model, model number and category; and from the NUSR, an earlier sale of
// this unit (other than the one being corrected, exceptId) and the latest
// of its model and year. A trailer's or another brand's VIN gives the year
// only.
export async function decodeSaleVin(shopId: string, text: string, exceptId: string | null = null): Promise<VinDecode | null> {
  const check = checkVin(String(text ?? "").slice(0, 40));
  if (check.status !== "ok") return null;
  const except = exceptId && isUuid(exceptId) ? exceptId : null;
  const thisYear = new Date().getUTCFullYear();
  const years = vinYears(check.vin);
  const decoded: VinDecode = {
    vin: check.vin,
    checkDigitOk: check.checkDigitOk,
    year: years.find((year) => year <= thisYear + 1) ?? years.at(-1) ?? null,
    model: null,
    modelNumber: null,
    category: null,
    onFile: null,
    sold: null,
    sameModel: null,
  };
  const [sold, sameModel] = await withShop(shopId, async (tx) => {
    const [unit] = await tx
      .select({
        id: unitSales.id,
        soldOn: unitSales.soldOn,
        condition: unitSales.condition,
        unitType: unitSales.unitType,
        year: unitSales.unitYear,
        model: unitSales.unitModel,
        category: unitSales.category,
        customerName: unitSales.customerName,
      })
      .from(unitSales)
      .where(and(eq(unitSales.vin, check.vin), except ? sql`${unitSales.id} <> ${except}` : undefined))
      .orderBy(desc(unitSales.soldOn), desc(unitSales.createdAt))
      .limit(1);
    const [model] = await tx
      .select({
        soldOn: unitSales.soldOn,
        model: unitSales.unitModel,
        category: unitSales.category,
        msrp: unitSales.msrpCents,
        dealerCost: unitSales.dealerCostCents,
        rebate: unitSales.rebateCents,
      })
      .from(unitSales)
      .where(
        and(
          eq(unitSales.unitType, "whole_good"),
          sql`length(${unitSales.vin}) = 17`,
          sql`substr(${unitSales.vin}, 4, 5) = ${vinModelCode(check.vin)}`,
          sql`substr(${unitSales.vin}, 10, 1) = ${check.vin[9]}`,
          sql`${unitSales.vin} <> ${check.vin}`,
          sql`(${unitSales.unitModel} is not null or ${unitSales.msrpCents} is not null)`,
          except ? sql`${unitSales.id} <> ${except}` : undefined,
        ),
      )
      .orderBy(desc(unitSales.soldOn), desc(unitSales.createdAt))
      .limit(1);
    return [unit ?? null, model ?? null];
  });
  decoded.sold = sold;
  decoded.sameModel = sameModel;
  const [record] = await withShop(shopId, (tx) =>
    tx
      .select({
        year: customerVehicles.year,
        make: customerVehicles.make,
        model: customerVehicles.model,
        modelNumber: customerVehicles.modelNumber,
        vin: customerVehicles.vin,
        relation: customerVehicles.relation,
        customerName: customers.name,
      })
      .from(customerVehicles)
      .innerJoin(customers, eq(customers.id, customerVehicles.customerId))
      .where(eq(customerVehicles.vin, check.vin))
      .orderBy(desc(customerVehicles.createdAt))
      .limit(1),
  );
  if (record) {
    decoded.onFile = {
      label: vehicleLabel(record),
      year: record.year,
      model: [record.make, record.model].filter(Boolean).join(" ") || record.modelNumber,
      customerName: record.customerName,
      relation: record.relation,
    };
  }
  const found = await withShop(shopId, async (tx) => {
    for (const { year, pattern } of vinModelNumberPatterns(check.vin)) {
      const rows = await tx.execute<{ number: string; description: string | null; brand: string | null }>(sql`
        select cm.model_number as number, cm.model_description as description, d.brand from manual_catalog_models cm
        join manual_catalog_documents d on d.shop_id = cm.shop_id and d.file_key = cm.file_key
        where cm.model_number like ${pattern}
        order by cm.model_number
        limit 50
      `);
      if (rows.rows.length > 0) return { year, rows: rows.rows };
    }
    return null;
  });
  if (!found) return decoded;
  const numbers = [...new Set(found.rows.map((row) => row.number))];
  const brands = [...new Set(found.rows.map((row) => row.brand).filter((brand): brand is string => Boolean(brand)))];
  const vehicle = brands.length === 1 ? brandInfo(brands[0]) : null;
  return {
    ...decoded,
    year: found.year,
    model: sharedModelName(found.rows.map((row) => row.description)),
    modelNumber: numbers.length === 1 ? numbers[0] : null,
    category: brands.length === 1 && brands[0] === "RZR" ? "RZR" : vehicle && (vehicle.vehicle === "UTV" || vehicle.vehicle === "ATV") ? vehicle.vehicle : null,
  };
}

// How many sales are tied to these customers, for removing one.
export async function countSalesFor(tx: ShopTransaction, customerIds: string[]) {
  if (customerIds.length === 0) return 0;
  const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(unitSales).where(inArray(unitSales.customerId, customerIds));
  return count;
}
