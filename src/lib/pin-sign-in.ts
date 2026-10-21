"use client";

import { startedSession } from "@/lib/bay-client";

// Browser side of PIN sign-in on a bay tablet (POST /api/auth/sign-in/pin).

export type PinWarning = { count: number; lastAt: string; deviceName: string | null };

export type PinSignInResult =
  | { ok: true; sessionId: string; warning: PinWarning | null }
  | { ok: false; message: string; notATablet?: boolean };

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60000));

export async function signInWithPin(userId: string, pin: string): Promise<PinSignInResult> {
  let response: Response;
  try {
    response = await fetch("/api/auth/sign-in/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, pin }),
    });
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check the Wi-Fi and try again." };
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) {
    const sessionId = String(body.sessionId ?? "");
    startedSession(sessionId, userId);
    return { ok: true, sessionId, warning: (body.warning as PinWarning | null) ?? null };
  }

  switch (body.code) {
    case "INVALID_PIN": {
      const left = typeof body.triesLeft === "number" ? body.triesLeft : null;
      return {
        ok: false,
        message:
          left === null
            ? "That PIN isn't right."
            : `That PIN isn't right. ${left} ${left === 1 ? "try" : "tries"} left before it locks.`,
      };
    }
    case "PIN_LOCKED": {
      const until = typeof body.until === "string" ? new Date(body.until) : null;
      return {
        ok: false,
        message: until
          ? `Too many wrong PINs. Your PIN is locked for ${minutes(until.getTime() - Date.now())} min.`
          : "Your PIN is locked. A manager can unlock it, or sign in with your password on a computer or phone.",
      };
    }
    case "TABLET_PAUSED":
      return {
        ok: false,
        message: `Too many wrong PINs on this tablet. Try again in ${minutes(Number(body.retryAfterMs) || 0)} min.`,
      };
    case "NOT_A_BAY_TABLET":
      return { ok: false, message: "This tablet isn't paired anymore.", notATablet: true };
    case "ACCOUNT_DISABLED":
      return { ok: false, message: "This account is disabled. Ask an admin." };
  }
  if (response.status === 429) return { ok: false, message: "Too many tries. Wait a minute." };
  return { ok: false, message: "Couldn't sign in right now. Try again." };
}

export function describeWarning(warning: PinWarning) {
  const last = new Date(warning.lastAt);
  const time = last.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // The tries can go back days, so say which day unless it was today.
  const when =
    last.toDateString() === new Date().toDateString()
      ? `today at ${time}`
      : `${last.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
  const where = warning.deviceName ? ` on ${warning.deviceName}` : "";
  return `${warning.count} wrong PIN ${warning.count === 1 ? "try" : "tries"} on your name since you last used your PIN (the last${where}, ${when}). If that wasn't you, tell your manager.`;
}
