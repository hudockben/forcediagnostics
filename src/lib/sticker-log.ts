import "server-only";

import { randomUUID } from "node:crypto";

import { DrizzleQueryError, and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { auditLog, customers, stickerPlateLog, users } from "@/db/schema";
import { matchCustomer } from "@/lib/customer-import-rules";
import { checkCustomer } from "@/lib/customer-rules";
import { personKeySql } from "@/lib/customers";
import { containsPattern, listPage, listSearchWords, type ListPage } from "@/lib/diagnose-list-rules";
import { isUuid } from "@/lib/diagnose-rules";
import { cutText } from "@/lib/manual-rules";
import type { CurrentUser } from "@/lib/session";
import {
  MAX_LOG_CHECK,
  MAX_STICKER_IMPORT_BATCH,
  checkStickerImport,
  personKey,
  type LoggedNumber,
  type StickerImportEntry,
  type StickerImportOutcome,
} from "@/lib/sticker-import-rules";
import {
  ENTRY_KINDS,
  ENTRY_KIND_LABELS,
  STICKER_LOG_PAGE_SIZE,
  checkStickerEntry,
  classOf,
  entryWords,
  kindOf,
  parseKindFilter,
  stockRange,
  stockWords,
  type EntryKind,
  type PlateClass,
  type StickerLogRow,
  type StockLevel,
} from "@/lib/sticker-log-rules";

// The Sticker & Plate log tab: each registration sticker and plate the
// shop hands out, tied to the customer it went to, and the ones it has on
// hand (no customer yet); a plate is Class 1 or Class 2, a sticker has no
// class. Callers check repair_orders.intake first; everything here runs
// inside withShop for the user's own shop, and every change is written to
// audit_log.

export type StickerEntry = {
  id: string;
  stickerNumber: string;
  plateClass: PlateClass | null;
  // Both null while it's on hand.
  customerId: string | null;
  customerName: string | null;
  // When it came into stock; null for one logged straight to a customer.
  receivedAt: Date | null;
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
  receivedAt: stickerPlateLog.receivedAt,
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

// Stickers (no class), one class of plates, or everything.
const ofKind = (kind: EntryKind | null) => {
  if (kind === null) return undefined;
  const plateClass = classOf(kind);
  return plateClass === null ? isNull(stickerPlateLog.plateClass) : eq(stickerPlateLog.plateClass, plateClass);
};

// The ones handed out (to a customer), or the ones on hand.
const filters = (query: string, kind: EntryKind | null, onHand: boolean) =>
  and(logSearch(query), ofKind(kind), onHand ? isNull(stickerPlateLog.customerId) : isNotNull(stickerPlateLog.customerId));

// One page of the log, or of what a search (and a class) finds: the ones
// handed out, the newest first; or the ones on hand, the next to hand out
// first (the order they came in, as the shop's sheet lists them). A page
// past the end gives the last one.
export async function listStickerLog(
  shopId: string,
  {
    query = "",
    kind = null,
    onHand = false,
    page = 1,
    perPage = STICKER_LOG_PAGE_SIZE,
  }: { query?: string; kind?: EntryKind | null; onHand?: boolean; page?: number; perPage?: number } = {},
): Promise<StickerLog> {
  const where = filters(query, kind, onHand);
  return withShop(shopId, async (tx) => {
    const [{ total }] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(stickerPlateLog)
      .leftJoin(customers, eq(customers.id, stickerPlateLog.customerId))
      .where(where);
    const at = listPage(total, page, perPage);
    const items =
      total === 0
        ? []
        : await tx
            .select(entryColumns)
            .from(stickerPlateLog)
            .leftJoin(customers, eq(customers.id, stickerPlateLog.customerId))
            .leftJoin(users, eq(users.id, stickerPlateLog.createdByUserId))
            .where(where)
            .orderBy(...(onHand ? [asc(stickerPlateLog.createdAt), asc(stickerPlateLog.id)] : [desc(stickerPlateLog.createdAt), desc(stickerPlateLog.id)]))
            .limit(perPage)
            .offset(at.offset);
    return { ...at, total, items };
  });
}

export const MAX_EXPORT_ROWS = 100_000;

// Everything a search (and a class) finds, handed out or on hand, for the
// CSV download, the oldest first, as a log is read.
export async function exportStickerLog(
  shopId: string,
  { query = "", kind = null, onHand = false }: { query?: string; kind?: EntryKind | null; onHand?: boolean } = {},
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
      .leftJoin(customers, eq(customers.id, stickerPlateLog.customerId))
      .leftJoin(users, eq(users.id, stickerPlateLog.createdByUserId))
      .where(filters(query, kind, onHand))
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
      .leftJoin(customers, eq(customers.id, stickerPlateLog.customerId))
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

const PICK_CUSTOMER = { error: "Pick the customer it went to, or add them." };

// The customer an entry is for: one of the shop's, or a new one added by
// name from the log's form (they can be filled in on Customers later).
// Null when the form names nobody.
async function customerFor(
  tx: ShopTransaction,
  actor: CurrentUser,
  input: { customerId?: unknown; newCustomerName?: unknown },
): Promise<{ id: string; name: string } | null | { error: string }> {
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
  return null;
}

// "a Class 1 plate for Dana Whitfield" or "a sticker on hand".
const whatAndWhose = (entry: { plateClass: PlateClass | null; customerName: string | null }) =>
  `a ${entryWords(entry.plateClass)} ${entry.customerName === null ? "on hand" : `for ${entry.customerName}`}`;

// The entry with this number, what it is and whose.
async function findNumber(tx: ShopTransaction, stickerNumber: string) {
  const [found] = await tx
    .select({ id: stickerPlateLog.id, plateClass: stickerPlateLog.plateClass, customerId: stickerPlateLog.customerId, customerName: customers.name })
    .from(stickerPlateLog)
    .leftJoin(customers, eq(customers.id, stickerPlateLog.customerId))
    .where(eq(stickerPlateLog.stickerNumber, stickerNumber))
    .for("update", { of: stickerPlateLog });
  return found ?? null;
}

// Another entry with this number, said what it is and whom it went to.
async function alreadyLogged(tx: ShopTransaction, stickerNumber: string, except?: string) {
  const other = await findNumber(tx, stickerNumber);
  return other && other.id !== except ? { error: `${stickerNumber} is already in the log, as ${whatAndWhose(other)}.` } : null;
}

export type StickerInput = { stickerNumber: unknown; plateClass: unknown; customerId?: unknown; newCustomerName?: unknown };

// Logs a sticker or plate for its customer. One on hand (that number, that
// kind) is handed out: logged to them, now, by whoever logs it.
export async function logSticker(
  actor: CurrentUser,
  input: StickerInput,
): Promise<{ id: string; customerId: string; fromStock: boolean } | { error: string }> {
  const checked = checkStickerEntry(input);
  if ("error" in checked) return checked;
  const { stickerNumber, plateClass } = checked.entry;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const found = await findNumber(tx, stickerNumber);
      if (found && found.customerId !== null) return { error: `${stickerNumber} is already in the log, as ${whatAndWhose(found)}.` };
      if (found && found.plateClass !== plateClass) {
        return { error: `${stickerNumber} is on hand as a ${entryWords(found.plateClass)}: pick ${ENTRY_KIND_LABELS[kindOf(found.plateClass)]}.` };
      }
      const customer = await customerFor(tx, actor, input);
      if (customer === null) return PICK_CUSTOMER;
      if ("error" in customer) return customer;
      if (found) {
        await tx
          .update(stickerPlateLog)
          .set({ customerId: customer.id, createdAt: sql`now()`, createdByUserId: actor.id })
          .where(eq(stickerPlateLog.id, found.id));
        await audit(tx, actor, "sticker.logged", found.id, { stickerNumber, plateClass, customerId: customer.id, fromStock: true });
        return { id: found.id, customerId: customer.id, fromStock: true };
      }
      const [row] = await tx
        .insert(stickerPlateLog)
        .values({ shopId: actor.shop.id, customerId: customer.id, stickerNumber, plateClass, createdByUserId: actor.id })
        .returning({ id: stickerPlateLog.id });
      await audit(tx, actor, "sticker.logged", row.id, { stickerNumber, plateClass, customerId: customer.id });
      return { id: row.id, customerId: customer.id, fromStock: false };
    });
  } catch (error) {
    // Logged by someone else a moment ago.
    if (unique(error)) return { error: `${stickerNumber} is already in the log.` };
    throw error;
  }
}

// Corrects an entry: its number, what it is (a sticker or a plate's class)
// or its customer. One on hand can be corrected and stay on hand (no
// customer picked), or be handed out to the customer picked, logged now.
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
      // One handed out stays someone's.
      if (customer === null && before.customerId !== null) return PICK_CUSTOMER;
      if (customer !== null && "error" in customer) return customer;
      const after = { stickerNumber, plateClass, customerId: customer?.id ?? null };
      const fields = (Object.keys(after) as (keyof typeof after)[]).filter((key) => before[key] !== after[key]);
      if (fields.length === 0) return { ok: true as const };
      const handedOut = before.customerId === null && after.customerId !== null;
      await tx
        .update(stickerPlateLog)
        .set({ ...after, ...(handedOut ? { createdAt: sql`now()`, createdByUserId: actor.id } : {}) })
        .where(eq(stickerPlateLog.id, id));
      await audit(
        tx,
        actor,
        handedOut ? "sticker.logged" : "sticker.updated",
        id,
        handedOut
          ? { stickerNumber, plateClass, customerId: after.customerId, fromStock: true }
          : { stickerNumber, fields, ...(fields.includes("stickerNumber") ? { was: before.stickerNumber } : {}) },
      );
      return { ok: true as const };
    });
  } catch (error) {
    if (unique(error)) return { error: `${stickerNumber} is already in the log.` };
    throw error;
  }
}

// Removes an entry logged by mistake, or one on hand that's damaged or
// void; the audit log keeps what it was.
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

// --- Stock on hand ---------------------------------------------------------------

// Each kind the shop keeps in stock (any of its numbers ever on hand), in
// the log's order: how many are on hand, and the next to hand out (the
// first of them added, as the shop's sheet lists them).
export async function getStickerStock(shopId: string): Promise<StockLevel[]> {
  const rows = await withShop(shopId, (tx) =>
    tx
      .select({
        plateClass: stickerPlateLog.plateClass,
        onHand: sql<number>`count(*) filter (where ${stickerPlateLog.customerId} is null)::int`,
        next: sql<string | null>`(array_agg(${stickerPlateLog.stickerNumber} order by ${stickerPlateLog.createdAt}, ${stickerPlateLog.id})
          filter (where ${stickerPlateLog.customerId} is null))[1]`,
      })
      .from(stickerPlateLog)
      .where(isNotNull(stickerPlateLog.receivedAt))
      .groupBy(stickerPlateLog.plateClass),
  );
  return ENTRY_KINDS.flatMap((kind) =>
    rows.filter((row) => kindOf(row.plateClass) === kind).map((row) => ({ kind, onHand: row.onHand, next: row.next })),
  );
}

// Adds a delivery to stock, on hand: one number, or a run from the first
// to the last, in that order (so the first is handed out first). A number
// already in the log is left as it is, and counted.
export async function addStock(
  actor: CurrentUser,
  input: { kind: unknown; from: unknown; to: unknown },
): Promise<{ added: number; already: number; message: string } | { error: string }> {
  const kind = parseKindFilter(input.kind);
  if (!kind) return { error: "Pick what they are: stickers, or Class 1 or Class 2 plates." };
  const range = stockRange(input.from, input.to);
  if ("error" in range) return range;
  const plateClass = classOf(kind);
  const { numbers } = range;
  return withShop(actor.shop.id, async (tx) => {
    const rows = await tx
      .insert(stickerPlateLog)
      .values(
        numbers.map((stickerNumber, index) => ({
          shopId: actor.shop.id,
          customerId: null,
          stickerNumber,
          plateClass,
          receivedAt: sql`now()`,
          createdByUserId: actor.id,
          // A microsecond apart, in order.
          createdAt: sql`now() + ${index} * interval '1 microsecond'`,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: stickerPlateLog.id });
    const added = rows.length;
    const already = numbers.length - added;
    if (added > 0) {
      await audit(tx, actor, "stickers.stocked", randomUUID(), {
        plateClass,
        from: numbers[0],
        to: numbers[numbers.length - 1],
        added,
        already,
      });
    }
    const message =
      added === 0
        ? `${numbers.length === 1 ? `${numbers[0]} is` : "Those are all"} in the log already: nothing added.`
        : `Added ${stockWords(kind, added)} to stock${already > 0 ? ` (${already.toLocaleString("en-US")} in the log already, left as ${already === 1 ? "it is" : "they are"})` : ""}.`;
    return { added, already, message };
  });
}

// --- Importing a log ------------------------------------------------------------

type Person = { id: string; name: string; phone: string | null; email: string | null };

const rowOf = (entry: unknown) => {
  const row = (entry as { row?: unknown } | null)?.row;
  return Number.isInteger(row) ? Number(row) : 0;
};

// Which of these numbers the log has already, what each is and whether
// it's on hand: for the import's preview, before anything is sent. Up to
// MAX_LOG_CHECK at a time; anything that isn't a number the log could hold
// is left out.
export async function numbersInLog(shopId: string, input: unknown): Promise<LoggedNumber[] | { error: string }> {
  if (!Array.isArray(input) || input.length > MAX_LOG_CHECK) return { error: "Those numbers couldn't be checked. Reload the page and try again." };
  const numbers = [
    ...new Set(input.flatMap((number) => {
      const checked = checkStickerEntry({ stickerNumber: number, plateClass: null });
      return "entry" in checked ? [checked.entry.stickerNumber] : [];
    })),
  ];
  if (numbers.length === 0) return [];
  return withShop(shopId, (tx) =>
    tx
      .select({
        stickerNumber: stickerPlateLog.stickerNumber,
        plateClass: stickerPlateLog.plateClass,
        onHand: sql<boolean>`${stickerPlateLog.customerId} is null`,
      })
      .from(stickerPlateLog)
      .where(inArray(stickerPlateLog.stickerNumber, numbers)),
  );
}

// Saves one batch of an imported Sticker & Plate log, each sticker and
// plate checked as the form checks it. One without a customer is on hand:
// added to stock. A number already in the log is left as it is (and said
// so when the log has it for someone else, or as something else), so
// importing the same file again adds nothing; but one on hand in the log
// that the file now names a customer for is handed out to them. Each
// one's customer is found on Customers by name, either way round ("Rudd,
// Benjamin" finds Benjamin Rudd), and by phone number when the file has
// one, the way the customer import finds them; anyone not there is added
// as written, once however many stickers they have. A name that several
// customers share, with nothing in the file to say which, is left out with
// a note: that sticker is logged on the form, picking them. Stickers are
// logged in the file's order, so the log (newest first) lists the file's
// last row first, and the first of a list on hand is handed out first.
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
    // The batch's stickers that are in the log already, and whose they are
    // (null: on hand).
    const numbers = [...new Set(valid.map((entry) => entry.stickerNumber))];
    const logged = numbers.length
      ? await tx
          .select({ id: stickerPlateLog.id, stickerNumber: stickerPlateLog.stickerNumber, plateClass: stickerPlateLog.plateClass, customerName: customers.name })
          .from(stickerPlateLog)
          .leftJoin(customers, eq(customers.id, stickerPlateLog.customerId))
          .where(inArray(stickerPlateLog.stickerNumber, numbers))
      : [];
    const inLog = new Map<string, { id: string | null; plateClass: PlateClass | null; customerName: string | null }>(
      logged.map((entry) => [entry.stickerNumber, entry]),
    );
    // Customers on file by name either way round, worked out by Postgres on
    // both sides, then matched by personKey; oldest first, so the same file
    // finds the same one.
    const names = [...new Set(valid.flatMap((entry) => (entry.customer ? [entry.customer.name] : [])))];
    const onFile: Person[] = names.length
      ? await tx
          .select({ id: customers.id, name: customers.name, phone: customers.phone, email: customers.email })
          .from(customers)
          .where(
            sql`${personKeySql(sql`${customers.name}`)} in (select ${personKeySql(sql`n`)} from unnest(array[${sql.join(
              names.map((name) => sql`${name}`),
              sql`, `,
            )}]::text[]) n)`,
          )
          .orderBy(asc(customers.createdAt), asc(customers.id))
      : [];
    const byName = new Map<string, Person[]>();
    for (const person of onFile) byName.set(personKey(person.name), [...(byName.get(personKey(person.name)) ?? []), person]);
    const newCustomers: (typeof customers.$inferInsert & { id: string })[] = [];

    // The customer on file for an entry, or one to add; a message when
    // several share the name and nothing says which.
    const personFor = (customer: NonNullable<StickerImportEntry["customer"]>): Person | { ambiguous: number } => {
      const key = personKey(customer.name);
      const people = byName.get(key) ?? [];
      // Matched under the one name, however each is written.
      const found = matchCustomer(
        people.map((person) => ({ ...person, name: key })),
        { name: key, phone: customer.phone, email: null },
      );
      if (!found.match && found.ambiguous > 1) return { ambiguous: found.ambiguous };
      if (found.match) return found.match;
      const person = { id: randomUUID(), name: customer.name, phone: customer.phone, email: null };
      byName.set(key, [...people, person]);
      newCustomers.push({ id: person.id, shopId: actor.shop.id, name: customer.name, phone: customer.phone, createdByUserId: actor.id });
      return person;
    };

    const outcomes: StickerImportOutcome[] = [];
    // What to save, each at its place in the file (seq), so the log keeps
    // the file's order: a new entry, or one on hand handed out (id).
    type Saving = { id: string | null; customerId: string | null; stickerNumber: string; plateClass: PlateClass | null; seq: number; outcome: StickerImportOutcome };
    const saving: Saving[] = [];
    checked.forEach(({ row, entry }, seq) => {
      if ("error" in entry) {
        outcomes.push({ row, result: "failed", customer: null, message: entry.error });
        return;
      }
      const { stickerNumber, plateClass, customer } = entry.entry;
      const already = inLog.get(stickerNumber);
      // On hand in the log, and the file says whom it went to: handed out.
      const handOut = already && already.id !== null && already.customerName === null && customer !== null && already.plateClass === plateClass;
      if (already && !handOut) {
        const samePerson =
          already.customerName === null ? customer === null : customer !== null && personKey(already.customerName) === personKey(customer.name);
        outcomes.push({
          row,
          result: "already",
          customer: null,
          message:
            samePerson && already.plateClass === plateClass
              ? null
              : `${stickerNumber} is in the log already, as a ${entryWords(already.plateClass)} ${already.customerName === null ? "on hand" : `for ${already.customerName}`}: left as it is.`,
        });
        return;
      }
      let customerId: string | null = null;
      if (customer) {
        const person = personFor(customer);
        if ("ambiguous" in person) {
          outcomes.push({
            row,
            result: "failed",
            customer: null,
            message: `${person.ambiguous} customers are called ${customer.name}, and nothing in the file says which: log ${entryWords(plateClass)} ${stickerNumber} on the log's form, picking them.`,
          });
          return;
        }
        customerId = person.id;
      }
      inLog.set(stickerNumber, { id: null, plateClass, customerName: customer?.name ?? null });
      const outcome: StickerImportOutcome = { row, result: customer ? "logged" : "stocked", customer: null, message: null };
      saving.push({ id: handOut ? already.id : null, customerId, stickerNumber, plateClass, seq, outcome });
      outcomes.push(outcome);
    });

    if (newCustomers.length > 0) await tx.insert(customers).values(newCustomers);
    // A sticker logged on the form while this ran is left as it is.
    const saved = new Set<string>();
    const adding = saving.filter((each) => each.id === null);
    if (adding.length > 0) {
      const rows = await tx
        .insert(stickerPlateLog)
        .values(
          adding.map(({ customerId, stickerNumber, plateClass, seq }) => ({
            shopId: actor.shop.id,
            customerId,
            stickerNumber,
            plateClass,
            receivedAt: customerId === null ? sql`now()` : null,
            createdByUserId: actor.id,
            // A microsecond apart, in the file's order.
            createdAt: sql`now() + ${seq} * interval '1 microsecond'`,
          })),
        )
        .onConflictDoNothing()
        .returning({ stickerNumber: stickerPlateLog.stickerNumber });
      for (const { stickerNumber } of rows) saved.add(stickerNumber);
    }
    for (const { id, customerId, stickerNumber, seq } of saving) {
      if (id === null || customerId === null) continue;
      const [handed] = await tx
        .update(stickerPlateLog)
        .set({ customerId, createdAt: sql`now() + ${seq} * interval '1 microsecond'`, createdByUserId: actor.id })
        .where(and(eq(stickerPlateLog.id, id), isNull(stickerPlateLog.customerId)))
        .returning({ stickerNumber: stickerPlateLog.stickerNumber });
      if (handed) saved.add(stickerNumber);
    }
    // Each customer added is counted on the first sticker of theirs logged;
    // one added only for a sticker that wasn't is taken off again.
    const added = new Set(newCustomers.map((customer) => customer.id));
    const credited = new Set<string>();
    for (const { customerId, stickerNumber, outcome } of saving) {
      if (!saved.has(stickerNumber)) {
        Object.assign(outcome, { result: "already", message: `${stickerNumber} was logged on the form while this import ran: left as it is.` });
        continue;
      }
      if (customerId === null) continue;
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
      stocked: count("stocked"),
      already: count("already"),
      customersAdded: credited.size,
      failed: count("failed"),
    });
    return { outcomes };
  });
}
