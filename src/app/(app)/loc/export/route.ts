import { listLocUnits } from "@/lib/loc";
import { locFileName, locWorkbook } from "@/lib/loc-export";
import { locFiltersTitle, parseLocFilters } from "@/lib/loc-rules";
import { attachmentHeader } from "@/lib/nusr-export";
import { shopToday } from "@/lib/nusr-rules";
import { allows, lookupCurrentUser } from "@/lib/session";
import { writeXlsx } from "@/lib/xlsx-write";

// The LOC as an Excel workbook (Download Excel on the LOC tab), as
// filtered there: the shop's LOC sheet, its sections and live totals.
export async function GET(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) return Response.redirect(new URL(lookup.redirectTo, request.url), 303);
  if (!allows(lookup.user, "sales.log")) return new Response("Your role can't open the LOC.", { status: 403 });

  const params = new URL(request.url).searchParams;
  // As a page's searchParams has them, so the download finds what the list
  // shows.
  const filters = parseLocFilters(Object.fromEntries([...new Set(params.keys())].map((key) => [key, params.getAll(key)])));
  const today = shopToday();
  const { units } = await listLocUnits(lookup.user.shop.id, filters, today);
  const title = locFiltersTitle(filters);
  const now = new Date();
  const workbook = writeXlsx(locWorkbook(units, { title, today, grouped: filters.show === null || filters.show === "nusr" }), { title: `LOC ${title}`, created: now });
  return new Response(workbook, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": attachmentHeader(locFileName(title, today)),
      "cache-control": "no-store",
    },
  });
}
