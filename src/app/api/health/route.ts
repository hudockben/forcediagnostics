import { sql } from "drizzle-orm";
import { connection } from "next/server";

import { db, isDatabaseConfigured } from "@/db";

// Reports whether the app can reach the database. Used to confirm the Neon
// hookup after deploys; it never exposes connection details or error text.
export async function GET() {
  await connection();
  const region = process.env.VERCEL_REGION ?? "local";

  if (!isDatabaseConfigured) {
    return Response.json(
      { ok: false, database: "not configured", region },
      { status: 503 },
    );
  }

  const started = performance.now();
  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    console.error("Database health check failed", error);
    return Response.json({ ok: false, database: "unreachable", region }, { status: 503 });
  }
  return Response.json({
    ok: true,
    database: "connected",
    region,
    latencyMs: Math.round(performance.now() - started),
  });
}
