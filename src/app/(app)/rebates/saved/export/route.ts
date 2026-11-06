import { DrizzleQueryError } from "drizzle-orm";

import { shopYear } from "@/lib/nusr-rules";
import { parseRebateFilters } from "@/lib/rebate-rules";
import { savedRebatesDownload } from "@/lib/rebates";
import { allows, lookupCurrentUser } from "@/lib/session";

// The saved rebates the filters find (the same ?year=, ?month=, ?column=
// and the rest as the Rebates tab's), as the workbook the tab makes for
// invoices: the NUSR sheet with the rebates in AO, AP and AQ, and the
// Rebates sheet.
export async function GET(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) return Response.redirect(new URL(lookup.redirectTo, request.url), 303);
  if (!allows(lookup.user, "sales.log")) return new Response("Your role can't open the NUSR.", { status: 403 });
  const search = new URL(request.url).searchParams;
  const query = Object.fromEntries([...new Set(search.keys())].map((key) => [key, search.getAll(key)]));
  try {
    const result = await savedRebatesDownload(lookup.user, parseRebateFilters(query, shopYear()));
    if ("error" in result) return new Response(result.error, { status: 403 });
    return new Response(result.bytes, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": result.contentDisposition,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    // A DrizzleQueryError's message lists the query parameters.
    console.error("Couldn't write the saved rebates", error instanceof DrizzleQueryError ? error.cause : error);
    return new Response("Couldn't make the workbook. Try again.", { status: 500 });
  }
}
