import "server-only";

import { randomUUID } from "node:crypto";

import { DrizzleQueryError, and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { auditLog, customers, stickerPlateLog, users } from "@/db/schema";
import { matchCustomer, nameKey } from "@/lib/customer-import-rules";
import { checkCustomer } from "@/lib/customer-rules";
import { containsPattern, listPage, listSearchWords, type ListPage } from "@/lib/diagnose-list-rules";
import { isUuid } from "@/lib/diagnose-rules";
import { cutText } from "@/lib/manual-rules";
import type { CurrentUser } from "@/lib/session";
import { MAX_STICKER_IMPORT_BATCH, checkStickerImport, type StickerImportOutcome } from "@/lib/sticker-import-rules";
import {
  STICKER_LOG_PAGE_SIZE,
  checkStickerEntry,
  type PlateClass,
  type StickerLogRow,
} from "@/lib/sticker-log-rules";

// The Sticker & Plate log tab: each registration sticker the shop
// hands out, tied to the customer it went to, with the plate's
// classification (1 or 2). Callers check repair_orders.intake first;
// everything here runs inside withShop for the user's own shop, and every
// change is written to audit_log.

export type StickerEntry = {
  id: string;
  stickerNumber: string;
  plateClass: PlateClass;
  customerId: string;
  customerName: string;
  createdAt: Date;
  createdBy: string | null;
};

export type StickerLog = ListPage & { items: StickerEntry[]; total: number };

const NOT_HERE = { error: "That entry isn't in this shop's log." };
const NO_CUSTOMER = { error: "That customer isn't in this shop." };

const entryColumns = {
  id: stickerPlateLog.id,
  stickerNumber: stickerPlateLog.stickerNumber,
  plateClass: stickerPlateLog.plateClass,
  customerId: stickerPlateLog.customerId,
  customerName: customers.name,
  createdAt: stickerPlateLog.createdAt,
  createdBy: users.name,
};

async function audit(tx: ShopTransaction, actor: CurrentUser, action: string, targetId: string, details: Record<string, unknown>) {
  await tx.insert(auditLog).values({ shopId: actor.shop.id, actorUserId: actor.id, action, targetType: "sticker", targetId, details });
}

const unique = (error: unknown) => ((error instanceof DrizzleQueryError ? error.cause : error) as { code?: string } | undefined)?.code === "23505";

// What a search of the log looks through: the sticker number and the
// customer's name and phone number (also as bare digits). Every word has
// to be somewhere, any order and any case, as on the other lists.
function logSearch(query: string): SQL | undefined {
  const words = listSearchWords(query);
  if (words.length === 0) return undefined;
  const text = sql`concat_ws(' ', ${stickerPlateLog.stickerNumber}, ${customers.name}, ${customers.phone},
    regexp_replace(coalesce(${customers.phone}, ''), '[^0-9]', '', 'g'))`;
  return sql`${text} ilike all (array[${sql.join(
    words.map((word) => sql`${containsPattern(word)}`),
    sql`, `,
  )}]::text[])`;
}

const filters = (query: string, plateClass: PlateClass | null) =>
  and(logSearch(query), plateClass ? eq(stickerPlateLog.plateClass, plateClass) : undefined);

// One page of the log, the newest first, or of what a search (and a class)
// finds. A page past the end gives the last one.
export async function listStickerLog(
  shopId: string,
  {
    query = "",
    plateClass = null,
    page = 1,
    perPage = STICKER_LOG_PAGE_SIZE,
  }: { query?: string; plateClass?: PlateClass | null; page?: number; perPage?: number } = {},
): Promise<StickerLog> {
  const where = filters(query, plateClass);
  return withShop(shopId, async (tx) => {
    const [{ total }] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(stickerPlateLog)
      .innerJoin(customers, eq(customers.id, stickerPlateLog.customerId))
      .where(where);
    const at = listPage(total, page, perPage);
    const items =
      total === 0
        ? []
        : await tx
            .select(entryColumns)
            .from(stickerPlateLog)
            .innerJoin(customers, eq(customers.id, stickerPlateLog.customerId))
            .leftJoin(users, eq(users.id, stickerPlateLog.createdByUserId))
            .where(where)
            .orderBy(desc(stickerPlateLog.createdAt), desc(stickerPlateLog.id))
            .limit(perPage)
            .offset(at.offset);
    return { ...at, total, items };
  });
}

export const MAX_EXPORT_ROWS = 100_000;

// Everything a search (and a class) finds, for the CSV download, the
// oldest first, as a log is read.
export async function exportStickerLog(
  shopId: string,
  { query = "", plateClass = null }: { query?: string; plateClass?: PlateClass | null } = {},
): Promise<StickerLogRow[]> {
  return withShop(shopId, (tx) =>
    tx
      .select({
        stickerNumber: stickerPlateLog.stickerNumber,
        customerName: customers.name,
        plateClass: stickerPlateLog.plateClass,
        createdAt: stickerPlateLog.createdAt,
        createdBy: users.name,
      })
      .from(stickerPlateLog)
      .innerJoin(customers, eq(customers.id, stickerPlateLog.customerId))
      .leftJoin(users, eq(users.id, stickerPlateLog.createdByUserId))
      .where(filters(query, plateClass))
      .orderBy(stickerPlateLog.createdAt, stickerPlateLog.id)
      .limit(MAX_EXPORT_ROWS),
  );
}

export async function getStickerEntry(shopId: string, id: string): Promise<StickerEntry | null> {
  if (!isUuid(id)) return null;
  return withShop(shopId, async (tx) => {
    const [row] = await tx
      .select(entryColumns)
      .from(stickerPlateLog)
      .innerJoin(customers, eq(customers.id, stickerPlateLog.customerId))
      .leftJoin(users, eq(users.id, stickerPlateLog.createdByUserId))
      .where(eq(stickerPlateLog.id, id));
    return row ?? null;
  });
}

// A customer's stickers, the newest first, for their record.
export async function stickersForCustomer(shopId: string, customerId: string): Promise<StickerEntry[]> {
  if (!isUuid(customerId)) return [];
  return withShop(shopId, (tx) =>
    tx
      .select(entryColumns)
      .from(stickerPlateLog)
      .innerJoin(customers, eq(customers.id, stickerPlateLog.customerId))
      .leftJoin(users, eq(users.id, stickerPlateLog.createdByUserId))
      .where(eq(stickerPlateLog.customerId, customerId))
      .orderBy(desc(stickerPlateLog.createdAt), desc(stickerPlateLog.id)),
  );
}

export type CustomerChoice = { id: string; name: string; detail: string | null };

export const CUSTOMER_SUGGESTIONS = 8;

// Customers for the log's customer box, by name or phone number, A to Z;
// the phone number and town to tell two of a name apart.
export async function searchCustomersForLog(shopId: string, query: string): Promise<CustomerChoice[]> {
  const words = listSearchWords(query);
  if (words.length === 0) return [];
  const text = sql`concat_ws(' ', ${customers.name}, ${customers.phone}, regexp_replace(coalesce(${customers.phone}, ''), '[^0-9]', '', 'g'), ${customers.email})`;
  const rows = await withShop(shopId, (tx) =>
    tx
      .select({ id: customers.id, name: customers.name, phone: customers.phone, city: customers.city })
      .from(customers)
      .where(sql`${text} ilike all (array[${sql.join(
        words.map((word) => sql`${containsPattern(word)}`),
        sql`, `,
      )}]::text[])`)
      .orderBy(sql`lower(${customers.name})`, customers.id)
      .limit(CUSTOMER_SUGGESTIONS),
  );
  return rows.map((row) => ({ id: row.id, name: row.name, detail: [row.phone, row.city].filter(Boolean).join(" · ") || null }));
}

export async function getCustomerChoice(shopId: string, id: string): Promise<CustomerChoice | null> {
  if (!isUuid(id)) return null;
  const [row] = await withShop(shopId, (tx) =>
    tx.select({ id: customers.id, name: customers.name, phone: customers.phone, city: customers.city }).from(customers).where(eq(customers.id, id)),
  );
  return row ? { id: row.id, name: row.name, detail: [row.phone, row.city].filter(Boolean).join(" · ") || null } : null;
}

// The customer an entry is for: one of the shop's, or a new one added by
// name from the log's form (they can be filled in on Customers later).
async function customerFor(
  tx: ShopTransaction,
  actor: CurrentUser,
  input: { customerId?: unknown; newCustomerName?: unknown },
): Promise<{ id: string; name: string } | { error: string }> {
  if (typeof input.customerId === "string" && input.customerId) {
    if (!isUuid(input.customerId)) return NO_CUSTOMER;
    const [found] = await tx.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.id, input.customerId));
    return found ?? NO_CUSTOMER;
  }
  if (typeof input.newCustomerName === "string" && input.newCustomerName.trim()) {
    const checked = checkCustomer({ name: input.newCustomerName, phone: "", email: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", notes: "" });
    if ("error" in checked) return checked;
    const [made] = await tx
      .insert(customers)
      .values({ ...checked.customer, shopId: actor.shop.id, createdByUserId: actor.id })
      .returning({ id: customers.id, name: customers.name });
    await tx.insert(auditLog).values({
      shopId: actor.shop.id,
      actorUserId: actor.id,
      action: "customer.created",
      targetType: "customer",
      targetId: made.id,
      details: { name: made.name, from: "sticker log" },
    });
    return made;
  }
  return { error: "Pick the customer the sticker went to, or add them." };
}

// Another entry with this sticker number, said by whom it went to.
async function alreadyLogged(tx: ShopTransaction, stickerNumber: string, except?: string) {
  const [other] = await tx
    .select({ id: stickerPlateLog.id, customerName: customers.name })
    .from(stickerPlateLog)
    .innerJoin(customers, eq(customers.id, stickerPlateLog.customerId))
    .where(eq(stickerPlateLog.stickerNumber, stickerNumber));
  return other && other.id !== except ? { error: `Sticker ${stickerNumber} is already in the log, for ${other.customerName}.` } : null;
}

export type StickerInput = { stickerNumber: unknown; plateClass: unknown; customerId?: unknown; newCustomerName?: unknown };

export async function logSticker(actor: CurrentUser, input: StickerInput): Promise<{ id: string; customerId: string } | { error: string }> {
  const checked = checkStickerEntry(input);
  if ("error" in checked) return checked;
  const { stickerNumber, plateClass } = checked.entry;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const taken = await alreadyLogged(tx, stickerNumber);
      if (taken) return taken;
      const customer = await customerFor(tx, actor, input);
      if ("error" in customer) return customer;
      const [row] = await tx
        .insert(stickerPlateLog)
        .values({ shopId: actor.shop.id, customerId: customer.id, stickerNumber, plateClass, createdByUserId: actor.id })
        .returning({ id: stickerPlateLog.id });
      await audit(tx, actor, "sticker.logged", row.id, { stickerNumber, plateClass, customerId: customer.id });
      return { id: row.id, customerId: customer.id };
    });
  } catch (error) {
    // Logged by someone else a moment ago.
    if (unique(error)) return { error: `Sticker ${stickerNumber} is already in the log.` };
    throw error;
  }
}

// Corrects an entry: its sticker number, classification or customer.
export async function updateSticker(actor: CurrentUser, id: string, input: StickerInput): Promise<{ ok: true } | { error: string }> {
  if (!isUuid(id)) return NOT_HERE;
  const checked = checkStickerEntry(input);
  if ("error" in checked) return checked;
  const { stickerNumber, plateClass } = checked.entry;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const [before] = await tx
        .select({ stickerNumber: stickerPlateLog.stickerNumber, plateClass: stickerPlateLog.plateClass, customerId: stickerPlateLog.customerId })
        .from(stickerPlateLog)
        .where(eq(stickerPlateLog.id, id))
        .for("update");
      if (!before) return NOT_HERE;
      const taken = await alreadyLogged(tx, stickerNumber, id);
      if (taken) return taken;
      const customer = await customerFor(tx, actor, input);
      if ("error" in customer) return customer;
      const after = { stickerNumber, plateClass, customerId: customer.id };
      const fields = (Object.keys(after) as (keyof typeof after)[]).filter((key) => before[key] !== after[key]);
      if (fields.length === 0) return { ok: true as const };
      await tx.update(stickerPlateLog).set(after).where(eq(stickerPlateLog.id, id));
      await audit(tx, actor, "sticker.updated", id, { stickerNumber, fields, ...(fields.includes("stickerNumber") ? { was: before.stickerNumber } : {}) });
      return { ok: true as const };
    });
  } catch (error) {
    if (unique(error)) return { error: `Sticker ${stickerNumber} is already in the log.` };
    throw error;
  }
}

// Removes an entry logged by mistake; the audit log keeps what it was.
export async function removeSticker(actor: CurrentUser, id: string): Promise<{ ok: true; stickerNumber: string } | { error: string }> {
  if (!isUuid(id)) return NOT_HERE;
  return withShop(actor.shop.id, async (tx) => {
    const [removed] = await tx
      .delete(stickerPlateLog)
      .where(eq(stickerPlateLog.id, id))
      .returning({ stickerNumber: stickerPlateLog.stickerNumber, plateClass: stickerPlateLog.plateClass, customerId: stickerPlateLog.customerId });
    if (!removed) return NOT_HERE;
    await audit(tx, actor, "sticker.removed", id, removed);
    return { ok: true as const, stickerNumber: removed.stickerNumber };
  });
}

// --- Importing a log ------------------------------------------------------------

type Person = { id: string; name: string; phone: string | null; email: string | null };

const rowOf = (entry: unknown) => {
  const row = (entry as { row?: unknown } | null)?.row;
  return Number.isInteger(row) ? Number(row) : 0;
};

// Saves one batch of an imported sticker log, each row checked as the
// form checks it. A sticker already in the log is left as it is (and said
// so when the file has it for someone else, or in the other class), so
// importing the same file again adds nothing. Each sticker's customer is
// found on Customers by name, and by phone number when the file has one,
// the way the customer import finds them; anyone not there is added, once
// however many stickers they have. A name that several customers share,
// with nothing in the file to say which, is left out with a note: that
// sticker is logged on the form, picking them. Stickers are logged in the
// file's order, so the log (newest first) lists the file's last row first.
// One import at a time per shop (a lock to the end of the batch); the batch
// is recorded in audit_log as stickers.imported, with its counts.
export async function importStickers(
  actor: CurrentUser,
  input: { importId: unknown; fileName: unknown; stickers: unknown },
): Promise<{ outcomes: StickerImportOutcome[] } | { error: string }> {
  if (!isUuid(input.importId)) return { error: "That import couldn't be read. Choose the file again." };
  const list = Array.isArray(input.stickers) ? (input.stickers as unknown[]) : null;
  if (!list || list.length === 0) return { error: "There were no stickers in that batch." };
  if (list.length > MAX_STICKER_IMPORT_BATCH) return { error: "That batch is too big. Reload the page and try again." };
  // Kept in the audit log, which can't hold a NUL or half an emoji.
  const fileName = cutText(typeof input.fileName === "string" ? input.fileName.replace(/\u0000/g, "") : "", 255);
  const checked = list.map((entry) => ({ row: rowOf(entry), entry: checkStickerImport(entry) }));
  const valid = checked.flatMap(({ entry }) => ("entry" in entry ? [entry.entry] : []));

  return withShop(actor.shop.id, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sticker-import'), hashtext(${actor.shop.id}))`);
    // The batch's stickers that are in the log already, and whose they are.
    const numbers = [...new Set(valid.map((entry) => entry.stickerNumber))];
    const logged = numbers.length
      ? await tx
          .select({ stickerNumber: stickerPlateLog.stickerNumber, plateClass: stickerPlateLog.plateClass, customerName: customers.name })
          .from(stickerPlateLog)
          .innerJoin(customers, eq(customers.id, stickerPlateLog.customerId))
          .where(inArray(stickerPlateLog.stickerNumber, numbers))
      : [];
    const inLog = new Map(logged.map((entry) => [entry.stickerNumber, entry]));
    // Customers on file by name, lower-cased by Postgres on both sides, then
    // matched by nameKey; oldest first, so the same file finds the same one.
    const names = [...new Set(valid.map((entry) => entry.customer.name))];
    const onFile: Person[] = names.length
      ? await tx
          .select({ id: customers.id, name: customers.name, phone: customers.phone, email: customers.email })
          .from(customers)
          .where(
            sql`lower(${customers.name}) in (select lower(n) from unnest(array[${sql.join(
              names.map((name) => sql`${name}`),
              sql`, `,
            )}]::text[]) n)`,
          )
          .orderBy(asc(customers.createdAt), asc(customers.id))
      : [];
    const byName = new Map<string, Person[]>();
    for (const person of onFile) byName.set(nameKey(person.name), [...(byName.get(nameKey(person.name)) ?? []), person]);

    const outcomes: StickerImportOutcome[] = [];
    const newCustomers: (typeof customers.$inferInsert & { id: string })[] = [];
    const newStickers: { customerId: string; stickerNumber: string; plateClass: PlateClass; outcome: StickerImportOutcome }[] = [];
    for (const { row, entry } of checked) {
      if ("error" in entry) {
        outcomes.push({ row, result: "failed", customer: null, message: entry.error });
        continue;
      }
      const { stickerNumber, plateClass, customer } = entry.entry;
      const already = inLog.get(stickerNumber);
      if (already) {
        const same = nameKey(already.customerName) === nameKey(customer.name) && already.plateClass === plateClass;
        outcomes.push({
          row,
          result: "already",
          customer: null,
          message: same ? null : `Sticker ${stickerNumber} is in the log already, for ${already.customerName} (Class ${already.plateClass}): left as it is.`,
        });
        continue;
      }
      const people = byName.get(nameKey(customer.name)) ?? [];
      const found = matchCustomer(people, { name: customer.name, phone: customer.phone, email: null });
      if (!found.match && found.ambiguous > 1) {
        outcomes.push({
          row,
          result: "failed",
          customer: null,
          message: `${found.ambiguous} customers are called ${customer.name}, and nothing in the file says which: log sticker ${stickerNumber} on the log's form, picking them.`,
        });
        continue;
      }
      let person = found.match;
      if (!person) {
        person = { id: randomUUID(), name: customer.name, phone: customer.phone, email: null };
        byName.set(nameKey(customer.name), [...people, person]);
        newCustomers.push({ id: person.id, shopId: actor.shop.id, name: customer.name, phone: customer.phone, createdByUserId: actor.id });
      }
      inLog.set(stickerNumber, { stickerNumber, plateClass, customerName: customer.name });
      const outcome: StickerImportOutcome = { row, result: "logged", customer: null, message: null };
      newStickers.push({ customerId: person.id, stickerNumber, plateClass, outcome });
      outcomes.push(outcome);
    }

    if (newCustomers.length > 0) await tx.insert(customers).values(newCustomers);
    // A sticker logged on the form while this ran is left as it is.
    const saved = new Set<string>();
    if (newStickers.length > 0) {
      const rows = await tx
        .insert(stickerPlateLog)
        .values(
          newStickers.map(({ customerId, stickerNumber, plateClass }, index) => ({
            shopId: actor.shop.id,
            customerId,
            stickerNumber,
            plateClass,
            createdByUserId: actor.id,
            // A microsecond apart, in the file's order.
            createdAt: sql`now() + ${index} * interval '1 microsecond'`,
          })),
        )
        .onConflictDoNothing()
        .returning({ stickerNumber: stickerPlateLog.stickerNumber });
      for (const { stickerNumber } of rows) saved.add(stickerNumber);
    }
    // Each customer added is counted on the first sticker of theirs logged;
    // one added only for a sticker that wasn't is taken off again.
    const added = new Set(newCustomers.map((customer) => customer.id));
    const credited = new Set<string>();
    for (const { customerId, stickerNumber, outcome } of newStickers) {
      if (!saved.has(stickerNumber)) {
        Object.assign(outcome, { result: "already", message: `Sticker ${stickerNumber} was logged on the form while this import ran: left as it is.` });
        continue;
      }
      const isNew = added.has(customerId) && !credited.has(customerId);
      if (isNew) credited.add(customerId);
      outcome.customer = isNew ? "added" : "found";
    }
    const unused = newCustomers.filter((customer) => !credited.has(customer.id));
    if (unused.length > 0) await tx.delete(customers).where(inArray(customers.id, unused.map((customer) => customer.id)));

    const count = (result: StickerImportOutcome["result"]) => outcomes.filter((outcome) => outcome.result === result).length;
    await audit(tx, actor, "stickers.imported", String(input.importId), {
      fileName,
      logged: count("logged"),
      already: count("already"),
      customersAdded: credited.size,
      failed: count("failed"),
    });
    return { outcomes };
  });
}
