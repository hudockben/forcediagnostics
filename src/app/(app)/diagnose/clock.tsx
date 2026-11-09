"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { CLOCK_BEAT_MS, CLOCK_IDLE_MS, formatDuration, shownClock, type ClockView } from "@/lib/diagnose-clock-rules";

import { QuickIcon } from "./icons";

// The clock on a diagnosis, under its heading: how long the shop has worked
// on it, where it stands, and Pause, End, Resume or Reopen (the rules are
// in src/lib/diagnose-clock-rules.ts). While someone uses the page, it
// tells the server about once a minute, and once more as it's left, so the
// clock keeps going while they work and stops by itself when they don't.
// Sending Claude a message, ticking a check and marking a cause move the
// clock on the server; the conversation brings back how it stands.

// --- The server's time, as this browser reckons it --------------------------
// Moved on every TICK_MS, and put right by the server's time on each clock
// it sends (a tablet's own clock can be off). A store outside React, so the
// server render (which has no time to show) and the browser's agree.

const TICK_MS = 15_000;
let skew = 0;
let syncedAt: string | null = null;
let serverNow: number | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  serverNow = Date.now() + skew;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    serverNow = Date.now() + skew;
    timer = setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// A clock the server worked out at `at`: its time, just now.
function syncServerTime(at: string) {
  if (at === syncedAt) return;
  syncedAt = at;
  skew = Date.parse(at) - Date.now();
  tick();
}

const noSubscribe = () => () => {};

// "10:42 AM", in the viewer's own time zone (the server render has none).
function ClockTime({ value }: { value: string }) {
  const text = useSyncExternalStore(
    noSubscribe,
    () => new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    () => "",
  );
  return <time dateTime={value}>{text}</time>;
}

const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none disabled:opacity-60";
const quietButton = `${buttonClass} border-white/15 text-ink-muted hover:border-white/25 hover:text-ink`;
const glowButton = `${buttonClass} border-glow/30 text-glow hover:border-glow/50 hover:bg-glow/10`;

type ClockAction = "look" | "use" | "pause" | "end" | "resume" | "keep-gap" | "drop-gap";

const newer = (next: ClockView, old: ClockView | null) => !old || Date.parse(next.at) >= Date.parse(old.at);

export function DiagnosisClock({ conversationId, clock, busy }: { conversationId: string; clock: ClockView | null; busy: boolean }) {
  // The latest clock: as the conversation has it (a message, a tick or a
  // mark brought it), or as the clock's own requests brought it, whichever
  // the server worked out last.
  const [held, setHeld] = useState(clock);
  const [given, setGiven] = useState(clock);
  if (clock !== given) {
    setGiven(clock);
    if (clock && newer(clock, held)) setHeld(clock);
  }
  const now = useSyncExternalStore(subscribe, () => serverNow, () => null);
  const [pending, setPending] = useState<ClockAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // When the page was last used, and last told the server so.
  const lastInput = useRef(0);
  const lastBeat = useRef(0);

  const at = held?.at ?? null;
  useEffect(() => {
    if (at) syncServerTime(at);
  }, [at]);

  const send = useCallback(
    async (action: ClockAction, { ago, keepalive = false }: { ago?: number; keepalive?: boolean } = {}) => {
      const response = await fetch("/api/diagnose/clock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, action, ago }),
        // Finishes even as the page is left.
        keepalive,
      });
      const data = (await response.json().catch(() => null)) as { clock?: ClockView | null; error?: string } | null;
      if (!response.ok || !data || !("clock" in data)) throw new Error(data?.error ?? "That didn't go through. Check the connection and try again.");
      return data.clock ?? null;
    },
    [conversationId],
  );
  const adopt = useCallback((next: ClockView | null) => {
    if (next) setHeld((old) => (newer(next, old) ? next : old));
  }, []);

  const shown = held ? shownClock(held, now) : null;
  const state = shown?.state ?? null;
  const mine = held?.mine ?? false;

  // While it runs on this person's stretch: their use keeps it going. The
  // page tells the server once a minute at most, and once more as it's left
  // (a tab closed or put away, a tablet going to sleep); Claude working on a
  // message counts as use.
  useEffect(() => {
    if (state !== "running" || !mine) return;
    let gone = false;
    const beat = (keepalive = false) => {
      const sent = Date.now();
      lastBeat.current = sent;
      send("use", { ago: Math.max(0, sent - lastInput.current), keepalive })
        .then((next) => !gone && adopt(next))
        .catch(() => {});
    };
    const onInput = () => {
      lastInput.current = Date.now();
      if (lastInput.current - lastBeat.current >= CLOCK_BEAT_MS) beat();
    };
    const onLeave = () => {
      if (document.visibilityState === "hidden" && lastInput.current > lastBeat.current) beat(true);
    };
    const onPageHide = () => {
      if (lastInput.current > lastBeat.current) beat(true);
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const type of events) window.addEventListener(type, onInput, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onLeave);
    window.addEventListener("pagehide", onPageHide);
    const timer = setInterval(() => {
      if (busy) lastInput.current = Date.now();
      if (lastInput.current > lastBeat.current && Date.now() - lastBeat.current >= CLOCK_BEAT_MS) beat();
    }, TICK_MS);
    return () => {
      gone = true;
      for (const type of events) window.removeEventListener(type, onInput, { capture: true });
      document.removeEventListener("visibilitychange", onLeave);
      window.removeEventListener("pagehide", onPageHide);
      clearInterval(timer);
      // Left while in use (another page in the app): said once more.
      if (lastInput.current > lastBeat.current) beat(true);
    };
  }, [state, mine, busy, send, adopt]);

  // How it stands on the server: as the page is shown (again: a tab come
  // back to, this page back from another), when it has just stopped by
  // itself here, and once a minute while it runs on someone else's stretch
  // (the bay tablet's, followed from the office).
  const hasClock = held !== null;
  useEffect(() => {
    if (!hasClock) return;
    let gone = false;
    const look = () => {
      if (document.visibilityState !== "visible") return;
      send("look")
        .then((next) => !gone && adopt(next))
        .catch(() => {});
    };
    look();
    document.addEventListener("visibilitychange", look);
    const timer = state === "running" && !mine ? setInterval(look, CLOCK_BEAT_MS) : null;
    return () => {
      gone = true;
      document.removeEventListener("visibilitychange", look);
      if (timer !== null) clearInterval(timer);
    };
  }, [hasClock, state, mine, send, adopt]);

  async function act(action: ClockAction) {
    setPending(action);
    setMessage(null);
    try {
      adopt(await send(action));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  }

  if (!held || !shown) return null;
  const idleMinutes = CLOCK_IDLE_MS / 60_000;
  const button = (action: ClockAction, label: string, className = quietButton) => (
    <button type="button" data-clock-action={action} onClick={() => void act(action)} disabled={pending !== null} className={className}>
      {pending === action ? "…" : label}
    </button>
  );

  return (
    <div role="group" aria-label="Time on this diagnosis" data-clock={shown.state} className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="flex min-h-11 flex-wrap items-center gap-x-2 text-sm">
          <QuickIcon className="size-4 shrink-0 text-ink-muted" />
          <span className="font-medium text-ink tabular-nums" data-clock-time>
            {formatDuration(shown.seconds)}
          </span>
          <span className="text-ink-muted">
            {shown.state === "running" ? (
              <>· Running{!held.mine && held.by ? ` (${held.by})` : ""}</>
            ) : shown.state === "paused" ? (
              <>
                · Paused at <ClockTime value={held.last} />
              </>
            ) : shown.state === "idle" ? (
              <>
                · Stopped at <ClockTime value={held.last} />: not used for {idleMinutes} min
              </>
            ) : (
              <>· {held.solved ? "Ended: solved" : "Ended"}</>
            )}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          {shown.state === "running" && button("pause", "Pause")}
          {(shown.state === "idle" || shown.state === "paused") && button("resume", "Resume", glowButton)}
          {shown.state !== "ended" && button("end", "End")}
          {shown.state === "ended" && button("resume", "Reopen")}
        </div>
      </div>
      {held.gap && (
        <div data-clock-gap className="space-y-2 rounded-xl border border-glow/25 bg-glow/5 px-4 py-3 text-sm">
          <p className="text-ink">
            This diagnosis wasn&apos;t used from <ClockTime value={held.gap.from} /> to <ClockTime value={held.gap.to} /> (
            {formatDuration(held.gap.seconds)}). Were you working on the unit then?
          </p>
          <div className="flex flex-wrap gap-2">
            {button("keep-gap", `Count the ${formatDuration(held.gap.seconds)}`, glowButton)}
            {button("drop-gap", "Don't count it")}
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm text-trail">
          {message}
        </p>
      )}
    </div>
  );
}
