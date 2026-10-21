import { lookupCurrentUser } from "@/lib/session";

// Bay tablets call this while someone is working without changing pages, so
// the server doesn't treat a busy session as idle. Looking the session up
// records the activity.
export async function POST() {
  const result = await lookupCurrentUser();
  if ("redirectTo" in result) {
    return Response.json({ ok: false, redirectTo: result.redirectTo }, { status: 401 });
  }
  return Response.json({ ok: true });
}
