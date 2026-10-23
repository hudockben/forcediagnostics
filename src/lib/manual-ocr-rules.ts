// Rules for reading scanned pages with OCR, shared by the browser job on
// System Admin > Manuals and the server (see manual-ocr.ts). Kept free of
// database imports so browser code can use them.

import { PAGE_BATCH_BYTES, type PageText } from "@/lib/manual-rules";

// Tesseract's worker, engine and English data, copied into public/ by
// scripts/copy-tesseract.mjs: nothing is fetched from anywhere else.
export const OCR_ASSET_URL = "/tesseract/";

// Pages are drawn for OCR at 300 dots per inch: small print (spec tables,
// notes) reads clearly better than at 200, for about a third more time.
export const OCR_DPI = 300;
// A letter page at 300 dpi is 8.4 million pixels. Bigger pages (fold-out
// wiring diagrams) are drawn smaller, so one page never takes more than about
// 50 MB of memory to draw.
export const OCR_MAX_PIXELS = 12_000_000;

// The scale to draw a page at (pdf.js's viewport scale, where 1 is 72 dpi)
// and the dots per inch that gives, for a page `width` x `height` points.
export function ocrScale(width: number, height: number) {
  const target = OCR_DPI / 72;
  const area = Math.max(1, width) * Math.max(1, height);
  const scale = Math.min(target, Math.sqrt(OCR_MAX_PIXELS / area));
  return { scale, dpi: Math.round(scale * 72) };
}

// Tesseract workers to run side by side: one per processor, leaving one for
// drawing pages and the rest of the browser, and at most four (each takes a
// couple of hundred MB while it reads).
export function ocrWorkerCount(hardwareConcurrency: number | undefined) {
  const processors = Number.isFinite(hardwareConcurrency) && hardwareConcurrency! > 0 ? hardwareConcurrency! : 2;
  return Math.min(4, Math.max(1, Math.floor(processors) - 1));
}

// A drawn page (RGBA, as a canvas gives it) as a grey PGM image, which
// Tesseract reads straight away. Much quicker than PNG, which the browser
// would have to compress and Tesseract decompress again.
export function toGreyPgm(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number) {
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const image = new Uint8Array(header.length + width * height);
  image.set(header);
  for (let from = 0, to = header.length; to < image.length; from += 4, to++) {
    image[to] = (rgba[from] * 77 + rgba[from + 1] * 150 + rgba[from + 2] * 29) >> 8;
  }
  return { image, pixels: image.subarray(header.length) };
}

// Ruled lines at least this long are taken out before reading (see
// removeRules).
export const RULE_MIN_INCHES = 0.5;
const DARK = 160;

// Whites out long, thin straight lines in a grey image (one byte per pixel):
// the rules of torque tables, boxes, underlines. Tesseract reads a ruled
// table as a picture and gets little of it; without the rules it reads the
// cells. A pixel counts as on a line when it or a neighbour across the line
// is dark, so a thin line on a slightly skewed scan still makes one long run.
// Letters never make runs that long. A run only counts as a line where the
// page a little way to both sides of it (`minRun` x 0.06: 0.03 in) is light,
// so a dark background (a grey photocopy, a coloured divider) or a black
// panel with white words in it is left alone. Returns how many pixels it
// cleared.
export function removeRules(grey: Uint8Array, width: number, height: number, minRun: number) {
  const onRule = new Uint8Array(width * height);
  const side = Math.round(minRun * 0.06);
  const light = (i: number) => grey[i] >= DARK;
  // Across each row.
  for (let y = 0; y < height; y++) {
    const above = Math.max(0, y - 1) * width;
    const row = y * width;
    const below = Math.min(height - 1, y + 1) * width;
    const farAbove = Math.max(0, y - side) * width;
    const farBelow = Math.min(height - 1, y + side) * width;
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const dark = x < width && (grey[row + x] < DARK || grey[above + x] < DARK || grey[below + x] < DARK);
      if (dark) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        if (x - start >= minRun) {
          let thin = 0;
          for (let k = start; k < x; k++) if (light(farAbove + k) && light(farBelow + k)) thin++;
          if (thin * 2 >= x - start) onRule.fill(1, row + start, row + x);
        }
        start = -1;
      }
    }
  }
  // Down each column, a row at a time (much quicker than a column at a time).
  const starts = new Int32Array(width).fill(-1);
  for (let y = 0; y <= height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const dark =
        y < height &&
        (grey[row + x] < DARK || (x > 0 && grey[row + x - 1] < DARK) || (x + 1 < width && grey[row + x + 1] < DARK));
      if (dark) {
        if (starts[x] < 0) starts[x] = y;
      } else if (starts[x] >= 0) {
        if (y - starts[x] >= minRun) {
          const left = Math.max(0, x - side);
          const right = Math.min(width - 1, x + side);
          let thin = 0;
          for (let k = starts[x]; k < y; k++) if (light(k * width + left) && light(k * width + right)) thin++;
          if (thin * 2 >= y - starts[x]) for (let k = starts[x]; k < y; k++) onRule[k * width + x] = 1;
        }
        starts[x] = -1;
      }
    }
  }
  let cleared = 0;
  for (let i = 0; i < onRule.length; i++) {
    if (onRule[i] && grey[i] < DARK) {
      grey[i] = 255;
      cleared++;
    }
  }
  return cleared;
}

// Words Tesseract is less sure of than this (0-100) are left out. On real
// text it's nearly always 85 or more; what it "reads" in photos, drawings
// and specks is mostly well under 50.
export const MIN_WORD_CONFIDENCE = 50;
// Fault codes and part numbers aren't in its dictionary, so it's less sure
// of them even when it reads them right (P0300 at 37 on small print, say).
// They're what people search for, and specks don't make them, so they only
// need this much.
export const MIN_CODE_CONFIDENCE = 20;

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// "P0300", "PB10F,", "2205123", "7081-A12": four or more letters, digits and
// dashes, at least two of them digits.
function looksLikeCode(word: string) {
  const core = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return /^[A-Za-z0-9-]{4,}$/.test(core) && (core.match(/\d/g)?.length ?? 0) >= 2;
}

function keepWord(word: string, confidence: number) {
  if (!HAS_LETTER_OR_DIGIT.test(word)) return false;
  return confidence >= (looksLikeCode(word) ? MIN_CODE_CONFIDENCE : MIN_WORD_CONFIDENCE);
}

// The text of a page from Tesseract's TSV output (one row per page, block,
// paragraph, line and word, with a confidence for each word). Leaves out the
// words it wasn't sure of (see keepWord) and marks with no letter or digit,
// and whole lines where that's most of the line (what it makes of a
// picture), keeping lines and paragraphs apart.
export function textFromTsv(tsv: string) {
  type Line = { paragraph: string; words: number; kept: string[] };
  const lines: Line[] = [];
  let current: Line | undefined;
  let currentKey = "";
  for (const row of tsv.split("\n")) {
    const fields = row.split("\t");
    // level page block paragraph line word left top width height conf text
    if (fields[0] !== "5" || fields.length < 12) continue;
    const word = fields.slice(11).join("\t").trim();
    if (!word) continue;
    const key = `${fields[2]}.${fields[3]}.${fields[4]}`;
    if (!current || key !== currentKey) {
      current = { paragraph: `${fields[2]}.${fields[3]}`, words: 0, kept: [] };
      currentKey = key;
      lines.push(current);
    }
    current.words++;
    if (keepWord(word, Number(fields[10]))) current.kept.push(word);
  }
  let text = "";
  let paragraph = "";
  for (const line of lines) {
    if (line.kept.length === 0 || line.kept.length * 2 < line.words) continue;
    if (text) text += line.paragraph === paragraph ? "\n" : "\n\n";
    text += line.kept.join(" ");
    paragraph = line.paragraph;
  }
  return fixDigitConfusions(text);
}

// OCR's usual slips in what people search for most: the letter O for a zero
// and l or I for a one in fault codes and part numbers ("PO300" -> "P0300",
// "22O5l23" -> "2205123"). Only in words that are mostly digits already, so
// real words are left alone.
export function fixDigitConfusions(text: string) {
  return text
    .replace(/\b([PBCU])([0-3O][0-9A-FO]{3})\b/g, (code, letter: string, rest: string) =>
      (rest.match(/\d/g)?.length ?? 0) >= 2 ? letter + rest.replace(/O/g, "0") : code,
    )
    .replace(/\b[0-9OoIl]{5,}\b/g, (word) =>
      (word.match(/\d/g)?.length ?? 0) >= word.length - 2 ? word.replace(/[Oo]/g, "0").replace(/[Il]/g, "1") : word,
    );
}

// Text is saved every few pages, so closing the tab loses little, and in
// batches well under the 1 MB Server Action limit (see PAGE_BATCH_BYTES).
export const OCR_PAGES_PER_BATCH = 10;
// The most the server takes at once.
export const OCR_MAX_PAGES_PER_BATCH = 100;

// What a page adds to a batch, roughly as sent.
export function batchBytes(page: PageText) {
  return new TextEncoder().encode(JSON.stringify(page.text)).length + 32;
}

// Whether a page still fits in a batch of `pages` pages and `bytes` bytes,
// or the batch has to be sent first. An empty batch always takes it.
export function fitsInBatch(batch: { pages: number; bytes: number }, pageBytes: number) {
  return batch.pages === 0 || (batch.pages < OCR_PAGES_PER_BATCH && batch.bytes + pageBytes <= PAGE_BATCH_BYTES);
}

// Before anything has been read: seconds a page takes with this many
// workers, roughly, on an ordinary office computer (about 3 seconds a page
// for one worker at 300 dpi; more workers share the work).
export function roughSeconds(pages: number, workers: number) {
  return (pages * 3) / Math.max(1, workers);
}

// Pages a minute lately: pages finished in the last few minutes (`finished`
// holds when each was, in ms), counted from `since` (when reading started
// or last resumed) if that's later. Null until there's enough to go on.
export function pagesPerMinute(finished: number[], now: number, since: number, windowMs = 3 * 60_000) {
  const from = Math.max(since, now - windowMs);
  const pages = finished.filter((time) => time > from && time <= now).length;
  const elapsed = now - from;
  if (pages < 3 || elapsed < 10_000) return null;
  return (pages / elapsed) * 60_000;
}

// "about 2 hours 10 minutes", for a time estimate in seconds.
export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 60) return "less than a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  // Past a few hours, to the nearest 10 minutes; past ten, to the hour.
  const rest = hours >= 10 ? 0 : hours >= 3 ? Math.round((minutes % 60) / 10) * 10 : minutes % 60;
  const hourText = hours === 1 ? "1 hour" : `${hours} hours`;
  if (rest === 0) return `about ${hourText}`;
  if (rest === 60) return `about ${hours + 1} hours`;
  return `about ${hourText} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

// "pages 3-5, 9": failed pages, for the list of problems.
export function describePages(pages: number[]) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    parts.push(end > i ? `${sorted[i]}-${sorted[end]}` : String(sorted[i]));
    i = end;
  }
  return `${sorted.length === 1 ? "page" : "pages"} ${parts.join(", ")}`;
}
