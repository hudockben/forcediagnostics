// Checks the per-account sign-in limit. Needs DATABASE_URL pointing at a
// disposable Postgres database; run with `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { systemDb } from "../src/db";
import {
  ACCOUNT_ATTEMPT_LIMIT,
  clearSignInAttempts,
  recordSignInAttempt,
} from "../src/lib/sign-in-throttle";

const username = `test${randomUUID().slice(0, 8)}.mike`;

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
