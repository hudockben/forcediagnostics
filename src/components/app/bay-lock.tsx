"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PinPad } from "@/components/pin-pad";
import {
  ACTIVITY_KEY,
  endBaySession,
  LOCKED_KEY,
  readPair,
  readStore,
  SESSION_KEY,
  stampFor,
  writeStore,
} from "@/lib/bay-client";
import { PIN_MIN_LENGTH } from "@/lib/pin-rules";
import { describeWarning, signInWithPin } from "@/lib/pin-sign-in";

// Idle lock for PIN sessions on a bay tablet. After a few idle minutes it
// covers the screen and ends the session on the server. They unlock with
// their PIN and carry on where they were, or tap "Not you?" to switch.
//
// Idle time is measured by the clock (shared by all tabs), not by timers,
// because timers stop while a tablet sleeps. A page that loads later (a
// reload, or a tab the browser brings back after sleep) starts locked if its
// session was idle or locked. The cover goes up without waiting for the
// network.

const WARN_MS = 30 * 1000;
// A locked screen goes back to the name list after this long.
const LOCKED_GIVE_UP_MS = 30 * 60 * 1000;

export function BayLock({
  userId,
  sessionId,
  name,
  idleMs,
  heartbeatMs,
}: {
  userId: string;
  sessionId: string;
  name: string;
  idleMs: number;
  heartbeatMs: number;
}) {
  const [locked, setLocked] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // The session this page belongs to; unlocking starts a new one.
  const session = useRef(sessionId);
  const lockedRef = useRef(false);
  const lockedAt = useRef(0);
  const lastWrite = useRef(0);
  const lastHeartbeat = useRef(0);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);

  // Leaves the page once (the checks run every second, and a new navigation
  // would restart a slow one).
  const leave = useCallback((to?: string) => {
    if (leaving.current) return;
    leaving.current = true;
    if (to) window.location.replace(to);
    else window.location.reload();
  }, []);

  const lock = useCallback((since = Date.now()) => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    lockedAt.current = since;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLocked(true);
    setSecondsLeft(null);
    setPin("");
    setMessage(null);
    document.getElementById("app-shell")?.setAttribute("inert", "");
    document.querySelectorAll("video, audio").forEach((media) => (media as HTMLMediaElement).pause());
    const id = session.current;
    if (stampFor(LOCKED_KEY, id) === null) writeStore(LOCKED_KEY, `${id}:${since}`);
    // End this session on the server; keep trying until it gets through.
    // It names the session, so it can't end the next person's.
    void (async () => {
      while (lockedRef.current && session.current === id) {
        if (await endBaySession(id)) return;
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    })();
  }, []);

  const unlockHere = useCallback(() => {
    lockedRef.current = false;
    setLocked(false);
    setPin("");
    setMessage(null);
    document.getElementById("app-shell")?.removeAttribute("inert");
    writeStore(ACTIVITY_KEY, `${session.current}:${Date.now()}`);
  }, []);

  // Follows sign-ins and sign-outs in other tabs. The same person signing in
  // again unlocks this tab too; anyone else, or no one, reloads it, so it
  // only ever shows what the browser's current session may see. Returns
  // whether this page still belongs to the browser's session.
  const followSession = useCallback(
    (value: string | null) => {
      const pair = readPair(value);
      if (!pair || pair[0] === session.current) return true;
      if (pair[0] !== "none" && pair[1] === userId) {
        session.current = pair[0];
        if (lockedRef.current) unlockHere();
        return true;
      }
      leave();
      return false;
    },
    [leave, unlockHere, userId],
  );

  const heartbeat = useCallback(async () => {
    lastHeartbeat.current = Date.now();
    const sent = session.current;
    try {
      const response = await fetch("/api/bay/heartbeat", { method: "POST" });
      if (lockedRef.current || session.current !== sent) return;
      // The server already ended this session: go to the name list.
      if (response.status === 401) {
        leave("/bay");
        return;
      }
      // Someone else signed in from a tab that couldn't tell this one.
      const body = (await response.json().catch(() => null)) as { sessionId?: string | null } | null;
      if (body?.sessionId && body.sessionId !== sent) leave();
    } catch {
      // Offline: the clock-based lock still applies.
    }
  }, [leave]);

  const check = useCallback(() => {
    if (!followSession(readStore(SESSION_KEY))) return;
    const now = Date.now();
    if (lockedRef.current) {
      if (now - lockedAt.current > LOCKED_GIVE_UP_MS) leave("/bay");
      return;
    }
    // Another tab locked this session while this one wasn't listening.
    if (stampFor(LOCKED_KEY, session.current) !== null) {
      lock();
      return;
    }
    let last = stampFor(ACTIVITY_KEY, session.current);
    if (last === null) {
      last = now;
      writeStore(ACTIVITY_KEY, `${session.current}:${now}`);
    }
    const idle = now - last;
    if (idle >= idleMs) {
      lock();
    } else if (idle >= idleMs - WARN_MS) {
      setSecondsLeft(Math.ceil((idleMs - idle) / 1000));
    } else {
      setSecondsLeft(null);
    }
  }, [followSession, idleMs, leave, lock]);

  useEffect(() => {
    // Loading a page isn't activity: a reload of an idle or locked session
    // stays locked. Only a session this browser hasn't seen (a sign-in that
    // couldn't record itself) starts its clock here.
    const id = session.current;
    const lockedSince = stampFor(LOCKED_KEY, id);
    const lastActive = stampFor(ACTIVITY_KEY, id);
    writeStore(SESSION_KEY, `${id}:${userId}`);
    if (lockedSince !== null) lock(lockedSince);
    else if (lastActive !== null && Date.now() - lastActive >= idleMs) lock();
    else if (lastActive === null) writeStore(ACTIVITY_KEY, `${id}:${Date.now()}`);

    function onInput(event: Event) {
      if (lockedRef.current) return;
      const stale = !followSession(readStore(SESSION_KEY));
      const now = Date.now();
      const last = stampFor(ACTIVITY_KEY, session.current);
      if (stale || (last !== null && now - last >= idleMs)) {
        // The tap that wakes the tablet mustn't act on the last person's page.
        event.preventDefault();
        event.stopPropagation();
        if (!stale) lock();
        return;
      }
      if (now - lastWrite.current > 1000) {
        lastWrite.current = now;
        writeStore(ACTIVITY_KEY, `${session.current}:${now}`);
        setSecondsLeft(null);
      }
      if (now - lastHeartbeat.current > heartbeatMs) void heartbeat();
    }
    function onStorage(event: StorageEvent) {
      if (event.key === SESSION_KEY) followSession(event.newValue);
      else if (event.key === LOCKED_KEY && readPair(event.newValue)?.[0] === session.current) lock();
      else if (event.key === ACTIVITY_KEY) check();
    }
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    events.forEach((type) => window.addEventListener(type, onInput, { capture: true }));
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", check);
    const timer = window.setInterval(check, 1000);
    return () => {
      events.forEach((type) => window.removeEventListener(type, onInput, { capture: true }));
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(timer);
    };
  }, [check, followSession, heartbeat, heartbeatMs, idleMs, lock, userId]);

  // Focus moves into the lock screen, and back to where it was on unlock.
  useEffect(() => {
    if (locked) {
      dialog.current?.focus();
      return;
    }
    const previous = restoreFocus.current;
    restoreFocus.current = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }, [locked]);

  async function unlock() {
    setPending(true);
    setMessage(null);
    // The PIN sign-in itself ends the old session if it's still there.
    const result = await signInWithPin(userId, pin);
    setPending(false);
    setPin("");
    if (!result.ok) {
      if (result.notATablet) leave("/bay");
      setMessage(result.message);
      return;
    }
    session.current = result.sessionId;
    if (result.warning) setWarning(describeWarning(result.warning));
    unlockHere();
  }

  return (
    <>
      {secondsLeft !== null && !locked && (
        <div
          role="alert"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-trail/40 bg-charcoal-900/95 px-4 py-4 text-center text-base text-trail backdrop-blur"
        >
          Locking in {secondsLeft}s. Tap anywhere to keep working.
        </div>
      )}

      {warning && !locked && (
        <div
          role="alert"
          className="fixed inset-x-0 top-0 z-40 flex flex-wrap items-center justify-center gap-3 border-b border-trail/40 bg-charcoal-900/95 px-4 py-3 text-sm text-trail backdrop-blur"
        >
          <span>{warning}</span>
          <button
            type="button"
            onClick={() => setWarning(null)}
            className="h-10 rounded-lg border border-trail/40 px-3 text-sm font-medium"
          >
            OK
          </button>
        </div>
      )}

      {locked && (
        <div
          ref={dialog}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="bay-lock-title"
          aria-describedby="bay-lock-help"
          className="fixed inset-0 z-50 flex items-center-safe justify-center overflow-y-auto bg-forest-950 px-4 py-8 outline-none"
        >
          <div className="w-full max-w-xs space-y-5">
            <div className="text-center">
              <p className="font-mono text-[11px] tracking-[0.2em] text-glow/80 uppercase">Locked</p>
              <h2 id="bay-lock-title" className="mt-2 text-2xl font-semibold text-ink">
                {name}
              </h2>
              <p id="bay-lock-help" className="mt-1 text-sm text-ink-muted">
                Enter your PIN to carry on.
              </p>
            </div>
            <PinPad
              value={pin}
              onChange={(value) => {
                setPin(value);
                setMessage(null);
              }}
              onSubmit={unlock}
              disabled={pending}
              submitLabel={pending ? "…" : "Unlock"}
              minLength={PIN_MIN_LENGTH}
            />
            <p role="status" className="min-h-10 text-center text-sm text-trail">
              {message}
            </p>
            <button
              type="button"
              onClick={() => leave("/bay")}
              className="h-12 w-full rounded-lg border border-white/15 text-base text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
            >
              Not you? Switch user
            </button>
          </div>
        </div>
      )}
    </>
  );
}
