// The drawings on a manual page, found where it paints its images
// (src/lib/manual-figures.ts): the boxes pdf.js's own operator list gives
// for a page built here with an image placed by a transform, inside a form,
// in a clip, inline, as a mask, repeated as tiles and turned, on an upright
// page and a turned one; then which boxes are drawings (big enough, tiles
// joined, a scan as the page, callout numbers taken in, largest first),
// and how a figure is written in the address and zoomed to. Needs no
// database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  FIGURE_LIMITS,
  IDENTITY,
  applyTo,
  areaOf,
  areaParam,
  aspectOf,
  boxThrough,
  figuresOf,
  fitArea,
  imageBoxes,
  isCalloutText,
  multiply,
  parseAreaParam,
  sizeOf,
  type Box,
  type FigureOps,
  type Matrix,
  type PageArea,
} from "../src/lib/manual-figures";

type PdfJs = typeof import("pdfjs-dist");

// --- A PDF with images, built by hand ----------------------------------------------

const W = 612;
const H = 792;

// One 2×2 RGB image, one 8×1 mask, and per page a content stream (and,
// for the form, its own stream), uncompressed.
function buildPdf(pages: { content: string; rotate?: number; form?: { matrix: number[]; bbox: number[]; content: string } }[]) {
  const parts: string[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (text: string) => {
    parts.push(text);
    length += Buffer.byteLength(text, "latin1");
  };
  const obj = (n: number, body: string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  const stream = (dict: string, data: string) => `<< ${dict} /Length ${Buffer.byteLength(data, "latin1")} >>\nstream\n${data}\nendstream`;
  push("%PDF-1.4\n");
  const pixels = String.fromCharCode(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0);
  // 1 catalog, 2 pages, 3 image, 4 mask, then per page: page, content, form.
  const first = 5;
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${first + 3 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  obj(3, stream("/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8", pixels));
  obj(4, stream("/Type /XObject /Subtype /Image /Width 8 /Height 1 /ImageMask true /BitsPerComponent 1", String.fromCharCode(0b10101010)));
  pages.forEach((page, i) => {
    const n = first + 3 * i;
    const form = page.form ? ` /Fm1 ${n + 2} 0 R` : "";
    obj(
      n,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}]${page.rotate ? ` /Rotate ${page.rotate}` : ""} /Resources << /XObject << /Im1 3 0 R /Mk 4 0 R${form} >> >> /Contents ${n + 1} 0 R >>`,
    );
    obj(n + 1, stream("", page.content));
    if (page.form) {
      obj(
        n + 2,
        stream(`/Type /XObject /Subtype /Form /Matrix [${page.form.matrix.join(" ")}] /BBox [${page.form.bbox.join(" ")}] /Resources << /XObject << /Im1 3 0 R >> >>`, page.form.content),
      );
    } else obj(n + 2, "null");
  });
  const count = first + 3 * pages.length;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.from(parts.join(""), "latin1"));
}

const INLINE = `BI /W 2 /H 1 /CS /RGB /BPC 8 ID ${String.fromCharCode(10, 20, 30, 40, 50, 60)} EI`;

let pdfjs: PdfJs;
before(async () => {
  pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJs;
  const require = createRequire(import.meta.url);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
});

// Each page's image boxes, as pdf.js lists the page's operations, and the
// page's viewport.
async function boxesOf(bytes: Uint8Array) {
  const loading = pdfjs.getDocument({ data: bytes, verbosity: pdfjs.VerbosityLevel.ERRORS });
  const doc = await loading.promise;
  const out: { boxes: Box[]; ops: number[]; viewport: { transform: number[]; width: number; height: number } }[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const list = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
    const viewport = page.getViewport({ scale: 1 });
    out.push({ boxes: imageBoxes(list, pdfjs.OPS as unknown as FigureOps), ops: [...list.fnArray], viewport });
  }
  await loading.destroy();
  return out;
}

const near = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) < 0.01, `${what}: ${actual} isn't ${expected}`);
function sameBox(actual: Box | undefined, expected: Box, what: string) {
  assert.ok(actual, `${what}: no box`);
  near(actual.x0, expected.x0, `${what} x0`);
  near(actual.y0, expected.y0, `${what} y0`);
  near(actual.x1, expected.x1, `${what} x1`);
  near(actual.y1, expected.y1, `${what} y1`);
}
function sameArea(actual: PageArea | null | undefined, expected: PageArea, what: string) {
  assert.ok(actual, `${what}: no area`);
  for (const side of ["left", "top", "right", "bottom"] as const) assert.ok(Math.abs(actual[side] - expected[side]) < 0.002, `${what} ${side}: ${actual[side]} isn't ${expected[side]}`);
}
const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 });
const area = (left: number, top: number, right: number, bottom: number): PageArea => ({ left, top, right, bottom });

describe("where a page paints its images, from pdf.js's operator list", () => {
  test("an image fills the unit square of its transform: placed, turned, inside a form (clipped to its box), in a clip, inline, as a mask", async () => {
    const [placed, turned, form, clipped, inline, mask, nested] = await boxesOf(
      buildPdf([
        { content: "q 300 0 0 200 100 400 cm /Im1 Do Q" },
        // A quarter turn about (300, 300), then 100 by 50.
        { content: "q 0 1 -1 0 300 300 cm 100 0 0 50 0 0 cm /Im1 Do Q" },
        // The form moves its contents by (50, 50) and clips to 200 by 100.
        { content: "q /Fm1 Do Q", form: { matrix: [1, 0, 0, 1, 50, 50], bbox: [0, 0, 200, 100], content: "q 400 0 0 300 0 0 cm /Im1 Do Q" } },
        // A picture larger than its frame, cut to the frame.
        { content: "q 100 100 200 150 re W n 400 0 0 400 0 0 cm /Im1 Do Q" },
        { content: `q 50 0 0 25 500 700 cm ${INLINE} Q` },
        { content: "q 120 0 0 80 30 30 cm /Mk Do Q" },
        // Saved and restored around a move: the second image is where the first transform left it.
        { content: "q 2 0 0 2 0 0 cm q 10 0 0 10 5 5 cm /Im1 Do Q 20 0 0 20 0 0 cm /Im1 Do Q" },
      ]),
    );
    sameBox(placed.boxes[0], box(100, 400, 400, 600), "placed");
    assert.equal(placed.boxes.length, 1);
    sameBox(turned.boxes[0], box(250, 300, 300, 400), "turned");
    sameBox(form.boxes[0], box(50, 50, 250, 150), "in a form");
    sameBox(clipped.boxes[0], box(100, 100, 300, 250), "clipped");
    sameBox(inline.boxes[0], box(500, 700, 550, 725), "inline");
    sameBox(mask.boxes[0], box(30, 30, 150, 110), "mask");
    assert.ok(inline.ops.includes(pdfjs.OPS.paintInlineImageXObject) && mask.ops.includes(pdfjs.OPS.paintImageMaskXObject) && form.ops.includes(pdfjs.OPS.paintFormXObjectBegin));
    sameBox(nested.boxes[0], box(10, 10, 30, 30), "nested first");
    sameBox(nested.boxes[1], box(0, 0, 40, 40), "nested second");
  });

  test("tiles of one image give a box each (as getOperatorList lists them: one by one, not joined as when pdf.js draws them, which the walk follows too)", async () => {
    const tiles = Array.from({ length: 4 }, (_, i) => `q 100 0 0 50 ${100 + 100 * i} 300 cm /Im1 Do Q`).join("\n");
    const [page] = await boxesOf(buildPdf([{ content: tiles }]));
    assert.equal(page.ops.filter((op) => op === pdfjs.OPS.paintImageXObject).length, 4);
    assert.equal(page.boxes.length, 4);
    page.boxes.forEach((found, i) => sameBox(found, box(100 + 100 * i, 300, 200 + 100 * i, 350), `tile ${i}`));
  });

  test("a box as an area of the page, top left first, on an upright page and a turned one", async () => {
    const [upright, rotated] = await boxesOf(buildPdf([{ content: "q 306 0 0 198 0 594 cm /Im1 Do Q" }, { content: "q 306 0 0 198 0 594 cm /Im1 Do Q", rotate: 90 }]));
    // The top left quarter of the page's width, a quarter of its height.
    sameArea(areaOf(upright.boxes[0], upright.viewport), area(0, 0, 0.5, 0.25), "upright");
    // Turned a quarter clockwise, the page's top left is at the top right.
    assert.equal(rotated.viewport.width, H);
    sameArea(areaOf(rotated.boxes[0], rotated.viewport), area(0.75, 0, 1, 0.5), "turned");
  });

  test("nothing off the page, and nothing for a page with no image", async () => {
    const [off, none] = await boxesOf(buildPdf([{ content: "q 100 0 0 100 700 900 cm /Im1 Do Q" }, { content: "0 0 m 100 100 l S" }]));
    assert.equal(areaOf(off.boxes[0], off.viewport), null);
    assert.deepEqual(none.boxes, []);
  });
});

describe("the walk itself, over a plain list", () => {
  // Small codes for a list written by hand.
  const OPS: FigureOps = {
    save: 1,
    restore: 2,
    transform: 3,
    paintFormXObjectBegin: 4,
    paintFormXObjectEnd: 5,
    beginGroup: 6,
    endGroup: 7,
    beginAnnotation: 8,
    endAnnotation: 9,
    clip: 10,
    eoClip: 11,
    constructPath: 12,
    paintImageXObject: 13,
    paintInlineImageXObject: 14,
    paintImageMaskXObject: 15,
    paintImageXObjectRepeat: 16,
    paintImageMaskXObjectRepeat: 17,
    paintImageMaskXObjectGroup: 18,
    paintInlineImageXObjectGroup: 19,
  };
  const walk = (ops: [number, unknown[] | null][]) => imageBoxes({ fnArray: ops.map(([fn]) => fn), argsArray: ops.map(([, args]) => args) }, OPS);

  test("a transparency group clips to its box in the transform before its form's matrix; an annotation draws from the page's own space in its rectangle", () => {
    const boxes = walk([
      [OPS.transform, [2, 0, 0, 2, 0, 0]],
      [OPS.beginGroup, [{ bbox: [0, 0, 50, 50], matrix: [1, 0, 0, 1, 10, 10] }]],
      [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 10, 10], null]],
      [OPS.transform, [100, 0, 0, 100, 0, 0]],
      [OPS.paintImageXObject, ["img_1", 2, 2]],
      [OPS.paintFormXObjectEnd, []],
      [OPS.endGroup, [{}]],
      [OPS.beginAnnotation, ["a1", [400, 400, 450, 420], [1, 0, 0, 1, 400, 400], [1, 0, 0, 1, 0, 0], false]],
      [OPS.transform, [100, 0, 0, 100, 0, 0]],
      [OPS.paintImageXObject, ["img_2", 2, 2]],
      [OPS.endAnnotation, []],
      [OPS.transform, [10, 0, 0, 10, 0, 0]],
      [OPS.paintImageXObject, ["img_3", 2, 2]],
    ]);
    // Group: (20, 20) to (120, 120) clipped to its box at 2x: (20, 20) to (120, 120).
    sameBox(boxes[0], box(20, 20, 120, 120), "group");
    sameBox(boxes[1], box(400, 400, 450, 420), "annotation");
    // After both, the page's own transform again (2x): 10 by 10 at 2x.
    sameBox(boxes[2], box(0, 0, 20, 20), "after");
  });

  test("a clip comes from the path that follows it, only for that path; an even-odd clip too", () => {
    const boxes = walk([
      [OPS.save, null],
      [OPS.eoClip, null],
      [OPS.constructPath, [28, [null], [10, 10, 60, 60]]],
      [OPS.constructPath, [20, [null], [0, 0, 500, 500]]],
      [OPS.transform, [100, 0, 0, 100, 0, 0]],
      [OPS.paintImageXObject, ["img_1"]],
      [OPS.restore, null],
      [OPS.transform, [100, 0, 0, 100, 0, 0]],
      [OPS.paintImageXObject, ["img_1"]],
    ]);
    sameBox(boxes[0], box(10, 10, 60, 60), "clipped");
    sameBox(boxes[1], box(0, 0, 100, 100), "after the clip's Q");
  });

  test("repeated masks with a skew, a group of masks, a group of inline images; an image cut to nothing isn't one", () => {
    const boxes = walk([
      [OPS.paintImageMaskXObjectRepeat, [{}, 10, 0, 0, 20, [0, 0, 100, 0]]],
      [OPS.paintImageMaskXObjectGroup, [[{ transform: [5, 0, 0, 5, 50, 50] }]]],
      [OPS.paintInlineImageXObjectGroup, [{}, [{ transform: [30, 0, 0, 10, 200, 200] }, { transform: [30, 0, 0, 10, 230, 200] }]]],
      [OPS.clip, null],
      [OPS.constructPath, [28, [null], [0, 0, 1, 1]]],
      [OPS.transform, [100, 0, 0, 100, 500, 500]],
      [OPS.paintImageXObject, ["img_1"]],
    ]);
    assert.equal(boxes.length, 5);
    sameBox(boxes[0], box(0, 0, 10, 20), "first mask");
    sameBox(boxes[1], box(100, 0, 110, 20), "second mask");
    sameBox(boxes[2], box(50, 50, 55, 55), "masks' group");
    sameBox(boxes[3], box(200, 200, 230, 210), "first inline");
    sameBox(boxes[4], box(230, 200, 260, 210), "second inline");
  });

  test("the transform maths", () => {
    const turn: Matrix = [0, 1, -1, 0, 0, 0];
    const move: Matrix = [1, 0, 0, 1, 10, 0];
    // Moved, then turned: (0, 0) -> (10, 0) -> (0, 10).
    assert.deepEqual(applyTo(multiply(turn, move), 0, 0), [0, 10]);
    assert.deepEqual(multiply(IDENTITY, move), move);
    sameBox(boxThrough(turn, 0, 0, 2, 1), box(-1, 0, 0, 2), "turned box");
  });
});

describe("which images are drawings", () => {
  const PAGE = { aspect: W / H };

  test("a drawing is big enough across, down and in all; smaller pictures (a logo, a tool's photo) aren't", () => {
    const { figures, wholePage } = figuresOf([area(0.1, 0.5, 0.6, 0.85), area(0.05, 0.02, 0.15, 0.08), area(0.7, 0.1, 0.95, 0.15), area(0.7, 0.3, 0.8, 0.9)], PAGE);
    assert.equal(wholePage, false);
    assert.equal(figures.length, 1);
    // With a little room around it.
    const pad = FIGURE_LIMITS.pad;
    sameArea(figures[0], area(0.1 - pad, 0.5 - pad * PAGE.aspect, 0.6 + pad, 0.85 + pad * PAGE.aspect), "the drawing");
  });

  test("two drawings, largest first; tiles that touch or nearly touch are one", () => {
    const small = area(0.6, 0.6, 0.9, 0.85);
    const tiles = [area(0.1, 0.1, 0.3, 0.4), area(0.3, 0.1, 0.5, 0.4), area(0.1, 0.405, 0.5, 0.5)];
    const { figures } = figuresOf([small, ...tiles], PAGE);
    assert.equal(figures.length, 2);
    assert.ok(sizeOf(figures[0]) > sizeOf(figures[1]));
    assert.ok(figures[0].left < 0.1 && figures[0].right > 0.5 && figures[0].bottom > 0.5, JSON.stringify(figures[0]));
    assert.ok(figures[1].left < 0.6 && figures[1].left > 0.58, JSON.stringify(figures[1]));
    // Far enough apart, they're two.
    const apart = figuresOf([area(0.1, 0.1, 0.35, 0.35), area(0.4, 0.1, 0.65, 0.35)], PAGE);
    assert.equal(apart.figures.length, 2);
  });

  test("a scan (one image most of the page, or tiles of it) is the page: no figure to crop", () => {
    assert.deepEqual(figuresOf([area(0, 0, 1, 1)], PAGE), { figures: [], wholePage: true, aspect: PAGE.aspect });
    const strips = Array.from({ length: 40 }, (_, i) => area(0.02, 0.02 + i * 0.024, 0.98, 0.02 + (i + 1) * 0.024));
    assert.equal(figuresOf(strips, PAGE).wholePage, true);
    // A page with no image (text, or a drawing all of lines) has none either, and isn't a scan.
    assert.deepEqual(figuresOf([], PAGE), { figures: [], wholePage: false, aspect: PAGE.aspect });
  });

  test("callout numbers around a drawing are taken into its crop; words and far numbers aren't; each number to the nearest drawing", () => {
    const drawing = area(0.25, 0.3, 0.75, 0.6);
    const label = (text: string, x: number, y: number) => ({ text, area: area(x, y, x + 0.02, y + 0.015) });
    const labels = [label("1", 0.2, 0.32), label("2", 0.77, 0.4), label("12A", 0.5, 0.62), label("Starter", 0.2, 0.45), label("7", 0.05, 0.05), label("3", 0.5, 0.25)];
    const [grown] = figuresOf([drawing], { aspect: PAGE.aspect, labels }).figures;
    assert.ok(grown.left < 0.2 && grown.right > 0.79 && grown.bottom > 0.635 && grown.top < 0.25, JSON.stringify(grown));
    assert.ok(grown.left > 0.18 && grown.top > 0.2, "a far number or a word taken in");
    // Between two drawings, a number goes to the nearer one only.
    const left = area(0.05, 0.3, 0.4, 0.6);
    const right = area(0.6, 0.3, 0.95, 0.6);
    const two = figuresOf([left, right], { aspect: PAGE.aspect, labels: [label("4", 0.42, 0.4)] }).figures;
    const [l, r] = two[0].left < two[1].left ? two : [two[1], two[0]];
    assert.ok(l.right > 0.44 && r.left > 0.59 - FIGURE_LIMITS.pad - 0.001, JSON.stringify(two));
    assert.equal(isCalloutText(" (3) "), true);
    assert.equal(isCalloutText("10.62"), false);
    assert.equal(isCalloutText("1234"), false);
  });

  test("at most a few, and an area's own shape on the page", () => {
    const many = Array.from({ length: 9 }, (_, i) => area(0.02 + (i % 3) * 0.33, 0.02 + Math.floor(i / 3) * 0.33, 0.3 + (i % 3) * 0.33, 0.3 + Math.floor(i / 3) * 0.33));
    assert.equal(figuresOf(many, PAGE).figures.length, FIGURE_LIMITS.most);
    // Half the page's width and a quarter of its height on a letter page: 306 by 198.
    assert.ok(Math.abs(aspectOf(area(0, 0, 0.5, 0.25), W / H) - 306 / 198) < 1e-9);
  });
});

describe("a figure in the address, and zoomed to", () => {
  test("written in thousandths of the page, read back; anything else isn't a figure", () => {
    const figure = area(0.1234, 0.5, 0.6, 0.95);
    assert.equal(areaParam(figure), "box-123-500-600-950");
    assert.deepEqual(parseAreaParam("box-123-500-600-950"), area(0.123, 0.5, 0.6, 0.95));
    for (const bad of ["box-600-500-123-950", "box-1-2-3", "box-0-0-1001-1000", "torque", "box-1-2-3-4-5", ""]) assert.equal(parseAreaParam(bad), null, bad);
  });

  test("zoomed so the figure fills the stage with room around it, centred; never less than the page, never past the most", () => {
    const size = { width: 400, height: 518 };
    const stage = { width: 800, height: 600 };
    const fit = fitArea(area(0.25, 0.5, 0.75, 0.75), size, stage, { margin: 20, most: 4 });
    // 200 by 129.5 at zoom 1: fills the width (760 / 200 = 3.8) before the height (560 / 129.5).
    assert.equal(fit.zoom, 3.8);
    assert.equal(fit.x, 400 - 0.5 * 400 * 3.8);
    assert.equal(fit.y, 300 - 0.625 * 518 * 3.8);
    // A small one is held at the most.
    assert.equal(fitArea(area(0.4, 0.4, 0.5, 0.5), size, stage, { margin: 20, most: 4 }).zoom, 4);
    assert.equal(fitArea(area(0, 0, 1, 1), size, { width: 300, height: 300 }).zoom, 1);
  });
});
