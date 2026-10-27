// The drawings on a manual page (an exploded view, a diagram, a photo), found
// where the page paints its images, for Diagnose to show a part's drawings
// cropped out of its pages rather than the whole page small. The browser
// hands pdf.js's operator list for a page (with pdf.js's own OPS codes, so
// nothing here depends on pdf.js) to imageBoxes, which follows the current
// transform through it and gives each painted image's box on the page;
// figuresOf keeps the boxes big enough to be drawings, joins tiles of one
// picture, takes in the callout numbers printed around one, and orders them
// largest first. A page that's one image from edge to edge (a scan) has no
// figures: it's shown as the page it is, as is a page whose drawings are
// all lines (no image at all). Also how a figure is cropped out of its
// page, written in the full-screen page's address, and zoomed to in that
// view. Pure: shared by the browser (src/app/(app)/diagnose/manual-pages.ts)
// and the tests.

// --- Transforms ---------------------------------------------------------------

// A PDF transform [a b c d e f]: a point (x, y) goes to
// (a·x + c·y + e, b·x + d·y + f).
export type Matrix = readonly [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// m after n: what a point goes to through n and then m (a content stream's
// `cm` makes the current transform `multiply(current, cm)`, as pdf.js's
// Util.transform does).
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyTo(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// A box on the page, in the PDF's own units (y up).
export type Box = { x0: number; y0: number; x1: number; y1: number };

// The box around a rectangle once it's been through a transform (turned or
// skewed, its corners' box).
export function boxThrough(m: Matrix, x0: number, y0: number, x1: number, y1: number): Box {
  const corners = [applyTo(m, x0, y0), applyTo(m, x1, y0), applyTo(m, x0, y1), applyTo(m, x1, y1)];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function intersect(a: Box, b: Box | null): Box {
  if (!b) return a;
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
}

const matrixOf = (value: unknown): Matrix | null => {
  const m = value as ArrayLike<number> | null | undefined;
  if (!m || typeof m.length !== "number" || m.length < 6) return null;
  const out = [m[0], m[1], m[2], m[3], m[4], m[5]].map(Number);
  return out.every(Number.isFinite) ? (out as unknown as Matrix) : null;
};

// --- Where a page paints its images -----------------------------------------------

// The operator list pdf.js gives for a page (page.getOperatorList()).
export type OperatorList = { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> };

// The pdf.js OPS codes the walk needs (pass pdfjs.OPS).
export type FigureOps = Record<
  | "save"
  | "restore"
  | "transform"
  | "paintFormXObjectBegin"
  | "paintFormXObjectEnd"
  | "beginGroup"
  | "endGroup"
  | "beginAnnotation"
  | "endAnnotation"
  | "clip"
  | "eoClip"
  | "constructPath"
  | "paintImageXObject"
  | "paintInlineImageXObject"
  | "paintImageMaskXObject"
  | "paintImageXObjectRepeat"
  | "paintImageMaskXObjectRepeat"
  | "paintImageMaskXObjectGroup"
  | "paintInlineImageXObjectGroup",
  number
>;

type State = { ctm: Matrix; clip: Box | null };

// The box of every image the page paints, in the PDF's units, as pdf.js's
// canvas draws them: an image fills the unit square of the transform it's
// painted under, which `cm` changes, q and Q save and restore, and a form
// (a drawing kept as an object of its own, often holding the picture)
// changes for its contents by its own matrix and clips to its box. A clip
// path (a picture placed in a frame smaller than itself) cuts the box down
// to the path's bounds. Repeated images (tiles pdf.js joins into one
// operation when it draws a page; getOperatorList lists them one by one)
// give a box each.
export function imageBoxes(list: OperatorList, ops: FigureOps): Box[] {
  const boxes: Box[] = [];
  const stack: State[] = [];
  let state: State = { ctm: IDENTITY, clip: null };
  let clipNext = false;
  const paint = (m: Matrix) => {
    const box = intersect(boxThrough(m, 0, 0, 1, 1), state.clip);
    if (box.x1 > box.x0 && box.y1 > box.y0) boxes.push(box);
  };
  const save = () => stack.push(state);
  const restore = () => {
    state = stack.pop() ?? state;
  };
  const clipTo = (box: Box) => {
    state = { ...state, clip: intersect(box, state.clip) };
  };
  const length = Math.min(list.fnArray.length, list.argsArray.length);
  for (let i = 0; i < length; i++) {
    const fn = list.fnArray[i];
    const args = (list.argsArray[i] ?? []) as unknown[];
    switch (fn) {
      case ops.save:
        save();
        break;
      case ops.restore:
        restore();
        break;
      case ops.transform: {
        const m = matrixOf(args);
        if (m) state = { ...state, ctm: multiply(state.ctm, m) };
        break;
      }
      case ops.paintFormXObjectBegin: {
        save();
        const m = matrixOf(args[0]);
        if (m) state = { ...state, ctm: multiply(state.ctm, m) };
        const bbox = args[1] as ArrayLike<number> | null;
        if (bbox && bbox.length >= 4) clipTo(boxThrough(state.ctm, bbox[0], bbox[1], bbox[2], bbox[3]));
        break;
      }
      case ops.beginGroup: {
        // A transparency group: its form's box is the group's, in the
        // transform before the form's own matrix.
        save();
        const group = (args[0] ?? {}) as { bbox?: ArrayLike<number> | null; matrix?: unknown };
        if (group.bbox && group.bbox.length >= 4) {
          const m = multiply(state.ctm, matrixOf(group.matrix) ?? IDENTITY);
          clipTo(boxThrough(m, group.bbox[0], group.bbox[1], group.bbox[2], group.bbox[3]));
        }
        break;
      }
      case ops.beginAnnotation: {
        // Drawn from the page's own space, in its rectangle.
        save();
        const rect = args[1] as ArrayLike<number> | null;
        const m = multiply(matrixOf(args[2]) ?? IDENTITY, matrixOf(args[3]) ?? IDENTITY);
        state = { ctm: m, clip: rect && rect.length >= 4 ? boxThrough(IDENTITY, rect[0], rect[1], rect[2], rect[3]) : null };
        break;
      }
      case ops.paintFormXObjectEnd:
      case ops.endGroup:
      case ops.endAnnotation:
        restore();
        break;
      case ops.clip:
      case ops.eoClip:
        clipNext = true;
        break;
      case ops.constructPath: {
        // [painting op, [path], its bounds as [minX, minY, maxX, maxY]].
        const bounds = args[2] as ArrayLike<number> | null;
        if (clipNext && bounds && bounds.length >= 4) clipTo(boxThrough(state.ctm, bounds[0], bounds[1], bounds[2], bounds[3]));
        clipNext = false;
        break;
      }
      case ops.paintImageXObject:
      case ops.paintInlineImageXObject:
      case ops.paintImageMaskXObject:
        paint(state.ctm);
        break;
      case ops.paintImageXObjectRepeat: {
        // [image, scaleX, scaleY, positions]
        const [, sx, sy, positions] = args as [unknown, number, number, ArrayLike<number>];
        for (let p = 0; positions && p + 1 < positions.length; p += 2) paint(multiply(state.ctm, [sx, 0, 0, sy, positions[p], positions[p + 1]]));
        break;
      }
      case ops.paintImageMaskXObjectRepeat: {
        // [image, scaleX, skewX, skewY, scaleY, positions]
        const [, sx, kx, ky, sy, positions] = args as [unknown, number, number, number, number, ArrayLike<number>];
        for (let p = 0; positions && p + 1 < positions.length; p += 2) paint(multiply(state.ctm, [sx, kx ?? 0, ky ?? 0, sy, positions[p], positions[p + 1]]));
        break;
      }
      case ops.paintImageMaskXObjectGroup: {
        for (const image of (args[0] ?? []) as { transform?: unknown }[]) paint(multiply(state.ctm, matrixOf(image.transform) ?? IDENTITY));
        break;
      }
      case ops.paintInlineImageXObjectGroup: {
        for (const entry of (args[1] ?? []) as { transform?: unknown }[]) paint(multiply(state.ctm, matrixOf(entry.transform) ?? IDENTITY));
        break;
      }
    }
  }
  return boxes;
}

// --- Figures --------------------------------------------------------------------

// A part of a page, as fractions of its width and height from its top left.
export type PageArea = { left: number; top: number; right: number; bottom: number };

// What pdf.js's page.getViewport({ scale: 1 }) says of the page: its
// transform from the PDF's units to the screen's (y down, turned as the
// page is), and its size there.
export type Viewport = { transform: ArrayLike<number>; width: number; height: number };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// A box in the PDF's units as an area of the page, cut to the page; null
// when nothing of it is on the page.
export function areaOf(box: Box, viewport: Viewport): PageArea | null {
  const m = matrixOf(viewport.transform);
  if (!m || viewport.width <= 0 || viewport.height <= 0) return null;
  const on = boxThrough(m, box.x0, box.y0, box.x1, box.y1);
  const area = {
    left: clamp01(on.x0 / viewport.width),
    top: clamp01(on.y0 / viewport.height),
    right: clamp01(on.x1 / viewport.width),
    bottom: clamp01(on.y1 / viewport.height),
  };
  return area.right > area.left && area.bottom > area.top ? area : null;
}

export const widthOf = (area: PageArea) => area.right - area.left;
export const heightOf = (area: PageArea) => area.bottom - area.top;
// As a share of the page.
export const sizeOf = (area: PageArea) => widthOf(area) * heightOf(area);

const union = (a: PageArea, b: PageArea): PageArea => ({
  left: Math.min(a.left, b.left),
  top: Math.min(a.top, b.top),
  right: Math.max(a.right, b.right),
  bottom: Math.max(a.bottom, b.bottom),
});

// How far apart two areas are across and down (0 where they overlap).
const gaps = (a: PageArea, b: PageArea) => ({
  x: Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)),
  y: Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)),
});

export const FIGURE_LIMITS = {
  // Images closer than this (of the page's width) are one picture: a scan
  // or a big drawing cut into tiles, a photo and its frame.
  near: 0.01,
  // A drawing is at least this much of the page's width and of its
  // height, and this share of the page.
  side: 0.12,
  size: 0.04,
  // One image this much of the page is the page (a scan, from edge to edge
  // or nearly): no crop. A raster drawing with its title and parts list
  // round it is less, and cropped.
  wholePage: 0.85,
  // Callout numbers this far from a drawing (of the page's width) are its.
  reach: 0.06,
  // Room left around a drawing's crop (of the page's width).
  pad: 0.008,
  most: 6,
  // Images looked at on one page (a scan cut into strips has hundreds).
  images: 2000,
} as const;

// A callout's number as a page prints it beside a drawing ("12", "4A",
// "(3)").
export const isCalloutText = (text: string) => /^\(?\d{1,3}[A-Za-z]?\)?$/.test(text.trim());

// A word of the page's text where it's printed (from its text layer).
export type PageLabel = { text: string; area: PageArea };

export type PageFigures = {
  // Largest first.
  figures: PageArea[];
  // One image is (nearly) the whole page: a scan, shown as the page.
  wholePage: boolean;
  // The page's width over its height.
  aspect: number;
};

// The page's drawings from where its images are (areaOf each of
// imageBoxes): images that touch or nearly touch joined (tiles of one
// picture), those too small to be a drawing left out (a logo, a warning
// sign, a photo of a tool beside a step), each
// grown to take in the callout numbers printed around it (labels: the
// page's text where it's printed) and given a little room, largest first,
// at most a few. None when one is most of the page (a scan: the page is
// shown as it is), or when there's no image (a page of text, or whose
// drawings are all lines: the page is shown as it is too).
export function figuresOf(images: PageArea[], { aspect, labels = [] }: { aspect: number; labels?: PageLabel[] }): PageFigures {
  const limits = FIGURE_LIMITS;
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  // Down the page, a distance across it is this much of its height.
  const down = (across: number) => across * ratio;
  let boxes = images.slice(0, limits.images);
  // Join until nothing's left to join (a joined pair can reach a third).
  for (let joined = true; joined; ) {
    joined = false;
    const out: PageArea[] = [];
    for (const box of boxes) {
      const into = out.findIndex((other) => {
        const gap = gaps(box, other);
        return gap.x <= limits.near && gap.y <= down(limits.near);
      });
      if (into === -1) out.push(box);
      else {
        out[into] = union(out[into], box);
        joined = true;
      }
    }
    boxes = out;
  }
  const big = boxes
    .filter((area) => widthOf(area) >= limits.side && heightOf(area) >= limits.side && sizeOf(area) >= limits.size)
    .sort((a, b) => sizeOf(b) - sizeOf(a) || a.top - b.top || a.left - b.left);
  if (big.length > 0 && sizeOf(big[0]) >= limits.wholePage) return { figures: [], wholePage: true, aspect: ratio };
  const kept = big.slice(0, limits.most);
  // Each callout number to the nearest drawing within reach of it.
  const grown = kept.map((area) => ({ ...area }));
  for (const label of labels) {
    if (!isCalloutText(label.text)) continue;
    const x = (label.area.left + label.area.right) / 2;
    const y = (label.area.top + label.area.bottom) / 2;
    let best = -1;
    let bestDistance = Infinity;
    kept.forEach((area, index) => {
      const dx = Math.max(0, area.left - x, x - area.right);
      const dy = Math.max(0, area.top - y, y - area.bottom) / ratio;
      if (dx > limits.reach || dy > limits.reach) return;
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    if (best !== -1) grown[best] = union(grown[best], label.area);
  }
  const figures = grown.map((area) => ({
    left: clamp01(area.left - limits.pad),
    top: clamp01(area.top - down(limits.pad)),
    right: clamp01(area.right + limits.pad),
    bottom: clamp01(area.bottom + down(limits.pad)),
  }));
  return { figures, wholePage: false, aspect: ratio };
}

// An area's own width over its height, on a page `aspect` wide for its
// height.
export const aspectOf = (area: PageArea, aspect: number) => (widthOf(area) * aspect) / Math.max(1e-6, heightOf(area));

// How a drawing is cropped out of its page (only that part is drawn): the
// scale to draw the page at and how far to move it so the area's top left
// is the canvas's top left (pdf.js's getViewport({ scale, offsetX,
// offsetY })), and the canvas's size. `page` is the page at scale 1 (its
// viewport's width and height, turned as it's shown), `cssWidth` the width
// the drawing is shown at; sharp at `ratio` screen pixels to a CSS pixel
// (at most 2), within `pixels` in all and `most` times the page's size.
// And never at a scale the whole page wouldn't fit in `pixels` at: pdf.js
// draws an image mask (a stencil, as scanned line art often is) anywhere on
// the page into a canvas of its own the mask's full size at that scale,
// however little of it is in the crop (on a Letter page, 8 times is a
// canvas of 66 MB for a mask over the page, past a tablet's limit; about 5
// times at most keeps the whole page within it).
export function cropOf(area: PageArea, page: { width: number; height: number }, cssWidth: number, { ratio = 1, pixels = 12_000_000, most = 8 } = {}) {
  const width = Math.max(1e-6, widthOf(area) * page.width);
  const height = Math.max(1e-6, heightOf(area) * page.height);
  const sharp = Math.min(ratio || 1, 2, Math.sqrt(pixels / (cssWidth * cssWidth * (height / width))));
  const whole = Math.sqrt(pixels / Math.max(1e-6, page.width * page.height));
  const scale = Math.min((cssWidth / width) * sharp, most, whole);
  return {
    scale,
    offsetX: -area.left * page.width * scale,
    offsetY: -area.top * page.height * scale,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// --- In the address and the full-screen page ------------------------------------

// A figure in the full-screen page's address (?manual-page=<manual>:<page>:
// box-<left>-<top>-<right>-<bottom>, in thousandths of the page), and back.
export function areaParam(area: PageArea) {
  const at = (value: number) => Math.round(clamp01(value) * 1000);
  return `box-${at(area.left)}-${at(area.top)}-${at(area.right)}-${at(area.bottom)}`;
}

export function parseAreaParam(value: string): PageArea | null {
  const match = /^box-(\d{1,4})-(\d{1,4})-(\d{1,4})-(\d{1,4})$/.exec(value);
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map((n) => Number(n) / 1000);
  if ([left, top, right, bottom].some((n) => n > 1) || right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

// The zoom and offset (as the full-screen page's view: the page `size` at
// zoom 1, moved by x and y on a stage) that show an area whole in the middle
// of the stage with `margin` around it, from no zoom at all up to `most`.
export function fitArea(
  area: PageArea,
  size: { width: number; height: number },
  stage: { width: number; height: number },
  { margin = 24, most = 4 }: { margin?: number; most?: number } = {},
) {
  const width = Math.max(1, widthOf(area) * size.width);
  const height = Math.max(1, heightOf(area) * size.height);
  const zoom = Math.min(most, Math.max(1, Math.min((stage.width - 2 * margin) / width, (stage.height - 2 * margin) / height)));
  return {
    zoom,
    x: stage.width / 2 - ((area.left + area.right) / 2) * size.width * zoom,
    y: stage.height / 2 - ((area.top + area.bottom) / 2) * size.height * zoom,
  };
}
