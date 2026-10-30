import { exportAuditLog } from "@/lib/audit-log";
import { auditLogCsv, parseAreaFilter } from "@/lib/audit-log-rules";
import { cleanListQuery } from "@/lib/diagnose-list-rules";
import { allows, lookupCurrentUser } from "@/lib/session";

// The Activity log as CSV (Download CSV on the log), as searched and
// filtered there, the oldest first, with its times in the viewer's time
// zone.
export async function GET(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) return Response.redirect(new URL(lookup.redirectTo, request.url), 303);
  if (!allows(lookup.user, "audit.read")) return new Response("Your role can't open the Activity log.", { status: 403 });

  const params = new URL(request.url).searchParams;
  const query = cleanListQuery(params.get("q") ?? "");
  const area = parseAreaFilter(params.get("area"));
  // A time zone the browser named, if it's a real one.
  let timeZone = "America/New_York";
  try {
    const asked = params.get("tz");
    if (asked) timeZone = new Intl.DateTimeFormat("en-US", { timeZone: asked }).resolvedOptions().timeZone;
  } catch {
    // Not a time zone: the default stays.
  }

  const rows = await exportAuditLog(lookup.user.shop.id, { query, area });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Response(auditLogCsv(rows, timeZone), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="activity-log-${today}.csv"`,
      "cache-control": "no-store",
    },
  });
}
