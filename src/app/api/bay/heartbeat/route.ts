import { lookupCurrentUser, recordBayActivity } from "@/lib/session";

// Bay tablets call this while someone is working without changing pages, so
// the server doesn't treat a busy session as idle. It also tells the page
// which session the browser holds now, so a tab left open from someone
// else's session can reload.
export async function POST() {
  const result = await lookupCurrentUser();
  if ("redirectTo" in result) {
    return Response.json({ ok: false, redirectTo: result.redirectTo }, { status: 401 });
  }
  const bay = result.user.bay;
  if (bay) await recordBayActivity(bay.sessionId);
  return Response.json({ ok: true, sessionId: bay?.sessionId ?? null });
}
