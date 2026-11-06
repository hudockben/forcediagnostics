import "server-only";

import { inArray, sql } from "drizzle-orm";

import { withShop } from "@/db";
import { unitSales } from "@/db/schema";
import { isUuid } from "@/lib/diagnose-rules";
import { attachmentHeader } from "@/lib/nusr-export";
import { findSales } from "@/lib/nusr";
import { MAX_AMOUNT_CENTS, atRate, parseIsoDate, unitLabel, type Cents, type SaleFilters } from "@/lib/nusr-rules";
import { allows } from "@/lib/permissions";
import { invoicesTitle, rebateWorkbook, type RebateInvoice, type RebateLine } from "@/lib/rebate-export";
import { isRebateColumn, matchItems, rebatesFileName, type ItemMatch, type MatchItem } from "@/lib/rebate-rules";
import type { CurrentUser } from "@/lib/session";
import { writeXlsx } from "@/lib/xlsx-write";

// Rebates (the Rebates tab): finding the units on a Polaris rebate invoice
// in the shop's NUSR, and the workbook with each one's rebate in AO, AP or
// AQ (src/lib/rebate-rules.ts has the rules). The invoice is read in the
// manager's browser; these only look things up and write the download,
// changing nothing, so nothing goes in the Activity log. Each checks the
// acting user may open the NUSR (sales.log: a manager or admin signed in
// with a password) and keeps to their shop.

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

// --- The download -------------------------------------------------------------

const cents = (value: unknown): Cents | null =>
  typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= MAX_AMOUNT_CENTS ? value : null;
const short = (value: unknown, length: number) => (typeof value === "string" ? value.replace(/\u0000/g, "").slice(0, length) || null : null);

// The invoices as the page sends them for the download, checked.
function checkInvoices(input: unknown): RebateInvoice[] | Problem {
  const list = (input as { invoices?: unknown } | null)?.invoices;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_REBATE_INVOICES) return badLines;
  let total = 0;
  const invoices: RebateInvoice[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) return badLines;
    const invoice = entry as Record<string, unknown>;
    if (!isRebateColumn(invoice.column) || !Array.isArray(invoice.lines)) return badLines;
    total += invoice.lines.length;
    if (total > MAX_REBATE_LINES) return badLines;
    const lines: RebateLine[] = [];
    for (const item of invoice.lines) {
      if (typeof item !== "object" || item === null) return badLines;
      const line = item as Record<string, unknown>;
      if (!Number.isSafeInteger(line.line) || typeof line.vinRead !== "string") return badLines;
      lines.push({
        line: line.line as number,
        part: short(line.part, 10),
        vinRead: line.vinRead.slice(0, 30),
        modelCode: short(line.modelCode, 30),
        programs: strings(line.programs, 6, 120),
        dates: strings(line.dates, 6, 120),
        names: strings(line.names, 6, 120),
        unitPrice: cents(line.unitPrice),
        amount: cents(line.amount),
        saleId: isUuid(line.saleId) ? line.saleId : null,
      });
    }
    invoices.push({
      fileName: short(invoice.fileName, 200) ?? "Invoice",
      number: short(invoice.number, 20),
      type: short(invoice.type, 30),
      date: typeof invoice.date === "string" ? parseIsoDate(invoice.date) : null,
      total: cents(invoice.total),
      column: invoice.column,
      lines,
    });
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
  return "America/New_York";
}

// The download: the NUSR sheet with the rebates in AO, AP and AQ (every
// sale of the years the invoice's units were sold in) and the Rebates
// sheet, named for the invoices and the day. A sale that isn't this
// shop's (or was removed since) counts as not found.
export async function rebateDownload(
  actor: CurrentUser,
  input: unknown,
  now = new Date(),
): Promise<{ bytes: Uint8Array<ArrayBuffer>; fileName: string; contentDisposition: string } | Problem> {
  if (!allows(actor, "sales.log")) return notAllowed;
  const invoices = checkInvoices(input);
  if ("error" in invoices) return invoices;
  const timeZone = timeZoneOf((input as { timeZone?: unknown }).timeZone);
  const ids = [...new Set(invoices.flatMap((invoice) => invoice.lines.flatMap((line) => (line.saleId ? [line.saleId] : []))))];
  const years = ids.length
    ? await withShop(actor.shop.id, (tx) =>
        tx
          .selectDistinct({ year: sql<number>`extract(year from ${unitSales.soldOn})::int` })
          .from(unitSales)
          .where(inArray(unitSales.id, ids)),
      )
    : [];
  const filters = (year: number): SaleFilters => ({ year, month: null, condition: null, unitType: null, category: null, salesperson: null, status: null, query: "" });
  const sales = (await Promise.all(years.map(({ year }) => findSales(actor.shop.id, filters(year), "oldest")))).flat();
  const known = new Set(sales.map((sale) => sale.id));
  const found = invoices.map((invoice) => ({ ...invoice, lines: invoice.lines.map((line) => (line.saleId && !known.has(line.saleId) ? { ...line, saleId: null } : line)) }));
  const sheets = rebateWorkbook(found, sales, { generatedAt: now, timeZone });
  const bytes = writeXlsx(sheets, { title: `Rebates ${invoicesTitle(found)}`, created: now });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const fileName = rebatesFileName(
    found.map((invoice) => invoice.number),
    today,
  );
  return { bytes, fileName, contentDisposition: attachmentHeader(fileName) };
}
