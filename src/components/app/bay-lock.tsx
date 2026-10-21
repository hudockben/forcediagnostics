"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PinPad } from "@/components/pin-pad";
import { authClient } from "@/lib/auth-client";
import { PIN_MIN_LENGTH } from "@/lib/pin-rules";
import { describeWarning, signInWithPin } from "@/lib/pin-sign-in";

// Idle lock for PIN sessions on a bay tablet. After a few idle minutes it
// covers the screen and signs the person out on the server. They unlock with
// their PIN and carry on where they were, or tap "Not you?" to switch.
//
// Idle time is measured by the clock (shared by all tabs), not by timers,
// because timers stop while a tablet sleeps. The cover goes up without
// waiting for the network.

const ACTIVITY_KEY = "fd-bay-activity";
const UNLOCKED_KEY = "fd-bay-unlocked";
const LOCKED_KEY = "fd-bay-locked";
const WARN_MS = 30 * 1000;
const HEARTBEAT_EVERY_MS = 60 * 1000;
// A locked screen goes back to the name list after this long.
const LOCKED_GIVE_UP_MS = 30 * 60 * 1000;

const memory = new Map<string, string>();
function readStore(key: string) {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}
function writeStore(key: string, value: string | null) {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: this tab still works from memory.
  }
}

function signOutWithTimeout(ms: number) {
  return Promise.race([
    authClient.signOut().then(({ error }) => !error),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]).catch(() => false);
}

export function BayLock({ userId, name, idleMs }: { userId: string; name: string; idleMs: number }) {
  const [locked, setLocked] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const lockedRef = useRef(false);
  const lockedAt = useRef(0);
  const lastWrite = useRef(0);
  const lastHeartbeat = useRef(0);
  const signedOut = useRef<Promise<void> | null>(null);

  const lastActivity = () => Number(readStore(ACTIVITY_KEY)) || 0;

  const lock = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    lockedAt.current = Date.now();
    setLocked(true);
    setPin("");
    setMessage(null);
    document.getElementById("app-shell")?.setAttribute("inert", "");
    document.querySelectorAll("video, audio").forEach((media) => (media as HTMLMediaElement).pause());
    writeStore(LOCKED_KEY, `${userId}:${Date.now()}`);
    // End the session on the server; keep trying until it works.
    signedOut.current = (async () => {
      while (lockedRef.current) {
        if (await signOutWithTimeout(3000)) return;
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    })();
  }, [userId]);

  const unlockHere = useCallback(() => {
    lockedRef.current = false;
    setLocked(false);
    setPin("");
    setMessage(null);
    document.getElementById("app-shell")?.removeAttribute("inert");
    writeStore(ACTIVITY_KEY, String(Date.now()));
  }, []);

  const heartbeat = useCallback(async () => {
    lastHeartbeat.current = Date.now();
    try {
      const response = await fetch("/api/bay/heartbeat", { method: "POST" });
      // The server already ended this session: go to the name list.
      if (response.status === 401) window.location.replace("/bay");
    } catch {
      // Offline: the clock-based lock still applies.
    }
  }, []);

  const check = useCallback(() => {
    const now = Date.now();
    if (lockedRef.current) {
      if (now - lockedAt.current > LOCKED_GIVE_UP_MS) window.location.replace("/bay");
      return;
    }
    const idle = now - lastActivity();
    if (idle >= idleMs) {
      lock();
      setSecondsLeft(null);
    } else if (idle >= idleMs - WARN_MS) {
      setSecondsLeft(Math.ceil((idleMs - idle) / 1000));
    } else {
      setSecondsLeft(null);
    }
  }, [idleMs, lock]);

  useEffect(() => {
    // A fresh page load counts as activity (they just signed in or moved).
    writeStore(ACTIVITY_KEY, String(Date.now()));
    if (readStore(LOCKED_KEY)) writeStore(LOCKED_KEY, null);

    function onInput(event: Event) {
      if (lockedRef.current) return;
      const now = Date.now();
      if (now - lastActivity() >= idleMs) {
        // The tap that wakes the tablet mustn't act on the last person's page.
        event.preventDefault();
        event.stopPropagation();
        lock();
        return;
      }
      if (now - lastWrite.current > 1000) {
        lastWrite.current = now;
        writeStore(ACTIVITY_KEY, String(now));
        setSecondsLeft(null);
      }
      if (now - lastHeartbeat.current > HEARTBEAT_EVERY_MS) void heartbeat();
    }
    function onStorage(event: StorageEvent) {
      if (event.key === ACTIVITY_KEY) check();
      if (event.key === LOCKED_KEY && event.newValue) lock();
      if (event.key === UNLOCKED_KEY && event.newValue?.startsWith(`${userId}:`) && lockedRef.current) {
        unlockHere();
      }
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
  }, [check, heartbeat, idleMs, lock, unlockHere, userId]);

  async function unlock() {
    setPending(true);
    setMessage(null);
    // Let the sign-out finish first, so it can't end the new session.
    await Promise.race([signedOut.current, new Promise((resolve) => setTimeout(resolve, 5000))]);
    const result = await signInWithPin(userId, pin);
    setPending(false);
    setPin("");
    if (!result.ok) {
      if (result.notATablet) window.location.replace("/bay");
      setMessage(result.message);
      return;
    }
    writeStore(UNLOCKED_KEY, `${userId}:${Date.now()}`);
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
          role="dialog"
          aria-modal="true"
          aria-labelledby="bay-lock-title"
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-forest-950 px-4 py-8"
        >
          <div className="w-full max-w-xs space-y-5">
            <div className="text-center">
              <p className="font-mono text-[11px] tracking-[0.2em] text-glow/80 uppercase">Locked</p>
              <h2 id="bay-lock-title" className="mt-2 text-2xl font-semibold text-ink">
                {name}
              </h2>
              <p className="mt-1 text-sm text-ink-muted">Enter your PIN to carry on.</p>
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
              onClick={() => window.location.replace("/bay")}
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
