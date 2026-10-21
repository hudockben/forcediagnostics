import "server-only";

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { systemDb } from "@/db";
import { rateLimits } from "@/db/schema";

// Better Auth limits sign-in attempts per IP address. This adds a limit per
// account, so guessing one person's password from many addresses still stops.
export const ACCOUNT_ATTEMPT_LIMIT = 10;
const WINDOW_MS = 15 * 60 * 1000;

const keyFor = (username: string) => `account|${username.trim().toLowerCase()}`;

// Counts an attempt and returns how many there have been for this account in
// the current window. The window restarts after 15 quiet minutes.
export async function recordSignInAttempt(username: string): Promise<number> {
  const now = Date.now();
  const result = await systemDb.execute<{ count: number }>(sql`
    insert into ${rateLimits} (id, key, count, last_request)
    values (${randomUUID()}, ${keyFor(username)}, 1, ${now})
    on conflict (key) do update set
      count = case
        when ${rateLimits.lastRequest} < ${now - WINDOW_MS} then 1
        else ${rateLimits.count} + 1
      end,
      last_request = ${now}
    returning count
  `);
  return Number(result.rows[0].count);
}

// A successful sign-in clears the count.
export async function clearSignInAttempts(username: string) {
  await systemDb.delete(rateLimits).where(eq(rateLimits.key, keyFor(username)));
}
