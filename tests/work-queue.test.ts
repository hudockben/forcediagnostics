// The queue Diagnose draws manual pictures and finds a part's drawings
// through (src/lib/work-queue.ts): a few at a time, pictures ahead of
// looking for drawings and a place always kept for one, work whose
// askers have all gone taken out before
// it starts (and asked for again from the start), work under way left to
// finish, each piece done once for everyone who asks. Pure: no browser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { workQueue, type Job } from "../src/lib/work-queue";

// Work that waits to be let finish, saying when it began.
function gated(log: string[], name: string) {
  let finish!: (value: string) => void;
  const done = new Promise<string>((resolve) => (finish = resolve));
  return {
    work: () => {
      log.push(name);
      return done;
    },
    finish: () => finish(name),
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const isAbort = (error: unknown) => (error as { name?: string })?.name === "AbortError";

describe("the work queue", () => {
  test("two at a time; what's asked for first (a picture) ahead of the rest, which leaves it a place, otherwise in the order asked", async () => {
    const queue = workQueue(2);
    const log: string[] = [];
    // A part's four drawing pages looked at, then the large page's picture asked for.
    const jobs = ["scan 1", "scan 2", "scan 3", "scan 4"].map((name) => gated(log, name));
    const picture = gated(log, "picture");
    const done = jobs.map((job) => queue.slot(job.work));
    assert.deepEqual(log, ["scan 1"]);
    assert.equal(queue.running(), 1);
    const shown = queue.slot(picture.work, { first: true });
    // The picture straight away, not after the scans asked for before it.
    assert.deepEqual(log, ["scan 1", "picture"]);
    assert.equal(queue.running(), 2);
    // Two pictures: the second waits for a place, ahead of the scans.
    const second = gated(log, "picture 2");
    const shownToo = queue.slot(second.work, { first: true });
    jobs[0].finish();
    await done[0];
    await tick();
    assert.deepEqual(log, ["scan 1", "picture", "picture 2"]);
    picture.finish();
    await shown;
    await tick();
    // A place free and a picture under way: the next scan.
    assert.deepEqual(log, ["scan 1", "picture", "picture 2", "scan 2"]);
    second.finish();
    await shownToo;
    await tick();
    // Never two scans at once.
    assert.deepEqual(log, ["scan 1", "picture", "picture 2", "scan 2"]);
    jobs[1].finish();
    await done[1];
    await tick();
    assert.deepEqual(log, ["scan 1", "picture", "picture 2", "scan 2", "scan 3"]);
    jobs[2].finish();
    await done[2];
    await tick();
    jobs[3].finish();
    assert.deepEqual(await Promise.all(done), ["scan 1", "scan 2", "scan 3", "scan 4"]);
    assert.deepEqual(log, ["scan 1", "picture", "picture 2", "scan 2", "scan 3", "scan 4"]);
    assert.equal(queue.running(), 0);
  });

  test("given up while waiting, it never runs, and the next in line takes its turn; under way, it finishes", async () => {
    const queue = workQueue(1);
    const log: string[] = [];
    const first = gated(log, "under way");
    const left = gated(log, "left");
    const wanted = gated(log, "wanted");
    const stopFirst = new AbortController();
    const stopLeft = new AbortController();
    const running = queue.slot(first.work, { signal: stopFirst.signal });
    const skipped = queue.slot(left.work, { signal: stopLeft.signal });
    const kept = queue.slot(wanted.work);
    stopLeft.abort();
    await assert.rejects(skipped, isAbort);
    assert.equal(queue.waiting(), 1);
    // Already begun: giving up doesn't stop it.
    stopFirst.abort();
    first.finish();
    assert.equal(await running, "under way");
    await tick();
    wanted.finish();
    assert.equal(await kept, "wanted");
    assert.deepEqual(log, ["under way", "wanted"]);
    // Asked for already given up: not even queued.
    await assert.rejects(queue.slot(async () => "no", { signal: AbortSignal.abort() }), isAbort);
  });

  test("shared: done once for everyone who asks; kept for the next ask; gone when all its askers have gone before it began, and asked for again from the start", async () => {
    const queue = workQueue(1);
    const jobs = new Map<string, Job<string>>();
    const log: string[] = [];
    const blocker = gated(log, "blocker");
    const busy = queue.slot(blocker.work);
    let runs = 0;
    const work = async () => {
      runs++;
      return "page 9";
    };
    // Two askers (the bubble and the sheet): one goes, the other still waits.
    const bubble = new AbortController();
    const sheet = new AbortController();
    const forBubble = queue.shared(jobs, "rzr:9", work, { signal: bubble.signal });
    const forSheet = queue.shared(jobs, "rzr:9", work, { signal: sheet.signal });
    assert.equal(forBubble, forSheet);
    bubble.abort();
    assert.ok(jobs.has("rzr:9"));
    blocker.finish();
    await busy;
    assert.equal(await forSheet, "page 9");
    assert.equal(runs, 1);
    // Kept: asked again, nothing runs.
    assert.equal(await queue.shared(jobs, "rzr:9", work), "page 9");
    assert.equal(runs, 1);

    // Every asker gone before its turn (a part the tech left): out of the queue, not kept.
    const again = gated(log, "blocker 2");
    const busyAgain = queue.slot(again.work);
    const left = new AbortController();
    const forLeft = queue.shared(jobs, "rzr:10", work, { signal: left.signal });
    left.abort();
    await assert.rejects(forLeft, isAbort);
    assert.equal(jobs.has("rzr:10"), false);
    assert.equal(queue.waiting(), 0);
    // Picked again: asked for from the start, and done.
    const back = queue.shared(jobs, "rzr:10", work, { signal: new AbortController().signal });
    again.finish();
    await busyAgain;
    assert.equal(await back, "page 9");
    assert.equal(runs, 2);

    // An asker with no signal waits whatever the others do.
    const third = gated(log, "blocker 3");
    const busyThird = queue.slot(third.work);
    const gone = new AbortController();
    const forGone = queue.shared(jobs, "rzr:11", work, { signal: gone.signal });
    const forAll = queue.shared(jobs, "rzr:11", work);
    gone.abort();
    third.finish();
    await busyThird;
    assert.equal(await forAll, "page 9");
    assert.equal(await forGone, "page 9");
    assert.equal(runs, 3);
  });

  test("shared: one that fails is forgotten, so it's tried again on the next ask", async () => {
    const queue = workQueue(2);
    const jobs = new Map<string, Job<string>>();
    let tries = 0;
    const work = async () => {
      if (++tries === 1) throw new Error("storage turned it down");
      return "drawn";
    };
    await assert.rejects(queue.shared(jobs, "rzr:7", work), /turned it down/);
    await tick();
    assert.equal(jobs.has("rzr:7"), false);
    assert.equal(await queue.shared(jobs, "rzr:7", work), "drawn");
    assert.equal(tries, 2);
  });
});
