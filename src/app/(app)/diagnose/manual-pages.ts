import type { PDFDocumentProxy, PDFWorker, RenderTask } from "pdfjs-dist";

import { PDFJS_WASM_URL, loadPdfJs } from "@/lib/pdfjs";

import { getManualFileUrl } from "../library/actions";
import { openStoragePdf, type StorageLink, type StoragePdf } from "../library/[manualId]/storage-pdf";

// The manual pages Diagnose shows as pictures (the pages Claude cites),
// drawn in the browser with pdf.js from the same storage links the viewer
// uses: the server checks the manual is the shop's own and hands out a
// link that lasts 15 minutes, renewed when storage turns it down (see
// storage-pdf.ts). One copy of each manual's PDF is opened (pdf.js reads
// only the parts a page needs), all of them in one shared pdf.js worker
// (not a worker, its own copy of pdf.js's code and caches, per manual cited),
// at most two pages draw at once, and each
// picture is kept (a small image) so it draws once however often it's
// shown. Everything is let go a little after the Diagnose page goes.

const RANGE_CHUNK_BYTES = 128 * 1024;
// Tablets refuse canvases much bigger than this many pixels.
const MAX_CANVAS_PIXELS = 12_000_000;
const PICTURES_KEPT = 80;
const RELEASE_AFTER_MS = 30_000;

type OpenManual = { pdf: StoragePdf; doc: PDFDocumentProxy; pageCount: number };

const opened = new Map<string, Promise<OpenManual>>();
let worker: PDFWorker | null = null;
const pictures = new Map<string, Promise<string>>();
let users = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

// Two at a time: a tablet stays responsive, and slow shop Wi-Fi isn't
// asked for a dozen pages at once.
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function open(manualId: string): Promise<OpenManual> {
  let manual = opened.get(manualId);
  if (manual) return manual;
  manual = (async () => {
    const first = await getManualFileUrl(manualId);
    if ("error" in first) throw new Error(first.error);
    let url = first.url;
    let renewal: Promise<void> | null = null;
    const link: StorageLink = {
      current: () => url,
      renew(expired) {
        if (url !== expired) return Promise.resolve();
        renewal ??= getManualFileUrl(manualId)
          .then((result) => {
            if ("error" in result) throw new Error(result.error);
            url = result.url;
          })
          .finally(() => (renewal = null));
        return renewal;
      },
    };
    const pdfjs = await loadPdfJs();
    worker ??= new pdfjs.PDFWorker();
    const pdf = openStoragePdf(pdfjs, link, { sizeBytes: first.sizeBytes, chunkBytes: RANGE_CHUNK_BYTES, wasmUrl: PDFJS_WASM_URL, worker });
    // A copy whose file broke can't be used again: the next ask opens a new one.
    pdf.broken.catch(() => {
      if (opened.get(manualId) === manual) opened.delete(manualId);
      void pdf.loading.destroy();
    });
    const doc = await Promise.race([pdf.broken, pdf.loading.promise]);
    return { pdf, doc, pageCount: doc.numPages };
  })();
  manual.catch(() => {
    if (opened.get(manualId) === manual) opened.delete(manualId);
  });
  opened.set(manualId, manual);
  return manual;
}

// Draws a page into a canvas `cssWidth` CSS pixels wide (sharp at the
// screen's pixel ratio, within what a tablet allows).
export async function drawPage(
  manualId: string,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  const manual = await open(manualId);
  const page = await Promise.race([manual.pdf.broken, manual.doc.getPage(Math.min(Math.max(1, pageNumber), manual.pageCount))]);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const css = page.getViewport({ scale });
  const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (css.width * css.height)));
  const viewport = page.getViewport({ scale: scale * ratio });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task: RenderTask = page.render({ canvas, viewport });
  const stop = () => task.cancel();
  signal?.addEventListener("abort", stop);
  try {
    await Promise.race([manual.pdf.broken, task.promise]);
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  return { width: css.width, height: css.height };
}

// A small picture of a page, as an image URL (kept for the next time).
export function pagePicture(manualId: string, pageNumber: number, cssWidth: number): Promise<string> {
  const key = `${manualId}:${pageNumber}:${cssWidth}`;
  let picture = pictures.get(key);
  if (picture) {
    // Most recently used last.
    pictures.delete(key);
    pictures.set(key, picture);
    return picture;
  }
  picture = slot(async () => {
    const canvas = document.createElement("canvas");
    await drawPage(manualId, pageNumber, canvas, cssWidth);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error("The page couldn't be turned into a picture.");
    return URL.createObjectURL(blob);
  });
  picture.catch(() => {
    if (pictures.get(key) === picture) pictures.delete(key);
  });
  pictures.set(key, picture);
  while (pictures.size > PICTURES_KEPT) {
    const [oldest, url] = pictures.entries().next().value!;
    pictures.delete(oldest);
    void url.then((u) => URL.revokeObjectURL(u), () => {});
  }
  return picture;
}

// The Diagnose page holds the manuals open while it's on screen; a little
// after the last holder lets go, every copy and picture is released.
export function holdManuals(): () => void {
  users++;
  clearTimeout(releaseTimer);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users--;
    if (users > 0) return;
    releaseTimer = setTimeout(() => {
      if (users > 0) return;
      const closing = [...opened.values()].map((manual) => manual.then((m) => m.pdf.loading.destroy(), () => {}));
      opened.clear();
      // The worker goes once every copy in it is closed.
      const shared = worker;
      worker = null;
      void Promise.all(closing).then(() => shared?.destroy());
      for (const picture of pictures.values()) void picture.then((u) => URL.revokeObjectURL(u), () => {});
      pictures.clear();
    }, RELEASE_AFTER_MS);
  };
}
