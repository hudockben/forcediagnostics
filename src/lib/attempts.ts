import "server-only";

import { eq, lt, sql } from "drizzle-orm";

import { systemDb } from "@/db";
import { attemptCounters } from "@/db/schema";

// Fixed-window attempt counters for the app's own limits, stored in
// attempt_counters (Better Auth prunes its own rate_limits table after about a
// minute, so it can't hold these).

export type AttemptResult =
  | { allowed: true; count: number }
  | { allowed: false; retryAfterMs: number };

const DAY_MS = 24 * 60 * 60 * 1000;

// Takes one attempt for `key` if fewer than `limit` have been taken in the
// current window. A refused attempt doesn't count or extend the window, so
// pressing again while blocked doesn't keep you blocked.
export async function takeAttempt(
  key: string,
  limit: number,
  windowMs: number,
): Promise<AttemptResult> {
  const now = Date.now();
  const staleBefore = now - windowMs;
  const result = await systemDb.execute<{ count: number; fresh: boolean }>(sql`
    insert into ${attemptCounters} (key, count, window_started_at, last_attempt_at)
    values (${key}, 1, ${now}, ${now})
    on conflict (key) do update set
      count = case when ${attemptCounters.windowStartedAt} <= ${staleBefore} then 1
                   else ${attemptCounters.count} + 1 end,
      window_started_at = case when ${attemptCounters.windowStartedAt} <= ${staleBefore} then ${now}
                               else ${attemptCounters.windowStartedAt} end,
      last_attempt_at = ${now}
    where ${attemptCounters.windowStartedAt} <= ${staleBefore} or ${attemptCounters.count} < ${limit}
    returning count, (window_started_at = ${now}) as fresh
  `);
  const row = result.rows[0];
  if (row) {
    // When a key starts a new window, sweep out counters nobody has used for a
    // day, so made-up usernames can't grow the table forever.
    if (row.fresh) {
      await systemDb.delete(attemptCounters).where(lt(attemptCounters.lastAttemptAt, now - DAY_MS));
    }
    return { allowed: true, count: Number(row.count) };
  }
  const [blocked] = await systemDb
    .select({ windowStartedAt: attemptCounters.windowStartedAt })
    .from(attemptCounters)
    .where(eq(attemptCounters.key, key));
  return {
    allowed: false,
    retryAfterMs: Math.max(0, (blocked?.windowStartedAt ?? now) + windowMs - now),
  };
}

// Gives back an attempt taken with takeAttempt, for limits that should only
// count failures (take before checking, give back on success).
export async function giveBackAttempt(key: string) {
  await systemDb
    .update(attemptCounters)
    .set({ count: sql`greatest(${attemptCounters.count} - 1, 0)` })
    .where(eq(attemptCounters.key, key));
}

export async function clearAttempts(key: string) {
  await systemDb.delete(attemptCounters).where(eq(attemptCounters.key, key));
}
