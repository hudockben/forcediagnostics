"use client";

// What every tab on a bay tablet needs to agree on, kept in localStorage:
// which session the browser holds, when the tablet was last used, and
// whether that session's screen is locked. Values carry the session id, so
// one person's leftovers never apply to the next person's session. When
// storage is blocked each tab keeps its own copy in memory.

export const SESSION_KEY = "fd-bay-session"; // `${sessionId}:${userId}`, or `none:${time}` after a sign-out
export const ACTIVITY_KEY = "fd-bay-activity"; // `${sessionId}:${time}`
export const LOCKED_KEY = "fd-bay-locked"; // `${sessionId}:${time}`

const memory = new Map<string, string>();

export function readStore(key: string) {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function writeStore(key: string, value: string | null) {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: this tab still works from memory.
  }
}

// Splits `${id}:${rest}`.
export function readPair(value: string | null): [string, string] | null {
  const index = value?.indexOf(":") ?? -1;
  return value && index > 0 ? [value.slice(0, index), value.slice(index + 1)] : null;
}

// The time stored for this session under `key`, if any.
export function stampFor(key: string, sessionId: string) {
  const pair = readPair(readStore(key));
  return pair && pair[0] === sessionId ? Number(pair[1]) || 0 : null;
}

// Called when a PIN sign-in succeeds: tells the other tabs, and starts the
// idle clock for the new session.
export function startedSession(sessionId: string, userId: string) {
  writeStore(ACTIVITY_KEY, `${sessionId}:${Date.now()}`);
  writeStore(LOCKED_KEY, null);
  writeStore(SESSION_KEY, `${sessionId}:${userId}`);
}

// Called after Switch user signs out, so other tabs don't keep showing the
// last person's screens.
export function endedSession() {
  writeStore(SESSION_KEY, `none:${Date.now()}`);
}

// Ends one PIN session on the server (see /api/bay/end-session). True once
// the server has answered; false if it couldn't be reached.
export async function endBaySession(sessionId: string) {
  try {
    const response = await fetch("/api/bay/end-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
      // Finishes even if the page is being left.
      keepalive: true,
    });
    return response.status < 500;
  } catch {
    return false;
  }
}
