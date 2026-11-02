import { cleanListQuery } from "@/lib/diagnose-list-rules";
import { allows, lookupCurrentUser } from "@/lib/session";
import { exportStickerLog } from "@/lib/sticker-log";
import { parseClassFilter, stickerLogCsv } from "@/lib/sticker-log-rules";

// The Sticker & Plate log as CSV (Download CSV on the log), as searched
// and filtered there, with its dates in the viewer's time zone.
export async function GET(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) return Response.redirect(new URL(lookup.redirectTo, request.url), 303);
  if (!allows(lookup.user, "repair_orders.intake")) return new Response("Your role can't open the Sticker & Plate log.", { status: 403 });

  const params = new URL(request.url).searchParams;
  const query = cleanListQuery(params.get("q") ?? "");
  const plateClass = parseClassFilter(params.get("class") ?? undefined);
  // A time zone the browser named, if it's a real one.
  let timeZone = "America/New_York";
  try {
    const asked = params.get("tz");
    if (asked) timeZone = new Intl.DateTimeFormat("en-US", { timeZone: asked }).resolvedOptions().timeZone;
  } catch {
    // Not a time zone: the default stays.
  }

  const rows = await exportStickerLog(lookup.user.shop.id, { query, plateClass });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Response(stickerLogCsv(rows, timeZone), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="sticker-plate-log-${today}.csv"`,
      "cache-control": "no-store",
    },
  });
}
