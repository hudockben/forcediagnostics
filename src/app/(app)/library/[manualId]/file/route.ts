import { getReadyManual } from "@/lib/library";
import { pdfFileName } from "@/lib/manual-rules";
import { allows, lookupCurrentUser } from "@/lib/session";
import { isStorageConfigured, r2Storage } from "@/lib/storage";

// Opens a manual's whole PDF in the browser. Storage links only last a few
// minutes, so "Open full PDF" points here and gets a fresh one each time.
export async function GET(request: Request, ctx: RouteContext<"/library/[manualId]/file">) {
  const result = await lookupCurrentUser();
  if ("redirectTo" in result) return Response.redirect(new URL(result.redirectTo, request.url), 303);
  if (!allows(result.user, "library.read")) return Response.redirect(new URL("/home", request.url), 303);
  if (!isStorageConfigured) return new Response("File storage isn't set up.", { status: 503 });

  const { manualId } = await ctx.params;
  const manual = await getReadyManual(result.user.shop.id, manualId);
  if (!manual) return new Response("That manual isn't in the library.", { status: 404 });
  const url = await r2Storage.downloadUrl(manual.storageKey, pdfFileName(manual.title));
  return new Response(null, {
    status: 303,
    // The link is personal and short-lived, so nothing should keep it.
    headers: { location: url, "cache-control": "private, no-store" },
  });
}
