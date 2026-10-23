import { getTurn } from "@/lib/diagnose";
import { allows, lookupCurrentUser } from "@/lib/session";

// A turn as it stands, for a page showing a message Claude is still working
// on that it isn't streaming itself (opened in another tab, or after the
// connection dropped).
export async function GET(_request: Request, ctx: RouteContext<"/api/diagnose/turns/[turnId]">) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) return Response.json({ redirectTo: lookup.redirectTo }, { status: 401 });
  if (!allows(lookup.user, "diagnostics.work")) return Response.json({ error: "Not allowed." }, { status: 403 });
  const { turnId } = await ctx.params;
  const turn = await getTurn(lookup.user, turnId, allows(lookup.user, "reports.kpis"));
  if (!turn) return Response.json({ error: "That message isn't in this shop." }, { status: 404 });
  return Response.json({ turn }, { headers: { "cache-control": "private, no-store" } });
}
