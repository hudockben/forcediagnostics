import "server-only";

import { randomUUID } from "node:crypto";

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
  numericSupplierId,
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

const textArray = (values: string[]) =>
  sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;

// Saves one batch of an imported supplier list. Each supplier is checked as
// the form checks it and found by Supplier ID (without case, lower-cased by
// Postgres as the unique index does: it and JavaScript don't lower-case
// every letter alike). An all-digit ID with no exact match takes the one
// on file with the same number, when there's only one: a spreadsheet opening
// the list reads "0042" as 42. One on file takes the file's values, except
// that a blank cell leaves what's on file; one not on file is added.
// Importing the same list again changes nothing. One import at a time per
// shop (a lock to the end of the batch), and the suppliers it matched are
// locked too, so one removed or renumbered meanwhile is added rather than
// lost. The batch is recorded in audit_log as suppliers.imported, with its
// counts and the suppliers it added.
export async function importSuppliers(
  actor: CurrentUser,
  input: { importId: unknown; fileName: unknown; suppliers: unknown },
): Promise<{ outcomes: SupplierImportOutcome[] } | { error: string }> {
  if (!isUuid(input.importId)) return { error: "That import couldn't be read. Choose the file again." };
  const importId = input.importId;
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
    const ids = [...new Set(checked.flatMap(({ supplier }) => ("supplier" in supplier ? [supplier.supplier.supplierId] : [])))];
    const numbers = [...new Set(ids.map(numericSupplierId).filter((value) => value !== null))];
    const keyOf = new Map<string, string>();
    let onFile: (Supplier & { key: string })[] = [];
    if (ids.length > 0) {
      const keys = await tx.execute<{ id: string; key: string }>(sql`select k as id, lower(k) as key from unnest(${textArray(ids)}) k`);
      for (const { id, key } of keys.rows) keyOf.set(id, key);
      const asNumber = sql`case when ${suppliers.supplierId} ~ '^[0-9]{1,15}$' then ${suppliers.supplierId}::bigint end`;
      onFile = await tx
        .select({ ...columns, key: sql<string>`lower(${suppliers.supplierId})` })
        .from(suppliers)
        .where(
          sql`lower(${suppliers.supplierId}) in (select lower(k) from unnest(${textArray(ids)}) k)${
            numbers.length > 0 ? sql` or ${asNumber} = any(array[${sql.join(numbers.map((value) => sql`${value}`), sql`, `)}]::bigint[])` : sql``
          }`,
        )
        .for("update");
    }
    const byKey = new Map(onFile.map((supplier) => [supplier.key, supplier]));
    const batchKeys = new Set(keyOf.values());
    const byNumber = new Map<number, (Supplier & { key: string })[]>();
    for (const supplier of onFile) {
      const value = numericSupplierId(supplier.supplierId);
      // One the batch names exactly is that row's, not a stand-in.
      if (value === null || batchKeys.has(supplier.key)) continue;
      byNumber.set(value, [...(byNumber.get(value) ?? []), supplier]);
    }

    // Each row's supplier: the one on file it matches, or a new one by its
    // key. Two rows for one supplier: the later is the one used, as the
    // browser's plan has it.
    const outcomes: (SupplierImportOutcome | null)[] = checked.map(() => null);
    const targets = checked.map((entry, index) => {
      if ("error" in entry.supplier) {
        outcomes[index] = { row: entry.row, result: "failed", error: entry.supplier.error };
        return null;
      }
      const incoming = entry.supplier.supplier;
      const key = keyOf.get(incoming.supplierId) ?? incoming.supplierId;
      const value = numericSupplierId(incoming.supplierId);
      const sameNumber = value === null ? [] : (byNumber.get(value) ?? []);
      const existing = byKey.get(key) ?? (sameNumber.length === 1 ? sameNumber[0] : undefined);
      return { incoming, existing, target: existing ? `on file ${existing.id}` : `new ${key}` };
    });
    const lastFor = new Map<string, number>();
    targets.forEach((target, index) => target && lastFor.set(target.target, index));

    // Suppliers an earlier try of this import added, when Carry on sends a
    // batch again whose answer was lost: they were added, not already there.
    const addedBefore = new Set(
      (
        await tx
          .select({ id: sql<string>`jsonb_array_elements_text(${auditLog.details} -> 'createdIds')` })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, "suppliers.imported"),
              eq(auditLog.targetId, importId),
              eq(auditLog.actorUserId, actor.id),
              sql`${auditLog.createdAt} > now() - interval '1 day'`,
            ),
          )
      ).map((row) => row.id),
    );

    const added: { index: number; values: typeof suppliers.$inferInsert }[] = [];
    let updated = 0;
    for (const [index, target] of targets.entries()) {
      if (!target) continue;
      const entry = checked[index];
      const later = lastFor.get(target.target)!;
      if (later !== index) {
        outcomes[index] = { row: entry.row, result: "failed", error: `Supplier ID ${target.incoming.supplierId} is the same supplier as row ${checked[later].row}, which is the one used.` };
        continue;
      }
      const { incoming, existing } = target;
      if (!existing) {
        const id = randomUUID();
        added.push({ index, values: { ...incoming, id, shopId: actor.shop.id, createdByUserId: actor.id } });
        outcomes[index] = { row: entry.row, result: "created", error: null };
        continue;
      }
      // A blank cell leaves what's on file, and so does the ID a number
      // matched ("0042" stays as it is).
      const changes = Object.fromEntries(
        SUPPLIER_FIELDS.filter((field) => incoming[field] !== null && incoming[field] !== existing[field] && !(field === "supplierId" && existing.key !== keyOf.get(incoming.supplierId))).map(
          (field) => [field, incoming[field]],
        ),
      ) as Partial<SupplierFields>;
      if (Object.keys(changes).length === 0) {
        outcomes[index] = { row: entry.row, result: addedBefore.has(existing.id) ? "created" : "unchanged", error: null };
        continue;
      }
      await tx.update(suppliers).set(changes).where(eq(suppliers.id, existing.id));
      updated++;
      outcomes[index] = { row: entry.row, result: "updated", error: null };
    }

    // One added by someone else since this batch looked is left out with a
    // note, rather than failing the batch.
    const inserted = added.length
      ? new Set(
          (
            await tx
              .insert(suppliers)
              .values(added.map(({ values }) => values))
              .onConflictDoNothing()
              .returning({ id: suppliers.id })
          ).map((row) => row.id),
        )
      : new Set<string>();
    for (const { index, values } of added) {
      if (inserted.has(values.id!)) continue;
      outcomes[index] = {
        row: checked[index].row,
        result: "failed",
        error: `Supplier ID ${values.supplierId} was added by someone else during the import. Import the list again to bring in this row.`,
      };
    }

    const done = outcomes as SupplierImportOutcome[];
    const count = (result: SupplierImportOutcome["result"]) => done.filter((outcome) => outcome.result === result).length;
    await audit(tx, actor, "suppliers.imported", importId, {
      fileName,
      created: inserted.size,
      updated,
      unchanged: count("unchanged"),
      failed: count("failed"),
      createdIds: [...inserted],
    });
    return { outcomes: done };
  });
}
