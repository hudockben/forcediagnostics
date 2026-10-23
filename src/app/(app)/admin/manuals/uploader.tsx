"use client";

import { useRouter } from "next/navigation";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useLayoutEffect, useRef, useState, type DragEvent } from "react";

import { secondaryButtonClass } from "@/components/hud";
import { catalogBatches, decodeModelList, readModelList, type LeftOutFile } from "@/lib/manual-catalog-rules";
import {
  MAX_PAGES_PER_BATCH,
  PAGE_BATCH_BYTES,
  cleanPageText,
  formatBytes,
  type PageText,
} from "@/lib/manual-rules";
import { describePdfError, loadPdfJs } from "@/lib/pdfjs";

import { confirmUpload, finishModelList, finishUpload, saveModelList, savePages, startUpload } from "./actions";

// Adds manuals from this browser. For each PDF: hash it, check it opens,
// ask the server what to do (skip, resume or upload), upload it straight to
// storage, then read its text page by page and save it in batches. Two files
// go at a time; files are only read while they're being worked on. A file
// already in the library under another name is skipped, and the server links
// its name to that manual.
//
// A model list (Polaris's spreadsheet of which models each manual covers,
// saved as CSV) among the chosen files is imported first, before any PDF
// starts: it's read here and sent in batches (see manual-catalog-rules.ts).

const AT_A_TIME = 2;
// Refresh the list below every so many finished files, and at the end.
const REFRESH_EVERY = 10;

type JobState = "waiting" | "checking" | "uploading" | "reading" | "added" | "skipped" | "failed";

type Job = {
  id: number;
  name: string;
  size: number;
  state: JobState;
  // 0–1 through the current step.
  progress: number;
  message: string;
};

const BUSY: ReadonlySet<JobState> = new Set(["waiting", "checking", "uploading", "reading"]);

// A failure with a message for the person, as opposed to a bug.
class Stop extends Error {}

function check<T extends object>(result: T | { error: string }): T {
  if ("error" in result) throw new Stop(result.error);
  return result;
}

const isPdf = (file: File) => /\.pdf$/i.test(file.name);
const isCsv = (file: File) => /\.csv$/i.test(file.name);

// A model list being imported: shown in its own row above the PDFs.
type ListJob = {
  id: number;
  name: string;
  size: number;
  state: "waiting" | "importing" | "imported" | "skipped" | "failed";
  progress: number;
  message: string;
  // Files the list couldn't take, with why.
  leftOut: LeftOutFile[];
};

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// The same file chosen again has the same name, size and date.
const fileKey = (file: File) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

// Model lists go in oldest first by their date (see importLists).
const olderFirst = (a: File, b: File) => a.lastModified - b.lastModified || a.name.localeCompare(b.name);

// Files being worked on, by SHA-256. Shared by every uploader in the tab:
// Next keeps a page running in the background after someone moves to
// another one, and can later show a fresh copy of it, so a file chosen in
// the new copy waits for the old one instead of being uploaded twice.
const inFlight = new Map<string, Promise<void>>();

// Uploaders on screen in the tab, and whether the list owes a refresh. A
// refresh reloads whatever page is on screen, which needn't be this one
// (the admin may be reading a manual meanwhile), so while they're elsewhere
// in the tab it waits until a Manuals page is shown again: this one, or a
// fresh copy.
let uploadersShown = 0;
let refreshOwed = false;

function refreshList(router: { refresh: () => void }) {
  if (uploadersShown > 0) router.refresh();
  else refreshOwed = true;
}

async function sha256Hex(data: ArrayBuffer) {
  if (!crypto.subtle) throw new Stop("Adding manuals needs a secure (https) connection.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function upload(url: string, file: File, onProgress: (fraction: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    // Part of the upload URL's signature.
    request.setRequestHeader("Content-Type", "application/pdf");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Stop(`Storage turned the upload down (error ${request.status}). Retry it.`));
    request.onerror = () =>
      reject(
        new Stop(
          "The upload didn't go through. Check the connection and retry. If every file stops here, the storage CORS settings need checking (see the README).",
        ),
      );
    request.send(file);
  });
}

// Files in a dropped folder, including its subfolders.
async function readDroppedEntries(entries: FileSystemEntry[]) {
  const files: File[] = [];
  async function walk(entry: FileSystemEntry) {
    if (entry.isFile) {
      files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries hands back at most about 100 entries per call.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  }
  for (const entry of entries) await walk(entry);
  return files;
}

function describe(job: Job) {
  switch (job.state) {
    case "waiting":
      return job.message || "Waiting";
    case "checking":
      return job.message || "Checking the file…";
    case "uploading":
      return `Uploading ${Math.round(job.progress * 100)}%`;
    default:
      return job.message;
  }
}

export function ManualUploader() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [lists, setLists] = useState<ListJob[]>([]);
  const listFiles = useRef(new Map<number, File>());
  // Model lists waiting to import, by ID, in order (see listOrder).
  const listQueue = useRef<number[]>([]);
  // A model list is importing or waiting to; PDFs wait for them.
  const importingLists = useRef(false);
  // Lists whose last import went through.
  const importedLists = useRef(new Set<number>());
  const [leftOut, setLeftOut] = useState(0);
  const [dragging, setDragging] = useState(false);
  const files = useRef(new Map<number, File>());
  // Job IDs by fileKey, so a file chosen again isn't listed twice.
  const jobsByFile = useRef(new Map<string, number>());
  const failedIds = useRef(new Set<number>());
  const queue = useRef<number[]>([]);
  const running = useRef(0);
  const finishedSinceRefresh = useRef(0);
  const waitingForConnection = useRef(false);
  // Closing the tab stops the uploads (they pick up again next time). Added
  // while files are being worked on, not by an effect: the work carries on
  // while this page is hidden, which cleans up effects.
  const warnBeforeClosing = useRef((event: BeforeUnloadEvent) => event.preventDefault());
  const nextId = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // Layout effects are cleaned up as soon as Next hides the page, and run
  // again when it's shown.
  useLayoutEffect(() => {
    uploadersShown += 1;
    if (refreshOwed && navigator.onLine) {
      refreshOwed = false;
      router.refresh();
    }
    return () => {
      uploadersShown -= 1;
    };
  }, [router]);

  const busy = jobs.some((job) => BUSY.has(job.state));
  const done = jobs.filter((job) => job.state === "added" || job.state === "skipped").length;
  const failed = jobs.filter((job) => job.state === "failed");
  const added = jobs.filter((job) => job.state === "added").length;

  function update(id: number, patch: Partial<Job>) {
    setJobs((list) => list.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  }

  function updateList(id: number, patch: Partial<ListJob>) {
    setLists((all) => all.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  }

  async function importList(id: number) {
    const file = listFiles.current.get(id);
    if (!file) return;
    failedIds.current.delete(id);
    importedLists.current.delete(id);
    updateList(id, { state: "importing", progress: 0, message: "Reading the model list…", leftOut: [] });
    try {
      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch {
        throw new Stop("This file couldn't be read. Check it's still there, then retry.");
      }
      const decoded = decodeModelList(new Uint8Array(bytes));
      if ("error" in decoded) {
        updateList(id, { state: "skipped", progress: 1, message: `Skipped. ${decoded.error}` });
        return;
      }
      const list = readModelList(decoded.text);
      if ("error" in list) {
        // Not the model list, or not readable as one: nothing is imported.
        updateList(id, { state: "skipped", progress: 1, message: `Skipped. ${list.error}` });
        return;
      }
      if (!crypto.randomUUID) throw new Stop("Importing the model list needs a secure (https) connection.");
      const importId = crypto.randomUUID();
      const total = list.files.length;
      let sent = 0;
      for (const batch of catalogBatches(list.files)) {
        updateList(id, {
          progress: sent / total,
          message: `Importing: ${sent.toLocaleString("en-US")} of ${plural(total, "manual", "manuals")}`,
        });
        check(await saveModelList({ importId, files: batch }));
        sent += batch.length;
      }
      const result = check(
        await finishModelList({
          importId,
          fileName: file.name,
          leftOut: list.leftOut.length,
          rowsWithoutFile: list.rowsWithoutFile,
        }),
      );
      importedLists.current.add(id);
      updateList(id, {
        state: "imported",
        progress: 1,
        message:
          `Model list: ${plural(result.manuals, "manual", "manuals")}, ${plural(result.models, "model", "models")}` +
          (result.brandsInferred > 0
            ? ` (${plural(result.brandsInferred, "brand", "brands")} filled in)`
            : ""),
        leftOut: list.leftOut,
      });
    } catch (error) {
      if (!(error instanceof Stop)) console.error("Couldn't import the model list", error);
      failedIds.current.add(id);
      updateList(id, {
        state: "failed",
        message: !navigator.onLine
          ? "The connection dropped. Retry when it's back; what was saved stays."
          : error instanceof Stop
            ? error.message
            : "Something went wrong. Check the connection and retry.",
      });
    }
  }

  // The order lists import in: by date, then in the order they were chosen.
  function listOrder(a: number, b: number) {
    return olderFirst(listFiles.current.get(a)!, listFiles.current.get(b)!) || a - b;
  }

  // One list at a time, oldest first by date, whichever drop or Retry queued
  // it, so the newest list has the last word on any file two lists have. A
  // list that goes in after a newer one did (in a later drop, with Retry, or
  // chosen again after it failed) puts its entries over the newer one's, so
  // the newer lists that went in are imported again after it. PDFs start
  // once they're all done.
  function importLists(ids: number[]) {
    queueLists(ids);
    if (importingLists.current || listQueue.current.length === 0) return;
    importingLists.current = true;
    window.addEventListener("beforeunload", warnBeforeClosing.current);
    void (async () => {
      try {
        for (let id = listQueue.current.shift(); id !== undefined; id = listQueue.current.shift()) {
          await importList(id);
          // Even after a failure: a batch that was saved still counts.
          queueLists([...importedLists.current].filter((other) => listOrder(other, id) > 0));
        }
      } finally {
        importingLists.current = false;
        if (navigator.onLine) refreshList(router);
        if (running.current === 0 && queue.current.length === 0) {
          window.removeEventListener("beforeunload", warnBeforeClosing.current);
        }
        pump();
      }
    })();
  }

  // Adds lists to the queue, each once, in order, and shows them waiting.
  function queueLists(ids: number[]) {
    const added = [...new Set(ids)].filter((id) => !listQueue.current.includes(id));
    if (added.length === 0) return;
    for (const id of added) failedIds.current.delete(id);
    listQueue.current = [...listQueue.current, ...added].sort(listOrder);
    setLists((all) =>
      all.map((job) =>
        added.includes(job.id) ? { ...job, state: "waiting" as const, progress: 0, message: "", leftOut: [] } : job,
      ),
    );
  }

  function retryList(id: number) {
    importLists([id]);
  }

  async function readAndSaveText(id: number, manualId: string, doc: PDFDocumentProxy) {
    const encoder = new TextEncoder();
    let batch: PageText[] = [];
    let batchBytes = 0;
    let unreadable = 0;
    // True when the manual was finished elsewhere, so there's no need to
    // read the rest.
    const send = async () => {
      const result = check(await savePages({ manualId, pages: batch }));
      batch = [];
      batchBytes = 0;
      return result.done === true;
    };

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      let text = "";
      try {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        text = cleanPageText(
          content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join(""),
        );
        page.cleanup();
      } catch {
        // A few damaged pages are saved without text rather than losing the
        // manual. More than that means the file (or this browser) is in
        // trouble, so it stops and can be retried.
        unreadable += 1;
        if (unreadable > Math.min(10, doc.numPages / 10)) {
          throw new Stop(`Pages of this PDF couldn't be read (page ${pageNumber}). Retry it; if it fails again, the file may be damaged.`);
        }
      }
      const size = encoder.encode(JSON.stringify(text)).length + 32;
      if (batch.length > 0 && (batchBytes + size > PAGE_BATCH_BYTES || batch.length >= MAX_PAGES_PER_BATCH)) {
        if (await send()) return;
      }
      batch.push({ pageNumber, text });
      batchBytes += size;
      update(id, {
        progress: pageNumber / doc.numPages,
        message: `Reading text: page ${pageNumber} of ${doc.numPages}`,
      });
    }
    if (batch.length > 0) await send();
  }

  // Returns true when the file was put back to wait for the connection.
  async function processFile(id: number): Promise<boolean> {
    const file = files.current.get(id);
    if (!file) return false;
    update(id, { state: "checking", progress: 0, message: "" });
    let release = () => {};
    try {
      let data: ArrayBuffer;
      try {
        data = await file.arrayBuffer();
      } catch {
        throw new Stop("This file couldn't be read. Check it's still there, then retry.");
      }
      const sha256 = await sha256Hex(data);
      // Another copy of the same file (under another name, say) waits for
      // the first, then finds it already in the library.
      const twin = inFlight.get(sha256);
      const mine: Promise<void> = new Promise((resolve) => {
        release = () => {
          resolve();
          if (inFlight.get(sha256) === mine) inFlight.delete(sha256);
        };
      });
      inFlight.set(sha256, mine);
      if (twin) {
        update(id, { message: "Waiting for another copy of this file to finish…" });
        await twin;
      }

      const pdfjs = await loadPdfJs();
      // pdf.js takes over the file's bytes (they move to its worker), so the
      // hash has to come first.
      const loading = pdfjs.getDocument({ data: new Uint8Array(data), verbosity: pdfjs.VerbosityLevel.ERRORS });
      try {
        let doc: PDFDocumentProxy;
        try {
          doc = await loading.promise;
        } catch (error) {
          throw new Stop(describePdfError(error));
        }

        const start = check(await startUpload({ fileName: file.name, sizeBytes: file.size, sha256 }));
        if (start.next === "skip") {
          // Says whether this name was linked to the manual already in.
          update(id, { state: "skipped", progress: 1, message: start.message });
          return false;
        }
        if (start.next === "upload") {
          update(id, { state: "uploading", progress: 0 });
          await upload(start.uploadUrl, file, (progress) => update(id, { progress }));
        }
        const confirmed = check(await confirmUpload({ manualId: start.manualId, pageCount: doc.numPages }));
        if (confirmed.next === "done") {
          update(id, { state: "skipped", progress: 1, message: "Already in the library" });
          return false;
        }

        update(id, { state: "reading", progress: 0, message: "Reading text…" });
        await readAndSaveText(id, start.manualId, doc);
        const finished = check(await finishUpload({ manualId: start.manualId }));
        if (!finished.added) {
          update(id, { state: "skipped", progress: 1, message: "Already in the library" });
          return false;
        }
        const pages = `${finished.pageCount} ${finished.pageCount === 1 ? "page" : "pages"}`;
        update(id, {
          state: "added",
          progress: 1,
          // Scanned pages are read afterwards, all together, by the Scanned
          // pages card: OCR is far slower than adding a file.
          message:
            (finished.pagesWithoutText > 0
              ? `Added · ${pages}, ${finished.pagesWithoutText} not searchable (scanned). Read them with Scanned pages below.`
              : `Added · ${pages}`) +
            // The name the model list knows it by, with or without the
            // browser's copy number ("X.pdf" for "X (1).pdf").
            (finished.nameTaken
              ? `${finished.pagesWithoutText > 0 ? "" : "."} A different manual is already called ${finished.nameTaken}, so the model list goes with that one.`
              : ""),
        });
      } finally {
        await loading.destroy();
      }
    } catch (error) {
      // Offline (Wi-Fi dropped, the laptop slept): put the file back to try
      // again when the connection returns, rather than failing it and every
      // file after it.
      if (!navigator.onLine) {
        queue.current.unshift(id);
        update(id, { state: "waiting", progress: 0, message: "Waiting for the connection…" });
        return true;
      }
      if (!(error instanceof Stop)) console.error("Couldn't add a manual", error);
      failedIds.current.add(id);
      update(id, {
        state: "failed",
        message:
          error instanceof Stop ? error.message : "Something went wrong. Check the connection and retry.",
      });
    } finally {
      release();
    }
    return false;
  }

  function pump() {
    // A model list goes first; this runs again once it's in.
    if (importingLists.current) return;
    // Offline: hold the queue until the connection is back. Refreshing the
    // list now would fail and reload the whole page.
    if (!navigator.onLine) {
      if (!waitingForConnection.current) {
        waitingForConnection.current = true;
        const resume = () => {
          waitingForConnection.current = false;
          pump();
        };
        window.addEventListener("online", resume, { once: true });
      }
      return;
    }
    while (running.current < AT_A_TIME && queue.current.length > 0) {
      const id = queue.current.shift()!;
      running.current += 1;
      window.addEventListener("beforeunload", warnBeforeClosing.current);
      void processFile(id).then((putBack) => {
        running.current -= 1;
        // A file waiting for the connection hasn't finished.
        if (!putBack) finishedSinceRefresh.current += 1;
        const allDone = running.current === 0 && queue.current.length === 0;
        if (allDone && !importingLists.current) {
          window.removeEventListener("beforeunload", warnBeforeClosing.current);
        }
        if (navigator.onLine && (allDone || finishedSinceRefresh.current >= REFRESH_EVERY)) {
          finishedSinceRefresh.current = 0;
          refreshList(router);
        }
        pump();
      });
    }
  }

  function addFiles(chosen: File[]) {
    // In name order, like the folder shows them ("001 - …", "002 - …").
    const pdfs = chosen
      .filter(isPdf)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    // Model lists oldest first, the order they import in.
    const csvs = chosen.filter(isCsv).sort(olderFirst);
    setLeftOut(chosen.length - pdfs.length - csvs.length);

    // A list that's already listed is only imported again if it failed.
    const newLists: ListJob[] = [];
    const listIds: number[] = [];
    for (const file of csvs) {
      const listed = jobsByFile.current.get(fileKey(file));
      if (listed !== undefined) {
        if (failedIds.current.has(listed)) {
          listFiles.current.set(listed, file);
          listIds.push(listed);
        }
        continue;
      }
      const id = nextId.current++;
      jobsByFile.current.set(fileKey(file), id);
      listFiles.current.set(id, file);
      listIds.push(id);
      newLists.push({ id, name: file.name, size: file.size, state: "waiting", progress: 0, message: "", leftOut: [] });
    }
    setLists((all) => [...all, ...newLists]);
    importLists(listIds);

    const newJobs: Job[] = [];
    const again: number[] = [];
    for (const file of pdfs) {
      // A file that's already listed (the same folder chosen again, say)
      // isn't listed twice: one that failed is tried again, and anything
      // else carries on as it is.
      const listed = jobsByFile.current.get(fileKey(file));
      if (listed !== undefined) {
        if (failedIds.current.has(listed) && !again.includes(listed)) {
          files.current.set(listed, file);
          again.push(listed);
        }
        continue;
      }
      const id = nextId.current++;
      jobsByFile.current.set(fileKey(file), id);
      files.current.set(id, file);
      queue.current.push(id);
      newJobs.push({ id, name: file.name, size: file.size, state: "waiting", progress: 0, message: "" });
    }
    setJobs((list) => [...list, ...newJobs]);
    // Starts the new ones too.
    retry(again);
  }

  function retry(ids: number[]) {
    for (const id of ids) failedIds.current.delete(id);
    setJobs((list) =>
      list.map((job) => (ids.includes(job.id) ? { ...job, state: "waiting", progress: 0, message: "" } : job)),
    );
    queue.current.push(...ids);
    pump();
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    // Entries and files have to be taken before the event ends (the list
    // is empty afterwards); reading them can wait.
    const dropped = [...event.dataTransfer.files];
    const entries = [...event.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => Boolean(entry));
    if (entries.length === 0) {
      addFiles(dropped);
      return;
    }
    void readDroppedEntries(entries).then(addFiles, () => addFiles(dropped));
  }

  return (
    <div className="space-y-5">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-xl border-2 border-dashed px-5 py-8 text-center transition ${
          dragging ? "border-glow/70 bg-glow/5" : "border-white/15"
        }`}
      >
        <p className="text-sm text-ink">Drag PDFs, the model list (.csv) or a whole folder here</p>
        <p className="mt-1 text-xs text-ink-muted">or</p>
        <div className="mx-auto mt-3 flex max-w-md flex-col gap-3 sm:flex-row">
          <button type="button" onClick={() => fileInput.current?.click()} className={secondaryButtonClass}>
            Choose files
          </button>
          <button type="button" onClick={() => folderInput.current?.click()} className={secondaryButtonClass}>
            Choose a folder
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf,text/csv,.csv"
          multiple
          aria-label="Choose files"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            addFiles([...(event.currentTarget.files ?? [])]);
            event.currentTarget.value = "";
          }}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          // Picks a folder (and everything in it) instead of files.
          {...({ webkitdirectory: "" } as object)}
          aria-label="Choose a folder"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            addFiles([...(event.currentTarget.files ?? [])]);
            event.currentTarget.value = "";
          }}
        />
      </div>

      {leftOut > 0 && (
        <p className="text-sm text-ink-muted">
          Left out {leftOut}{" "}
          {leftOut === 1 ? "file that isn't a PDF or a model list" : "files that aren't PDFs or a model list"}.
        </p>
      )}

      {lists.length > 0 && (
        <ul aria-label="Model lists" className="divide-y divide-white/10 rounded-lg border border-white/10">
          {lists.map((job) => (
            <li key={job.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="min-w-0 truncate text-sm text-ink" title={job.name}>
                  {job.name}
                </p>
                <p className="text-xs text-ink-muted">{formatBytes(job.size)}</p>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p
                  role="status"
                  className={`text-xs ${
                    job.state === "imported"
                      ? "text-glow"
                      : job.state === "failed" || job.state === "skipped"
                        ? "text-trail"
                        : "text-ink-muted"
                  }`}
                >
                  {job.state === "waiting" ? "Waiting" : job.message}
                </p>
                {job.state === "failed" && (
                  <button
                    type="button"
                    onClick={() => retryList(job.id)}
                    aria-label={`Retry ${job.name}`}
                    className="h-9 rounded-lg px-3 text-sm font-medium text-glow transition hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
                  >
                    Retry
                  </button>
                )}
              </div>
              {job.state === "importing" && (
                <div className="h-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-glow/70" style={{ width: `${job.progress * 100}%` }} />
                </div>
              )}
              {job.leftOut.length > 0 && (
                <div className="text-xs text-trail">
                  <p>
                    Left out {plural(job.leftOut.length, "manual", "manuals")} with something wrong in the list
                    (the rest went in):
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {job.leftOut.slice(0, 5).map((file) => (
                      <li key={file.fileName}>
                        {file.fileName}: {file.problem}
                      </li>
                    ))}
                    {job.leftOut.length > 5 && <li>and {job.leftOut.length - 5} more</li>}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {jobs.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-sm text-ink">
              {done} of {jobs.length} done
              {added > 0 && <span className="text-ink-muted"> · {added} added</span>}
              {failed.length > 0 && <span className="text-trail"> · {failed.length} failed</span>}
            </p>
            {failed.length > 0 && !busy && (
              <button
                type="button"
                onClick={() => retry(failed.map((job) => job.id))}
                className="h-10 rounded-lg border border-trail/40 px-4 text-sm font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none"
              >
                Retry failed
              </button>
            )}
          </div>
          <div
            role="progressbar"
            aria-label="Manuals done"
            aria-valuemin={0}
            aria-valuemax={jobs.length}
            aria-valuenow={done + failed.length}
            className="h-2 overflow-hidden rounded-full bg-white/10"
          >
            <div
              className="h-full rounded-full bg-glow transition-[width]"
              style={{ width: `${((done + failed.length) / jobs.length) * 100}%` }}
            />
          </div>
          {busy && (
            <p className="text-xs text-ink-muted">
              Keep this tab open until it finishes. If it closes, add the same files again to pick up where it
              stopped.
            </p>
          )}

          <ul className="max-h-[28rem] divide-y divide-white/10 overflow-y-auto rounded-lg border border-white/10">
            {jobs.map((job) => (
              <li key={job.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="min-w-0 truncate text-sm text-ink" title={job.name}>
                    {job.name}
                  </p>
                  <p className="text-xs text-ink-muted">{formatBytes(job.size)}</p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p
                    className={`text-xs ${
                      job.state === "failed"
                        ? "text-trail"
                        : job.state === "added" || job.state === "skipped"
                          ? "text-glow"
                          : "text-ink-muted"
                    }`}
                  >
                    {describe(job)}
                  </p>
                  {job.state === "failed" && (
                    <button
                      type="button"
                      onClick={() => retry([job.id])}
                      aria-label={`Retry ${job.name}`}
                      className="h-9 rounded-lg px-3 text-sm font-medium text-glow transition hover:bg-glow/10 focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
                    >
                      Retry
                    </button>
                  )}
                </div>
                {(job.state === "uploading" || job.state === "reading") && (
                  <div className="h-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-glow/70" style={{ width: `${job.progress * 100}%` }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
