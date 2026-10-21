// Checks that row-level security keeps each shop's data private, even when a
// query forgets to filter by shop. Needs DATABASE_URL pointing at a disposable
// Postgres database; run with `npm test`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { systemDb, withShop } from "../src/db";
import { locations, shops, users } from "../src/db/schema";

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
let shopA: string;
let shopB: string;

async function createShop(code: string) {
  const [shop] = await systemDb
    .insert(shops)
    .values({ code, name: `Shop ${code}` })
    .returning({ id: shops.id });
  await systemDb.insert(locations).values({ shopId: shop.id, name: "Main" });
  await systemDb.insert(users).values({
    id: randomUUID(),
    shopId: shop.id,
    role: "tech",
    name: "Mike",
    username: `${code}.mike`,
    email: `${randomUUID()}@no-email.invalid`,
  });
  return shop.id;
}

before(async () => {
  await migrate(systemDb, { migrationsFolder: "drizzle" });
  shopA = await createShop(`a${suffix}`);
  shopB = await createShop(`b${suffix}`);
});

after(async () => {
  await systemDb.delete(shops).where(eq(shops.id, shopA));
  await systemDb.delete(shops).where(eq(shops.id, shopB));
  await systemDb.$client.end();
});

describe("withShop", () => {
  test("only sees its own shop, locations and users", async () => {
    await withShop(shopA, async (tx) => {
      const visibleShops = await tx.select({ id: shops.id }).from(shops);
      assert.deepEqual(
        visibleShops.map((s) => s.id),
        [shopA],
      );

      const visibleLocations = await tx.select({ shopId: locations.shopId }).from(locations);
      assert.ok(visibleLocations.length > 0);
      assert.ok(visibleLocations.every((l) => l.shopId === shopA));

      const visibleUsers = await tx.select({ shopId: users.shopId }).from(users);
      assert.ok(visibleUsers.length > 0);
      assert.ok(visibleUsers.every((u) => u.shopId === shopA));
    });
  });

  test("can't read another shop's rows by asking for them", async () => {
    const rows = await withShop(shopA, (tx) =>
      tx.select().from(locations).where(eq(locations.shopId, shopB)),
    );
    assert.equal(rows.length, 0);
  });

  test("can't write rows into another shop", async () => {
    await assert.rejects(
      withShop(shopA, (tx) => tx.insert(locations).values({ shopId: shopB, name: "Sneaky" })),
      (error: Error & { cause?: { code?: string } }) =>
        // 42501: row violates the row-level security policy
        error.cause?.code === "42501",
    );
  });

  test("can't change or delete another shop's rows", async () => {
    const updated = await withShop(shopA, (tx) =>
      tx
        .update(locations)
        .set({ name: "Renamed" })
        .where(eq(locations.shopId, shopB))
        .returning(),
    );
    assert.equal(updated.length, 0);

    const deleted = await withShop(shopA, (tx) =>
      tx.delete(locations).where(eq(locations.shopId, shopB)).returning(),
    );
    assert.equal(deleted.length, 0);
  });

  test("has no access to sessions or password hashes", async () => {
    for (const table of ["sessions", "accounts", "verifications", "rate_limits"]) {
      await assert.rejects(
        withShop(shopA, (tx) => tx.execute(sql.raw(`select * from "${table}"`))),
        (error: Error & { cause?: { code?: string } }) =>
          // 42501: permission denied
          error.cause?.code === "42501",
        table,
      );
    }
  });

  test("sees nothing when no shop is set", async () => {
    const rows = await systemDb.transaction(async (tx) => {
      await tx.execute(sql`set local role app_user`);
      return tx.select().from(locations);
    });
    assert.equal(rows.length, 0);
  });

  test("hands the connection back as the owner afterwards", async () => {
    await withShop(shopA, (tx) => tx.select().from(shops));
    const result = await systemDb.execute<{ role: string }>(sql`select current_user as role`);
    assert.notEqual(result.rows[0].role, "app_user");
  });
});
