"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { unstable_rethrow } from "next/navigation";

import { importSales } from "@/lib/nusr-import";
import type { NusrImportOutcome } from "@/lib/nusr-import-rules";
import { requireCapability } from "@/lib/session";

// Every action re-checks the permission: server actions can be called
// directly, not just from this page. Unexpected failures (a dropped
// database connection, say) come back as a message instead of an error
// page; Next.js's own redirects pass straight through.
async function attempt<T extends object>(what: string, run: () => Promise<T>, failed: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    // A DrizzleQueryError's message lists the query parameters: the
    // customers' names and phone numbers. Only log the database's own error.
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return failed;
  }
}

// One batch of an import (see src/lib/nusr-import-rules.ts); the browser
// sends them one after another, each with the sales on file the batches
// before it found.
export async function importSalesAction(input: {
  importId: string;
  fileName: string;
  sales: unknown;
  found: string[];
}): Promise<{ outcomes: NusrImportOutcome[]; found: string[] } | { error: string }> {
  return attempt<{ outcomes: NusrImportOutcome[]; found: string[] } | { error: string }>(
    "import sales",
    async () => {
      const user = await requireCapability("sales.log");
      return importSales(user, { importId: input?.importId, fileName: input?.fileName, sales: input?.sales, found: input?.found });
    },
    { error: "Couldn't save that batch. Check the connection and try again." },
  );
}
