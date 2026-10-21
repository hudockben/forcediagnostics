// Applies pending migrations in ./drizzle. Vercel runs this before every build
// (see vercel.json), so production migrates the main database and each
// preview deployment migrates its own Neon branch.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// Migrations use the direct (unpooled) connection, as Neon recommends.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!url) {
  console.warn("migrate: no DATABASE_URL set, skipping database migrations");
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle({ client: pool }), { migrationsFolder: "drizzle" });
  console.log("migrate: database is up to date");
} finally {
  await pool.end();
}
