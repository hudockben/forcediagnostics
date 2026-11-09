// The clock on a diagnosis: how long the shop worked on it, for the Reports
// tab's Diagnosis times (how long each kind of job takes, to schedule the
// next one by). Kept free of database and React imports, so the server,
// the browser and the tests share it; src/lib/diagnose-clock.ts keeps it
// in the database.
//
// The clock is a list of stretches of work, each with who started it. It
// starts when the diagnosis does, and it's meant to count time on the job,
// not time on the screen: a tech reads a check, goes to the machine and
// comes back to tick it off, so a gap between uses of up to CLOCK_IDLE_MS
// counts as work. After that long without use the clock stops by itself,
// back at the last use (so a tablet left on a diagnosis over lunch adds
// nothing). When the person who was working on it starts it again within
// CLOCK_GAP_MAX_MS, they're asked whether they were working on the unit in
// between, and can count the gap.
//
// Work on the diagnosis (sending Claude a message, ticking a check, marking
// a cause, changing the unit, Resume) starts the clock or keeps it going.
// Using its page (tapping, typing, scrolling) only keeps a stretch going for
// the person whose stretch it is, so a manager looking a diagnosis over
// from the office adds nothing. Someone else's work keeps it going too, and
// once its person has been away from it a couple of minutes (a manager
// started it at the counter and a tech carries on), the stretch is theirs
// from then on, with no gap. Pause stops it until the next work; End and
// "This was it" stop it for good, until it's reopened (Reopen, or taking
// "This was it" back).

// A gap between uses up to this long counts as work.
export const CLOCK_IDLE_MS = 15 * 60_000;
// The longest gap the person who was working can count when they come back.
export const CLOCK_GAP_MAX_MS = 4 * 60 * 60_000;
// A shorter gap isn't asked about: back within a minute (End or "This was
// it" taken back), the clock carries on as if it hadn't stopped.
export const CLOCK_GAP_ASK_MS = 60_000;
// How often an open diagnosis that's in use tells the server so.
export const CLOCK_BEAT_MS = 60_000;
// A stretch's person is away from it after this long without using it.
export const CLOCK_AWAY_MS = 2 * CLOCK_BEAT_MS;

// Why a stretch stopped: Pause; no use for CLOCK_IDLE_MS; End; "This was
// it" (solved); or someone else carried on with it (handover, never the
// latest stretch). A stretch still going has none.
export const CLOCK_STOPS = ["pause", "idle", "end", "solved", "handover"] as const;
export type ClockStop = (typeof CLOCK_STOPS)[number];

// The clock as a whole: none (a diagnosis started before the clock was
// added); counting; stopped by itself; paused; ended (End or solved).
export type ClockState = "off" | "running" | "idle" | "paused" | "ended";

// One stretch, times in milliseconds, numbered from 1 in its diagnosis
// (the latest is the highest). `endedAt` is the last use while it's going
// (stop null), and where it stopped once it has. `gapFrom`: the stretch
// began after a gap its person may count (the stretch before ended there,
// see CLOCK_GAP_MAX_MS); null once they've answered, or when there's
// nothing to ask.
export type ClockSpan = {
  id: string;
  seq: number;
  userId: string;
  startedAt: number;
  endedAt: number;
  stop: ClockStop | null;
  gapFrom: number | null;
};

// What happens to the clock: work on the diagnosis by someone; the page in
// use by someone; Claude finishing a message (keeps a stretch going,
// whoever's it is, but never starts one); Resume or Reopen; Pause, End or
// "This was it"; and the answer to the gap question.
export type ClockEvent =
  | { kind: "work"; userId: string }
  // `ago`: how long before the request the page was last used (it tells the
  // server about once a minute, see CLOCK_BEAT_MS), in milliseconds.
  | { kind: "use"; userId: string; ago?: number }
  | { kind: "touch" }
  | { kind: "resume"; userId: string }
  | { kind: "stop"; userId: string; stop: "pause" | "end" | "solved" }
  | { kind: "gap"; userId: string; keep: boolean };

// What to write for an event, worked out from the latest stretch: at most
// one stretch changed (`update`, by id) and one added after it (`add`,
// which may be stopped already: an end right after a gap, so the gap can
// still be counted).
export type ClockPlan = {
  update?: { id: string; endedAt?: number; stop?: ClockStop; startedAt?: number; gapFrom?: null };
  add?: { seq: number; userId: string; startedAt: number; endedAt: number; stop: ClockStop | null; gapFrom: number | null };
};

const isOpen = (span: ClockSpan) => span.stop === null;
// Going, and used recently enough that the time since still counts.
const isFresh = (span: ClockSpan, now: number) => isOpen(span) && now - span.endedAt <= CLOCK_IDLE_MS;
const isEnded = (span: ClockSpan) => span.stop === "end" || span.stop === "solved";

// Where the clock stands, from its latest stretch.
export function clockState(latest: ClockSpan | null, now: number): ClockState {
  if (!latest) return "off";
  if (isOpen(latest)) return isFresh(latest, now) ? "running" : "idle";
  if (latest.stop === "pause") return "paused";
  if (latest.stop === "end" || latest.stop === "solved") return "ended";
  return "idle";
}

// The gap a new stretch by `userId` would follow, when they may count it:
// they had the stretch before, it stopped by itself or ended (not paused:
// they said they'd stopped), and they're back within CLOCK_GAP_MAX_MS.
function gapBefore(latest: ClockSpan, userId: string, now: number): number | null {
  if (latest.userId !== userId || latest.stop === "pause") return null;
  const gap = now - latest.endedAt;
  return gap > 0 && gap <= CLOCK_GAP_MAX_MS ? latest.endedAt : null;
}

// Stops ranked: a stop only ever moves up this list (stopped by itself,
// paused, ended, solved), so an ended clock stays ended and a solved one
// solved.
const RANK: Record<ClockStop, number> = { handover: 0, idle: 0, pause: 1, end: 2, solved: 3 };

export function clockPlan(latest: ClockSpan | null, event: ClockEvent, now: number): ClockPlan {
  // A diagnosis started before the clock was added has none, and gets none.
  if (!latest) return {};
  // When it happened: the page's use as long ago as it says (at most two
  // beats), and never before the last use (two servers' clocks a moment
  // apart).
  const ago = event.kind === "use" ? Math.min(Math.max(0, event.ago ?? 0), 2 * CLOCK_BEAT_MS) : 0;
  const at = Math.max(now - ago, latest.endedAt);
  const fresh = isFresh(latest, at);
  // A stretch whose page went quiet (a tablet asleep, a tab closed) is
  // stopped by itself where it was last used.
  const closeStale: ClockPlan["update"] = isOpen(latest) && !fresh ? { id: latest.id, stop: "idle" } : undefined;
  const stopped: ClockSpan = closeStale ? { ...latest, stop: "idle" } : latest;
  const tidy = (): ClockPlan => (closeStale ? { update: closeStale } : {});
  // A stretch from now, after the latest (or ending here, with `stop`):
  // after a gap its person may count, or right where the last one ended
  // when they're back within a minute.
  const add = (userId: string, stop: ClockStop | null = null): ClockPlan["add"] => {
    const gapFrom = gapBefore(stopped, userId, at);
    const carryOn = gapFrom !== null && at - gapFrom < CLOCK_GAP_ASK_MS;
    return { seq: latest.seq + 1, userId, startedAt: carryOn ? gapFrom : at, endedAt: at, stop, gapFrom: carryOn ? null : gapFrom };
  };

  switch (event.kind) {
    case "use":
      return fresh && latest.userId === event.userId ? { update: { id: latest.id, endedAt: at } } : tidy();
    case "touch":
      return fresh ? { update: { id: latest.id, endedAt: at } } : tidy();
    case "work":
    case "resume":
      if (fresh) {
        // Someone else carries on with a stretch its person left: it's
        // theirs from now, with no gap.
        if (latest.userId !== event.userId && at - latest.endedAt > CLOCK_AWAY_MS) {
          return {
            update: { id: latest.id, endedAt: at, stop: "handover" },
            add: { seq: latest.seq + 1, userId: event.userId, startedAt: at, endedAt: at, stop: null, gapFrom: null },
          };
        }
        return { update: { id: latest.id, endedAt: at } };
      }
      // Ended stays ended: only Resume (Reopen) starts it again.
      if (isEnded(stopped) && event.kind === "work") return {};
      return { update: closeStale, add: add(event.userId) };
    case "stop": {
      if (fresh) return { update: { id: latest.id, endedAt: at, stop: event.stop } };
      if (RANK[event.stop] <= RANK[stopped.stop!]) return tidy();
      // Ending it, or "This was it", after it stopped by itself: the person
      // who was working on it may have been at the machine all along, so it
      // ends in a stretch of its own they can stretch back over the gap.
      if (event.stop !== "pause" && stopped.stop === "idle" && gapBefore(stopped, event.userId, at) !== null) {
        return { update: closeStale, add: add(event.userId, event.stop) };
      }
      return { update: { id: latest.id, stop: event.stop } };
    }
    case "gap":
      if (latest.gapFrom === null || latest.userId !== event.userId) return {};
      return { update: { id: latest.id, gapFrom: null, ...(event.keep ? { startedAt: latest.gapFrom } : {}) } };
  }
}

// The latest stretch: the highest numbered.
export function latestSpan<T extends Pick<ClockSpan, "seq">>(spans: readonly T[]): T | null {
  let latest: T | null = null;
  for (const span of spans) if (!latest || span.seq > latest.seq) latest = span;
  return latest;
}

// The stretches with a plan applied: what the database will hold (the
// tests, and the screen's own copy).
export function applyPlan(spans: readonly ClockSpan[], plan: ClockPlan, newId = `span-${spans.length + 1}`): ClockSpan[] {
  const { id = null, ...change } = plan.update ?? {};
  const next = spans.map((span) => (span.id === id ? { ...span, ...change } : span));
  if (plan.add) next.push({ id: newId, ...plan.add });
  return next;
}

// The time counted: every stretch from its start to its last use.
export const countedMs = (spans: readonly Pick<ClockSpan, "startedAt" | "endedAt">[]) =>
  spans.reduce((sum, span) => sum + Math.max(0, span.endedAt - span.startedAt), 0);

// What the screen shows of the clock, worked out on the server.
export type ClockView = {
  state: Exclude<ClockState, "off">;
  // Counted up to the last use (or where it stopped), in seconds.
  seconds: number;
  // The last use, or where it stopped (ISO). While it's running, the time
  // since counts too, up to CLOCK_IDLE_MS (see shownClock).
  last: string;
  // When the server worked this out (ISO), the screen's measure of time.
  at: string;
  // Ended by "This was it".
  solved: boolean;
  // Who has the latest stretch, and whether it's the viewer.
  by: string | null;
  mine: boolean;
  // A gap the viewer may count: they came back to it after it stopped.
  gap: { from: string; to: string; seconds: number } | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

// Null for a diagnosis with no clock (started before it was added).
export function clockView(spans: readonly ClockSpan[], viewerId: string, now: number, names: ReadonlyMap<string, string> = new Map()): ClockView | null {
  const latest = latestSpan(spans);
  if (!latest) return null;
  const at = Math.max(now, latest.endedAt);
  return {
    state: clockState(latest, at) as ClockView["state"],
    seconds: Math.round(countedMs(spans) / 1000),
    last: iso(latest.endedAt),
    at: iso(at),
    solved: latest.stop === "solved",
    by: names.get(latest.userId) ?? null,
    mine: latest.userId === viewerId,
    gap:
      latest.gapFrom !== null && latest.userId === viewerId
        ? { from: iso(latest.gapFrom), to: iso(latest.startedAt), seconds: Math.round((latest.startedAt - latest.gapFrom) / 1000) }
        : null,
  };
}

// The clock as the screen shows it at `now` (the server's time, as the
// browser reckons it): while it's running, the time since the last use
// counts on, and once that passes CLOCK_IDLE_MS it has stopped by itself,
// back at the last use, whether or not the server has said so yet.
export function shownClock(view: Pick<ClockView, "state" | "seconds" | "last">, now: number | null): { state: ClockView["state"]; seconds: number } {
  if (view.state !== "running" || now === null) return { state: view.state, seconds: view.seconds };
  const since = Math.max(0, now - Date.parse(view.last));
  return since <= CLOCK_IDLE_MS ? { state: "running", seconds: view.seconds + since / 1000 } : { state: "idle", seconds: view.seconds };
}

// "under 1 min", "42 min", "1 h", "1 h 5 min", "26 h 40 min": whole
// minutes, as a tech would say it.
export function formatDuration(seconds: number) {
  const minutes = Math.round(Math.max(0, seconds) / 60);
  if (minutes === 0) return seconds > 0 ? "under 1 min" : "0 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// Decimal hours, as labor is booked (0.75), to two places.
export const decimalHours = (seconds: number) => Math.round(Math.max(0, seconds) / 36) / 100;
