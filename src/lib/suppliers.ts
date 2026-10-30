import "server-only";

import { DrizzleQueryError, and, asc, eq, sql, type SQL } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { auditLog, suppliers } from "@/db/schema";
import { containsPattern, listPage, listSearchWords, type ListPage } from "@/lib/diagnose-list-rules";
import { isUuid } from "@/lib/diagnose-rules";
import { cutText } from "@/lib/manual-rules";
import type { CurrentUser } from "@/lib/session";
import {
  MAX_SUPPLIER_BATCH,
  SUPPLIER_FIELDS,
  SUPPLIER_PAGE_SIZE,
  checkSupplier,
  nextSupplierId,
  supplierKey,
  type SupplierFields,
  type SupplierImportOutcome,
} from "@/lib/supplier-rules";

// System Admin > Supplier: the shop's suppliers. Callers check
// parts.manage first; everything here runs inside withShop for the user's
// own shop, and every change is written to audit_log.

export type Supplier = SupplierFields & { id: string; updatedAt: Date };
export type SupplierList = ListPage & { items: Supplier[]; total: number };

const NOT_HERE = { error: "That supplier isn't in this shop." };

const columns = {
  id: suppliers.id,
  supplierId: suppliers.supplierId,
  supplierCode: suppliers.supplierCode,
  supplierName: suppliers.supplierName,
  categoryCode: suppliers.categoryCode,
  categoryId: suppliers.categoryId,
  updatedAt: suppliers.updatedAt,
};

async function audit(tx: ShopTransaction, actor: CurrentUser, action: string, targetId: string, details: Record<string, unknown>) {
  await tx.insert(auditLog).values({ shopId: actor.shop.id, actorUserId: actor.id, action, targetType: "supplier", targetId, details });
}

const isUniqueViolation = (error: unknown) =>
  ((error instanceof DrizzleQueryError ? error.cause : error) as { code?: string } | undefined)?.code === "23505";

// Postgres lower-cases the Supplier ID on both sides, as the unique index
// does, so a match here is a match there.
const sameSupplierId = (supplierId: string) => sql`lower(${suppliers.supplierId}) = lower(${supplierId})`;

// What a search of the list looks through: every field. Every word has to
// be somewhere, any order and any case, as on the other lists.
function supplierSearch(query: string): SQL | undefined {
  const words = listSearchWords(query);
  if (words.length === 0) return undefined;
  const text = sql`concat_ws(' ', ${suppliers.supplierId}, ${suppliers.supplierCode}, ${suppliers.supplierName}, ${suppliers.categoryCode}, ${suppliers.categoryId})`;
  return sql`${text} ilike all (array[${sql.join(
    words.map((word) => sql`${containsPattern(word)}`),
    sql`, `,
  )}]::text[])`;
}

const filters = (query: string, category: string | null) =>
  and(supplierSearch(query), category ? sql`lower(coalesce(${suppliers.categoryCode}, '')) = lower(${category})` : undefined);

// Supplier IDs in order: 2 before 10 when they're numbers, then as text.
const byId = [sql`(${suppliers.supplierId} ~ '^[0-9]{1,15}$') desc`, sql`case when ${suppliers.supplierId} ~ '^[0-9]{1,15}$' then ${suppliers.supplierId}::bigint end`, sql`lower(${suppliers.supplierId})`];

// One page of the list, by Supplier ID, or of what a search (and a
// category) finds. A page past the end gives the last one.
export async function listSuppliers(
  shopId: string,
  { query = "", category = null, page = 1, perPage = SUPPLIER_PAGE_SIZE }: { query?: string; category?: string | null; page?: number; perPage?: number } = {},
): Promise<SupplierList> {
  const where = filters(query, category);
  return withShop(shopId, async (tx) => {
    const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(suppliers).where(where);
    const at = listPage(total, page, perPage);
    const items =
      total === 0
        ? []
        : await tx
            .select(columns)
            .from(suppliers)
            .where(where)
            .orderBy(...byId, asc(suppliers.id))
            .limit(perPage)
            .offset(at.offset);
    return { ...at, total, items };
  });
}

export const MAX_SUPPLIER_EXPORT = 100_000;

// Everything a search (and a category) finds, for the CSV download.
export async function exportSuppliers(shopId: string, { query = "", category = null }: { query?: string; category?: string | null } = {}) {
  return withShop(shopId, (tx) =>
    tx
      .select(columns)
      .from(suppliers)
      .where(filters(query, category))
      .orderBy(...byId, asc(suppliers.id))
      .limit(MAX_SUPPLIER_EXPORT),
  );
}

export async function getSupplier(shopId: string, id: string): Promise<Supplier | null> {
  if (!isUuid(id)) return null;
  const [row] = await withShop(shopId, (tx) => tx.select(columns).from(suppliers).where(eq(suppliers.id, id)));
  return row ?? null;
}

export type Category = { code: string; id: string | null; suppliers: number };

// The categories in use, by code, with the Category ID most suppliers of
// that code have: for the filter, and for filling in a Category ID when a
// code is picked on the form. A code spelt two ways ("DIST", "dist") is
// one, shown as most of its suppliers spell it; a tie goes by byte order
// (collate "C"), so the answer doesn't depend on the database's collation.
export async function listCategories(shopId: string): Promise<Category[]> {
  const rows = await withShop(shopId, (tx) =>
    tx
      .select({
        code: sql<string>`mode() within group (order by ${suppliers.categoryCode} collate "C")`,
        id: sql<string | null>`mode() within group (order by ${suppliers.categoryId} collate "C")`,
        suppliers: sql<number>`count(*)::int`,
      })
      .from(suppliers)
      .where(sql`${suppliers.categoryCode} is not null`)
      .groupBy(sql`lower(${suppliers.categoryCode})`)
      .orderBy(sql`lower(min(${suppliers.categoryCode} collate "C")) collate "C"`),
  );
  return rows;
}

// The Supplier ID a new supplier would get next, when the shop's IDs are
// numbers.
export async function suggestSupplierId(shopId: string): Promise<string | null> {
  const rows = await withShop(shopId, (tx) => tx.select({ supplierId: suppliers.supplierId }).from(suppliers));
  return nextSupplierId(rows.map((row) => row.supplierId));
}

const TAKEN = (supplierId: string, name: string) => ({ error: `Supplier ID ${supplierId} is already ${name}.` });

async function takenBy(tx: ShopTransaction, supplierId: string, except?: string) {
  const [other] = await tx.select({ id: suppliers.id, supplierName: suppliers.supplierName }).from(suppliers).where(sameSupplierId(supplierId));
  return other && other.id !== except ? TAKEN(supplierId, other.supplierName) : null;
}

export async function createSupplier(actor: CurrentUser, input: Partial<Record<keyof SupplierFields, unknown>>): Promise<{ id: string } | { error: string }> {
  const checked = checkSupplier(input);
  if ("error" in checked) return checked;
  const supplier = checked.supplier;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const taken = await takenBy(tx, supplier.supplierId);
      if (taken) return taken;
      const [row] = await tx
        .insert(suppliers)
        .values({ ...supplier, shopId: actor.shop.id, createdByUserId: actor.id })
        .returning({ id: suppliers.id });
      await audit(tx, actor, "supplier.created", row.id, { supplierId: supplier.supplierId, supplierName: supplier.supplierName });
      return { id: row.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: `Supplier ID ${supplier.supplierId} is already in the list.` };
    throw error;
  }
}

export async function updateSupplier(actor: CurrentUser, id: string, input: Partial<Record<keyof SupplierFields, unknown>>): Promise<{ ok: true } | { error: string }> {
  if (!isUuid(id)) return NOT_HERE;
  const checked = checkSupplier(input);
  if ("error" in checked) return checked;
  const supplier = checked.supplier;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const [before] = await tx.select(columns).from(suppliers).where(eq(suppliers.id, id)).for("update");
      if (!before) return NOT_HERE;
      const taken = await takenBy(tx, supplier.supplierId, id);
      if (taken) return taken;
      const fields = SUPPLIER_FIELDS.filter((field) => before[field] !== supplier[field]);
      if (fields.length === 0) return { ok: true as const };
      await tx.update(suppliers).set(supplier).where(eq(suppliers.id, id));
      await audit(tx, actor, "supplier.updated", id, { supplierId: supplier.supplierId, fields });
      return { ok: true as const };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: `Supplier ID ${supplier.supplierId} is already in the list.` };
    throw error;
  }
}

export async function removeSupplier(actor: CurrentUser, id: string): Promise<{ ok: true; supplierName: string } | { error: string }> {
  if (!isUuid(id)) return NOT_HERE;
  return withShop(actor.shop.id, async (tx) => {
    const [removed] = await tx.delete(suppliers).where(eq(suppliers.id, id)).returning({ supplierId: suppliers.supplierId, supplierName: suppliers.supplierName });
    if (!removed) return NOT_HERE;
    await audit(tx, actor, "supplier.removed", id, removed);
    return { ok: true as const, supplierName: removed.supplierName };
  });
}

// Saves one batch of an imported supplier list. Each supplier is checked as
// the form checks it and found by Supplier ID (without case): one on file
// takes the file's values, except that a blank cell leaves what's on file;
// one not on file is added. Importing the same list again changes nothing.
// One import at a time per shop (a lock to the end of the batch). The
// batch is recorded in audit_log as suppliers.imported, with its counts.
export async function importSuppliers(
  actor: CurrentUser,
  input: { importId: unknown; fileName: unknown; suppliers: unknown },
): Promise<{ outcomes: SupplierImportOutcome[] } | { error: string }> {
  if (!isUuid(input.importId)) return { error: "That import couldn't be read. Choose the file again." };
  const list = Array.isArray(input.suppliers) ? (input.suppliers as Record<string, unknown>[]) : null;
  if (!list || list.length === 0) return { error: "There were no suppliers in that batch." };
  if (list.length > MAX_SUPPLIER_BATCH) return { error: "That batch is too big. Reload the page and try again." };
  const fileName = cutText(typeof input.fileName === "string" ? input.fileName.replace(/\u0000/g, "") : "", 255);
  const checked = list.map((entry) => ({
    row: Number.isInteger(entry?.row) ? Number(entry.row) : 0,
    supplier: checkSupplier(entry && typeof entry === "object" ? entry : {}),
  }));

  return withShop(actor.shop.id, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('supplier-import'), hashtext(${actor.shop.id}))`);
    const keys = [...new Set(checked.flatMap(({ supplier }) => ("supplier" in supplier ? [supplier.supplier.supplierId] : [])))];
    const onFile = keys.length
      ? await tx
          .select(columns)
          .from(suppliers)
          .where(
            sql`lower(${suppliers.supplierId}) in (select lower(k) from unnest(array[${sql.join(
              keys.map((key) => sql`${key}`),
              sql`, `,
            )}]::text[]) k)`,
          )
      : [];
    const byKey = new Map(onFile.map((supplier) => [supplierKey(supplier.supplierId), supplier]));
    const outcomes: SupplierImportOutcome[] = [];
    const added: (typeof suppliers.$inferInsert)[] = [];
    let updated = 0;
    for (const entry of checked) {
      if ("error" in entry.supplier) {
        outcomes.push({ row: entry.row, result: "failed", error: entry.supplier.error });
        continue;
      }
      const incoming = entry.supplier.supplier;
      const existing = byKey.get(supplierKey(incoming.supplierId));
      if (!existing) {
        added.push({ ...incoming, shopId: actor.shop.id, createdByUserId: actor.id });
        // The same ID twice in one batch is one supplier.
        byKey.set(supplierKey(incoming.supplierId), { ...incoming, id: "", updatedAt: new Date() });
        outcomes.push({ row: entry.row, result: "created", error: null });
        continue;
      }
      // A blank cell leaves what's on file.
      const changes = Object.fromEntries(
        SUPPLIER_FIELDS.filter((field) => incoming[field] !== null && incoming[field] !== existing[field]).map((field) => [field, incoming[field]]),
      ) as Partial<SupplierFields>;
      if (Object.keys(changes).length === 0 || !existing.id) {
        outcomes.push({ row: entry.row, result: existing.id ? "unchanged" : "created", error: null });
        continue;
      }
      await tx.update(suppliers).set(changes).where(eq(suppliers.id, existing.id));
      Object.assign(existing, changes);
      updated++;
      outcomes.push({ row: entry.row, result: "updated", error: null });
    }
    for (let at = 0; at < added.length; at += 500) await tx.insert(suppliers).values(added.slice(at, at + 500));
    const count = (result: SupplierImportOutcome["result"]) => outcomes.filter((outcome) => outcome.result === result).length;
    await audit(tx, actor, "suppliers.imported", String(input.importId), {
      fileName,
      created: added.length,
      updated,
      unchanged: count("unchanged"),
      failed: count("failed"),
    });
    return { outcomes };
  });
}
