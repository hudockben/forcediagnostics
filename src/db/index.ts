import "server-only";

import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// Set on Vercel by the Neon integration: the pooled connection string.
const connectionString = process.env.DATABASE_URL;

export const isDatabaseConfigured = Boolean(connectionString);

// A TCP connection pool per function instance, as Neon recommends for Vercel
// Fluid compute. attachDatabasePool lets idle connections close before Vercel
// suspends the instance.
const pool = new Pool({ connectionString });
attachDatabasePool(pool);

export const db = drizzle({ client: pool });
