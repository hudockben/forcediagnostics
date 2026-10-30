import { cleanListQuery } from "@/lib/diagnose-list-rules";
import { allows, lookupCurrentUser } from "@/lib/session";
import { suppliersCsv } from "@/lib/supplier-rules";
import { exportSuppliers } from "@/lib/suppliers";

// The supplier list as CSV (Download CSV on the list), as searched and
// filtered there, with the list's headings.
export async function GET(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) return Response.redirect(new URL(lookup.redirectTo, request.url), 303);
  if (!allows(lookup.user, "parts.manage")) return new Response("Your role can't open the supplier list.", { status: 403 });
  const params = new URL(request.url).searchParams;
  const query = cleanListQuery(params.get("q") ?? "");
  const category = params.get("category")?.slice(0, 40) || null;
  const rows = await exportSuppliers(lookup.user.shop.id, { query, category });
  return new Response(suppliersCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="suppliers.csv"',
      "cache-control": "no-store",
    },
  });
}
