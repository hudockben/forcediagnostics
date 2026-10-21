import { cookies } from "next/headers";

import { BAY_COOKIE, endDeviceSession, findDeviceByToken } from "@/lib/bay";

// POST { sessionId }: ends that PIN session on this tablet. The idle lock
// and the name screen use this rather than signing out, because signing out
// ends whichever session the browser holds when the request arrives, which
// can already be the next person's. It also never changes cookies, so a
// slow reply can't clear a newer sign-in.
export async function POST(request: Request) {
  // JSON only: a cross-site form can't send it.
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ ok: false }, { status: 415 });
  }
  const body = (await request.json().catch(() => null)) as { sessionId?: unknown } | null;
  const sessionId = body?.sessionId;
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) {
    return Response.json({ ok: false }, { status: 400 });
  }
  const device = await findDeviceByToken((await cookies()).get(BAY_COOKIE)?.value);
  // A removed tablet's sessions are already gone.
  if (device) await endDeviceSession(device.id, sessionId);
  return Response.json({ ok: true });
}
