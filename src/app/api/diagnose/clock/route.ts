import { DrizzleQueryError } from "drizzle-orm";

import { clockAction, type ClockAction } from "@/lib/diagnose-clock";
import { allows, lookupCurrentUser } from "@/lib/session";

// POST { conversationId, action }: the clock on a diagnosis. The page sends
// "use" about once a minute while someone's using it (and as it's left,
// with keepalive, which a server action can't), "look" when it's shown
// again, and the clock's own buttons: Pause, End, Resume, and the answer
// to "were you working on it?" ("keep-gap", "drop-gap"). Answers with the
// clock as this person sees it (see src/lib/diagnose-clock.ts).
export async function POST(request: Request) {
  const lookup = await lookupCurrentUser();
  if ("redirectTo" in lookup) {
    return Response.json({ error: "You've been signed out. Sign in again.", redirectTo: lookup.redirectTo }, { status: 401 });
  }
  if (!allows(lookup.user, "diagnostics.work")) return Response.json({ error: "Your role can't use Diagnose." }, { status: 403 });
  // JSON only: a form on another site can't send it.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "That request couldn't be read." }, { status: 415 });
  }
  const body = (await request.json().catch(() => null)) as { conversationId?: unknown; action?: unknown; ago?: unknown } | null;
  try {
    const result = await clockAction(lookup.user, {
      conversationId: typeof body?.conversationId === "string" ? body.conversationId : "",
      action: (typeof body?.action === "string" ? body.action : "") as ClockAction,
      ago: typeof body?.ago === "number" ? body.ago : 0,
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    // A DrizzleQueryError's message lists the query parameters.
    console.error("Couldn't move the diagnosis clock", error instanceof DrizzleQueryError ? error.cause : error);
    return Response.json({ error: "That didn't go through. Check the connection and try again." }, { status: 500 });
  }
}
