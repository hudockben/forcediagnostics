import "server-only";

import { and, asc, desc, inArray, sql, type SQL } from "drizzle-orm";

import { withShop } from "@/db";
import { auditLog } from "@/db/schema";
import { AUDIT_AREAS, AUDIT_LOG_PAGE_SIZE, type AuditArea, type AuditLogCheck, type AuditLogEntry } from "@/lib/audit-log-rules";
import { containsPattern, listPage, listSearchWords, type ListPage } from "@/lib/diagnose-list-rules";

// System Admin > Activity log: the shop's audit_log, for reading only.
// Callers check audit.read first; everything here runs inside withShop for
// the user's own shop. Nothing in the app changes or deletes an entry, and
// the database wouldn't let it (drizzle/0035_audit_log_locked.sql).

export type AuditLogPage = ListPage & { items: AuditLogEntry[]; total: number };

const entryColumns = {
  id: auditLog.id,
  seq: auditLog.seq,
  createdAt: auditLog.createdAt,
  actorUserId: auditLog.actorUserId,
  actorName: auditLog.actorName,
  action: auditLog.action,
  targetType: auditLog.targetType,
  targetId: auditLog.targetId,
  details: auditLog.details,
  hash: auditLog.hash,
  prevHash: auditLog.prevHash,
};

// What a search of the log looks through: who, the kind of entry, the
// record it's on and everything it says. Every word has to be somewhere,
// any order and any case, as on the other lists.
function logSearch(query: string): SQL | undefined {
  const words = listSearchWords(query);
  if (words.length === 0) return undefined;
  const text = sql`concat_ws(' ', ${auditLog.actorName}, ${auditLog.action}, ${auditLog.targetId}, ${auditLog.details}::text)`;
  return sql`${text} ilike all (array[${sql.join(
    words.map((word) => sql`${containsPattern(word)}`),
    sql`, `,
  )}]::text[])`;
}

const filters = (query: string, area: AuditArea | null) =>
  and(logSearch(query), area ? inArray(auditLog.targetType, [...AUDIT_AREAS[area].targetTypes]) : undefined);

// One page of the log, the newest first by the seal's numbers (an entry
// never sealed, which the check flags, comes before them), or of what a
// search (and an area) finds. A page past the end gives the last one.
export async function listAuditLog(
  shopId: string,
  {
    query = "",
    area = null,
    page = 1,
    perPage = AUDIT_LOG_PAGE_SIZE,
  }: { query?: string; area?: AuditArea | null; page?: number; perPage?: number } = {},
): Promise<AuditLogPage> {
  const where = filters(query, area);
  return withShop(shopId, async (tx) => {
    const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(auditLog).where(where);
    const at = listPage(total, page, perPage);
    const items =
      total === 0
        ? []
        : await tx
            .select(entryColumns)
            .from(auditLog)
            .where(where)
            .orderBy(sql`${auditLog.seq} desc nulls first`, desc(auditLog.createdAt), desc(auditLog.id))
            .limit(perPage)
            .offset(at.offset);
    return { ...at, total, items };
  });
}

export const MAX_EXPORT_ROWS = 100_000;

// Everything a search (and an area) finds, for the CSV download, the
// oldest first, as a log is read.
export async function exportAuditLog(
  shopId: string,
  { query = "", area = null }: { query?: string; area?: AuditArea | null } = {},
): Promise<AuditLogEntry[]> {
  return withShop(shopId, (tx) =>
    tx
      .select(entryColumns)
      .from(auditLog)
      .where(filters(query, area))
      .orderBy(sql`${auditLog.seq} asc nulls last`, asc(auditLog.createdAt), asc(auditLog.id))
      .limit(MAX_EXPORT_ROWS),
  );
}

// Checks each of the shop's entries against its seal, in order: its hash is
// still over what it says (nothing in it changed), its number follows the
// one before (nothing taken out), and the entry before it is the one it
// was sealed after. The database works the hashes out (audit_log_hash) as
// the seal did.
export async function verifyAuditLog(shopId: string): Promise<AuditLogCheck> {
  const result = await withShop(shopId, (tx) =>
    tx.execute<{
      entries: number;
      unsealed: number;
      broken_seq: number | null;
      broken_reason: "changed" | "missing" | "relinked" | null;
      last_seq: number | null;
      last_hash: string | null;
      last_at: Date | null;
    }>(sql`
      with chain as (
        select seq, hash, prev_hash, created_at,
          hash is not distinct from audit_log_hash(audit_log) as intact,
          lag(hash) over (order by seq) as before,
          row_number() over (order by seq) as position
        from audit_log
        where shop_id = ${shopId} and seq is not null
      ),
      broken as (
        select seq,
          case when seq <> position then 'missing' when not intact then 'changed' else 'relinked' end as reason
        from chain
        where seq <> position or not intact or prev_hash is distinct from before
        order by seq
        limit 1
      ),
      last as (
        select seq, hash, created_at from chain order by seq desc limit 1
      )
      select
        (select count(*) from chain)::int as entries,
        (select count(*) from audit_log where shop_id = ${shopId} and seq is null)::int as unsealed,
        (select seq from broken)::int as broken_seq,
        (select reason from broken) as broken_reason,
        (select seq from last)::int as last_seq,
        (select hash from last) as last_hash,
        (select created_at from last) as last_at
    `),
  );
  const [row] = result.rows;
  return {
    entries: row.entries,
    unsealed: row.unsealed,
    broken: row.broken_seq !== null && row.broken_reason ? { seq: row.broken_seq, reason: row.broken_reason } : null,
    last:
      row.last_seq !== null && row.last_hash && row.last_at
        ? { seq: row.last_seq, hash: row.last_hash, createdAt: new Date(row.last_at) }
        : null,
  };
}
