import "server-only";

import { attachDatabasePool } from "@vercel/functions";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

// Set on Vercel by the Neon integration: the pooled connection string.
const connectionString = process.env.DATABASE_URL;

export const isDatabaseConfigured = Boolean(connectionString);

// A TCP connection pool per function instance, as Neon recommends for Vercel
// Fluid compute. attachDatabasePool lets idle connections close before Vercel
// suspends the instance.
const pool = new Pool({ connectionString });
attachDatabasePool(pool);

// Connects as the database owner, which bypasses row-level security. Only for
// sign-in, first-run setup and other code that works across shops by design.
// Everything shop-specific goes through withShop.
export const systemDb = drizzle({ client: pool, schema });

export type ShopTransaction = Parameters<Parameters<typeof systemDb.transaction>[0]>[0];

// Runs queries as app_user with the shop set for this transaction only, so
// row-level security limits every read and write to that shop.
export function withShop<T>(
  shopId: string,
  run: (tx: ShopTransaction) => Promise<T>,
): Promise<T> {
  return systemDb.transaction(async (tx) => {
    await tx.execute(sql`set local role app_user`);
    await tx.execute(sql`select set_config('app.shop_id', ${shopId}, true)`);
    return run(tx);
  });
}
