import "server-only";

import { DrizzleQueryError, and, desc, eq, sql, type SQL } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { auditLog, customers, stickerPlateLog, users } from "@/db/schema";
import { checkCustomer } from "@/lib/customer-rules";
import { containsPattern, listPage, listSearchWords, type ListPage } from "@/lib/diagnose-list-rules";
import { isUuid } from "@/lib/diagnose-rules";
import type { CurrentUser } from "@/lib/session";
import {
  STICKER_LOG_PAGE_SIZE,
  checkStickerEntry,
  type PlateClass,
  type StickerLogRow,
} from "@/lib/sticker-log-rules";

// System Admin > Sticker & Plate log: each registration sticker the shop
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
