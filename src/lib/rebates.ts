import "server-only";

import { DrizzleQueryError, and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";

import { withShop } from "@/db";
import { auditLog, rebateInvoices, rebateLines, unitSales, users } from "@/db/schema";
import { containsPattern, listPage, listSearchWords, type ListPage } from "@/lib/diagnose-list-rules";
import { isUuid } from "@/lib/diagnose-rules";
import { attachmentHeader } from "@/lib/nusr-export";
import { findSales } from "@/lib/nusr";
import { MAX_AMOUNT_CENTS, SHOP_TIME_ZONE, atRate, parseIsoDate, unitLabel, type Cents, type SaleFilters } from "@/lib/nusr-rules";
import { allows } from "@/lib/permissions";
import { invoicesTitle, rebateWorkbook, type RebateInvoice, type RebateLine } from "@/lib/rebate-export";
import {
  MATCH_HOWS,
  REBATE_COLUMNS,
  REBATE_COLUMN_LABELS,
  isRebateColumn,
  matchItems,
  parseRebateFilters,
  rebateFiltersTitle,
  rebatesFileName,
  savedRebatesFileName,
  type ItemMatch,
  type MatchHow,
  type MatchItem,
  type RebateColumn,
  type RebateFilters,
} from "@/lib/rebate-rules";
import type { CurrentUser } from "@/lib/session";
import { writeXlsx } from "@/lib/xlsx-write";

// Rebates (the Rebates tab): finding the units on a Polaris rebate invoice
// in the shop's NUSR, the workbook with each one's rebate in AO, AP or AQ
// (src/lib/rebate-rules.ts has the rules), and the invoices saved as
// checked (Saved rebates: saving one, listing them by the filters, opening
// one again, removing one, and their workbook). The invoice is read in the
// manager's browser. Looking up and the downloads change nothing; saving
// and removing an invoice go in the Activity log. Each checks the acting
// user may open the NUSR (sales.log: a manager or admin signed in with a
// password) and keeps to their shop.

// What the page is shown of a sale a line may be.
export type RebateSaleSummary = {
  id: string;
  soldOn: string;
  customerName: string;
  salesperson: string | null;
  unit: string;
  vin: string | null;
  category: string | null;
  condition: "new" | "used";
  // The NUSR's holdback on it (MSRP x its rate), for AO.
  holdback: Cents;
};

export type RebateLookup = { matches: ItemMatch[]; sales: RebateSaleSummary[] };

type Problem = { error: string };

const notAllowed: Problem = { error: "Only a manager or admin signed in with a password can use Rebates." };
const badLines: Problem = { error: "That invoice's lines couldn't be read. Drop the invoice again." };

// The most one invoice lookup, or one download, takes: far more than a
// rebate invoice has.
export const MAX_REBATE_LINES = 2000;
export const MAX_REBATE_INVOICES = 20;
// Sales a search offers.
const SEARCH_LIMIT = 10;

const summaryColumns = {
  id: unitSales.id,
  soldOn: unitSales.soldOn,
  customerName: unitSales.customerName,
  salesperson: unitSales.salesperson,
  unitYear: unitSales.unitYear,
  unitModel: unitSales.unitModel,
  vin: unitSales.vin,
  category: unitSales.category,
  condition: unitSales.condition,
  msrp: unitSales.msrpCents,
  holdbackRateBp: unitSales.holdbackRateBp,
};

function summary(row: {
  id: string;
  soldOn: string;
  customerName: string;
  salesperson: string | null;
  unitYear: number | null;
  unitModel: string | null;
  vin: string | null;
  category: string | null;
  condition: "new" | "used";
  msrp: Cents | null;
  holdbackRateBp: number;
}): RebateSaleSummary {
  return {
    id: row.id,
    soldOn: row.soldOn,
    customerName: row.customerName,
    salesperson: row.salesperson,
    unit: unitLabel(row),
    vin: row.vin,
    category: row.category,
    condition: row.condition,
    holdback: row.msrp === null ? 0 : atRate(row.msrp, row.holdbackRateBp),
  };
}

// Up to `most` strings of a list, each at most `length` long.
function strings(value: unknown, most: number, length: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, most)
    .map((item) => item.replace(/\u0000/g, "").slice(0, length));
}

// The invoice's units as the browser sends them to be found.
function checkItems(input: unknown): MatchItem[] | Problem {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_REBATE_LINES) return badLines;
  const items: MatchItem[] = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) return badLines;
    const { key, vinRead, names, purchased } = entry as Record<string, unknown>;
    if (typeof key !== "string" || key.length === 0 || key.length > 40) return badLines;
    if (typeof vinRead !== "string" || vinRead.length > 30) return badLines;
    items.push({
      key,
      vinRead: vinRead.toUpperCase().replace(/[^A-Z0-9?]/g, "?"),
      names: strings(names, 6, 120),
      purchased: strings(purchased, 6, 10).filter((day) => parseIsoDate(day) !== null),
    });
  }
  return items;
}

// Each unit on an invoice found in the shop's NUSR (matchItems), with what
// the page shows of every sale it found or offers.
export async function findRebateSales(actor: CurrentUser, input: unknown): Promise<RebateLookup | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  const items = checkItems(input);
  if ("error" in items) return items;
  return withShop(actor.shop.id, async (tx) => {
    const units = await tx
      .select({ id: unitSales.id, soldOn: unitSales.soldOn, customerName: unitSales.customerName, vin: unitSales.vin, condition: unitSales.condition })
      .from(unitSales);
    const matches = matchItems(items, units);
    const ids = [...new Set(matches.flatMap((match) => match.candidates))];
    const rows = ids.length ? await tx.select(summaryColumns).from(unitSales).where(inArray(unitSales.id, ids)) : [];
    return { matches, sales: rows.map(summary) };
  });
}

// Sales to pick from for a line that wasn't found: a search as the NUSR's
// own box searches (every word somewhere in the customer's name, phone or
// address, the unit, VIN, salesman and the rest), the newest first.
export async function searchRebateSales(actor: CurrentUser, query: unknown): Promise<{ sales: RebateSaleSummary[] } | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  const text = typeof query === "string" ? query.replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, 100) : "";
  if (text.length < 2) return { sales: [] };
  const filters: SaleFilters = { year: null, month: null, condition: null, unitType: null, category: null, salesperson: null, status: null, query: text };
  const found = (await findSales(actor.shop.id, filters)).slice(0, SEARCH_LIMIT);
  return { sales: found.map(summary) };
}

// --- What the page sends -----------------------------------------------------

const cents = (value: unknown): Cents | null =>
  typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= MAX_AMOUNT_CENTS ? value : null;
const short = (value: unknown, length: number) => (typeof value === "string" ? value.replace(/\u0000/g, "").slice(0, length) || null : null);

// A line as the page sends it, checked: what the download needs, and what
// saving keeps besides (its page, purchase dates read, other lines, the
// amount as read and how sure, and how its sale was found).
type CheckedLine = RebateLine & { page: number; purchased: string[]; other: string[]; amountText: string; amountSure: boolean; how: MatchHow };
type CheckedInvoice = Omit<RebateInvoice, "lines"> & { pages: number; lines: CheckedLine[] };

function checkLine(item: unknown): CheckedLine | null {
  if (typeof item !== "object" || item === null) return null;
  const line = item as Record<string, unknown>;
  if (!Number.isSafeInteger(line.line) || (line.line as number) < 1 || (line.line as number) > 100_000) return null;
  if (typeof line.vinRead !== "string" || !line.vinRead.trim()) return null;
  const page = Number.isSafeInteger(line.page) && (line.page as number) >= 0 && (line.page as number) <= 1000 ? (line.page as number) : 0;
  return {
    line: line.line as number,
    page,
    part: short(line.part, 10),
    vinRead: line.vinRead.replace(/\u0000/g, "").slice(0, 30),
    modelCode: short(line.modelCode, 30),
    programs: strings(line.programs, 6, 120),
    dates: strings(line.dates, 6, 120),
    purchased: strings(line.purchased, 6, 10).filter((day) => parseIsoDate(day) !== null),
    names: strings(line.names, 6, 120),
    other: strings(line.other, 6, 120),
    unitPrice: cents(line.unitPrice),
    amount: cents(line.amount),
    amountText: short(line.amountText, 60) ?? "",
    amountSure: line.amountSure !== false,
    saleId: isUuid(line.saleId) ? line.saleId : null,
    how: (MATCH_HOWS as readonly unknown[]).includes(line.how) ? (line.how as MatchHow) : null,
  };
}

function checkInvoice(entry: unknown): CheckedInvoice | null {
  if (typeof entry !== "object" || entry === null) return null;
  const invoice = entry as Record<string, unknown>;
  if (!isRebateColumn(invoice.column) || !Array.isArray(invoice.lines) || invoice.lines.length > MAX_REBATE_LINES) return null;
  const lines: CheckedLine[] = [];
  for (const item of invoice.lines) {
    const line = checkLine(item);
    if (!line) return null;
    lines.push(line);
  }
  // A line's place is its own.
  if (new Set(lines.map((line) => line.line)).size !== lines.length) return null;
  return {
    fileName: short(invoice.fileName, 200) ?? "Invoice",
    number: short(invoice.number, 20),
    type: short(invoice.type, 30),
    date: typeof invoice.date === "string" ? parseIsoDate(invoice.date) : null,
    total: cents(invoice.total),
    column: invoice.column,
    pages: Number.isSafeInteger(invoice.pages) && (invoice.pages as number) >= 0 && (invoice.pages as number) <= 1000 ? (invoice.pages as number) : 0,
    lines,
  };
}

// The invoices as the page sends them for the download, checked.
function checkInvoices(input: unknown): CheckedInvoice[] | Problem {
  const list = (input as { invoices?: unknown } | null)?.invoices;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_REBATE_INVOICES) return badLines;
  const invoices: CheckedInvoice[] = [];
  let total = 0;
  for (const entry of list) {
    const invoice = checkInvoice(entry);
    if (!invoice) return badLines;
    total += invoice.lines.length;
    if (total > MAX_REBATE_LINES) return badLines;
    invoices.push(invoice);
  }
  return invoices;
}

// A time zone the browser named, if it's a real one; else the shop's.
function timeZoneOf(value: unknown) {
  try {
    if (typeof value === "string" && value) return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    // Not a time zone: the shop's.
  }
  return SHOP_TIME_ZONE;
}

type Download = { bytes: Uint8Array<ArrayBuffer>; fileName: string; contentDisposition: string };

// The workbook for invoices: the NUSR sheet with the rebates in AO, AP and
// AQ (every sale of the years their units were sold in) and the Rebates
// sheet. A sale that isn't this shop's (or was removed since) counts as
// not found.
async function workbookFor(shopId: string, invoices: readonly RebateInvoice[], now: Date, timeZone: string, title: string) {
  const ids = [...new Set(invoices.flatMap((invoice) => invoice.lines.flatMap((line) => (line.saleId ? [line.saleId] : []))))];
  const years = ids.length
    ? await withShop(shopId, (tx) =>
        tx
          .selectDistinct({ year: sql<number>`extract(year from ${unitSales.soldOn})::int` })
          .from(unitSales)
          .where(inArray(unitSales.id, ids)),
      )
    : [];
  const filters = (year: number): SaleFilters => ({ year, month: null, condition: null, unitType: null, category: null, salesperson: null, status: null, query: "" });
  const sales = (await Promise.all(years.map(({ year }) => findSales(shopId, filters(year), "oldest")))).flat();
  const known = new Set(sales.map((sale) => sale.id));
  const found = invoices.map((invoice) => ({ ...invoice, lines: invoice.lines.map((line) => (line.saleId && !known.has(line.saleId) ? { ...line, saleId: null } : line)) }));
  const bytes = writeXlsx(rebateWorkbook(found, sales, { generatedAt: now, timeZone }), { title, created: now });
  return { bytes, found };
}

const dayIn = (timeZone: string, now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

// The download of invoices on the page, named for them and the day.
export async function rebateDownload(actor: CurrentUser, input: unknown, now = new Date()): Promise<Download | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  const invoices = checkInvoices(input);
  if ("error" in invoices) return invoices;
  const timeZone = timeZoneOf((input as { timeZone?: unknown }).timeZone);
  const { bytes, found } = await workbookFor(actor.shop.id, invoices, now, timeZone, `Rebates ${invoicesTitle(invoices)}`);
  const fileName = rebatesFileName(
    found.map((invoice) => invoice.number),
    dayIn(timeZone, now),
  );
  return { bytes, fileName, contentDisposition: attachmentHeader(fileName) };
}

// --- Saved rebates ---------------------------------------------------------------

const notSaved: Problem = { error: "That invoice isn't saved in this shop's Rebates." };

// What saving says: saved (or saved in place of the one saved before), or
// that the invoice number is saved already, by whom and when, to save it in
// its place if that's meant.
export type SaveResult =
  | { saved: { id: string; replaced: boolean } }
  | { exists: { id: string; savedAt: string; savedBy: string | null; lines: number } }
  | Problem;

const isUniqueViolation = (error: unknown) => ((error instanceof DrizzleQueryError ? error.cause : error) as { code?: string } | undefined)?.code === "23505";

// The facts an invoice's Activity log entry keeps.
const invoiceFacts = (invoice: Pick<CheckedInvoice, "number" | "date" | "column" | "fileName">, lines: readonly Pick<CheckedLine, "amount" | "saleId">[]) => ({
  number: invoice.number,
  invoiceDate: invoice.date,
  lines: lines.length,
  found: lines.filter((line) => line.saleId).length,
  amount: lines.reduce((sum, line) => sum + (line.amount ?? 0), 0),
  column: REBATE_COLUMN_LABELS[invoice.column],
  fileName: invoice.fileName,
});

// Saves an invoice as read and checked on the page, with its lines and the
// sale each was found as (one that isn't this shop's is saved as not
// found). An invoice saved already (`savedId`, the one opened on the page,
// or else the one with its number) is only saved again, in place of the
// one before (its lines replaced), when `replace` says so.
export async function saveRebateInvoice(actor: CurrentUser, input: unknown): Promise<SaveResult> {
  if (!allows(actor, "sales.log")) return notAllowed;
  const invoice = checkInvoice((input as { invoice?: unknown } | null)?.invoice);
  if (!invoice) return badLines;
  const replace = (input as { replace?: unknown }).replace === true;
  const savedId = (input as { savedId?: unknown }).savedId;
  try {
    return await withShop(actor.shop.id, async (tx): Promise<SaveResult> => {
      const ids = [...new Set(invoice.lines.flatMap((line) => (line.saleId ? [line.saleId] : [])))];
      const known = new Set(ids.length ? (await tx.select({ id: unitSales.id }).from(unitSales).where(inArray(unitSales.id, ids))).map((row) => row.id) : []);
      const lines = invoice.lines.map((line) => (line.saleId && !known.has(line.saleId) ? { ...line, saleId: null, how: null } : line));
      const saved = (where: SQL) =>
        tx
          .select({ id: rebateInvoices.id, savedAt: rebateInvoices.updatedAt, savedBy: users.name })
          .from(rebateInvoices)
          .leftJoin(users, eq(users.id, rebateInvoices.savedByUserId))
          .where(where)
          .for("update", { of: rebateInvoices });
      // The one opened, unless it was removed meanwhile; else its number's.
      let [before] = isUuid(savedId) ? await saved(eq(rebateInvoices.id, savedId)) : [];
      if (!before && invoice.number) [before] = await saved(eq(rebateInvoices.number, invoice.number));
      if (before && !replace) {
        const [{ lines: count }] = await tx.select({ lines: sql<number>`count(*)::int` }).from(rebateLines).where(eq(rebateLines.invoiceId, before.id));
        return { exists: { id: before.id, savedAt: before.savedAt.toISOString(), savedBy: before.savedBy, lines: count } };
      }
      const details = {
        number: invoice.number,
        invoiceType: invoice.type,
        invoiceDate: invoice.date,
        totalCents: invoice.total === null ? null : Math.abs(invoice.total),
        rebateColumn: invoice.column,
        fileName: invoice.fileName,
        pages: invoice.pages,
        savedByUserId: actor.id,
      };
      let id: string;
      if (before) {
        await tx.update(rebateInvoices).set(details).where(eq(rebateInvoices.id, before.id));
        await tx.delete(rebateLines).where(eq(rebateLines.invoiceId, before.id));
        id = before.id;
      } else {
        [{ id }] = await tx
          .insert(rebateInvoices)
          .values({ shopId: actor.shop.id, ...details })
          .returning({ id: rebateInvoices.id });
      }
      if (lines.length) {
        await tx.insert(rebateLines).values(
          lines.map((line) => ({
            shopId: actor.shop.id,
            invoiceId: id,
            line: line.line,
            page: line.page,
            part: line.part,
            vinRead: line.vinRead,
            modelCode: line.modelCode,
            programs: line.programs,
            dates: line.dates,
            purchased: line.purchased,
            names: line.names,
            other: line.other,
            unitPriceCents: line.unitPrice,
            amountCents: line.amount,
            amountText: line.amountText,
            amountSure: line.amountSure,
            saleId: line.saleId,
            matchHow: line.saleId ? line.how : null,
          })),
        );
      }
      await tx.insert(auditLog).values({
        shopId: actor.shop.id,
        actorUserId: actor.id,
        action: before ? "rebate_invoice.replaced" : "rebate_invoice.saved",
        targetType: "rebate_invoice",
        targetId: id,
        details: invoiceFacts(invoice, lines),
      });
      return { saved: { id, replaced: Boolean(before) } };
    });
  } catch (error) {
    // The same invoice saved at the same moment elsewhere: it's there now.
    if (isUniqueViolation(error)) return { error: "That invoice was saved meanwhile, in another tab or by someone else. Save it again to save this in its place." };
    throw error;
  }
}

// A saved invoice, for its list: its lines, how many were found and what
// they came to, and of those the lines the filters find (all of them
// unless a filter or search is about the lines).
export type SavedInvoice = {
  id: string;
  number: string | null;
  type: string | null;
  // Its date, and the day it counts on (its date, or the day it was first
  // saved when no date was read).
  date: string | null;
  day: string;
  column: RebateColumn;
  fileName: string;
  pages: number;
  total: Cents | null;
  lines: number;
  found: number;
  amount: Cents;
  shown: number;
  shownAmount: Cents;
  savedBy: string | null;
  savedAt: Date;
};

// The day an invoice counts on, for the filters and the order: its date,
// or the day it was first saved when no date was read from it.
const invoiceDay = sql<string>`coalesce(${rebateInvoices.invoiceDate}, (${rebateInvoices.createdAt} at time zone ${SHOP_TIME_ZONE})::date)`;

const inYearAndMonth = (filters: Pick<RebateFilters, "year" | "month">) => {
  if (filters.year === null) return undefined;
  const from = filters.month === null ? `${filters.year}-01-01` : `${filters.year}-${String(filters.month).padStart(2, "0")}-01`;
  const to =
    filters.month === null ? `${filters.year + 1}-01-01` : filters.month === 12 ? `${filters.year + 1}-01-01` : `${filters.year}-${String(filters.month + 1).padStart(2, "0")}-01`;
  return and(gte(invoiceDay, from), lt(invoiceDay, to));
};

// The saved invoices of the filters' year and month and column, the
// newest first; when a filter or search is about the lines, only those
// with lines it finds.
export async function listSavedInvoices(actor: CurrentUser, filters: RebateFilters): Promise<SavedInvoice[] | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  const lines = lineWhere(filters);
  const shown = lines ? sql<number>`(count(${rebateLines.id}) filter (where ${lines}))::int` : sql<number>`count(${rebateLines.id})::int`;
  const shownAmount = lines
    ? sql<number>`coalesce(sum(${rebateLines.amountCents}) filter (where ${lines}), 0)::int`
    : sql<number>`coalesce(sum(${rebateLines.amountCents}), 0)::int`;
  return withShop(actor.shop.id, (tx) =>
    tx
      .select({
        id: rebateInvoices.id,
        number: rebateInvoices.number,
        type: rebateInvoices.invoiceType,
        date: rebateInvoices.invoiceDate,
        day: invoiceDay,
        column: rebateInvoices.rebateColumn,
        fileName: rebateInvoices.fileName,
        pages: rebateInvoices.pages,
        total: rebateInvoices.totalCents,
        lines: sql<number>`count(${rebateLines.id})::int`,
        found: sql<number>`count(${rebateLines.saleId})::int`,
        amount: sql<number>`coalesce(sum(${rebateLines.amountCents}), 0)::int`,
        shown,
        shownAmount,
        savedBy: users.name,
        savedAt: rebateInvoices.updatedAt,
      })
      .from(rebateInvoices)
      .leftJoin(rebateLines, eq(rebateLines.invoiceId, rebateInvoices.id))
      .leftJoin(unitSales, eq(unitSales.id, rebateLines.saleId))
      .leftJoin(users, eq(users.id, rebateInvoices.savedByUserId))
      .where(invoiceWhere(filters))
      .groupBy(rebateInvoices.id, users.name)
      .having(lines ? sql`count(${rebateLines.id}) filter (where ${lines}) > 0` : undefined)
      .orderBy(desc(invoiceDay), desc(rebateInvoices.createdAt)),
  );
}

// A saved line, with its invoice and the sale it was found as.
export type SavedRebateLine = {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  column: RebateColumn;
  line: number;
  vinRead: string;
  names: string[];
  amount: Cents | null;
  sale: RebateSaleSummary | null;
};

// What the filters find, added up: lines, how many were found, the
// amounts in each column, and by salesman and by category.
export type SavedTotals = {
  lines: number;
  found: number;
  amounts: Record<RebateColumn, Cents>;
  bySalesman: { label: string; lines: number; amount: Cents }[];
  byCategory: { label: string; lines: number; amount: Cents }[];
  // Each invoice's lines the filters find, by salesman, for its line in
  // the list of invoices.
  bySalesmanOf: Record<string, { label: string; lines: number; amount: Cents }[]>;
};

export type SavedRebates = ListPage & { items: SavedRebateLine[]; total: number; totals: SavedTotals };

export const SAVED_PAGE_SIZE = 50;
const MAX_SAVED_LINES = 20_000;

// The filters about the invoice (its year and month, and column), and those
// about its lines (the salesman and category of the sale each was found
// as, whether it was found, and the search: by the VIN and names read, the
// invoice number, and the sale's customer, VIN, salesman, model and
// category). The lines' need the sale joined.
const invoiceWhere = (filters: RebateFilters) => and(inYearAndMonth(filters), filters.column ? eq(rebateInvoices.rebateColumn, filters.column) : undefined);

function lineWhere(filters: RebateFilters) {
  const words = listSearchWords(filters.query);
  const text = sql`concat_ws(' ', ${rebateLines.vinRead}, array_to_string(${rebateLines.names}, ' '), ${rebateInvoices.number}, ${unitSales.customerName},
    ${unitSales.vin}, ${unitSales.salesperson}, ${unitSales.unitModel}, ${unitSales.category})`;
  return and(
    filters.salesperson ? sql`lower(${unitSales.salesperson}) = lower(${filters.salesperson})` : undefined,
    filters.category ? sql`lower(${unitSales.category}) = lower(${filters.category})` : undefined,
    filters.status === "found" ? sql`${rebateLines.saleId} is not null` : filters.status === "missing" ? isNull(rebateLines.saleId) : undefined,
    words.length ? sql`${text} ilike all (array[${sql.join(words.map((word) => sql`${containsPattern(word)}`), sql`, `)}]::text[])` : undefined,
  );
}

const lineColumns = {
  id: rebateLines.id,
  invoiceId: rebateLines.invoiceId,
  invoiceNumber: rebateInvoices.number,
  invoiceDate: rebateInvoices.invoiceDate,
  column: rebateInvoices.rebateColumn,
  line: rebateLines.line,
  page: rebateLines.page,
  part: rebateLines.part,
  vinRead: rebateLines.vinRead,
  modelCode: rebateLines.modelCode,
  programs: rebateLines.programs,
  dates: rebateLines.dates,
  purchased: rebateLines.purchased,
  names: rebateLines.names,
  other: rebateLines.other,
  unitPrice: rebateLines.unitPriceCents,
  amount: rebateLines.amountCents,
  amountText: rebateLines.amountText,
  amountSure: rebateLines.amountSure,
  how: rebateLines.matchHow,
  saleId: rebateLines.saleId,
  sale: {
    id: unitSales.id,
    soldOn: unitSales.soldOn,
    customerName: unitSales.customerName,
    salesperson: unitSales.salesperson,
    unitYear: unitSales.unitYear,
    unitModel: unitSales.unitModel,
    vin: unitSales.vin,
    category: unitSales.category,
    condition: unitSales.condition,
    msrp: unitSales.msrpCents,
    holdbackRateBp: unitSales.holdbackRateBp,
  },
};

type LineRow = Awaited<ReturnType<typeof savedLines>>[number];

// Every saved line the filters find, the newest invoice first, each in its
// invoice's order.
async function savedLines(shopId: string, filters: RebateFilters, invoiceId?: string) {
  return withShop(shopId, (tx) =>
    tx
      .select(lineColumns)
      .from(rebateLines)
      .innerJoin(rebateInvoices, eq(rebateInvoices.id, rebateLines.invoiceId))
      .leftJoin(unitSales, eq(unitSales.id, rebateLines.saleId))
      .where(invoiceId ? eq(rebateLines.invoiceId, invoiceId) : and(invoiceWhere(filters), lineWhere(filters)))
      .orderBy(desc(invoiceDay), desc(rebateInvoices.createdAt), asc(rebateLines.line))
      .limit(MAX_SAVED_LINES),
  );
}

const lineSale = (row: LineRow): RebateSaleSummary | null => (row.sale?.id ? summary({ ...row.sale, id: row.sale.id, soldOn: row.sale.soldOn!, customerName: row.sale.customerName!, condition: row.sale.condition!, holdbackRateBp: row.sale.holdbackRateBp ?? 0 }) : null);

// Groups by a name however it's capitalised, under the spelling met first.
function groupBy(rows: readonly LineRow[], nameOf: (row: LineRow) => string) {
  const groups = new Map<string, { label: string; lines: number; amount: Cents }>();
  for (const row of rows) {
    const label = nameOf(row);
    const key = label.toLowerCase();
    const group = groups.get(key) ?? { label, lines: 0, amount: 0 };
    group.lines += 1;
    group.amount += row.amount ?? 0;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
}

const salesmanOf = (row: LineRow) => (row.saleId ? row.sale?.salesperson?.trim() || "No salesman" : "Not found");

// The saved lines the filters find, a page of them, with their totals.
export async function listSavedRebates(actor: CurrentUser, filters: RebateFilters, { page = 1, perPage = SAVED_PAGE_SIZE } = {}): Promise<SavedRebates | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  const rows = await savedLines(actor.shop.id, filters);
  const at = listPage(rows.length, page, perPage);
  const amounts = Object.fromEntries(REBATE_COLUMNS.map((column) => [column, 0])) as Record<RebateColumn, Cents>;
  for (const row of rows) amounts[row.column] += row.amount ?? 0;
  return {
    ...at,
    total: rows.length,
    items: rows.slice(at.offset, at.offset + perPage).map((row) => ({
      id: row.id,
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNumber,
      invoiceDate: row.invoiceDate,
      column: row.column,
      line: row.line,
      vinRead: row.vinRead,
      names: row.names,
      amount: row.amount,
      sale: lineSale(row),
    })),
    totals: {
      lines: rows.length,
      found: rows.filter((row) => row.saleId).length,
      amounts,
      bySalesman: groupBy(rows, salesmanOf),
      byCategory: groupBy(rows, (row) => (row.saleId ? row.sale?.category?.trim() || "No category" : "Not found")),
      bySalesmanOf: Object.fromEntries(
        [...Map.groupBy(rows, (row) => row.invoiceId)].map(([invoiceId, lines]) => [invoiceId, groupBy(lines, salesmanOf)]),
      ),
    },
  };
}

// A saved invoice with every line as it was saved, and what the page shows
// of each sale, to open it on the page again.
export type OpenedInvoice = {
  id: string;
  invoice: { number: string | null; type: string | null; date: string | null; total: Cents | null; column: RebateColumn; fileName: string; pages: number };
  lines: (CheckedLine & { programs: string[] })[];
  sales: RebateSaleSummary[];
};

export async function openSavedInvoice(actor: CurrentUser, id: unknown): Promise<OpenedInvoice | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  if (!isUuid(id)) return notSaved;
  const [invoice] = await withShop(actor.shop.id, (tx) => tx.select().from(rebateInvoices).where(eq(rebateInvoices.id, id)));
  if (!invoice) return notSaved;
  const rows = await savedLines(actor.shop.id, parseRebateFilters({}, 2000), id);
  const sales = new Map<string, RebateSaleSummary>();
  for (const row of rows) {
    const sale = lineSale(row);
    if (sale) sales.set(sale.id, sale);
  }
  return {
    id: invoice.id,
    invoice: {
      number: invoice.number,
      type: invoice.invoiceType,
      date: invoice.invoiceDate,
      total: invoice.totalCents,
      column: invoice.rebateColumn,
      fileName: invoice.fileName,
      pages: invoice.pages,
    },
    lines: rows.map((row) => ({
      line: row.line,
      page: row.page,
      part: row.part,
      vinRead: row.vinRead,
      modelCode: row.modelCode,
      programs: row.programs,
      dates: row.dates,
      purchased: row.purchased,
      names: row.names,
      other: row.other,
      unitPrice: row.unitPrice,
      amount: row.amount,
      amountText: row.amountText,
      amountSure: row.amountSure,
      saleId: row.saleId,
      how: row.how,
    })),
    sales: [...sales.values()],
  };
}

// Removes a saved invoice and its lines, writing what it was to the
// Activity log.
export async function removeSavedInvoice(actor: CurrentUser, id: unknown): Promise<{ ok: true; number: string | null } | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  if (!isUuid(id)) return notSaved;
  return withShop(actor.shop.id, async (tx) => {
    const [invoice] = await tx.select().from(rebateInvoices).where(eq(rebateInvoices.id, id)).for("update");
    if (!invoice) return notSaved;
    const lines = await tx.select({ amount: rebateLines.amountCents, saleId: rebateLines.saleId }).from(rebateLines).where(eq(rebateLines.invoiceId, id));
    await tx.delete(rebateInvoices).where(eq(rebateInvoices.id, id));
    await tx.insert(auditLog).values({
      shopId: actor.shop.id,
      actorUserId: actor.id,
      action: "rebate_invoice.removed",
      targetType: "rebate_invoice",
      targetId: id,
      details: invoiceFacts(
        { number: invoice.number, date: invoice.invoiceDate, column: invoice.rebateColumn, fileName: invoice.fileName },
        lines.map((line) => ({ amount: line.amount, saleId: line.saleId })),
      ),
    });
    return { ok: true as const, number: invoice.number };
  });
}

// The saved rebates the filters find, as the workbook the page's download
// makes for invoices: each invoice with its lines the filters find.
export async function savedRebatesDownload(actor: CurrentUser, filters: RebateFilters, now = new Date()): Promise<Download | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  const rows = await savedLines(actor.shop.id, filters);
  const invoices = new Map<string, RebateInvoice>();
  const opened = rows.length ? await withShop(actor.shop.id, (tx) => tx.select().from(rebateInvoices).where(inArray(rebateInvoices.id, [...new Set(rows.map((row) => row.invoiceId))]))) : [];
  const byId = new Map(opened.map((invoice) => [invoice.id, invoice]));
  for (const row of rows) {
    const saved = byId.get(row.invoiceId)!;
    const invoice = invoices.get(row.invoiceId) ?? {
      fileName: saved.fileName,
      number: saved.number,
      type: saved.invoiceType,
      date: saved.invoiceDate,
      total: saved.totalCents,
      column: saved.rebateColumn,
      lines: [],
    };
    invoice.lines.push({
      line: row.line,
      part: row.part,
      vinRead: row.vinRead,
      modelCode: row.modelCode,
      programs: row.programs,
      dates: row.dates,
      names: row.names,
      unitPrice: row.unitPrice,
      amount: row.amount,
      saleId: row.saleId,
    });
    invoices.set(row.invoiceId, invoice);
  }
  const title = rebateFiltersTitle(filters);
  const { bytes } = await workbookFor(actor.shop.id, [...invoices.values()], now, SHOP_TIME_ZONE, `Rebates ${title}`);
  const fileName = savedRebatesFileName(title, dayIn(SHOP_TIME_ZONE, now));
  return { bytes, fileName, contentDisposition: attachmentHeader(fileName) };
}

// The years with saved invoices, the newest first, for the year filter.
export async function savedInvoiceYears(actor: CurrentUser): Promise<number[]> {
  if (!allows(actor, "sales.log")) return [];
  const rows = await withShop(actor.shop.id, (tx) => tx.selectDistinct({ year: sql<number>`extract(year from ${invoiceDay})::int` }).from(rebateInvoices));
  return rows.map((row) => row.year).sort((a, b) => b - a);
}
