import { unstable_isUnrecognizedActionError as isUnrecognizedActionError } from "next/navigation";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

import type { OcrManual } from "@/lib/manual-ocr";
import {
  OCR_ASSET_URL,
  RULE_MIN_INCHES,
  batchBytes,
  fitsInBatch,
  ocrScale,
  ocrWorkerCount,
  pagesPerMinute,
  removeRules,
  textFromTsv,
  toGreyPgm,
} from "@/lib/manual-ocr-rules";
import type { PageText } from "@/lib/manual-rules";
import { PDFJS_WASM_URL, describePdfError, loadPdfJs } from "@/lib/pdfjs";

import { getScannedFileUrl, listScannedPages, saveScannedText } from "./actions";

// Reads the library's scanned pages with OCR, in this browser (the Scanned
// pages card on System Admin > Manuals). For each manual with pages left to
// read: open its PDF straight from storage (pdf.js fetches only the parts
// those pages need), draw each page at about 300 dpi, turn it grey and take
// out table rules, read it with Tesseract (several workers side by side),
// and send the text to the server every few pages. The server says what's
// left to read, so a run that stops (the tab closed, the laptop slept)
// carries on from there next time. While it reads, the tab warns before
// closing and keeps the computer awake while it's in front.
//
// One run per tab, kept here rather than in the card: Next keeps a page
// running in the background after someone moves to another one and may
// show a fresh copy of it later, which then shows the same run.

// Bytes per range request: pages of scans are big, so bigger than the
// viewer's.
const RANGE_CHUNK_BYTES = 512 * 1024;
// Storage links last 15 minutes; a manual open longer gets a new one.
const LINK_REFRESH_MS = 10 * 60_000;
// A page taking longer than this has hung Tesseract; it's tried again.
const PAGE_TIMEOUT_MS = 3 * 60_000;
// Workers are started afresh every so many pages, between manuals, in case
// Tesseract's memory creeps up over a long run.
const PAGES_PER_ENGINE = 400;
// Refresh the Manuals page (its counts and list) at most this often.
const REFRESH_EVERY_MS = 30_000;
// Only one tab reads at a time (where the browser can tell).
const LOCK_NAME = "forcediagnostics-ocr";
// While the connection is down, the server is asked again after this long,
// doubling up to the most (and straight away when the browser says it's
// back online). Each ask gives up after PROBE_TIMEOUT_MS.
const RECONNECT_FIRST_MS = 5_000;
const RECONNECT_MOST_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
// The run stops when this many manuals, or pages, fail with nothing saved
// in between, and the connection up: something other than the manuals is
// wrong (file storage, say), and working down the list won't help.
const MANUALS_FAILING_TO_STOP = 3;
const PAGES_FAILING_TO_STOP = 20;

export type OcrFailure = {
  key: string;
  manualId: string;
  title: string;
  pages: number[];
  message: string;
};

export type OcrState =
  // Nothing running.
  | "idle"
  // Getting the list of pages and starting Tesseract.
  | "starting"
  | "running"
  // Finishing the pages being read before pausing.
  | "pausing"
  | "paused"
  | "finished"
  // Another tab is reading.
  | "elsewhere";

export type OcrSnapshot = {
  state: OcrState;
  // Waiting for the connection to come back.
  waiting: boolean;
  // Pages in this run, and how many have been read.
  total: number;
  read: number;
  // Pages read that now have text search can find.
  withText: number;
  manuals: number;
  manualsDone: number;
  current: { title: string; pageNumber: number; position: number; count: number } | null;
  pagesPerMinute: number | null;
  workers: number;
  failures: OcrFailure[];
  // Why the run couldn't start, or stopped.
  problem: string | null;
};

const initial: OcrSnapshot = {
  state: "idle",
  waiting: false,
  total: 0,
  read: 0,
  withText: 0,
  manuals: 0,
  manualsDone: 0,
  current: null,
  pagesPerMinute: null,
  workers: 0,
  failures: [],
  problem: null,
};

// A failure with a message for the person, as opposed to a bug.
class Stop extends Error {}
// A failure that stops the whole run, not just a page or a manual: Tesseract
// didn't start, the app was updated, or one thing after another failed.
class StopRun extends Stop {}

const appUpdated = () =>
  new StopRun("The app was updated while reading. Reload this page and press Read scanned pages to carry on.");
const failingInARow = () =>
  new StopRun(
    "Reading stopped: one manual or page after another couldn't be read, which usually means trouble with the connection or file storage, not the manuals. Press Read scanned pages later to try again: it carries on where it stopped.",
  );

function check<T extends object>(result: T | { error: string }): T {
  if ("error" in result) throw new Stop(result.error);
  return result;
}

function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Stop(message)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Closing the tab mid-run loses at most the last few pages, but still ask.
const warnBeforeClosing = (event: BeforeUnloadEvent) => event.preventDefault();

// Whether the app's server answers. The browser's own online flag stays on
// when only the shop's internet is down (the router is still there), so a
// step that failed asks the server before blaming the page or manual.
async function reachable() {
  if (!navigator.onLine) return false;
  try {
    const response = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

// Holds the cross-tab lock until the returned function is called. Null when
// another tab has it. Browsers without the Locks API just go ahead: two
// tabs reading at once waste time, but the server never saves a page twice.
function takeLock(): Promise<(() => void) | null> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    void locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return;
      }
      return new Promise<void>((release) => resolve(release));
    });
  });
}

// A PDF pdf.js can't read (damaged, or password-protected), as opposed to
// one storage didn't hand over.
const isPdfProblem = (error: unknown) =>
  ["PasswordException", "InvalidPDFException"].includes((error as { name?: string } | null)?.name ?? "");
// A problem with that one file (or it isn't in storage at all), which says
// nothing about the next manual's.
const isFileProblem = (error: unknown) =>
  isPdfProblem(error) || (error as { missing?: boolean } | null)?.missing === true;

// Why a manual's PDF couldn't be opened, for the list of problems. The
// connection was up (see reachable), so it's the file or storage.
function openProblem(error: unknown) {
  if (error instanceof Stop) return error.message;
  if (isPdfProblem(error)) return describePdfError(error);
  console.error("Couldn't open a manual for OCR", error);
  return "The PDF couldn't be opened from storage. Retry it; if it fails again, the file may be damaged.";
}

// pdf.js's image decoders for scanned pages (CCITT and JBIG2, JPEG 2000),
// fetched once in this tab and handed to every PDF opened for OCR.
const decoderFiles = new Map<string, Promise<Uint8Array>>();

// Whether a decoder failed to load for one opened PDF.
type Decoders = { failed: boolean };
type Opened = { pdf: PDFDocumentProxy; decoders: Decoders };

// What pdf.js asks for a decoder with (getDocument's BinaryDataFactory). When
// a decoder doesn't load, pdf.js draws the images it's for blank rather
// than failing, and OCR would save the page as one with no words, for good.
// This notes it in `decoders`, so the page is drawn again from a fresh copy
// of the PDF, or listed as failed.
function decoderFactory(decoders: Decoders) {
  return class {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      // Fonts and character maps aren't set up for OCR (nor for the viewer).
      if (kind !== "wasmUrl") throw new Error(`No ${kind} data for OCR.`);
      let file = decoderFiles.get(filename);
      if (!file) {
        file = fetch(`${PDFJS_WASM_URL}${filename}`).then(async (response) => {
          if (!response.ok) throw new Error(`${filename}: ${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        });
        decoderFiles.set(filename, file);
      }
      try {
        // A copy: pdf.js hands the bytes on to its worker.
        return (await file).slice();
      } catch (error) {
        if (decoderFiles.get(filename) === file) decoderFiles.delete(filename);
        decoders.failed = true;
        throw error;
      }
    }
  };
}

// Draws a page for OCR and returns it as a grey image without ruled lines.
async function drawPage({ pdf, decoders }: Opened, pageNumber: number) {
  const page = await pdf.getPage(pageNumber);
  const canvas = document.createElement("canvas");
  try {
    const size = page.getViewport({ scale: 1 });
    const { scale, dpi } = ocrScale(size.width, size.height);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    // The print intent draws without waiting for animation frames, which a
    // tab in the background never gets.
    await page.render({ canvas, viewport, intent: "print" }).promise;
    // Its scanned image (or an earlier page's) drew blank.
    if (decoders.failed) throw new Error("An image decoder for this PDF didn't load.");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas");
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const { image, pixels } = toGreyPgm(data, canvas.width, canvas.height);
    removeRules(pixels, canvas.width, canvas.height, Math.round(RULE_MIN_INCHES * dpi));
    return { image, dpi };
  } finally {
    // Frees the canvas's memory now rather than whenever it's collected.
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

type Engine = {
  recognize(image: Uint8Array, dpi: number): Promise<string>;
  stop(): Promise<void>;
  pages: number;
};

// Starts Tesseract: a scheduler handing pages to `workers` workers. Every
// file it needs comes from this site (copied into public/ by
// scripts/copy-tesseract.mjs), never a CDN.
async function startEngine(workers: number): Promise<Engine> {
  const tesseract = await import("tesseract.js");
  const { createScheduler, createWorker, OEM } = tesseract.default ?? tesseract;
  const scheduler = createScheduler();
  const options = {
    workerPath: `${OCR_ASSET_URL}worker.min.js`,
    corePath: `${OCR_ASSET_URL}core`,
    langPath: `${OCR_ASSET_URL}lang`,
    // Where the browser keeps the English data after the first download.
    cachePath: "forcediagnostics-ocr",
    gzip: true,
    // Errors come back from recognize instead of being thrown elsewhere.
    errorHandler: () => {},
  };
  const addWorker = async () => {
    const worker = await within(
      createWorker("eng", OEM.LSTM_ONLY, options),
      2 * 60_000,
      "OCR couldn't start: its files didn't load. Check the connection, then press Read scanned pages to carry on.",
    );
    scheduler.addWorker(worker);
  };
  try {
    // The first worker saves the English data in the browser, so the others
    // needn't download it again.
    await addWorker();
    await Promise.all(Array.from({ length: workers - 1 }, addWorker));
  } catch (error) {
    await scheduler.terminate();
    throw new StopRun(
      error instanceof Stop
        ? error.message
        : "OCR couldn't start in this browser. Try an up-to-date Chrome, Edge, Firefox or Safari.",
    );
  }
  // Settles every page being read when the engine stops.
  let stopAll: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    stopAll = reject;
  });
  stopped.catch(() => {});
  const engine: Engine = {
    pages: 0,
    async recognize(image, dpi) {
      engine.pages += 1;
      // Tesseract settings for this page go in with recognize's options;
      // tesseract.js's types only list its own. Its resolution helps
      // Tesseract judge sizes, since a PGM image doesn't say.
      const settings = { user_defined_dpi: String(dpi) } as object;
      const job = scheduler.addJob(
        "recognize",
        // A PGM image's bytes; tesseract.js passes them on as they are.
        image as unknown as Buffer,
        settings,
        // Words with how sure it is of each (see textFromTsv).
        { text: false, tsv: true },
      );
      const { data } = await within(Promise.race([job, stopped]), PAGE_TIMEOUT_MS, "Reading this page took too long.");
      return textFromTsv(data.tsv ?? "");
    },
    async stop() {
      stopAll(new Stop("OCR stopped."));
      await scheduler.terminate();
    },
  };
  return engine;
}

class OcrJob {
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private refreshPage: (() => void) | null = null;
  private lastRefresh = 0;
  private queue: OcrManual[] = [];
  private pausing = false;
  private resumeRun: (() => void) | null = null;
  private engine: Promise<Engine> | null = null;
  private finishedAt: number[] = [];
  private since = 0;
  private nextKey = 1;
  // Set when the run has to stop (see StopRun).
  private stopped: StopRun | null = null;
  // Pages and manuals that failed since text was last saved (see failing).
  private pagesFailing = 0;
  private manualsFailing = 0;
  // Waiting for the connection, shared by every step that needs it.
  private reconnecting: Promise<void> | null = null;
  // While reading: keep the computer awake (see guard).
  private awake = false;
  private wakeLock: Promise<WakeLockSentinel | null> | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  // The card showing the run refreshes the page when text has been saved.
  setRefresh(refresh: () => void) {
    this.refreshPage = refresh;
    return () => {
      if (this.refreshPage === refresh) this.refreshPage = null;
    };
  }

  private set(patch: Partial<OcrSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  // Only when the server answers: a refresh that can't reach it makes Next
  // load the whole page again, which would end the run.
  private refresh(force: boolean) {
    if (!force && Date.now() - this.lastRefresh < REFRESH_EVERY_MS) return;
    this.lastRefresh = Date.now();
    void reachable().then((up) => {
      if (up) this.refreshPage?.();
    });
  }

  get busy() {
    return ["starting", "running", "pausing", "paused"].includes(this.snapshot.state);
  }

  // Reads every scanned page the server says is left, or only `only`
  // (pages that failed, tried again).
  async start(only?: OcrManual[]) {
    if (this.busy) return;
    this.set({ state: "starting", problem: null, waiting: false });
    const release = await takeLock();
    if (!release) {
      this.set({ state: "elsewhere" });
      return;
    }
    this.guard(true);
    try {
      const manuals = only ?? check(await this.online(() => listScannedPages())).manuals;
      this.queue = [...manuals];
      this.finishedAt = [];
      this.since = Date.now();
      this.pausing = false;
      this.stopped = null;
      this.pagesFailing = 0;
      this.manualsFailing = 0;
      this.set({
        state: "running",
        total: manuals.reduce((total, manual) => total + manual.pages.length, 0),
        read: 0,
        withText: 0,
        manuals: manuals.length,
        manualsDone: 0,
        current: null,
        pagesPerMinute: null,
        workers: ocrWorkerCount(navigator.hardwareConcurrency),
        // Retrying some keeps the others listed.
        failures: only ? this.snapshot.failures : [],
      });
      while (this.queue.length > 0) {
        if (this.stopped) throw this.stopped;
        await this.pausePoint(async () => {});
        const manual = this.queue[0];
        await this.readManual(manual);
        this.queue.shift();
        this.set({ manualsDone: this.snapshot.manualsDone + 1 });
        this.refresh(false);
        // A fresh set of workers now and then, between manuals.
        const engine = this.engine && (await this.engine.catch(() => null));
        if (engine && engine.pages >= PAGES_PER_ENGINE) await this.stopEngine();
      }
      if (this.stopped) throw this.stopped;
      this.set({ state: "finished", current: null, waiting: false });
    } catch (error) {
      if (!(error instanceof Stop)) console.error("Couldn't read scanned pages", error);
      this.queue = [];
      this.set({
        state: this.snapshot.read > 0 ? "finished" : "idle",
        current: null,
        waiting: false,
        problem:
          error instanceof Stop
            ? error.message
            : "Reading stopped: something went wrong. Check the connection and press Read scanned pages to carry on.",
      });
    } finally {
      await this.stopEngine();
      this.guard(false);
      release();
      this.refresh(true);
    }
  }

  pause() {
    if (this.snapshot.state !== "running") return;
    this.pausing = true;
    this.set({ state: "pausing" });
  }

  resume() {
    if (this.snapshot.state !== "paused" && this.snapshot.state !== "pausing") return;
    this.pausing = false;
    const resumeRun = this.resumeRun;
    this.resumeRun = null;
    if (resumeRun) resumeRun();
    else this.set({ state: "running" });
  }

  // Tries a failure's pages again: at the end of this run, or in a new one.
  retry(keys: string[]) {
    const failures = this.snapshot.failures.filter((failure) => keys.includes(failure.key));
    if (failures.length === 0) return;
    const manuals = failures.map((failure) => ({
      id: failure.manualId,
      title: failure.title,
      pageCount: 0,
      pages: failure.pages,
    }));
    this.set({ failures: this.snapshot.failures.filter((failure) => !keys.includes(failure.key)) });
    if (this.busy) {
      this.queue.push(...manuals);
      this.set({
        total: this.snapshot.total + manuals.reduce((total, manual) => total + manual.pages.length, 0),
        manuals: this.snapshot.manuals + manuals.length,
      });
    } else {
      void this.start(manuals);
    }
  }

  // While reading: the leave-page warning, and a screen wake lock so the
  // computer doesn't go to sleep on a long run. Browsers let go of the wake
  // lock when the tab is hidden, so it's asked for again when it's back in
  // front; browsers without one just don't keep the computer awake.
  private guard(on: boolean) {
    this.awake = on;
    if (on) {
      window.addEventListener("beforeunload", warnBeforeClosing);
      document.addEventListener("visibilitychange", this.stayAwake);
      this.stayAwake();
      return;
    }
    window.removeEventListener("beforeunload", warnBeforeClosing);
    document.removeEventListener("visibilitychange", this.stayAwake);
    const wakeLock = this.wakeLock;
    this.wakeLock = null;
    void wakeLock?.then((lock) => lock?.release()).catch(() => {});
  }

  private stayAwake = () => {
    if (!this.awake || this.wakeLock || document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
    const request: Promise<WakeLockSentinel | null> = navigator.wakeLock.request("screen").then(
      (lock) => {
        lock.addEventListener("release", () => {
          if (this.wakeLock === request) this.wakeLock = null;
        });
        // Paused or stopped meanwhile.
        if (this.wakeLock !== request) {
          void lock.release().catch(() => {});
          return null;
        }
        return lock;
      },
      () => {
        if (this.wakeLock === request) this.wakeLock = null;
        return null;
      },
    );
    this.wakeLock = request;
  };

  // Runs a step that needs the server or storage. If it fails and the
  // server doesn't answer either, waits for the connection to come back and
  // tries again; otherwise (the server answered) the error is the step's.
  private async online<T>(step: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await step();
      } catch (error) {
        if (error instanceof Stop) throw error;
        // A new version of the app is live: these actions are gone.
        if (isUnrecognizedActionError(error)) throw appUpdated();
        if (await reachable()) throw error;
      }
      await this.connection();
    }
  }

  // Waits until the server answers again: asked when the browser says it's
  // back online, and every so often (it can't always tell).
  private connection() {
    this.reconnecting ??= (async () => {
      this.set({ waiting: true });
      for (let delay = RECONNECT_FIRST_MS; ; delay = Math.min(delay * 2, RECONNECT_MOST_MS)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            window.removeEventListener("online", done);
            resolve();
          };
          const timer = setTimeout(done, delay);
          window.addEventListener("online", done);
        });
        if (await reachable()) break;
      }
      this.set({ waiting: false });
      // Pages a minute counts from here.
      this.since = Date.now();
    })().finally(() => {
      this.reconnecting = null;
    });
    return this.reconnecting;
  }

  // Counts pages and manuals that failed for no reason the server gave, with
  // the connection up; too many with nothing saved in between stops the run.
  private failing(pages: number, manuals: number) {
    this.pagesFailing += pages;
    this.manualsFailing += manuals;
    if (this.pagesFailing >= PAGES_FAILING_TO_STOP || this.manualsFailing >= MANUALS_FAILING_TO_STOP) {
      this.stopped ??= failingInARow();
    }
  }

  private getEngine() {
    this.engine ??= this.startEngineOnline().catch((error) => {
      this.engine = null;
      throw error;
    });
    return this.engine;
  }

  // Starts Tesseract; if its files didn't load because the connection is
  // down, waits for it and tries again.
  private async startEngineOnline() {
    for (;;) {
      try {
        return await startEngine(this.snapshot.workers);
      } catch (error) {
        if (await reachable()) throw error;
      }
      await this.connection();
    }
  }

  // Stops Tesseract, or only `which` if that's still the one running.
  private async stopEngine(which?: Promise<Engine>) {
    const engine = this.engine;
    if (which && which !== engine) return;
    this.engine = null;
    await (await engine?.catch(() => null))?.stop();
  }

  // Where a run stops when it's paused: after `settle` (the pages being read
  // are saved), with Tesseract stopped to give its memory back.
  private async pausePoint(settle: () => Promise<void>) {
    if (!this.pausing) return;
    await settle();
    await this.stopEngine();
    if (!this.pausing) return;
    this.guard(false);
    this.set({ state: "paused" });
    await new Promise<void>((resolve) => {
      this.resumeRun = resolve;
    });
    this.guard(true);
    this.since = Date.now();
    this.set({ state: "running" });
  }

  private pageRead() {
    const now = Date.now();
    this.finishedAt.push(now);
    if (this.finishedAt.length > 500) this.finishedAt.splice(0, this.finishedAt.length - 500);
    this.set({ read: this.snapshot.read + 1, pagesPerMinute: pagesPerMinute(this.finishedAt, now, this.since) });
  }

  private fail(manual: OcrManual, pages: number[], message: string) {
    if (pages.length === 0) return;
    const failure = { key: String(this.nextKey++), manualId: manual.id, title: manual.title, pages, message };
    this.set({ failures: [...this.snapshot.failures, failure] });
  }

  // Draws a page, waiting out a dropped connection and trying once more
  // from a fresh copy of the PDF (with a new link: it most likely ran out).
  // Null when it can't be drawn, with why in `failed`.
  private async drawOrFail(
    pageNumber: number,
    pdf: () => Promise<Opened>,
    open: () => Promise<Opened>,
    failed: Map<number, string>,
  ) {
    let fresh = false;
    for (let tries = 0; ; ) {
      try {
        return await drawPage(await (fresh ? open() : pdf()), pageNumber);
      } catch (error) {
        fresh = true;
        if (error instanceof StopRun) throw error;
        if (!(error instanceof Stop) && !(await reachable())) {
          await this.connection();
          continue;
        }
        if (error instanceof Stop || ++tries > 1) {
          if (!(error instanceof Stop)) {
            console.error(`Couldn't draw page ${pageNumber} for OCR`, error);
            this.failing(1, 0);
          }
          failed.set(pageNumber, error instanceof Stop ? error.message : "This page couldn't be drawn.");
          return null;
        }
      }
    }
  }

  private async readManual(manual: OcrManual) {
    let loading: PDFDocumentLoadingTask | null = null;
    let opened: Promise<Opened> | null = null;
    let openedAt = 0;
    const open = async () => {
      await loading?.destroy();
      loading = null;
      opened = null;
      const { url } = check(await this.online(() => getScannedFileUrl({ manualId: manual.id })));
      const pdfjs = await loadPdfJs();
      const decoders = { failed: false };
      loading = pdfjs.getDocument({
        url,
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: RANGE_CHUNK_BYTES,
        // Decoders for scanned-page images (CCITT, JBIG2, JPEG 2000), which
        // its worker asks this page for (see decoderFactory). wasmUrl is
        // where it finds their plain JavaScript versions.
        wasmUrl: PDFJS_WASM_URL,
        BinaryDataFactory: decoderFactory(decoders),
        useWorkerFetch: false,
        verbosity: pdfjs.VerbosityLevel.ERRORS,
      });
      openedAt = Date.now();
      opened = loading.promise.then((pdf) => ({ pdf, decoders }));
      return opened;
    };
    const pdf = () => (opened && Date.now() - openedAt < LINK_REFRESH_MS ? opened : open());

    // Text waiting to be sent, sent in order.
    let batch: PageText[] = [];
    let batchSize = 0;
    let saving = Promise.resolve();
    const failed = new Map<number, string>();
    const send = () => {
      if (batch.length > 0) {
        const pages = batch;
        batch = [];
        batchSize = 0;
        saving = saving.then(async () => {
          try {
            const saved = check(await this.online(() => saveScannedText({ manualId: manual.id, pages })));
            this.set({ withText: this.snapshot.withText + saved.withText });
            this.pagesFailing = 0;
            this.manualsFailing = 0;
          } catch (error) {
            // The app was updated: the run stops, and these pages stay to
            // read after a reload.
            if (error instanceof StopRun) {
              this.stopped ??= error;
              return;
            }
            if (!(error instanceof Stop)) {
              console.error("Couldn't save text read by OCR", error);
              this.failing(pages.length, 0);
            }
            const message = error instanceof Stop ? error.message : "The text couldn't be saved.";
            for (const page of pages) failed.set(page.pageNumber, message);
          }
        });
      }
      return saving;
    };
    const keep = (page: PageText) => {
      const size = batchBytes(page);
      if (!fitsInBatch({ pages: batch.length, bytes: batchSize }, size)) void send();
      batch.push(page);
      batchSize += size;
      if (!fitsInBatch({ pages: batch.length, bytes: batchSize }, 0)) void send();
    };

    const reading = new Set<Promise<void>>();
    const settle = async () => {
      await Promise.all(reading);
      await send();
    };

    try {
      try {
        await this.online(open);
      } catch (error) {
        if (error instanceof StopRun) throw error;
        if (!(error instanceof Stop) && !isFileProblem(error)) this.failing(0, 1);
        this.fail(manual, manual.pages, openProblem(error));
        return;
      }
      // Pages Tesseract couldn't read get a second go at the end.
      let pages = manual.pages;
      for (let round = 0; round < 2 && pages.length > 0; round++) {
        const again: number[] = [];
        for (const [index, pageNumber] of pages.entries()) {
          if (this.stopped) throw this.stopped;
          await this.pausePoint(settle);
          // One page drawn ahead of the workers, no more: each takes memory.
          while (reading.size > this.snapshot.workers) await Promise.race(reading);
          this.set({ current: { title: manual.title, pageNumber, position: index + 1, count: pages.length } });

          const drawn = await this.drawOrFail(pageNumber, pdf, open, failed);
          if (!drawn) continue;
          const { image, dpi } = drawn;
          const engine = this.getEngine();
          const read = engine
            .then((tesseract) => tesseract.recognize(image, dpi))
            .then(
              (text) => {
                keep({ pageNumber, text });
                this.pageRead();
              },
              async (error) => {
                if (error instanceof StopRun) {
                  this.stopped ??= error;
                  return;
                }
                if (round === 0) again.push(pageNumber);
                else {
                  failed.set(pageNumber, "OCR couldn't read this page.");
                  this.failing(1, 0);
                }
                // It may have left a worker in a bad way: start afresh.
                await this.stopEngine(engine);
              },
            );
          reading.add(read);
          void read.finally(() => reading.delete(read));
        }
        await Promise.all(reading);
        // The run stops (Tesseract couldn't start, say), and the pages stay
        // to read.
        if (this.stopped) throw this.stopped;
        pages = again;
      }
      await settle();
    } finally {
      await Promise.allSettled(reading);
      await send();
      await (loading as PDFDocumentLoadingTask | null)?.destroy();
      const byMessage = new Map<string, number[]>();
      for (const [pageNumber, message] of failed) byMessage.set(message, [...(byMessage.get(message) ?? []), pageNumber]);
      for (const [message, pages] of byMessage) this.fail(manual, pages, message);
    }
  }
}

let job: OcrJob | undefined;

export function ocrJob() {
  job ??= new OcrJob();
  return job;
}
