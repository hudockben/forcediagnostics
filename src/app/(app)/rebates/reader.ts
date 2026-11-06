import type { PDFDocumentProxy } from "pdfjs-dist";

import { OCR_ASSET_URL, ocrScale, ocrWorkerCount, toGreyPgm } from "@/lib/manual-ocr-rules";
import { PDFJS_WASM_URL, describePdfError, loadPdfJs } from "@/lib/pdfjs";
import { amountColumn, readInvoice, settleAmounts, wordsFromTsv, type Invoice, type InvoicePage, type InvoiceWord } from "@/lib/rebate-rules";

// Reading a Polaris invoice in this browser, for the Rebates tab: a PDF's
// pages through pdf.js (its own text when it has some; drawn at about 300
// dpi and read by Tesseract when it's a scan), or a picture of the printout
// read by Tesseract, into words and where each sits on the page, which
// src/lib/rebate-rules.ts sorts into the invoice's table. An amount OCR
// couldn't be sure of (a tick through it, say) is read again on its own,
// cut off where the tick starts and read as figures only. Nothing leaves
// the browser: Tesseract's files come from this site (public/tesseract/,
// as for System Admin > Manuals' scanned pages).

export type ReadProgress = { step: "opening" | "reading" | "checking"; done: number; pages: number };

// The biggest file read: a long invoice scanned in colour is a few MB.
export const MAX_INVOICE_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 60;
// A page with at least this many words of its own is a PDF made by the
// portal, read as it is; fewer, and it's a scan.
const TEXT_PAGE_WORDS = 20;
// A picture is taken as a letter page across its width, for its dpi.
const LETTER_INCHES = 8.5;

// What OCR is told about an amount read again.
const AMOUNT_SETTINGS = { tessedit_pageseg_mode: "7", tessedit_char_whitelist: "0123456789$,.-" };

class Stop extends Error {}

// A page's Amount column, kept from its drawing to read amounts again.
type Strip = { page: number; left: number; width: number; height: number; pixels: Uint8Array; dpi: number };

type Engine = {
  read(image: Uint8Array, settings: Record<string, string>, tsv: boolean): Promise<string>;
  stop(): Promise<void>;
};

// Tesseract, a worker or two (an invoice has a handful of pages), every
// file from this site.
async function startEngine(workers: number): Promise<Engine> {
  const tesseract = await import("tesseract.js");
  const { createScheduler, createWorker, OEM } = tesseract.default ?? tesseract;
  const scheduler = createScheduler();
  const options = {
    workerPath: `${OCR_ASSET_URL}worker.min.js`,
    corePath: `${OCR_ASSET_URL}core`,
    langPath: `${OCR_ASSET_URL}lang`,
    // Where the browser keeps the English data after the first download,
    // shared with the manuals' OCR.
    cachePath: "forcediagnostics-ocr",
    gzip: true,
    errorHandler: () => {},
  };
  try {
    // The first saves the English data in the browser for the others.
    scheduler.addWorker(await createWorker("eng", OEM.LSTM_ONLY, options));
    for (let i = 1; i < workers; i++) scheduler.addWorker(await createWorker("eng", OEM.LSTM_ONLY, options));
  } catch {
    await scheduler.terminate();
    throw new Stop("Reading scans couldn't start in this browser: its files didn't load. Check the connection, or try an up-to-date Chrome, Edge, Firefox or Safari.");
  }
  return {
    async read(image, settings, tsv) {
      // Settings for this job go in with recognize's options; tesseract.js's
      // types only list its own. A PGM image's bytes go in as they are.
      const { data } = await scheduler.addJob("recognize", image as unknown as Buffer, settings as object, tsv ? { text: false, tsv: true } : { text: true });
      return (tsv ? data.tsv : data.text) ?? "";
    },
    stop: () => scheduler.terminate(),
  };
}

// The words of a page with text of its own: each run of text split at its
// spaces, a word's place worked out from where it falls in the run.
async function textWords(page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>>, pdfjs: Awaited<ReturnType<typeof loadPdfJs>>): Promise<InvoiceWord[]> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const words: InvoiceWord[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const [, , c, d, x, y] = pdfjs.Util.transform(viewport.transform, item.transform);
    const height = Math.hypot(c, d) || item.height || 1;
    const perCharacter = item.str.length ? item.width / item.str.length : 0;
    for (const match of item.str.matchAll(/\S+/g)) {
      words.push({ text: match[0], left: x + match.index! * perCharacter, top: y - height, width: match[0].length * perCharacter, height });
    }
  }
  return words;
}

// A page (or picture) drawn on a canvas as a grey image for Tesseract.
function greyImage(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) throw new Stop("This browser can't draw the invoice to read it.");
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return toGreyPgm(data, canvas.width, canvas.height);
}

// The Amount column of a page read by OCR, kept to read amounts again.
function keepStrip(page: number, pixels: Uint8Array, width: number, height: number, dpi: number, words: InvoiceWord[]): Strip | null {
  const column = amountColumn(words);
  if (!column) return null;
  const left = Math.max(0, Math.floor(column.left - column.height));
  const right = Math.min(width, Math.ceil(column.right + column.height));
  if (right <= left) return null;
  const strip = new Uint8Array((right - left) * height);
  for (let y = 0; y < height; y++) strip.set(pixels.subarray(y * width + left, y * width + right), y * (right - left));
  return { page, left, width: right - left, height, pixels: strip, dpi };
}

// An Amount cell from a page's strip, with a white margin round it (OCR
// reads a line better with room about it), as a PGM image.
function cellImage(strip: Strip, box: { left: number; top: number; right: number; bottom: number }) {
  const x0 = Math.max(0, Math.round(box.left) - strip.left);
  const x1 = Math.min(strip.width, Math.round(box.right) - strip.left);
  const y0 = Math.max(0, Math.round(box.top));
  const y1 = Math.min(strip.height, Math.round(box.bottom));
  if (x1 <= x0 || y1 <= y0) return null;
  const margin = 20;
  const width = x1 - x0 + margin * 2;
  const height = y1 - y0 + margin * 2;
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const image = new Uint8Array(header.length + width * height).fill(255);
  image.set(header);
  for (let y = y0; y < y1; y++) {
    image.set(strip.pixels.subarray(y * strip.width + x0, y * strip.width + x1), header.length + (y - y0 + margin) * width + margin);
  }
  return image;
}

const isPdf = (file: File, head: Uint8Array) =>
  /\.pdf$/i.test(file.name) || file.type === "application/pdf" || new TextDecoder().decode(head.subarray(0, 5)) === "%PDF-";
const isPicture = (file: File) => /^image\//.test(file.type) || /\.(?:jpe?g|png|webp|gif|bmp|tiff?|heic)$/i.test(file.name);

// The invoice in a file, read page by page (`onProgress` says how far it
// is), with whether any of it was a scan read by OCR.
export async function readInvoiceFile(
  file: File,
  onProgress: (progress: ReadProgress) => void,
  signal?: AbortSignal,
): Promise<{ invoice: Invoice; scanned: boolean } | { error: string }> {
  if (file.size > MAX_INVOICE_BYTES) return { error: `${file.name} is over ${MAX_INVOICE_BYTES / 1024 / 1024} MB: too big to be an invoice.` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = isPdf(file, bytes);
  if (!pdf && !isPicture(file)) return { error: `${file.name} isn't a PDF or a picture. Drop the invoice as a PDF from the dealer portal, or a scan or photo of it.` };

  let engine: Engine | null = null;
  const engineFor = async (pages: number) => (engine ??= await startEngine(Math.max(1, Math.min(pages, ocrWorkerCount(navigator.hardwareConcurrency), 3))));
  const strips = new Map<number, Strip>();
  const stopped = () => {
    if (signal?.aborted) throw new Stop("Stopped.");
  };
  try {
    const pages: InvoicePage[] = [];
    if (pdf) {
      onProgress({ step: "opening", done: 0, pages: 0 });
      const pdfjs = await loadPdfJs();
      // Closed (its worker and all) by destroying the loading task.
      const loading = pdfjs.getDocument({ data: bytes, wasmUrl: PDFJS_WASM_URL, verbosity: pdfjs.VerbosityLevel.ERRORS });
      let opened: PDFDocumentProxy;
      try {
        opened = await loading.promise;
      } catch (error) {
        await loading.destroy();
        return { error: describePdfError(error) };
      }
      try {
        const count = Math.min(opened.numPages, MAX_PAGES);
        const reading: Promise<void>[] = [];
        for (let number = 1; number <= count; number++) {
          stopped();
          const page = await opened.getPage(number);
          const words = await textWords(page, pdfjs);
          if (words.filter((word) => /[A-Za-z0-9]{2}/.test(word.text)).length >= TEXT_PAGE_WORDS) {
            pages[number - 1] = { words };
            onProgress({ step: "reading", done: pages.filter(Boolean).length, pages: count });
            page.cleanup();
            continue;
          }
          // A scan: drawn, then read by OCR while the next page is drawn.
          const size = page.getViewport({ scale: 1 });
          const { scale, dpi } = ocrScale(size.width, size.height);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          await page.render({ canvas, viewport, intent: "print" }).promise;
          const { image, pixels } = greyImage(canvas);
          const { width, height } = canvas;
          canvas.width = 0;
          canvas.height = 0;
          page.cleanup();
          const ocr = await engineFor(count);
          const index = number - 1;
          reading.push(
            ocr.read(image, { user_defined_dpi: String(dpi) }, true).then((tsv) => {
              const pageWords = wordsFromTsv(tsv);
              pages[index] = { words: pageWords };
              const strip = keepStrip(index + 1, pixels, width, height, dpi, pageWords);
              if (strip) strips.set(index + 1, strip);
              onProgress({ step: "reading", done: pages.filter(Boolean).length, pages: count });
            }),
          );
          // At most a few pages drawn ahead of what's been read.
          if (reading.length >= 3) await Promise.all(reading.splice(0, reading.length - 2));
        }
        await Promise.all(reading);
      } finally {
        await loading.destroy();
      }
    } else {
      onProgress({ step: "opening", done: 0, pages: 1 });
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(new Blob([bytes], { type: file.type || "image/jpeg" }));
      } catch {
        return { error: `${file.name} couldn't be opened as a picture. Save it as a JPG or PNG, or drop the PDF instead.` };
      }
      const scale = Math.min(1, Math.sqrt(12_000_000 / (bitmap.width * bitmap.height)));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const dpi = Math.max(72, Math.round(canvas.width / LETTER_INCHES));
      const { image, pixels } = greyImage(canvas);
      const { width, height } = canvas;
      canvas.width = 0;
      canvas.height = 0;
      const ocr = await engineFor(1);
      const words = wordsFromTsv(await ocr.read(image, { user_defined_dpi: String(dpi) }, true));
      pages.push({ words });
      const strip = keepStrip(1, pixels, width, height, dpi, words);
      if (strip) strips.set(1, strip);
      onProgress({ step: "reading", done: 1, pages: 1 });
    }

    stopped();
    const invoice = readInvoice(pages.filter(Boolean));
    if ("error" in invoice) return invoice;

    // The amounts OCR couldn't be sure of, read again on their own.
    const unsure = invoice.lines.filter((line) => !line.amount.sure && strips.has(line.page));
    const again = new Map<number, string>();
    if (unsure.length > 0 && engine) {
      const ocr: Engine = engine;
      onProgress({ step: "checking", done: 0, pages: unsure.length });
      let done = 0;
      await Promise.all(
        unsure.map(async (line) => {
          const strip = strips.get(line.page)!;
          const image = cellImage(strip, line.amountBox);
          if (!image) return;
          const text = await ocr.read(image, { ...AMOUNT_SETTINGS, user_defined_dpi: String(strip.dpi) }, false);
          again.set(line.line, text.trim());
          onProgress({ step: "checking", done: ++done, pages: unsure.length });
        }),
      );
    }
    return { invoice: settleAmounts(invoice, again), scanned: strips.size > 0 || engine !== null };
  } catch (error) {
    if (error instanceof Stop) return { error: error.message };
    console.error("Couldn't read the invoice", error);
    return { error: `${file.name} couldn't be read. Check it opens, then drop it again.` };
  } finally {
    await (engine as Engine | null)?.stop();
  }
}
