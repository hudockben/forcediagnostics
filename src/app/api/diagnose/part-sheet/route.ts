import { DrizzleQueryError } from "drizzle-orm";

import { partPageCard, partSheet } from "@/lib/diagnose-part-sheet";
import { allows, lookupCurrentUser } from "@/lib/session";

// The part sheet for a system of the unit the tech tapped: its parts, the
// manual pages that show the one picked (or the first), and the large
// page's card as saved. With a page, only that page's card, read the first
// time anyone opens it (a few seconds, once). The same people can as can
// see the diagnosis (diagnostics.work).
//
// A route rather than a server action: the browser runs a page's server
// actions one at a time, so a tick on a step tapped while a page is being
// read would wait for the reading; requests here don't queue behind them.
// A reading is two requests to Claude at most, each with a 30-second
// timeout and one retry (src/lib/manual-facts.ts).
export const maxDuration = 150;

const NOT_THROUGH = "That didn't go through. Check the connection and try again.";

export async function POST(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) {
    return Response.json({ error: "You've been signed out. Sign in again.", redirectTo: lookup.redirectTo }, { status: 401 });
  }
  if (!allows(lookup.user, "diagnostics.work")) return Response.json({ error: "Your role can't use Diagnose." }, { status: 403 });
  // JSON only, as for sending a message: a form on another site can't send
  // it without asking first.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "That request couldn't be read." }, { status: 415 });
  }
  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "That request couldn't be read." }, { status: 400 });
  }
  const page = body.page && typeof body.page === "object" ? (body.page as Record<string, unknown>) : null;
  const conversationId = String(body.conversationId ?? "");
  try {
    const sheet = page
      ? await partPageCard(lookup.user, { conversationId, page: { manualId: String(page.manualId ?? ""), page: Number(page.page) } })
      : await partSheet(lookup.user, { conversationId, system: String(body.system ?? ""), part: typeof body.part === "string" ? body.part : undefined });
    const headers = { "cache-control": "private, no-store" };
    return "error" in sheet ? Response.json(sheet, { status: 404, headers }) : Response.json(sheet, { headers });
  } catch (error) {
    console.error("Couldn't open the part", error instanceof DrizzleQueryError ? error.cause : error);
    return Response.json({ error: NOT_THROUGH }, { status: 500 });
  }
}
