import { DrizzleQueryError } from "drizzle-orm";

import { timesWorkbook } from "@/lib/diagnosis-times-export";
import { parseTimesParams, timesFileName } from "@/lib/diagnosis-times-rules";
import { diagnosisTimes } from "@/lib/diagnosis-times";
import { attachmentHeader } from "@/lib/nusr-export";
import { SHOP_TIME_ZONE, shopToday } from "@/lib/nusr-rules";
import { allows, lookupCurrentUser } from "@/lib/session";
import { writeXlsx } from "@/lib/xlsx-write";

// Diagnosis times' Download Excel: the period as the page shows it (the same
// ?view=, ?on= and ?group=), as a workbook.
export async function GET(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) return Response.redirect(new URL(lookup.redirectTo, request.url), 303);
  if (!allows(lookup.user, "reports.kpis")) return new Response("Your role can't see how long diagnoses take.", { status: 403 });

  const search = new URL(request.url).searchParams;
  const query = Object.fromEntries([...new Set(search.keys())].map((key) => [key, search.getAll(key)]));
  const today = shopToday();
  const params = parseTimesParams(query, today);
  try {
    const result = await diagnosisTimes(lookup.user, params);
    if ("error" in result) return new Response(result.error, { status: 403 });
    const now = new Date();
    const sheets = timesWorkbook(params, result, { generatedAt: now, timeZone: SHOP_TIME_ZONE });
    const fileName = timesFileName(params, today);
    return new Response(writeXlsx(sheets, { title: fileName.replace(/\.xlsx$/, ""), created: now }), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": attachmentHeader(fileName),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    // A DrizzleQueryError's message lists the query parameters.
    console.error("Couldn't write the diagnosis times", error instanceof DrizzleQueryError ? error.cause : error);
    return new Response("Couldn't make the workbook. Try again.", { status: 500 });
  }
}
