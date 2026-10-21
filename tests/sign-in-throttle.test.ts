// Checks the per-account sign-in limit. Needs DATABASE_URL pointing at a
// disposable Postgres database; run with `npm test`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { systemDb } from "../src/db";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  clearSignInAttempts,
  recordSignInAttempt,
} from "../src/lib/sign-in-throttle";

const username = `test${randomUUID().slice(0, 8)}.mike`;

before(() => migrate(systemDb, { migrationsFolder: "drizzle" }));
after(async () => {
  await clearSignInAttempts(username);
  await systemDb.$client.end();
});

test("counts attempts per account, whatever the letter case", async () => {
  for (let attempt = 1; attempt <= ACCOUNT_ATTEMPT_LIMIT + 1; attempt++) {
    const name = attempt % 2 ? username : username.toUpperCase();
    assert.equal(await recordSignInAttempt(name), attempt);
  }
});

test("a successful sign-in clears the count", async () => {
  await clearSignInAttempts(username);
  assert.equal(await recordSignInAttempt(username), 1);
});
