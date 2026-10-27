// The queue Diagnose draws its manual pictures through and finds a part's
// drawings on its pages through (src/app/(app)/diagnose/manual-pages.ts):
// a few at a time (a tablet stays responsive, and slow shop Wi-Fi isn't
// asked for a dozen pages at once), work asked for first (a picture on
// the screen) ahead of the rest (looking for drawings), otherwise first
// asked, first done; work whose askers have all gone (a part the tech has
// left, a picture scrolled away) is taken out before it starts, and each
// piece of work is done once for everyone who asks for it while it's kept.
// Pure: no browser, no pdf.js; shared by the browser and the tests.

const aborted = () => new DOMException("Aborted", "AbortError");

export type Ask = { signal?: AbortSignal; first?: boolean };

// A piece of work kept for the next time it's asked for: its result, how
// many askers still wait for it, and whether it's begun.
export type Job<T> = { promise: Promise<T>; waiters: number; started: boolean; stop: AbortController };

export function workQueue(atOnce = 2) {
  let running = 0;
  type Waiting = { start: () => void; skip: () => void; signal?: AbortSignal; first: boolean };
  const queue: Waiting[] = [];

  function next() {
    while (running < atOnce && queue.length > 0) {
      const at = queue.findIndex((job) => job.first);
      const [job] = queue.splice(at === -1 ? 0 : at, 1);
      if (job.signal?.aborted) job.skip();
      else job.start();
    }
  }

  // Work in its turn; given up (its signal) before its turn, it never runs.
  function slot<T>(work: () => Promise<T>, { signal, first = false }: Ask = {}): Promise<T> {
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise<T>((resolve, reject) => {
      const job: Waiting = {
        signal,
        first,
        skip: () => reject(aborted()),
        start: () => {
          running++;
          // Begun now (not a moment later), so it's known to be under way.
          let doing: Promise<T>;
          try {
            doing = work();
          } catch (error) {
            doing = Promise.reject(error);
          }
          doing.then(resolve, reject).finally(() => {
            running--;
            next();
          });
        },
      };
      queue.push(job);
      signal?.addEventListener(
        "abort",
        () => {
          const at = queue.indexOf(job);
          if (at === -1) return;
          queue.splice(at, 1);
          job.skip();
        },
        { once: true },
      );
      next();
    });
  }

  // Work kept in `jobs` under `key`, done once for everyone who asks while
  // it's kept (most recently asked for last, for the caller to trim). Each
  // asker may give up (its signal): once all of them have before it's
  // begun, it's taken out of the queue and forgotten, so the next ask
  // starts it again. One that asks with no signal waits whatever happens.
  // A failed one is forgotten too.
  function shared<T>(jobs: Map<string, Job<T>>, key: string, work: () => Promise<T>, { signal, first = false }: Ask = {}): Promise<T> {
    let job = jobs.get(key);
    if (!job) {
      if (signal?.aborted) return Promise.reject(aborted());
      const made: Job<T> = { promise: Promise.resolve() as Promise<T>, waiters: 0, started: false, stop: new AbortController() };
      made.promise = slot(
        () => {
          made.started = true;
          return work();
        },
        { signal: made.stop.signal, first },
      );
      made.promise.catch(() => {
        if (jobs.get(key) === made) jobs.delete(key);
      });
      jobs.set(key, made);
      job = made;
    } else {
      jobs.delete(key);
      jobs.set(key, job);
    }
    if (!signal) job.waiters = Infinity;
    else if (!signal.aborted) {
      const made = job;
      made.waiters++;
      signal.addEventListener(
        "abort",
        () => {
          if (--made.waiters > 0 || made.started) return;
          if (jobs.get(key) === made) jobs.delete(key);
          made.stop.abort();
        },
        { once: true },
      );
    }
    return job.promise;
  }

  return { slot, shared, waiting: () => queue.length, running: () => running };
}
