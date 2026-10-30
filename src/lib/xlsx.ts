// Reads Excel workbooks (.xlsx, and .xlsm, which is the same with macros in
// it) into rows of text, for importing customer lists. A workbook is a zip of XML
// files: xl/workbook.xml lists the sheets, each sheet is an XML file of its
// own, and text cells point into a shared list of strings. Kept free of other
// imports, like csv.ts, so the browser can use it: the zip is unpacked with
// DecompressionStream (browsers and Node 18+ have it), and the XML is read by
// the small reader below, since the browser's DOMParser isn't in Node.
//
// Each cell comes out as the text Excel shows for it in a plain column:
// numbers without floating-point noise, dates as 2024-03-05, TRUE and FALSE,
// errors such as #N/A. Hidden sheets and chart sheets are left out.
//
// Files come from anyone's computer, so nothing here trusts them: a part that
// unpacks to more than it should, or a sheet with millions of cells, stops
// with an XlsxError instead of filling the browser's memory.

// Every failure the person importing should see, in words they can act on.
export class XlsxError extends Error {}

export type XlsxSheet = { name: string; rows: string[][] };

// How much one part of the zip may unpack to, and how many cells all the
// sheets may hold between them (blanks that pad out a row count too).
export const XLSX_LIMITS = { maxEntryBytes: 64 * 1024 * 1024, maxCells: 2_000_000 };

// "PK" and a local file header: a zip, so maybe a workbook.
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
}

const AGAIN = "Save it as an Excel workbook (.xlsx) or as CSV and try again.";
const NOT_WORKBOOK = `This file isn't an Excel workbook. ${AGAIN}`;
const DAMAGED =
  "This workbook is damaged or incomplete, so it can't be read. If it was downloaded or copied, try that again; otherwise open it in Excel, save it again and try again.";

function notWorkbook(looksLike: string) {
  return new XlsxError(`This file isn't an Excel workbook (it looks like ${looksLike}). ${AGAIN}`);
}

function damaged(what: string) {
  return new XlsxError(`This workbook is damaged: ${what}. Open it in Excel, save it again and try again.`);
}

function tooManyCells(max: number) {
  return new XlsxError(
    `This workbook has more than ${max.toLocaleString("en-US")} cells, more than can be imported at once. Split it into smaller files and import them one at a time.`,
  );
}

type Limits = typeof XLSX_LIMITS;

export async function readXlsx(bytes: Uint8Array, limits?: Partial<Limits>): Promise<XlsxSheet[]> {
  const caps: Limits = {
    maxEntryBytes: limits?.maxEntryBytes ?? XLSX_LIMITS.maxEntryBytes,
    maxCells: limits?.maxCells ?? XLSX_LIMITS.maxCells,
  };
  if (!isZip(bytes)) {
    // Old .xls files and password-protected workbooks are both OLE compound
    // files, which start with these eight bytes.
    const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (bytes.length >= 8 && ole.every((byte, i) => bytes[i] === byte)) {
      throw new XlsxError(
        "This is an older Excel file (.xls) or a password-protected workbook, which can't be read here. Open it in Excel and save it as .xlsx without a password (or as CSV), then try again.",
      );
    }
    throw new XlsxError(NOT_WORKBOOK);
  }
  const zip: Zip = { bytes, entries: readZipDirectory(bytes), caps };

  // The package's own relationships say which part is the workbook; most
  // files call it xl/workbook.xml.
  let workbookPart = "";
  for (const rel of (await readRelationships(zip, "")).values()) {
    if (rel.type.endsWith("/officeDocument")) {
      workbookPart = rel.target;
      break;
    }
  }
  if (!workbookPart || !zip.entries.has(partKey(workbookPart))) {
    if (zip.entries.has(partKey("xl/workbook.xml"))) workbookPart = "xl/workbook.xml";
    else if (zip.entries.has("mimetype") && zip.entries.has("content.xml")) throw notWorkbook("an OpenDocument file, such as .ods");
    else if (workbookPart) throw damaged(`its workbook part (${workbookPart}) is missing`);
    else throw new XlsxError(NOT_WORKBOOK);
  }
  if (/\.bin$/i.test(workbookPart)) {
    throw new XlsxError(`This is an Excel binary workbook (.xlsb), which can't be read here. ${AGAIN}`);
  }

  const book = readWorkbook(await readPart(zip, workbookPart), workbookPart);
  const rels = await readRelationships(zip, workbookPart);
  const folder = workbookPart.slice(0, workbookPart.lastIndexOf("/") + 1);
  const partOfType = (type: string, usual: string) => {
    for (const rel of rels.values()) if (rel.type.endsWith(type)) return rel.target;
    return folder + usual;
  };
  const stringsPart = partOfType("/sharedStrings", "sharedStrings.xml");
  const strings = readSharedStrings(await readOptionalPart(zip, stringsPart), stringsPart, caps.maxCells);
  const stylesPart = partOfType("/styles", "styles.xml");
  const formats = readStyles(await readOptionalPart(zip, stylesPart), stylesPart);

  const counter = { cells: 0, max: caps.maxCells };
  const sheets: XlsxSheet[] = [];
  for (const sheet of book.sheets) {
    if (sheet.state === "hidden" || sheet.state === "veryhidden") continue;
    const rel = rels.get(sheet.id);
    if (!rel) throw damaged(`sheet "${sheet.name}" is missing`);
    // Chart sheets, dialog sheets and old macro sheets hold no rows.
    if (!rel.type.endsWith("/worksheet")) continue;
    if (!zip.entries.has(partKey(rel.target))) throw damaged(`sheet "${sheet.name}" is missing`);
    const xml = await readPart(zip, rel.target);
    const rows = readSheet(xml, rel.target, sheet.name, { strings, formats, dates: book.dates, counter });
    sheets.push({ name: sheet.name, rows });
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// The zip

type ZipEntry = { name: string; method: number; flags: number; compressedSize: number; size: number; offset: number };
type Zip = { bytes: Uint8Array; entries: Map<string, ZipEntry>; caps: Limits };

const utf8 = new TextDecoder();

function u16(bytes: Uint8Array, at: number) {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number) {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

// Part names are matched the way packages define them: without a leading
// slash and ignoring case (Excel itself will open "xl/Worksheets/Sheet1.xml"
// when the relationship says "worksheets/sheet1.xml").
function partKey(name: string) {
  let key = name.replace(/\\/g, "/").replace(/^\/+/, "");
  try {
    key = decodeURIComponent(key);
  } catch {
    // A stray % that isn't an escape: keep the name as it is.
  }
  return key.toLowerCase();
}

// The zip's table of contents sits at the end of the file and its sizes are
// the ones to trust (a writer that streams may leave the sizes before each
// file's data as zeros).
function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  // The last record is 22 bytes plus a comment of up to 64 KB, so look for
  // its signature backwards from the end.
  let end = -1;
  for (let at = bytes.length - 22, stop = Math.max(0, bytes.length - 22 - 0xffff); at >= stop; at--) {
    if (u32(bytes, at) === 0x06054b50 && at + 22 + u16(bytes, at + 20) <= bytes.length) {
      end = at;
      break;
    }
  }
  if (end === -1) throw new XlsxError(DAMAGED);
  const count = u16(bytes, end + 10);
  const directorySize = u32(bytes, end + 12);
  const directoryAt = u32(bytes, end + 16);
  // ZIP64, for zips over 4 GB or with more than 65,535 files, fills these
  // with all ones and keeps the real numbers elsewhere. No customer list
  // needs it, and refusing it keeps the sizes below trustworthy.
  if (count === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) throw zip64();
  if (u16(bytes, end + 4) !== 0 || u16(bytes, end + 6) !== 0) {
    throw new XlsxError("This workbook is split across several files, which can't be read here. " + AGAIN);
  }
  if (directoryAt + directorySize > end) throw new XlsxError(DAMAGED);

  const entries = new Map<string, ZipEntry>();
  let at = directoryAt;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(bytes, at) !== 0x02014b50) throw new XlsxError(DAMAGED);
    const nameLength = u16(bytes, at + 28);
    if (at + 46 + nameLength > end) throw new XlsxError(DAMAGED);
    const entry: ZipEntry = {
      name: utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      flags: u16(bytes, at + 8),
      method: u16(bytes, at + 10),
      compressedSize: u32(bytes, at + 20),
      size: u32(bytes, at + 24),
      offset: u32(bytes, at + 42),
    };
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) throw zip64();
    const key = partKey(entry.name);
    if (!entries.has(key)) entries.set(key, entry);
    at += 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
  }
  return entries;
}

function sizeText(bytes: number) {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function zip64() {
  return new XlsxError(
    "This workbook is stored in a format for very large files (ZIP64), which can't be read here. Split it into smaller files, or save it as CSV, and try again.",
  );
}

async function readPart(zip: Zip, name: string): Promise<string> {
  const entry = zip.entries.get(partKey(name));
  if (!entry) throw damaged(`${name} is missing`);
  const data = await unpack(zip, entry);
  // Parts are UTF-8, or now and then UTF-16 with a byte order mark.
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
  return utf8.decode(data);
}

// Shared strings and styles are optional: a workbook without them has no
// text cells, or only plain formatting.
async function readOptionalPart(zip: Zip, name: string): Promise<string | null> {
  return zip.entries.has(partKey(name)) ? readPart(zip, name) : null;
}

async function unpack(zip: Zip, entry: ZipEntry): Promise<Uint8Array> {
  const { bytes, caps } = zip;
  // Bit 0 and bit 6 mark encryption, and method 99 is WinZip's AES.
  if (entry.flags & 0x41 || entry.method === 99) {
    throw new XlsxError(
      "This workbook is password-protected. Open it in Excel, save a copy without the password, and import that.",
    );
  }
  if (entry.size > caps.maxEntryBytes) {
    throw new XlsxError(
      `This workbook is too big to import: part of it (${entry.name}) unpacks to more than ${sizeText(caps.maxEntryBytes)}. Split it into smaller files, or save it as CSV, and try again.`,
    );
  }
  const at = entry.offset;
  if (at + 30 > bytes.length || u32(bytes, at) !== 0x04034b50) throw new XlsxError(DAMAGED);
  const start = at + 30 + u16(bytes, at + 26) + u16(bytes, at + 28);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new XlsxError(DAMAGED);
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new XlsxError(DAMAGED);
    return data;
  }
  if (entry.method !== 8) {
    throw new XlsxError(`This workbook is compressed in a way that can't be read here. Open it in Excel, save it again as .xlsx and try again.`);
  }
  if (entry.size === 0) return new Uint8Array(0);
  return inflate(data, entry.size);
}

// Unpacks deflated data that the zip's directory says is `size` bytes long.
// The data goes in a slice at a time and the stream paces it, so a part that
// unpacks to far more than it claims (a "zip bomb") is stopped as soon as it
// passes the claim, before the rest of it is unpacked.
async function inflate(data: Uint8Array, size: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new XlsxError("This browser is too old to open Excel files. Update it, or save the workbook as CSV, and try again.");
  }
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let stopped = false;
  // Its failures (data that isn't deflate) show up on the reading side.
  void (async () => {
    for (let at = 0; at < data.length && !stopped; at += 16384) {
      await writer.ready;
      if (stopped) return;
      writer.write(data.slice(at, at + 16384)).catch(() => {});
    }
    await writer.close();
  })().catch(() => {});

  const out = new Uint8Array(size);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > size) throw new XlsxError(DAMAGED);
      out.set(value, length);
      length += value.length;
    }
  } catch (error) {
    stopped = true;
    reader.cancel().catch(() => {});
    writer.abort().catch(() => {});
    throw error instanceof XlsxError ? error : new XlsxError(DAMAGED);
  }
  if (length !== size) throw new XlsxError(DAMAGED);
  return out;
}

// ---------------------------------------------------------------------------
// The XML

// Attributes by local name: "r:id" is "id". Namespace declarations are left
// out, so xmlns:r="..." on a cell can't pass for its r.
type Attrs = Record<string, string | undefined>;

type XmlReader = {
  open(name: string, attrs: Attrs): void;
  close(name: string): void;
  // Text is decoded and handed over only while this is true, which saves
  // decoding the whitespace and formulas nobody reads.
  wantText: boolean;
  text(text: string): void;
};

// Element names come without their prefix too, as writers differ: Excel
// writes <row>, some libraries write <x:row> with the same meaning.
function localName(name: string) {
  return name.slice(name.indexOf(":") + 1);
}

function isSpace(c: number) {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

// Where an element or attribute name stops: a space, "/", ">" or "=".
function endsName(c: number) {
  return isSpace(c) || c === 0x2f || c === 0x3e || c === 0x3d;
}

// Reads `xml` from start to end, telling `reader` about each element as it
// opens and closes. Comments, processing instructions and the document type
// are skipped; CDATA is text. Anything malformed stops with an XlsxError
// naming the part.
function parseXml(xml: string, part: string, reader: XmlReader): void {
  const broken = () => damaged(`${part} can't be read`);
  const end = xml.length;
  let at = 0;
  let depth = 0;
  while (at < end) {
    const lt = xml.indexOf("<", at);
    if (lt === -1) break;
    if (lt > at && reader.wantText) reader.text(decodeEntities(lineEnds(xml.slice(at, lt))));
    const next = xml.charCodeAt(lt + 1);

    if (next === 0x21 /* ! */) {
      if (xml.startsWith("--", lt + 2)) {
        const close = xml.indexOf("-->", lt + 4);
        if (close === -1) throw broken();
        at = close + 3;
      } else if (xml.startsWith("[CDATA[", lt + 2)) {
        const close = xml.indexOf("]]>", lt + 9);
        if (close === -1) throw broken();
        if (reader.wantText) reader.text(lineEnds(xml.slice(lt + 9, close)));
        at = close + 3;
      } else {
        // <!DOCTYPE ...>, maybe with declarations in [ ]. Its entities
        // aren't expanded, which also keeps "billion laughs" files harmless.
        let close = xml.indexOf(">", lt);
        const bracket = xml.indexOf("[", lt);
        if (bracket !== -1 && bracket < close) {
          const shut = xml.indexOf("]", bracket);
          close = shut === -1 ? -1 : xml.indexOf(">", shut);
        }
        if (close === -1) throw broken();
        at = close + 1;
      }
      continue;
    }
    if (next === 0x3f /* ? */) {
      const close = xml.indexOf("?>", lt + 2);
      if (close === -1) throw broken();
      at = close + 2;
      continue;
    }
    if (next === 0x2f /* / */) {
      const close = xml.indexOf(">", lt + 2);
      if (close === -1 || depth === 0) throw broken();
      depth--;
      reader.close(localName(xml.slice(lt + 2, close).trim()));
      at = close + 1;
      continue;
    }

    // A start tag: its name, then attributes in either quote style.
    let i = lt + 1;
    while (i < end && !endsName(xml.charCodeAt(i))) i++;
    if (i === lt + 1) throw broken();
    const name = localName(xml.slice(lt + 1, i));
    const attrs: Attrs = Object.create(null);
    let empty = false;
    for (;;) {
      while (i < end && isSpace(xml.charCodeAt(i))) i++;
      if (i >= end) throw broken();
      const c = xml.charCodeAt(i);
      if (c === 0x3e /* > */) {
        i++;
        break;
      }
      if (c === 0x2f /* / */) {
        if (xml.charCodeAt(i + 1) !== 0x3e) throw broken();
        i += 2;
        empty = true;
        break;
      }
      const nameAt = i;
      while (i < end && !endsName(xml.charCodeAt(i))) i++;
      const attr = xml.slice(nameAt, i);
      while (i < end && isSpace(xml.charCodeAt(i))) i++;
      if (!attr || xml.charCodeAt(i) !== 0x3d /* = */) throw broken();
      i++;
      while (i < end && isSpace(xml.charCodeAt(i))) i++;
      const quote = xml[i];
      if (quote !== '"' && quote !== "'") throw broken();
      const close = xml.indexOf(quote, i + 1);
      if (close === -1) throw broken();
      if (attr !== "xmlns" && !attr.startsWith("xmlns:")) attrs[localName(attr)] = decodeEntities(xml.slice(i + 1, close));
      i = close + 1;
    }
    reader.open(name, attrs);
    if (empty) reader.close(name);
    else depth++;
    at = i;
  }
  if (depth !== 0) throw broken();
}

// XML reads a line break written as CR LF, or a lone CR, as LF. (A real
// CR is written &#13; or, by Excel, _x000D_, and survives.)
function lineEnds(text: string) {
  return text.indexOf("\r") === -1 ? text : text.replace(/\r\n?/g, "\n");
}

// The five named entities and numeric ones (&#233; &#xE9;). Anything else
// is left as written.
function decodeEntities(text: string): string {
  if (text.indexOf("&") === -1) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
    }
    switch (name) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return whole;
    }
  });
}

// Excel writes characters XML can't hold (a carriage return, other control
// characters) as _xHHHH_ in text, and a real "_x" that happens to look like
// one with its underscore as _x005F_. One pass left to right undoes both.
function decodeEscapes(text: string): string {
  if (text.indexOf("_x") === -1) return text;
  return text.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// ---------------------------------------------------------------------------
// The workbook's parts

type Relationship = { type: string; target: string };

// A part's relationships live beside it, in _rels/<name>.rels; the
// package's own are in _rels/.rels. Targets are relative to the part's
// folder unless they start with "/".
async function readRelationships(zip: Zip, part: string): Promise<Map<string, Relationship>> {
  const folder = part.slice(0, part.lastIndexOf("/") + 1);
  const name = `${folder}_rels/${part.slice(folder.length)}.rels`;
  const rels = new Map<string, Relationship>();
  const xml = await readOptionalPart(zip, name);
  if (xml === null) return rels;
  parseXml(xml, name, {
    wantText: false,
    open(element, attrs) {
      if (element !== "Relationship" || !attrs.Id || !attrs.Target || attrs.TargetMode === "External") return;
      rels.set(attrs.Id, { type: attrs.Type ?? "", target: resolveTarget(folder, attrs.Target) });
    },
    close() {},
    text() {},
  });
  return rels;
}

function resolveTarget(folder: string, target: string) {
  const path = target.replace(/\\/g, "/");
  const segments: string[] = [];
  for (const segment of (path.startsWith("/") ? path : folder + path).split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  return segments.join("/");
}

// Which day serial dates count from; see serialText.
type DateSystem = "1900" | "1904" | "1899-12-30";

type Workbook = { dates: DateSystem; sheets: { name: string; id: string; state: string }[] };

function readWorkbook(xml: string, part: string): Workbook {
  const book: Workbook = { dates: "1900", sheets: [] };
  let root = "";
  let inSheets = false;
  parseXml(xml, part, {
    wantText: false,
    open(name, attrs) {
      if (!root) root = name;
      if (name === "workbookPr") {
        const flag = (value = "") => value.trim().toLowerCase();
        // LibreOffice writes dateCompatibility="false": its 1900 dates count
        // from 1899-12-30 straight through, without Lotus's leap day.
        if (["1", "true"].includes(flag(attrs.date1904))) book.dates = "1904";
        else if (["0", "false"].includes(flag(attrs.dateCompatibility))) book.dates = "1899-12-30";
      } else if (name === "sheets") {
        inSheets = true;
      } else if (name === "sheet" && inSheets) {
        book.sheets.push({ name: attrs.name ?? "", id: attrs.id ?? "", state: (attrs.state ?? "visible").toLowerCase() });
      }
    },
    close(name) {
      if (name === "sheets") inSheets = false;
    },
    text() {},
  });
  // A Word document or a slide deck is the same kind of package with a
  // different part in the workbook's place.
  if (root === "document") throw notWorkbook("a Word document");
  if (root === "presentation") throw notWorkbook("a PowerPoint presentation");
  if (root !== "workbook") throw new XlsxError(NOT_WORKBOOK);
  return book;
}

// The text of each shared string: a plain <t>, or rich text whose runs
// (<r><t>) are joined. Phonetic guides (<rPh>, the small kana Japanese
// workbooks put over names) aren't part of the text.
function readSharedStrings(xml: string | null, part: string, max: number): string[] {
  const strings: string[] = [];
  if (xml === null) return strings;
  let inItem = false;
  let phonetic = 0;
  let item = "";
  let text = "";
  const reader: XmlReader = {
    wantText: false,
    open(name) {
      if (name === "si") {
        inItem = true;
        phonetic = 0;
        item = "";
      } else if (name === "rPh" && inItem) {
        phonetic++;
      } else if (name === "t" && inItem && phonetic === 0) {
        reader.wantText = true;
        text = "";
      }
    },
    close(name) {
      if (name === "t" && reader.wantText) {
        item += text;
        reader.wantText = false;
      } else if (name === "rPh" && inItem) {
        phonetic--;
      } else if (name === "si" && inItem) {
        inItem = false;
        // Every shared string is meant for at least one cell, so more of
        // them than cells allowed is a file built to use up memory.
        if (strings.push(decodeEscapes(item)) > max) throw tooManyCells(max);
      }
    },
    text(chunk) {
      text += chunk;
    },
  };
  parseXml(xml, part, reader);
  return strings;
}

// How a number formatted as a date or time is shown: the date part, the
// time part (with or without seconds), or both. `elapsed` is a duration
// such as [h]:mm, whose hours keep counting past 24.
type DateFormat = { date: boolean; time: boolean; seconds: boolean; elapsed: boolean };

const DATE: DateFormat = { date: true, time: false, seconds: false, elapsed: false };
const DATE_TIME: DateFormat = { date: true, time: true, seconds: false, elapsed: false };
const TIME: DateFormat = { date: false, time: true, seconds: false, elapsed: false };
const TIME_SECONDS: DateFormat = { date: false, time: true, seconds: true, elapsed: false };

// Excel's built-in date and time formats, by number. 27-36 and 50-58 differ
// from one language's Excel to another; they're dates, apart from the two
// that every language shows as a time.
function builtInDateFormat(id: number): DateFormat | null {
  if ((id >= 14 && id <= 17) || (id >= 27 && id <= 31) || (id >= 34 && id <= 36) || (id >= 50 && id <= 58)) return DATE;
  if (id === 18 || id === 20 || id === 32) return TIME;
  if (id === 19 || id === 21 || id === 33 || id === 45 || id === 47) return TIME_SECONDS;
  if (id === 22) return DATE_TIME;
  if (id === 46) return { date: false, time: true, seconds: true, elapsed: true };
  return null;
}

// Whether a format code such as "dd/mm/yyyy h:mm" shows a date. Its letters
// d, m, y, h and s count, but not inside quotes, after a backslash, after
// _ or * (which take the next character as padding), or in [brackets]
// (colours, locales, conditions), apart from durations like [h]. An m is
// minutes when it follows an h or comes before an s, and months otherwise.
function dateFormatOf(code: string): DateFormat | null {
  const letters: string[] = [];
  let ampm = false;
  let elapsed = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') {
      const close = code.indexOf('"', i + 1);
      if (close === -1) break;
      i = close;
    } else if (c === "\\" || c === "_" || c === "*") {
      i++;
    } else if (c === "[") {
      const close = code.indexOf("]", i + 1);
      if (close === -1) break;
      const inside = code.slice(i + 1, close).toLowerCase();
      if (/^(h+|m+|s+)$/.test(inside)) {
        letters.push(inside[0]);
        elapsed = true;
      }
      i = close;
    } else if (/^(am\/pm|a\/p)/i.test(code.slice(i, i + 5))) {
      ampm = true;
      i += code[i + 1] === "/" ? 2 : 4;
    } else {
      const letter = c.toLowerCase();
      if ("dmyhs".includes(letter)) {
        letters.push(letter);
        while (code[i + 1]?.toLowerCase() === letter) i++;
      }
    }
  }
  let date = false;
  let time = ampm;
  let seconds = false;
  letters.forEach((letter, i) => {
    if (letter === "d" || letter === "y") date = true;
    else if (letter === "h") time = true;
    else if (letter === "s") time = seconds = true;
    else if (letters[i - 1] === "h" || letters[i + 1] === "s") time = true;
    else date = true;
  });
  if (!date && !time) return null;
  return { date, time, seconds, elapsed: elapsed && !date };
}

// The date format, if any, for each cell style (a cell's s attribute is an
// index into cellXfs).
function readStyles(xml: string | null, part: string): (DateFormat | null)[] {
  if (xml === null) return [];
  const codes = new Map<number, string>();
  const styleFormats: number[] = [];
  let inFormats = false;
  let inCellStyles = false;
  parseXml(xml, part, {
    wantText: false,
    open(name, attrs) {
      if (name === "numFmts") inFormats = true;
      else if (name === "cellXfs") inCellStyles = true;
      else if (name === "numFmt" && inFormats) codes.set(Number(attrs.numFmtId), attrs.formatCode ?? "");
      else if (name === "xf" && inCellStyles) styleFormats.push(Number(attrs.numFmtId ?? 0));
    },
    close(name) {
      if (name === "numFmts") inFormats = false;
      else if (name === "cellXfs") inCellStyles = false;
    },
    text() {},
  });
  // A format the file spells out wins, even over a built-in number.
  const formatOf = (id: number) => {
    const code = codes.get(id);
    return code === undefined ? builtInDateFormat(id) : dateFormatOf(code);
  };
  return styleFormats.map(formatOf);
}

// ---------------------------------------------------------------------------
// Sheets

// Excel's grid: no real file has a cell beyond it, and checking stops a
// made-up reference like ZZZZZ99999999 from padding a row out forever.
const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;

type SheetContext = {
  strings: string[];
  formats: (DateFormat | null)[];
  dates: DateSystem;
  counter: { cells: number; max: number };
};

function readSheet(xml: string, part: string, sheetName: string, context: SheetContext): string[][] {
  const { counter } = context;
  const count = () => {
    if (++counter.cells > counter.max) throw tooManyCells(counter.max);
  };
  const outside = () => damaged(`sheet "${sheetName}" has a cell outside Excel's grid`);

  const rows: string[][] = [];
  let inData = false;
  let row = -1; // 0-based, the row being read
  let column = -1; // 0-based, the cell last read in it
  // The cell being read.
  let inCell = false;
  let type = "";
  let style = 0;
  let value: string | null = null;
  let inline: string | null = null;
  let phonetic = 0;
  // Which element's text is being collected: a value <v>, or a <t> of an
  // inline string.
  let reading: "" | "v" | "t" = "";
  let text = "";

  const reader: XmlReader = {
    wantText: false,
    open(name, attrs) {
      if (name === "sheetData") {
        inData = true;
      } else if (!inData) {
        return;
      } else if (name === "row") {
        // Rows say which they are ("5"); one that doesn't follows the last.
        const r = Number(attrs.r);
        row = r >= 1 ? r - 1 : row + 1;
        if (row >= MAX_ROWS || row !== Math.floor(row)) throw outside();
        column = -1;
      } else if (name === "c") {
        count();
        inCell = true;
        type = attrs.t ?? "n";
        style = Number(attrs.s ?? 0);
        value = null;
        inline = null;
        // A cell's reference ("C5") gives its column and row; one without
        // follows the last cell.
        const ref = attrs.r ?? "";
        let i = 0;
        let letters = 0;
        for (; i < ref.length; i++) {
          const c = ref.charCodeAt(i) | 0x20;
          if (c < 0x61 || c > 0x7a) break;
          letters = letters * 26 + c - 0x60;
          if (letters > MAX_COLUMNS) throw outside();
        }
        column = letters > 0 ? letters - 1 : column + 1;
        const digits = ref.slice(i);
        if (digits) {
          const r = Number(digits);
          if (!(r >= 1 && r <= MAX_ROWS) || r !== Math.floor(r)) throw outside();
          row = r - 1;
        }
        if (row < 0) row = 0;
        if (column >= MAX_COLUMNS) throw outside();
      } else if (!inCell) {
        return;
      } else if (name === "v" || (name === "t" && inline !== null && phonetic === 0)) {
        reading = name;
        reader.wantText = true;
        text = "";
      } else if (name === "is") {
        inline = "";
        phonetic = 0;
      } else if (name === "rPh" && inline !== null) {
        phonetic++;
      }
    },
    close(name) {
      if (name === "sheetData") {
        inData = false;
      } else if (!inCell) {
        return;
      } else if (name === reading) {
        if (reading === "v") value = text;
        else inline = (inline ?? "") + text;
        reading = "";
        reader.wantText = false;
      } else if (name === "rPh" && inline !== null) {
        phonetic--;
      } else if (name === "c") {
        inCell = false;
        reading = "";
        reader.wantText = false;
        const shown = cellText(type, value, inline, context.formats[style] ?? null, context);
        if (shown === "") return;
        // Pad with blank rows and cells up to this one.
        while (rows.length <= row) {
          if (rows.length < row) count();
          rows.push([]);
        }
        const cells = rows[row];
        while (cells.length < column) {
          count();
          cells.push("");
        }
        cells[column] = shown;
      }
    },
    text(chunk) {
      text += chunk;
    },
  };
  parseXml(xml, part, reader);
  return rows;
}

// What Excel shows for a cell, from its type (t), the text of its <v> and
// of its <is> (an inline string), and its style's date format.
function cellText(type: string, value: string | null, inline: string | null, format: DateFormat | null, context: SheetContext) {
  switch (type) {
    case "s":
      return context.strings[value === null ? -1 : parseInt(value, 10)] ?? "";
    case "inlineStr":
      return decodeEscapes(inline ?? value ?? "");
    case "str":
      return decodeEscapes(value ?? "");
    case "b":
      return value === null ? "" : value.trim() === "1" ? "TRUE" : value.trim() === "0" ? "FALSE" : value;
    case "e":
      return value ?? "";
    case "d":
      return value === null ? "" : isoDateText(value.trim(), format);
  }
  // A number ("n", or no t at all). A formula that was never calculated has
  // no value, so it's blank.
  const written = (value ?? "").trim();
  if (written === "") return "";
  const number = Number(written);
  if (!isFinite(number)) return written;
  if (format) {
    const shown = serialText(number, format, context.dates);
    if (shown !== null) return shown;
  }
  return numberText(number);
}

// Excel keeps 15 significant digits, so 0.1 + 0.2 shows as 0.3 and a total
// stored as 2.0000000000000004 shows as 2: round the same way, then write
// the shortest text for it. Whole numbers come out in full (8145550199, not
// 8.15E+09), and so do small fractions (0.0000015, not 1.5e-6).
function numberText(number: number): string {
  const rounded = Number(number.toPrecision(15));
  const text = String(rounded);
  const e = text.indexOf("e-");
  if (e === -1) return text;
  const fraction = text.slice(0, e).split(".")[1] ?? "";
  return rounded.toFixed(Math.min(100, Number(text.slice(e + 2)) + fraction.length));
}

const DAY_MS = 86_400_000;

function two(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

// "HH:MM" or "HH:MM:SS" for a number of seconds.
function clockText(seconds: number, withSeconds: boolean) {
  const clock = `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}`;
  return withSeconds ? `${clock}:${two(seconds % 60)}` : clock;
}

// "YYYY-MM-DD" for a time in milliseconds, or null past the year 9999.
function dayText(ms: number) {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  if (!(year >= 1000 && year <= 9999)) return null;
  return `${year}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

// A date in Excel is a number of days: in the 1900 system day 1 is 1900-01-01,
// and day 60 is 1900-02-29, a day that never was (Lotus 1-2-3 thought 1900
// was a leap year, and Excel kept it so old sheets would still add up). Macs
// once used the 1904 system, where day 0 is 1904-01-01. The fraction is the
// time of day, rounded here to the nearest second. Null for a number no date
// format can show (a negative one, which Excel shows as ####, or past 9999).
function serialText(serial: number, format: DateFormat, dates: DateSystem): string | null {
  if (serial < 0 && (dates !== "1899-12-30" || !format.date)) return null;
  const total = Math.round(serial * 86400);
  const days = Math.floor(total / 86400);
  const seconds = total - days * 86400;
  if (!format.date) return clockText(format.elapsed ? total : seconds, format.seconds);
  let day: string | null;
  if (dates === "1904") day = dayText(Date.UTC(1904, 0, 1) + days * DAY_MS);
  else if (dates === "1899-12-30") day = dayText(Date.UTC(1899, 11, 30) + days * DAY_MS);
  else if (days === 0) day = "1900-01-00"; // what Excel shows for day 0
  else if (days === 60) day = "1900-02-29";
  else day = dayText(Date.UTC(1899, 11, days < 60 ? 31 : 30) + days * DAY_MS);
  if (day === null) return null;
  return format.time ? `${day} ${clockText(seconds, format.seconds)}` : day;
}

// A date cell (t="d") holds an ISO 8601 date, maybe with a time, or just a
// time. It's shown the way its style says, or else as the date, with the
// time only when there is one. A time zone, if written, is left out: the
// clock time is what was typed.
function isoDateText(value: string, format: DateFormat | null): string {
  const time = /^T?(\d\d):(\d\d)(?::(\d\d(?:\.\d+)?))?$/.exec(value);
  if (time) {
    const clock = Math.round(Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3] ?? 0));
    return clock < 86400 ? clockText(clock, format ? format.seconds : clock % 60 !== 0) : value;
  }
  const match = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d(?:\.\d+)?))?)?(?:Z|[+-]\d\d:?\d\d)?$/.exec(value);
  if (!match) return value;
  const [year, month, day, hours = 0, minutes = 0, seconds = 0] = match.slice(1).map((part) => Number(part ?? 0));
  const midnight = Date.UTC(year, month - 1, day);
  if (dayText(midnight) !== value.slice(0, 10)) return value; // 2024-02-31 and the like
  const ms = midnight + Math.round(hours * 3600 + minutes * 60 + seconds) * 1000;
  const date = dayText(ms);
  if (date === null) return value;
  const clock = Math.round((ms - Math.floor(ms / DAY_MS) * DAY_MS) / 1000);
  const shown = format ?? (clock === 0 ? DATE : { ...DATE_TIME, seconds: clock % 60 !== 0 });
  if (!shown.date) return clockText(clock, shown.seconds);
  return shown.time ? `${date} ${clockText(clock, shown.seconds)}` : date;
}
