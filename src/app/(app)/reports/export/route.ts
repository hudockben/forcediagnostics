import { DrizzleQueryError } from "drizzle-orm";

import { attachmentHeader } from "@/lib/nusr-export";
import { SHOP_TIME_ZONE, shopToday } from "@/lib/nusr-rules";
import { bonusWorkbook } from "@/lib/report-export";
import { bonusesFileName, parseReportParams } from "@/lib/report-rules";
import { bonusSales } from "@/lib/reports";
import { allows, lookupCurrentUser } from "@/lib/session";
import { writeXlsx } from "@/lib/xlsx-write";

// Reports' Download Excel: the salesmen's bonuses as the page shows them
// (the same ?view=, ?on= and ?by=), as a workbook.
export async function GET(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) return Response.redirect(new URL(lookup.redirectTo, request.url), 303);
  if (!allows(lookup.user, "sales.log")) return new Response("Your role can't see the salesmen's bonuses.", { status: 403 });

  const search = new URL(request.url).searchParams;
  const query = Object.fromEntries([...new Set(search.keys())].map((key) => [key, search.getAll(key)]));
  const today = shopToday();
  const params = parseReportParams(query, today);
  try {
    const result = await bonusSales(lookup.user, params);
    if ("error" in result) return new Response(result.error, { status: 403 });
    const now = new Date();
    const sheets = bonusWorkbook(params, result.sales, { generatedAt: now, timeZone: SHOP_TIME_ZONE });
    const fileName = bonusesFileName(params, today);
    return new Response(writeXlsx(sheets, { title: fileName.replace(/\.xlsx$/, ""), created: now }), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": attachmentHeader(fileName),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    // A DrizzleQueryError's message lists the query parameters.
    console.error("Couldn't write the bonus report", error instanceof DrizzleQueryError ? error.cause : error);
    return new Response("Couldn't make the workbook. Try again.", { status: 500 });
  }
}
