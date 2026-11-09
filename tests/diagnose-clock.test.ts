// Diagnose's clock (src/lib/diagnose-clock-rules.ts): how long the shop
// worked on a diagnosis. Time between uses up to 15 minutes counts (the
// tech is at the machine); after that it stops by itself at the last use,
// and the person who was working can count the gap when they come back,
// within 4 hours. Someone else's use adds nothing, their work does, and a
// stretch its person left is theirs from then on. Pause, End and "This was
// it", Reopen, Claude finishing a message, what the screen shows, and how
// times read. No database: tests/diagnose.test.ts drives the real thing.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CLOCK_GAP_MAX_MS,
  applyPlan,
  clockPlan,
  clockState,
  clockView,
  countedMs,
  decimalHours,
  formatDuration,
  latestSpan,
  shownClock,
  type ClockEvent,
  type ClockSpan,
} from "../src/lib/diagnose-clock-rules";

const MIN = 60_000;
const T0 = Date.parse("2026-11-09T14:00:00.000Z");
const at = (minutes: number) => T0 + minutes * MIN;

// A clock started by `userId` at T0, moved by events at minutes past T0.
function clock(userId = "mike") {
  let spans: ClockSpan[] = [{ id: "span-1", seq: 1, userId, startedAt: T0, endedAt: T0, stop: null, gapFrom: null }];
  const self = {
    on(minutes: number, event: ClockEvent) {
      spans = applyPlan(spans, clockPlan(latestSpan(spans), event, at(minutes)));
      return self;
    },
    get spans() {
      return spans;
    },
    get latest() {
      return latestSpan(spans)!;
    },
    // Counted, in minutes.
    get minutes() {
      return countedMs(spans) / MIN;
    },
    state: (minutes: number) => clockState(latestSpan(spans), at(minutes)),
    view: (viewer: string, minutes: number) => clockView(spans, viewer, at(minutes), new Map([["mike", "Mike"], ["rae", "Rae"], ["lou", "Lou"]])),
  };
  return self;
}

const use = (userId = "mike", ago?: number): ClockEvent => ({ kind: "use", userId, ago });
const work = (userId = "mike"): ClockEvent => ({ kind: "work", userId });
const resume = (userId = "mike"): ClockEvent => ({ kind: "resume", userId });
const stop = (what: "pause" | "end" | "solved", userId = "mike"): ClockEvent => ({ kind: "stop", userId, stop: what });
const gap = (keep: boolean, userId = "mike"): ClockEvent => ({ kind: "gap", userId, keep });

describe("the clock counts time on the job", () => {
  test("time between uses up to 15 minutes counts; after that it stops by itself, back at the last use", () => {
    const c = clock().on(5, use()).on(12, use()).on(26, work());
    assert.equal(c.minutes, 26);
    assert.equal(c.state(41), "running");
    assert.equal(c.state(41.5), "idle");
    // The page used again after that doesn't start it: the stretch is
    // closed where it was last used.
    c.on(45, use());
    assert.equal(c.minutes, 26);
    assert.deepEqual([c.spans.length, c.latest.stop, c.latest.endedAt], [1, "idle", at(26)]);
    assert.equal(c.state(45), "idle");
  });

  test("the page says how long ago it was last used, at most two beats back", () => {
    const c = clock().on(5, use("mike", 30_000));
    assert.equal(c.minutes, 4.5);
    c.on(10, use("mike", 10 * MIN));
    assert.equal(c.minutes, 8);
    // Never back before the last use.
    c.on(10.5, use("mike", 2 * MIN));
    assert.equal(c.minutes, 8.5);
  });

  test("someone else's use adds nothing; their work keeps it going, and a stretch its person left is theirs from then on", () => {
    const c = clock().on(3, use());
    c.on(5, use("lou"));
    assert.equal(c.minutes, 3);
    // Mike was here a minute ago: Lou's tick is help, and the stretch stays Mike's.
    c.on(4, work("lou"));
    assert.deepEqual([c.minutes, c.spans.length, c.latest.userId], [4, 1, "mike"]);
    c.on(4.5, use("lou"));
    assert.equal(c.minutes, 4);
    // Mike's been away 6 minutes when Rae carries on: no gap, and it's hers.
    c.on(10, work("rae"));
    assert.deepEqual(
      c.spans.map((span) => [span.userId, (span.startedAt - T0) / MIN, (span.endedAt - T0) / MIN, span.stop]),
      [
        ["mike", 0, 10, "handover"],
        ["rae", 10, 10, null],
      ],
    );
    c.on(12, use("rae")).on(13, use("mike"));
    assert.equal(c.minutes, 12);
    assert.equal(c.view("mike", 13)!.by, "Rae");
    assert.equal(c.view("mike", 13)!.mine, false);
    assert.equal(c.view("rae", 13)!.mine, true);
  });
});

describe("coming back after it stopped by itself", () => {
  test("the person who was working is asked about the gap and can count it", () => {
    const c = clock().on(10, use()).on(40, work());
    assert.equal(c.minutes, 10);
    assert.deepEqual(
      c.spans.map((span) => [span.seq, (span.startedAt - T0) / MIN, (span.endedAt - T0) / MIN, span.stop, span.gapFrom && (span.gapFrom - T0) / MIN]),
      [
        [1, 0, 10, "idle", null],
        [2, 40, 40, null, 10],
      ],
    );
    assert.deepEqual(c.view("mike", 40)!.gap, { from: new Date(at(10)).toISOString(), to: new Date(at(40)).toISOString(), seconds: 1800 });
    assert.equal(c.view("rae", 40)!.gap, null);
    // Only they can answer it.
    c.on(41, gap(true, "rae"));
    assert.equal(c.minutes, 10);
    c.on(41, gap(true));
    assert.equal(c.minutes, 40);
    assert.equal(c.view("mike", 41)!.gap, null);
    c.on(42, use());
    assert.equal(c.minutes, 42);
  });

  test("not counting it leaves it out, and the question goes", () => {
    const c = clock().on(10, use()).on(40, resume()).on(41, gap(false)).on(42, use());
    assert.equal(c.minutes, 12);
    assert.equal(c.view("mike", 42)!.gap, null);
  });

  test("nothing is asked of someone else, after a pause, or after more than 4 hours", () => {
    assert.equal(clock().on(10, use()).on(40, work("rae")).latest.gapFrom, null);
    assert.equal(clock().on(10, use()).on(11, stop("pause")).on(40, work()).latest.gapFrom, null);
    const late = clock().on(10, use()).on(10 + CLOCK_GAP_MAX_MS / MIN + 1, work());
    assert.equal(late.latest.gapFrom, null);
    assert.notEqual(clock().on(10, use()).on(10 + CLOCK_GAP_MAX_MS / MIN, work()).latest.gapFrom, null);
  });
});

describe("Pause, End, This was it and Reopen", () => {
  test("Pause stops it at once, until the next work", () => {
    const c = clock().on(10, use()).on(12, stop("pause"));
    assert.deepEqual([c.minutes, c.state(13)], [12, "paused"]);
    c.on(14, use());
    assert.deepEqual([c.minutes, c.state(14)], [12, "paused"]);
    c.on(30, work()).on(35, use());
    assert.deepEqual([c.minutes, c.state(35), c.spans.length], [17, "running", 2]);
    // Paused, then stopped by itself: still paused.
    assert.equal(clock().on(10, stop("pause")).state(100), "paused");
  });

  test("End stops it for good: work doesn't start it again, Reopen does, carrying on as it was within a minute", () => {
    const c = clock().on(10, use()).on(20, stop("end"));
    assert.deepEqual([c.minutes, c.state(21), c.view("mike", 21)!.solved], [20, "ended", false]);
    c.on(25, work()).on(26, use());
    assert.deepEqual([c.minutes, c.state(26)], [20, "ended"]);
    const quick = clock().on(10, use()).on(20, stop("end")).on(20.5, resume()).on(21, use());
    assert.deepEqual([quick.minutes, quick.state(21), quick.latest.gapFrom], [21, "running", null]);
    // Reopened half an hour later: asked about the gap.
    const later = clock().on(10, use()).on(20, stop("end")).on(50, resume());
    assert.equal(later.latest.gapFrom, at(20));
    assert.equal(later.state(50), "running");
  });

  test("This was it after the clock stopped by itself ends it in a stretch the gap can be counted into", () => {
    const c = clock().on(10, use()).on(40, stop("solved"));
    assert.deepEqual(
      c.spans.map((span) => [(span.startedAt - T0) / MIN, (span.endedAt - T0) / MIN, span.stop, span.gapFrom && (span.gapFrom - T0) / MIN]),
      [
        [0, 10, "idle", null],
        [40, 40, "solved", 10],
      ],
    );
    assert.deepEqual([c.state(41), c.view("mike", 41)!.solved, c.view("mike", 41)!.gap?.seconds], ["ended", true, 1800]);
    c.on(42, gap(true));
    assert.equal(c.minutes, 40);
    // Someone else's This was it just ends it where it stopped.
    const other = clock().on(10, use()).on(40, stop("solved", "lou"));
    assert.deepEqual([other.spans.length, other.latest.stop, other.minutes], [1, "solved", 10]);
    // While it runs, at once.
    const running = clock().on(10, use()).on(12, stop("solved"));
    assert.deepEqual([running.spans.length, running.latest.stop, running.minutes], [1, "solved", 12]);
  });

  test("a stop only moves on: ended stays ended, solved stays solved", () => {
    const c = clock().on(10, stop("end")).on(12, stop("pause"));
    assert.equal(c.latest.stop, "end");
    c.on(13, stop("solved"));
    assert.equal(c.latest.stop, "solved");
    c.on(14, stop("end"));
    assert.deepEqual([c.latest.stop, c.minutes, c.spans.length], ["solved", 10, 1]);
    const paused = clock().on(10, stop("pause")).on(30, stop("end"));
    assert.deepEqual([paused.latest.stop, paused.minutes, paused.spans.length], ["end", 10, 1]);
  });

  test("Claude finishing a message keeps any stretch going, but never starts one", () => {
    const c = clock().on(2, { kind: "touch" });
    assert.equal(c.minutes, 2);
    for (const stopped of [clock().on(2, stop("pause")), clock().on(2, stop("end")), clock().on(2, use())]) {
      const before = stopped.minutes;
      stopped.on(30, { kind: "touch" });
      assert.equal(stopped.minutes, before);
      assert.notEqual(stopped.state(30), "running");
    }
  });

  test("a diagnosis from before the clock has none, and gets none", () => {
    assert.deepEqual(clockPlan(null, work(), T0), {});
    assert.deepEqual(clockPlan(null, resume(), T0), {});
    assert.equal(clockView([], "mike", T0), null);
    assert.equal(clockState(null, T0), "off");
  });
});

describe("what the screen shows", () => {
  test("the view: counted up to the last use, where it stands, whose stretch", () => {
    const c = clock().on(10, use());
    assert.deepEqual(c.view("mike", 12), {
      state: "running",
      seconds: 600,
      last: new Date(at(10)).toISOString(),
      at: new Date(at(12)).toISOString(),
      solved: false,
      by: "Mike",
      mine: true,
      gap: null,
    });
  });

  test("while it runs the time since the last use counts on; past 15 minutes it has stopped by itself", () => {
    const view = clock().on(10, use()).view("mike", 10)!;
    assert.deepEqual(shownClock(view, at(14)), { state: "running", seconds: 840 });
    assert.deepEqual(shownClock(view, at(25)), { state: "running", seconds: 1500 });
    assert.deepEqual(shownClock(view, at(25.1)), { state: "idle", seconds: 600 });
    // Before the browser knows the time (the server's render): as counted.
    assert.deepEqual(shownClock(view, null), { state: "running", seconds: 600 });
    const paused = clock().on(10, stop("pause")).view("mike", 10)!;
    assert.deepEqual(shownClock(paused, at(30)), { state: "paused", seconds: 600 });
  });

  test("times as a tech would say them, and as labor is booked", () => {
    assert.deepEqual(
      [0, 20, 29, 31, 90, 42 * 60, 60 * 60, 65 * 60, 26 * 3600 + 40 * 60].map(formatDuration),
      ["0 min", "under 1 min", "under 1 min", "1 min", "2 min", "42 min", "1 h", "1 h 5 min", "26 h 40 min"],
    );
    assert.deepEqual([0, 45 * 60, 3600, 5400, 100].map(decimalHours), [0, 0.75, 1, 1.5, 0.03]);
  });
});
