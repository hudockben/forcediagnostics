import type { PDFDocumentProxy, PDFPageProxy, PDFWorker, RenderTask } from "pdfjs-dist";

import { areaOf, areaParam, cropOf, figuresOf, imageBoxes, isCalloutText, type FigureOps, type PageArea, type PageFigures, type PageLabel } from "@/lib/manual-figures";
import { PDFJS_WASM_URL, loadPdfJs } from "@/lib/pdfjs";
import { workQueue, type Job } from "@/lib/work-queue";

import { getManualFileUrl } from "../library/actions";
import { openStoragePdf, type StorageLink, type StoragePdf } from "../library/[manualId]/storage-pdf";

// The manual pages Diagnose shows as pictures (the pages Claude cites),
// drawn in the browser with pdf.js from the same storage links the viewer
// uses: the server checks the manual is the shop's own and hands out a
// link that lasts 15 minutes, renewed when storage turns it down (see
// storage-pdf.ts). One copy of each manual's PDF is opened (pdf.js reads
// only the parts a page needs), all of them in one shared pdf.js worker
// (not a worker, its own copy of pdf.js's code and caches, per manual cited),
// at most two pages draw at once (what's on the screen first, nothing for
// a part or a picture that's gone), and each picture is kept (a small
// image, the page's decoded images let go once it's made) so it draws once
// however often it's shown. A part's drawings are found on its pages here
// too (where each page paints its images, src/lib/manual-figures.ts) and
// cropped out of them, each drawn once and kept the same way. Everything
// is let go a little after the Diagnose page goes.

const RANGE_CHUNK_BYTES = 128 * 1024;
// Tablets refuse canvases much bigger than this many pixels.
const MAX_CANVAS_PIXELS = 12_000_000;
const PICTURES_KEPT = 80;
const FIGURES_KEPT = 120;
// A crop of a small drawing isn't drawn bigger than this many screen pixels
// to the page's point: past it there's nothing more in a manual's images.
const MAX_CROP_SCALE = 8;
const RELEASE_AFTER_MS = 30_000;

type OpenManual = { pdf: StoragePdf; doc: PDFDocumentProxy; pageCount: number };

const opened = new Map<string, Promise<OpenManual>>();
let worker: PDFWorker | null = null;
const pictures = new Map<string, Job<string>>();
const figures = new Map<string, Job<PageFigures>>();
let users = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

// Two at a time, pictures on the screen before looking for drawings (which
// leaves a place for a picture: one page looked at at a time), and
// nothing for an asker that's gone (src/lib/work-queue.ts).
const { shared } = workQueue(2);

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

async function pageOf(manualId: string, pageNumber: number): Promise<{ manual: OpenManual; page: PDFPageProxy }> {
  const manual = await open(manualId);
  const page = await Promise.race([manual.pdf.broken, manual.doc.getPage(Math.min(Math.max(1, pageNumber), manual.pageCount))]);
  return { manual, page };
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
  const { manual, page } = await pageOf(manualId, pageNumber);
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

// A part of a page, as fractions of its width and height from its top left.
export type { PageArea } from "@/lib/manual-figures";

// Where a page prints the lines `heading` matches (its TORQUE boxes'
// headings) and what's under each, down to about `below` lines and starting
// near where it does (a box's labels and values), from the PDF's text
// layer. Null when it has none of them: a scanned page has no text layer
// (its words came from OCR), so it's opened as it is.
export async function headingArea(manualId: string, pageNumber: number, heading: RegExp, below: number): Promise<PageArea | null> {
  const { manual, page } = await pageOf(manualId, pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await Promise.race([manual.pdf.broken, page.getTextContent()]);
  const boxes = content.items.flatMap((item) => {
    if (!("str" in item) || item.str.trim() === "") return [];
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const height = item.height || Math.hypot(item.transform[2], item.transform[3]);
    return [{ text: item.str.trim(), left: x, right: x + item.width, top: y - height, bottom: y, height }];
  });
  const area = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const top of boxes.filter((box) => heading.test(box.text))) {
    const width = top.right - top.left;
    // Lines are about one and a half times their letters' height apart.
    const under = boxes.filter((box) => box.top >= top.top - 1 && box.top <= top.bottom + below * 1.5 * top.height && box.left >= top.left - 2 * width && box.left <= top.right + 2 * width);
    for (const box of [top, ...under]) {
      area.left = Math.min(area.left, box.left);
      area.top = Math.min(area.top, box.top);
      area.right = Math.max(area.right, box.right);
      area.bottom = Math.max(area.bottom, box.bottom);
    }
  }
  if (area.left === Infinity) return null;
  const fraction = (value: number, of: number) => Math.min(1, Math.max(0, value / of));
  return { left: fraction(area.left, viewport.width), top: fraction(area.top, viewport.height), right: fraction(area.right, viewport.width), bottom: fraction(area.bottom, viewport.height) };
}

// A picture kept for the next time it's shown (an image URL), made once.
// make draws it into the canvas and says which page it drew: that page's
// images (pdf.js keeps every image it decoded for a page until it's told
// to let them go; a manual's drawing can be tens of megabytes) are let go
// once the picture is made, as it's kept as an image anyway.
function keptPicture(key: string, make: (canvas: HTMLCanvasElement) => Promise<PDFPageProxy>, signal?: AbortSignal): Promise<string> {
  const picture = shared(
    pictures,
    key,
    async () => {
      const canvas = document.createElement("canvas");
      const page = await make(canvas);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
      canvas.width = canvas.height = 0;
      // Put off by pdf.js while another drawing of the page is under way
      // (the full-screen page), and done when that's finished.
      page.cleanup();
      if (!blob) throw new Error("The page couldn't be turned into a picture.");
      return URL.createObjectURL(blob);
    },
    { signal, first: true },
  );
  while (pictures.size > PICTURES_KEPT) {
    const [oldest, job] = pictures.entries().next().value!;
    pictures.delete(oldest);
    void job.promise.then((u) => URL.revokeObjectURL(u), () => {});
  }
  return picture;
}

// A small picture of a page, as an image URL (kept for the next time).
export function pagePicture(manualId: string, pageNumber: number, cssWidth: number, signal?: AbortSignal): Promise<string> {
  return keptPicture(
    `${manualId}:${pageNumber}:${cssWidth}`,
    async (canvas) => {
      await drawPage(manualId, pageNumber, canvas, cssWidth);
      return (await pageOf(manualId, pageNumber)).page;
    },
    signal,
  );
}

// A drawing cropped out of a page (an area of it), as a picture `cssWidth`
// CSS pixels wide, sharp at the screen's pixel ratio: only that part of the
// page is drawn, at the scale it needs, so a small drawing comes out as
// sharp as a large one without a canvas the size of the whole page at that
// scale. Kept for the next time, like a page's picture.
export function figurePicture(manualId: string, pageNumber: number, area: PageArea, cssWidth: number, signal?: AbortSignal): Promise<string> {
  return keptPicture(
    `${manualId}:${pageNumber}:${areaParam(area)}:${cssWidth}`,
    async (canvas) => {
      const { manual, page } = await pageOf(manualId, pageNumber);
      const crop = cropOf(area, page.getViewport({ scale: 1 }), cssWidth, { ratio: window.devicePixelRatio || 1, pixels: MAX_CANVAS_PIXELS, most: MAX_CROP_SCALE });
      // The page moved so the area's top left is the canvas's.
      const viewport = page.getViewport({ scale: crop.scale, offsetX: crop.offsetX, offsetY: crop.offsetY });
      canvas.width = crop.width;
      canvas.height = crop.height;
      await Promise.race([manual.pdf.broken, page.render({ canvas, viewport }).promise]);
      return page;
    },
    signal,
  );
}

// A page's drawings (src/lib/manual-figures.ts): where it paints its
// images, from pdf.js's list of the page's operations (worked out in the
// shared worker, which reads only the parts of the file the page needs;
// annotations aren't the page's drawings), with the callout numbers its
// text layer prints around them. Found once for the visit (after the
// pictures waiting to be drawn); a page that couldn't be read is looked at
// again the next time it's asked for, as is one whose askers all went
// before it was looked at.
export function pageFigures(manualId: string, pageNumber: number, signal?: AbortSignal): Promise<PageFigures> {
  const found = shared(
    figures,
    `${manualId.toLowerCase()}:${pageNumber}`,
    async () => {
      const { manual, page } = await pageOf(manualId, pageNumber);
      const pdfjs = await loadPdfJs();
      const list = await Promise.race([manual.pdf.broken, page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE })]);
      const viewport = page.getViewport({ scale: 1 });
      const images = imageBoxes(list, pdfjs.OPS as unknown as FigureOps).flatMap((box) => areaOf(box, viewport) ?? []);
      let labels: PageLabel[] = [];
      if (images.length > 0) {
        const content = await Promise.race([manual.pdf.broken, page.getTextContent()]);
        labels = content.items.flatMap((item) => {
          if (!("str" in item) || !isCalloutText(item.str)) return [];
          const [x, y] = [item.transform[4], item.transform[5]];
          const height = item.height || Math.hypot(item.transform[2], item.transform[3]);
          const area = areaOf({ x0: x, y0: y, x1: x + item.width, y1: y + height }, viewport);
          return area ? [{ text: item.str, area }] : [];
        });
      }
      // The images pdf.js decoded for the list (a scan's is tens of
      // megabytes) aren't the ones a picture of the page draws with (that's
      // another list, decoded again, and let go once it's drawn): let them go.
      page.cleanup();
      return figuresOf(images, { aspect: viewport.width / viewport.height, labels });
    },
    { signal },
  );
  while (figures.size > FIGURES_KEPT) figures.delete(figures.keys().next().value!);
  return found;
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
      for (const picture of pictures.values()) void picture.promise.then((u) => URL.revokeObjectURL(u), () => {});
      pictures.clear();
      figures.clear();
    }, RELEASE_AFTER_MS);
  };
}
