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

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  // Two builds deploying at once take turns instead of racing to apply the
  // same migration. The lock is released when the connection closes.
  await client.query("select pg_advisory_lock(hashtext('forcediagnostics:migrate'))");
  await migrate(drizzle({ client }), { migrationsFolder: "drizzle" });
  console.log("migrate: database is up to date");
} finally {
  await client.end();
}
