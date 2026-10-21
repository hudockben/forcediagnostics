// Checks the per-account sign-in limit and that Better Auth's own rate-limit
// cleanup can't erase it. Needs DATABASE_URL pointing at a disposable Postgres
// database; run with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { eq } from "drizzle-orm";

import { systemDb } from "../src/db";
import { attemptCounters, rateLimits } from "../src/db/schema";
import { giveBackAttempt, takeAttempt } from "../src/lib/attempts";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  clearSignInAttempts,
  takeSignInAttempt,
} from "../src/lib/sign-in-throttle";

const username = `test${randomUUID().slice(0, 8)}.mike`;

after(async () => {
  await clearSignInAttempts(username);
  await systemDb.$client.end();
});

test("allows the limit per account, whatever the letter case, then refuses", async () => {
  for (let attempt = 1; attempt <= ACCOUNT_ATTEMPT_LIMIT; attempt++) {
    const name = attempt % 2 ? username : username.toUpperCase();
    const result = await takeSignInAttempt(name);
    assert.deepEqual(result, { allowed: true, count: attempt });
  }
  const refused = await takeSignInAttempt(username);
  assert.equal(refused.allowed, false);
  // Being refused doesn't count or extend the window.
  const [row] = await systemDb
    .select()
    .from(attemptCounters)
    .where(eq(attemptCounters.key, `account|${username}`));
  assert.equal(row.count, ACCOUNT_ATTEMPT_LIMIT);
});

test("survives Better Auth pruning its rate_limits table", async () => {
  // Better Auth deletes every rate_limits row older than its longest window.
  await systemDb.delete(rateLimits);
  assert.equal((await takeSignInAttempt(username)).allowed, false);
});

test("a successful sign-in clears the count", async () => {
  await clearSignInAttempts(username);
  assert.deepEqual(await takeSignInAttempt(username), { allowed: true, count: 1 });
});

test("a new window starts after the old one ends", async () => {
  const key = `test|${randomUUID()}`;
  assert.equal((await takeAttempt(key, 1, 50)).allowed, true);
  assert.equal((await takeAttempt(key, 1, 50)).allowed, false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(await takeAttempt(key, 1, 50), { allowed: true, count: 1 });
  await giveBackAttempt(key);
  assert.deepEqual(await takeAttempt(key, 1, 50), { allowed: true, count: 1 });
});

test("many attempts at once never get past the limit", async () => {
  const key = `test|${randomUUID()}`;
  const results = await Promise.all(Array.from({ length: 25 }, () => takeAttempt(key, 10, 60_000)));
  assert.equal(results.filter((r) => r.allowed).length, 10);
});
