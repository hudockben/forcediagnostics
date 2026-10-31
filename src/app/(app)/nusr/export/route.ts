import { findSales, unitsByMonth } from "@/lib/nusr";
import { attachmentHeader, nusrFileName, nusrWorkbook } from "@/lib/nusr-export";
import { filtersTitle, parseSaleFilters, shopYear } from "@/lib/nusr-rules";
import { allows, lookupCurrentUser } from "@/lib/session";
import { writeXlsx } from "@/lib/xlsx-write";

// NUSR as an Excel workbook (Download Excel on the NUSR tab), as filtered
// there, the oldest first: the shop's own NUSR sheet with its formulas, a
// Summary, and the month-by-month Comparison of every year, with the day in
// the viewer's time zone.
export async function GET(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) return Response.redirect(new URL(lookup.redirectTo, request.url), 303);
  if (!allows(lookup.user, "sales.log")) return new Response("Your role can't open the NUSR.", { status: 403 });

  const params = new URL(request.url).searchParams;
  // As a page's searchParams has them, so the download finds what the log
  // shows.
  const query = Object.fromEntries([...new Set(params.keys())].map((key) => [key, params.getAll(key)]));
  const filters = parseSaleFilters(query, shopYear());
  // A time zone the browser named, if it's a real one.
  let timeZone = "America/New_York";
  try {
    const asked = params.get("tz");
    if (asked) timeZone = new Intl.DateTimeFormat("en-US", { timeZone: asked }).resolvedOptions().timeZone;
  } catch {
    // Not a time zone: the default stays.
  }

  const shopId = lookup.user.shop.id;
  const [sales, comparison] = await Promise.all([findSales(shopId, filters, "oldest"), unitsByMonth(shopId, filters)]);
  const title = filtersTitle(filters);
  const now = new Date();
  const workbook = writeXlsx(nusrWorkbook(sales, { title, comparison, generatedAt: now, timeZone }), { title: `NUSR ${title}`, created: now });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Response(workbook, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": attachmentHeader(nusrFileName(title, today)),
      "cache-control": "no-store",
    },
  });
}
