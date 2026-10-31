import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";

import { withShop } from "@/db";
import { auditLog, customers, unitSales } from "@/db/schema";
import { matchCustomer, nameKey, phoneKey } from "@/lib/customer-import-rules";
import { isUuid } from "@/lib/diagnose-rules";
import { cutText } from "@/lib/manual-rules";
import { MATCH_WORDS, MAX_NUSR_IMPORT_BATCH, isImportRef, saleFinder, type KnownSale, type NusrImportOutcome } from "@/lib/nusr-import-rules";
import { checkSale, type SaleFields } from "@/lib/nusr-rules";
import type { CurrentUser } from "@/lib/session";

// NUSR > Import, the saving side: each batch of sales the browser planned
// from the shop's NUSR workbook (src/lib/nusr-import-rules.ts) is checked
// again, matched against the sales already in the NUSR, and added. Callers
// check sales.log first; it all runs inside withShop for the user's own
// shop, and each batch is written to audit_log, which the Activity log
// shows.

// Every column of a sale but those an import sets itself.
type SaleColumns = Required<Omit<typeof unitSales.$inferInsert, "id" | "shopId" | "customerId" | "importRef" | "createdByUserId" | "createdAt" | "updatedAt">>;

// A sale's fields as its row's columns.
function columnsOf(sale: SaleFields): SaleColumns {
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

const asText = (value: unknown) => (typeof value === "string" ? value : "");
const SEVEN_DAYS_MS = 7 * 86_400_000;
const dayShift = (day: string, ms: number) => new Date(Date.parse(`${day}T00:00:00Z`) + ms).toISOString().slice(0, 10);

// Saves one batch of an import. Each sale is checked as the form checks
// one, then left out when the NUSR has it already: the same row of the
// same sheet (this file imported before), the same VIN sold the same day,
// the same VIN sold to the same customer, or the same customer and sales
// price within a week (see saleFinder; never two rows of one sheet). A
// sale is tied to a customer on file only when it's them by name and phone
// number (customers aren't added). Sending a batch again adds nothing, so
// a stopped import can carry on. One import at a time per shop (a lock
// held to the end of the batch); each batch is recorded in audit_log as
// unit_sales.imported, with its counts.
export async function importSales(
  actor: CurrentUser,
  input: { importId: unknown; fileName: unknown; sales: unknown },
): Promise<{ outcomes: NusrImportOutcome[] } | { error: string }> {
  if (!isUuid(input.importId)) return { error: "That import couldn't be read. Choose the file again." };
  const list = Array.isArray(input.sales) ? (input.sales as unknown[]) : null;
  if (!list || list.length === 0) return { error: "There were no sales in that batch." };
  if (list.length > MAX_NUSR_IMPORT_BATCH) return { error: "That batch is too big. Reload the page and try again." };
  // Kept in the audit log, which can't hold a NUL or half an emoji.
  const fileName = cutText(asText(input.fileName).replace(/\u0000/g, ""), 255);

  // Checked before anything is read, the same way the form checks a sale.
  const checked = list.map((entry) => {
    const record = (entry && typeof entry === "object" ? entry : {}) as { ref?: unknown; fields?: unknown };
    const ref = isImportRef(record.ref) ? record.ref : null;
    const fields = (record.fields && typeof record.fields === "object" ? record.fields : {}) as Record<keyof SaleFields, unknown>;
    return {
      ref: ref ?? cutText(asText(record.ref).replace(/\u0000/g, ""), 120),
      sale: ref ? checkSale(fields) : { error: "That sale's sheet and row couldn't be read." },
    };
  });
  const sales = checked.flatMap(({ sale }) => ("sale" in sale ? [sale.sale] : []));

  return withShop(actor.shop.id, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('nusr-import'), hashtext(${actor.shop.id}))`);
    // The sales on file this batch could be: by row, by VIN, or by price
    // within a week of the batch's dates.
    const refs = checked.flatMap(({ ref, sale }) => ("sale" in sale ? [ref] : []));
    const vins = [...new Set(sales.flatMap((sale) => (sale.vin ? [sale.vin] : [])))];
    const prices = [...new Set(sales.flatMap((sale) => (sale.salesPrice !== null ? [sale.salesPrice] : [])))];
    const days = sales.map((sale) => sale.soldOn).sort();
    const could: SQL[] = [];
    if (refs.length) could.push(inArray(unitSales.importRef, refs));
    if (vins.length) could.push(inArray(unitSales.vin, vins));
    if (prices.length) {
      const from = dayShift(days[0], -SEVEN_DAYS_MS);
      const to = dayShift(days.at(-1)!, SEVEN_DAYS_MS);
      could.push(and(inArray(unitSales.salesPriceCents, prices), gte(unitSales.soldOn, from), lte(unitSales.soldOn, to))!);
    }
    const onFile: KnownSale[] = could.length
      ? await tx
          .select({ ref: unitSales.importRef, vin: unitSales.vin, soldOn: unitSales.soldOn, customerName: unitSales.customerName, salesPrice: unitSales.salesPriceCents })
          .from(unitSales)
          .where(or(...could))
          .orderBy(asc(unitSales.createdAt), asc(unitSales.id))
      : [];
    const finder = saleFinder(onFile);

    // Customers on file by name, lower-cased by Postgres on both sides, then
    // matched by nameKey; oldest first, so the same file finds the same one.
    const names = [...new Set(sales.map((sale) => sale.customerName))];
    const people = names.length
      ? await tx
          .select({ id: customers.id, name: customers.name, phone: customers.phone })
          .from(customers)
          .where(
            sql`lower(${customers.name}) in (select lower(n) from unnest(array[${sql.join(
              names.map((name) => sql`${name}`),
              sql`, `,
            )}]::text[]) n)`,
          )
          .orderBy(asc(customers.createdAt), asc(customers.id))
      : [];
    const byName = new Map<string, { id: string; name: string; phone: string | null; email: null }[]>();
    for (const person of people) byName.set(nameKey(person.name), [...(byName.get(nameKey(person.name)) ?? []), { ...person, email: null }]);
    // The customer a sale is for: one on file of that name who shares its
    // phone number, and no other.
    const customerOf = (sale: SaleFields) => {
      const phone = phoneKey(sale.customerPhone);
      if (!phone) return null;
      const found = matchCustomer(byName.get(nameKey(sale.customerName)) ?? [], { name: sale.customerName, phone: sale.customerPhone, email: null });
      return found.match && phoneKey(found.match.phone) === phone ? found.match.id : null;
    };

    const outcomes: NusrImportOutcome[] = [];
    const rows: (typeof unitSales.$inferInsert)[] = [];
    for (const { ref, sale: entry } of checked) {
      if ("error" in entry) {
        outcomes.push({ ref, result: "failed", reason: entry.error });
        continue;
      }
      const sale = entry.sale;
      const known: KnownSale = { ref, vin: sale.vin, soldOn: sale.soldOn, customerName: sale.customerName, salesPrice: sale.salesPrice };
      const found = finder.find(known);
      if (found.match) {
        outcomes.push({ ref, result: "already", reason: `Already in the NUSR: ${MATCH_WORDS[found.how]}.` });
        continue;
      }
      // A row another sale has (the file has changed since it was last
      // imported) isn't kept with this one too.
      const importRef = found.refTaken ? null : ref;
      finder.add({ ...known, ref: importRef });
      rows.push({ ...columnsOf(sale), id: randomUUID(), importRef, customerId: customerOf(sale), shopId: actor.shop.id, createdByUserId: actor.id });
      outcomes.push({ ref, result: "added", reason: null });
    }
    // A sale logged by hand meanwhile (the same VIN the same day) is left
    // as it is, and this one counted as already there.
    const added = new Set<string>();
    for (let at = 0; at < rows.length; at += MAX_NUSR_IMPORT_BATCH) {
      const saved = await tx.insert(unitSales).values(rows.slice(at, at + MAX_NUSR_IMPORT_BATCH)).onConflictDoNothing().returning({ id: unitSales.id });
      for (const { id } of saved) added.add(id);
    }
    let at = 0;
    for (const outcome of outcomes) {
      if (outcome.result !== "added") continue;
      const row = rows[at++];
      if (!added.has(row.id!)) Object.assign(outcome, { result: "already", reason: `Already in the NUSR: ${MATCH_WORDS.vinDay}.` });
    }
    const count = (result: NusrImportOutcome["result"]) => outcomes.filter((outcome) => outcome.result === result).length;
    await tx.insert(auditLog).values({
      shopId: actor.shop.id,
      actorUserId: actor.id,
      action: "unit_sales.imported",
      targetType: "unit_sale",
      targetId: String(input.importId),
      details: { fileName, added: count("added"), already: count("already"), failed: count("failed") },
    });
    return { outcomes };
  });
}
