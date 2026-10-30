// Reading Excel workbooks for the customer import (src/lib/xlsx.ts): files
// openpyxl and LibreOffice wrote (tests/fixtures/xlsx, rebuilt by its
// make-fixtures.py), and workbooks put together here, byte by byte, for what
// those two never write: other writers' habits, damaged files and files
// built to do harm.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, test } from "node:test";
import { crc32, deflateRawSync, constants as zlib } from "node:zlib";

import { XLSX_LIMITS, XlsxError, isZip, readXlsx, type XlsxSheet } from "../src/lib/xlsx";

function fixture(name: string) {
  return readFileSync(new URL(`./fixtures/xlsx/${name}`, import.meta.url));
}

// ---------------------------------------------------------------------------
// A small zip writer

type ZipFile = {
  name: string;
  data: string | Uint8Array;
  // Stored as it is rather than deflated.
  store?: boolean;
  // Already-deflated bytes to use instead of deflating `data`.
  packed?: Uint8Array;
  // What the zip's directory claims, when it should lie.
  size?: number;
  compressedSize?: number;
  flags?: number;
  method?: number;
};

type ZipOptions = {
  // Sizes and checksum after the data instead of before it, as a writer
  // that streams does.
  descriptors?: boolean;
  comment?: string;
  // Change the end record before it's written.
  end?: (record: Buffer) => void;
};

function makeZip(files: ZipFile[], options: ZipOptions = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = typeof file.data === "string" ? Buffer.from(file.data, "utf8") : Buffer.from(file.data);
    const packed = file.packed ? Buffer.from(file.packed) : file.store ? raw : deflateRawSync(raw);
    const method = file.method ?? (file.store ? 0 : 8);
    const flags = (file.flags ?? 0) | (options.descriptors ? 8 : 0) | 0x800;
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(raw);
    const size = file.size ?? raw.length;
    const compressedSize = file.compressedSize ?? packed.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!options.descriptors) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressedSize, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const parts = [local, name, packed];
    if (options.descriptors) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(packed.length, 8);
      descriptor.writeUInt32LE(raw.length, 12);
      parts.push(descriptor);
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    const entry = Buffer.concat(parts);
    locals.push(entry);
    offset += entry.length;
  }
  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? "", "utf8");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  options.end?.(end);
  return new Uint8Array(Buffer.concat([...locals, directory, end, comment]));
}

// ---------------------------------------------------------------------------
// Workbooks put together here

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";

type SheetSpec = {
  name: string;
  // The rows inside <sheetData>, or with `xml` the whole part.
  rows?: string;
  xml?: string;
  state?: string;
  // Where the relationship points, relative to xl/ (or absolute).
  target?: string;
  // The relationship type's last word.
  type?: string;
  // Leave the part out of the zip.
  missing?: boolean;
};

type BookSpec = {
  sheets: SheetSpec[];
  strings?: string; // the inside of <sst>
  styles?: string; // the whole part
  workbookPr?: string; // attributes
  store?: boolean;
};

function sheetPart(rows: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN}" xmlns:r="${RELS}"><sheetData>${rows}</sheetData></worksheet>`;
}

function bookFiles(spec: BookSpec): ZipFile[] {
  const files: ZipFile[] = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
  ];
  const sheets = spec.sheets
    .map((sheet, i) => `<sheet name="${sheet.name}" sheetId="${i + 1}"${sheet.state ? ` state="${sheet.state}"` : ""} r:id="rId${i + 1}"/>`)
    .join("");
  files.push({
    name: "xl/workbook.xml",
    data: `<?xml version="1.0"?><workbook xmlns="${MAIN}" xmlns:r="${RELS}"><workbookPr ${spec.workbookPr ?? ""}/><sheets>${sheets}</sheets></workbook>`,
  });
  const rels = spec.sheets.map(
    (sheet, i) =>
      `<Relationship Id="rId${i + 1}" Type="${RELS}/${sheet.type ?? "worksheet"}" Target="${sheet.target ?? `worksheets/sheet${i + 1}.xml`}"/>`,
  );
  if (spec.strings !== undefined) {
    rels.push(`<Relationship Id="rIdS" Type="${RELS}/sharedStrings" Target="sharedStrings.xml"/>`);
    files.push({ name: "xl/sharedStrings.xml", data: `<sst xmlns="${MAIN}">${spec.strings}</sst>` });
  }
  if (spec.styles !== undefined) {
    rels.push(`<Relationship Id="rIdT" Type="${RELS}/styles" Target="styles.xml"/>`);
    files.push({ name: "xl/styles.xml", data: spec.styles });
  }
  files.push({ name: "xl/_rels/workbook.xml.rels", data: `<Relationships xmlns="${PACKAGE_RELS}">${rels.join("")}</Relationships>` });
  spec.sheets.forEach((sheet, i) => {
    if (sheet.missing) return;
    const target = sheet.target ?? `worksheets/sheet${i + 1}.xml`;
    files.push({ name: posix.normalize(target.startsWith("/") ? target.slice(1) : `xl/${target}`), data: sheet.xml ?? sheetPart(sheet.rows ?? "") });
  });
  return files.map((file) => ({ ...file, store: spec.store }));
}

function book(spec: BookSpec, options?: ZipOptions) {
  return makeZip(bookFiles(spec), options);
}

// The rows of a one-sheet workbook.
async function rowsOf(rows: string, spec: Omit<BookSpec, "sheets"> = {}) {
  const sheets = await readXlsx(book({ ...spec, sheets: [{ name: "Sheet1", rows }] }));
  assert.equal(sheets.length, 1);
  return sheets[0].rows;
}

// The text of one number cell shown in a style with this number format
// (a built-in number, or a format code).
async function shown(value: string, format: number | string, workbookPr = "") {
  const id = typeof format === "number" ? format : 164;
  const formats = typeof format === "string" ? `<numFmts><numFmt numFmtId="164" formatCode="${escapeXml(format)}"/></numFmts>` : "";
  const styles = `<styleSheet xmlns="${MAIN}">${formats}<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="${id}"/></cellXfs></styleSheet>`;
  const rows = await rowsOf(`<row r="1"><c r="A1" s="1"><v>${value}</v></c></row>`, { styles, workbookPr });
  return rows[0]?.[0] ?? "";
}

function escapeXml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

async function refusal(bytes: Uint8Array, limits?: Partial<typeof XLSX_LIMITS>): Promise<XlsxError> {
  try {
    await readXlsx(bytes, limits);
  } catch (error) {
    assert.ok(error instanceof XlsxError, `expected an XlsxError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the workbook to be refused");
}

// ---------------------------------------------------------------------------

describe("workbooks other programs wrote", () => {
  test("openpyxl: inline strings, dates, a blank row, and the hidden sheets left out", async () => {
    const sheets = await readXlsx(fixture("customers-openpyxl.xlsx"));
    const expected: XlsxSheet[] = [
      {
        name: "Customers",
        rows: [
          ["First name", "Last name", "Phone", "Email", "Customer since", "Last visit", "Callback", "Balance", "Tax exempt", "Notes"],
          [
            "Dana",
            "O'Brien",
            "8145550199",
            "dana@example.com",
            "2019-03-05",
            "2024-06-01 09:15:00",
            "13:45:00",
            "1.5",
            "FALSE",
            "Rides a RZR & a Sportsman <2 seats>",
          ],
          // 0.1 + 0.2 is stored as 0.30000000000000004; Excel shows 0.3.
          ["Zoë", "Müller", "(814) 555-0123", "zoe@example.com", "2023-11-20", "2024-06-02 16:05:30", "", "0.3", "TRUE", "Gate code 1234\nCall first"],
          [],
          // openpyxl can't calculate =H2+H3, so it has no value.
          ["Lee", "", "01234", "", "", "", "", "", "", "  spaces kept  "],
          // The bold empty cell in row 8 isn't a row.
        ],
      },
      // "Old customers" is hidden and "Lists" very hidden.
      { name: "Notes", rows: [["Imported from the old DMS", "42"], ["Share", "0.25"]] },
    ];
    assert.deepEqual(sheets, expected);
  });

  test("openpyxl: dates counted from 1904", async () => {
    assert.deepEqual(await readXlsx(fixture("dates-1904-openpyxl.xlsx")), [
      { name: "Dates", rows: [["2019-03-05", "2024-06-01 09:15:00", "1904-01-01", "06:30:00"]] },
    ]);
  });

  test("openpyxl: dates written as ISO text (t=\"d\")", async () => {
    assert.deepEqual(await readXlsx(fixture("iso-dates-openpyxl.xlsx")), [
      { name: "Dates", rows: [["2019-03-05", "2023-11-20 14:30:15", "13:45:00"]] },
    ]);
  });

  test("LibreOffice: shared strings, calculated formulas, an error, booleans and a hidden sheet", async () => {
    assert.deepEqual(await readXlsx(fixture("customers-libreoffice.xlsx")), [
      {
        name: "Customers",
        rows: [
          ["First name", "Last name", "Phone", "Customer since", "Last visit", "Callback", "Balance", "Tax exempt", "Notes"],
          ["Dana", "O'Brien", "8145550199", "2019-03-05", "2024-06-01 09:15", "13:45", "1.5", "FALSE", "Rides a RZR & a Sportsman <2 seats>"],
          ["Zoë", "Müller", "(814) 555-0123", "2023-11-20", "", "", "0.3", "TRUE", "Gate code 1234\nCall first"],
          [],
          ["Lee", "", "01234", "", "", "", "1.8", "#DIV/0!", "VIP Dana"],
          [" Sam  "],
        ],
      },
      // "Archive" is hidden.
      { name: "Vehicles", rows: [["VIN", "Year", "Model"], ["4XASEE57XPA123456", "2023", "Sportsman 570"]] },
    ]);
  });

  test("a spreadsheet saved as .ods, or a Word document, isn't an Excel workbook", async () => {
    const ods = await refusal(fixture("customers-libreoffice.ods"));
    assert.match(ods.message, /isn't an Excel workbook.*OpenDocument/);
    const docx = await refusal(fixture("letter-libreoffice.docx"));
    assert.match(docx.message, /isn't an Excel workbook.*Word document/);
  });

  test("bytes from the middle of a larger buffer read the same", async () => {
    const file = fixture("customers-libreoffice.xlsx");
    const padded = Buffer.concat([Buffer.from("junk before"), file, Buffer.from("junk after")]);
    const view = padded.subarray(11, 11 + file.length);
    assert.deepEqual(await readXlsx(view), await readXlsx(new Uint8Array(file)));
  });
});

describe("isZip", () => {
  test("true for a zip's first bytes, false for anything else", () => {
    assert.equal(isZip(fixture("customers-openpyxl.xlsx")), true);
    assert.equal(isZip(new Uint8Array([0x50, 0x4b, 3, 4])), true);
    assert.equal(isZip(new TextEncoder().encode("First name,Last name\nDana,O'Brien\n")), false);
    assert.equal(isZip(new Uint8Array([0x50, 0x4b, 3])), false);
    assert.equal(isZip(new Uint8Array([0x50, 0x4b, 5, 6])), false);
    assert.equal(isZip(new Uint8Array(0)), false);
  });
});

describe("the zip", () => {
  const spec: BookSpec = {
    sheets: [{ name: "Customers", rows: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>` }],
    strings: `<si><t>Dana</t></si>`,
  };
  const expected = [{ name: "Customers", rows: [["Dana", "42"]] }];

  test("stored and deflated parts read the same", async () => {
    assert.deepEqual(await readXlsx(book(spec)), expected);
    assert.deepEqual(await readXlsx(book({ ...spec, store: true })), expected);
  });

  test("sizes written after the data, and a comment after the directory", async () => {
    assert.deepEqual(await readXlsx(book(spec, { descriptors: true })), expected);
    assert.deepEqual(await readXlsx(book(spec, { comment: "Exported by DealerSoft PK\u0005\u0006 v2" })), expected);
  });

  test("part names match whatever their case and %-escapes", async () => {
    const files = bookFiles({ ...spec, sheets: [{ ...spec.sheets[0], target: "worksheets/Sheet%201.xml" }] }).map((file) =>
      file.name === "xl/worksheets/Sheet%201.xml" ? { ...file, name: "XL/Worksheets/SHEET 1.xml" } : file,
    );
    assert.ok(files.some((file) => file.name === "XL/Worksheets/SHEET 1.xml"));
    assert.deepEqual(await readXlsx(makeZip(files)), expected);
  });

  test("something that isn't a zip isn't a workbook", async () => {
    const csv = await refusal(new TextEncoder().encode("First name,Last name\nDana,O'Brien\n"));
    assert.match(csv.message, /^This file isn't an Excel workbook\./);
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    assert.match((await refusal(ole)).message, /older Excel file \(\.xls\) or a password-protected workbook/);
    await refusal(new Uint8Array(0));
  });

  test("a file cut short anywhere is refused, never a crash", async () => {
    const whole = fixture("customers-libreoffice.xlsx");
    for (let length = 0; length < whole.length; length += 61) {
      const error = await refusal(whole.subarray(0, length));
      assert.match(error.message, /damaged|isn't an Excel workbook/);
    }
    const ours = book(spec);
    for (let length = 4; length < ours.length; length++) await refusal(ours.subarray(0, length));
  });

  test("bytes changed here and there: read or refused, never a crash", async () => {
    const whole = new Uint8Array(fixture("customers-libreoffice.xlsx"));
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 300; round++) {
      const bytes = whole.slice();
      for (let n = 0; n < 1 + round % 4; n++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      try {
        await readXlsx(bytes);
      } catch (error) {
        assert.ok(error instanceof XlsxError, `round ${round}: ${String(error)}`);
      }
    }
  });

  test("ZIP64, for zips too big for the usual sizes, is refused", async () => {
    const tooMany = await refusal(book(spec, { end: (record) => record.writeUInt16LE(0xffff, 10) }));
    assert.match(tooMany.message, /ZIP64/);
    const files = bookFiles(spec).map((file) => (file.name === "xl/worksheets/sheet1.xml" ? { ...file, size: 0xffffffff } : file));
    assert.match((await refusal(makeZip(files))).message, /ZIP64/);
  });

  test("encrypted parts and unknown compression are refused", async () => {
    const encrypted = bookFiles(spec).map((file) => (file.name === "xl/workbook.xml" ? { ...file, flags: 1 } : file));
    assert.match((await refusal(makeZip(encrypted))).message, /password-protected/);
    const bzip2 = bookFiles(spec).map((file) => (file.name === "xl/workbook.xml" ? { ...file, method: 12 } : file));
    assert.match((await refusal(makeZip(bzip2))).message, /compressed in a way/);
    // A workbook split over several zip files.
    assert.match((await refusal(book(spec, { end: (record) => record.writeUInt16LE(1, 4) }))).message, /split across several files/);
  });

  test("data that isn't deflate is refused", async () => {
    const garbage = bookFiles(spec).map((file) =>
      file.name === "xl/worksheets/sheet1.xml" ? { ...file, packed: new Uint8Array([0xff, 0xff, 0xff, 0xff, 1, 2, 3]) } : file,
    );
    assert.match((await refusal(makeZip(garbage))).message, /damaged/);
    // Deflate data that stops part way: the directory says it's shorter.
    const cut = bookFiles(spec).map((file) => {
      if (file.name !== "xl/worksheets/sheet1.xml") return file;
      return { ...file, compressedSize: deflateRawSync(Buffer.from(file.data)).length - 8 };
    });
    assert.match((await refusal(makeZip(cut))).message, /damaged/);
    // Stored data whose sizes disagree.
    const stored = bookFiles({ ...spec, store: true }).map((file) => (file.name === "xl/workbook.xml" ? { ...file, size: 10 } : file));
    assert.match((await refusal(makeZip(stored))).message, /damaged/);
  });

  // 1 GB of zeros in about 1 MB: 16 MB deflated (a full flush ends it on a
  // byte, so copies can follow one another), 64 times, then a last, empty
  // block.
  const chunk = deflateRawSync(Buffer.alloc(16 << 20), { finishFlush: zlib.Z_FULL_FLUSH });
  const bomb = Buffer.concat([...Array(64).fill(chunk), Buffer.from([3, 0])]);
  const bombBook = (size: number) =>
    makeZip(
      bookFiles(spec).map((file) => (file.name === "xl/worksheets/sheet1.xml" ? { ...file, packed: bomb, size } : file)),
    );

  test("a part claiming to unpack to more than the limit is refused before unpacking", async () => {
    const started = Date.now();
    const error = await refusal(bombBook(1 << 30));
    assert.match(error.message, /too big to import.*more than 64 MB/);
    assert.ok(Date.now() - started < 1000);
    // A smaller limit, for a part that isn't a bomb at all.
    const big = bookFiles(spec).map((file) => (file.name === "xl/sharedStrings.xml" ? { ...file, data: file.data + " ".repeat(5000) } : file));
    assert.match((await refusal(makeZip(big), { maxEntryBytes: 4096 })).message, /unpacks to more than 4 KB/);
  });

  test("a part that unpacks to more than it claims is stopped as soon as it passes the claim", async () => {
    const started = Date.now();
    const used = process.memoryUsage().rss;
    assert.match((await refusal(bombBook(1000))).message, /damaged/);
    assert.match((await refusal(bombBook(XLSX_LIMITS.maxEntryBytes))).message, /damaged/);
    // Unpacking all of it would take seconds and a gigabyte.
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
    assert.ok(process.memoryUsage().rss - used < 512 << 20);
  });
});

describe("finding the sheets", () => {
  const rows = (text: string) => `<row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row>`;

  test("in the workbook's order, leaving out hidden sheets, chart sheets and dialog sheets", async () => {
    const sheets = await readXlsx(
      book({
        sheets: [
          { name: "Second file, first tab", rows: rows("one"), target: "worksheets/sheet20.xml" },
          { name: "Hidden", rows: rows("no"), state: "hidden" },
          { name: "Very hidden", rows: rows("no"), state: "veryHidden" },
          { name: "Chart", xml: `<chartsheet xmlns="${MAIN}"/>`, type: "chartsheet", target: "chartsheets/sheet1.xml" },
          { name: "Dialog", xml: `<dialogsheet xmlns="${MAIN}"/>`, type: "dialogsheet", target: "dialogsheets/sheet1.xml" },
          { name: "Absolute", rows: rows("two"), target: "/xl/worksheets/absolute.xml" },
          { name: "Up and over", rows: rows("three"), target: "../xl/./worksheets/other.xml" },
          { name: "Visible", rows: rows("four"), state: "visible" },
          { name: "Empty", rows: "" },
        ],
      }),
    );
    assert.deepEqual(sheets, [
      { name: "Second file, first tab", rows: [["one"]] },
      { name: "Absolute", rows: [["two"]] },
      { name: "Up and over", rows: [["three"]] },
      { name: "Visible", rows: [["four"]] },
      { name: "Empty", rows: [] },
    ]);
  });

  test("the workbook part is wherever the package's relationships say", async () => {
    const files = makeZip([
      {
        name: "_rels/.rels",
        data: `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="a" Type="${RELS}/extended-properties" Target="docProps/app.xml"/><Relationship Target="/book/main.xml" Type="${RELS}/officeDocument" Id="b"/></Relationships>`,
      },
      {
        name: "book/main.xml",
        data: `<workbook xmlns="${MAIN}" xmlns:r="${RELS}"><sheets><sheet name="Only" sheetId="1" r:id="s"/></sheets></workbook>`,
      },
      { name: "book/_rels/main.xml.rels", data: `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="s" Type="${RELS}/worksheet" Target="data/one.xml"/></Relationships>` },
      { name: "book/data/one.xml", data: sheetPart(rows("found")) },
    ]);
    assert.deepEqual(await readXlsx(files), [{ name: "Only", rows: [["found"]] }]);
  });

  test("without the package's relationships, xl/workbook.xml; no shared strings or styles is fine", async () => {
    const files = bookFiles({ sheets: [{ name: "Plain", rows: `<row r="1"><c r="A1"><v>7</v></c></row>` }] }).filter(
      (file) => file.name !== "_rels/.rels",
    );
    assert.deepEqual(await readXlsx(makeZip(files)), [{ name: "Plain", rows: [["7"]] }]);
  });

  test("a zip with no workbook in it isn't a workbook", async () => {
    const error = await refusal(makeZip([{ name: "customers.csv", data: "First name\nDana\n" }]));
    assert.match(error.message, /^This file isn't an Excel workbook\./);
    const slides = makeZip([
      { name: "_rels/.rels", data: `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="a" Type="${RELS}/officeDocument" Target="ppt/presentation.xml"/></Relationships>` },
      { name: "ppt/presentation.xml", data: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>` },
    ]);
    assert.match((await refusal(slides)).message, /PowerPoint/);
    const binary = makeZip([
      { name: "_rels/.rels", data: `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="a" Type="${RELS}/officeDocument" Target="xl/workbook.bin"/></Relationships>` },
      { name: "xl/workbook.bin", data: new Uint8Array([0x83, 1, 0]) },
    ]);
    assert.match((await refusal(binary)).message, /binary workbook \(\.xlsb\)/);
  });

  test("a workbook part, sheet part or sheet relationship that's missing is refused", async () => {
    const noWorkbook = bookFiles({ sheets: [{ name: "A", rows: "" }] }).filter((file) => file.name !== "xl/workbook.xml");
    assert.match((await refusal(makeZip(noWorkbook))).message, /damaged: its workbook part \(xl\/workbook\.xml\) is missing/);

    const noSheet = await refusal(book({ sheets: [{ name: "Customers", rows: "" }, { name: "Gone", missing: true }] }));
    assert.match(noSheet.message, /damaged: sheet "Gone" is missing/);

    const noRelationship = bookFiles({ sheets: [{ name: "Unlinked", rows: "" }] }).map((file) =>
      file.name === "xl/_rels/workbook.xml.rels" ? { ...file, data: `<Relationships xmlns="${PACKAGE_RELS}"/>` } : file,
    );
    assert.match((await refusal(makeZip(noRelationship))).message, /sheet "Unlinked" is missing/);

    // A hidden sheet isn't read, so it doesn't matter that it's missing.
    assert.deepEqual(await readXlsx(book({ sheets: [{ name: "Gone", missing: true, state: "hidden" }] })), []);
  });
});

describe("the XML", () => {
  test("prefixed element names, as some writers use", async () => {
    const xml = `<x:worksheet xmlns:x="${MAIN}"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>1</x:v></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>inline</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`;
    const sheets = await readXlsx(
      book({ sheets: [{ name: "Prefixed", xml }], strings: `<x:si xmlns:x="${MAIN}"><x:t>zero</x:t></x:si><x:si xmlns:x="${MAIN}"><x:t>one</x:t></x:si>` }),
    );
    assert.deepEqual(sheets, [{ name: "Prefixed", rows: [["one", "inline"]] }]);
  });

  test("attributes in any order and either quote, comments, processing instructions, CDATA and a doctype", async () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<!DOCTYPE worksheet [ <!ENTITY boom "boom"> ]>
<!-- written by hand -->
<worksheet xmlns='${MAIN}'>
  <sheetData>
    <row spans = '1:2' r = '1' >
      <?some-tool keep this?>
      <c t='inlineStr' s='0' r='B1' ><is><t><![CDATA[<b>&amp; kept</b>]]></t></is></c>
      <!-- <c r="C1"><v>99</v></c> -->
      <c
        r="A1"><v>5</v></c>
    </row>
  </sheetData>
</worksheet>`;
    assert.deepEqual(await readXlsx(book({ sheets: [{ name: "Hand", xml }] })), [{ name: "Hand", rows: [["5", "<b>&amp; kept</b>"]] }]);
  });

  test("entities, numeric character references, and a namespace declaration that isn't the cell's r", async () => {
    const rows = `<row r="1"><c xmlns:r="${RELS}" r="A1" t="inlineStr"><is><t>&lt;&gt;&amp;&quot;&apos; caf&#233; caf&#xE9; &#x1F527; &nbsp; AT&amp;T</t></is></c></row>`;
    assert.deepEqual(await rowsOf(rows), [[`<>&"' café café 🔧 &nbsp; AT&T`]]);
  });

  test("Excel's _xHHHH_ escapes in text, and line breaks", async () => {
    const strings = `<si><t>a_x000D__x000A_b</t></si><si><t>_x005F_x000D_ is how Excel writes "_x000D_"</t></si><si><t>tab_x0009_here, not_x00_short</t></si>`;
    const rows =
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c>` +
      `<c r="D1" t="inlineStr"><is><t>in_x002D_line</t></is></c><c r="E1" t="str"><f>A1</f><v>form_x0021_</v></c>` +
      `<c r="F1" t="inlineStr"><is><t>two\r\nlines\rthree</t></is></c><c r="G1" t="inlineStr"><is><t>kept&#13;CR</t></is></c></row>`;
    assert.deepEqual(await rowsOf(rows, { strings }), [
      ["a\r\nb", `_x000D_ is how Excel writes "\r"`, "tab\there, not_x00_short", "in-line", "form!", "two\nlines\nthree", "kept\rCR"],
    ]);
  });

  test("XML that's broken is refused, naming the part", async () => {
    for (const rows of [
      `<row r="1"><c r="A1"><v>1</v></c>`, // never closed
      `<row r="1"><c r=A1><v>1</v></c></row>`,
      `<row r="1"><c r="A1><v>1</v></c></row>`,
      `<row r="1"><c r="A1" checked><v>1</v></c></row>`,
      `<row r="1"><!-- never closed </row>`,
      `<row r="1"><c r="A1"><v><![CDATA[1</v></c></row>`,
      `</row>`,
      `<row r="1"/><`,
      `< row/>`,
    ]) {
      const error = await refusal(book({ sheets: [{ name: "Broken", xml: `<worksheet xmlns="${MAIN}"><sheetData>${rows}</sheetData></worksheet>` }] }));
      assert.match(error.message, /damaged: xl\/worksheets\/sheet1\.xml can't be read/, rows);
    }
    const strings = await refusal(book({ sheets: [{ name: "A", rows: "" }], strings: `<si><t>open` }));
    assert.match(strings.message, /xl\/sharedStrings\.xml can't be read/);
  });
});

describe("cells", () => {
  test("shared strings: plain, rich text runs joined, phonetic guides left out", async () => {
    const strings =
      `<si><t>Dana</t></si>` +
      `<si><r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space="preserve"> and plain</t></r></si>` +
      `<si><r><t>山田</t></r><rPh sb="0" eb="2"><t>ヤマダ</t></rPh><phoneticPr fontId="1"/></si>` +
      `<si><t/></si><si/>`;
    const rows = `<row r="1">${[0, 1, 2, 3, 4, 5, 99].map((i, n) => `<c r="${"ABCDEFG"[n]}1" t="s"><v>${i}</v></c>`).join("")}<c r="H1" t="s"><v>1</v></c></row>`;
    assert.deepEqual(await rowsOf(rows, { strings }), [["Dana", "Bold and plain", "山田", "", "", "", "", "Bold and plain"]]);
  });

  test("inline strings, formula strings, booleans, errors, and formulas with and without a value", async () => {
    const rows =
      `<row r="1">` +
      `<c r="A1" t="inlineStr"><is><r><t>Rich </t></r><r><t>inline</t></r><rPh><t>no</t></rPh></is></c>` +
      `<c r="B1" t="str"><f>A1&amp;"!"</f><v>Rich inline!</v></c>` +
      `<c r="C1" t="b"><v>1</v></c><c r="D1" t="b"><v>0</v></c>` +
      `<c r="E1" t="e"><f>NA()</f><v>#N/A</v></c><c r="F1" t="e"><v>#REF!</v></c>` +
      `<c r="G1"><f>1+1</f><v>2</v></c><c r="H1"><f>1+1</f></c><c r="I1"><f>1+1</f><v></v></c>` +
      `<c r="J1" t="n"><v>3</v></c><c r="K1" t="str"><f>""</f><v></v></c><c r="L1" t="inlineStr"><is><t>last</t></is></c>` +
      `</row>`;
    assert.deepEqual(await rowsOf(rows), [["Rich inline", "Rich inline!", "TRUE", "FALSE", "#N/A", "#REF!", "2", "", "", "3", "", "last"]]);
  });

  test("numbers as Excel shows them: 15 significant digits, no exponents for whole numbers", async () => {
    const cases: [string, string][] = [
      ["8145550199", "8145550199"],
      ["1.5", "1.5"],
      ["0.1", "0.1"],
      ["2.0000000000000004", "2"],
      ["0.30000000000000004", "0.3"],
      ["1.0000000000000002", "1"],
      ["44381.3854166667", "44381.3854166667"],
      ["-12.75", "-12.75"],
      ["-0", "0"],
      ["1E+20", "100000000000000000000"],
      ["123456789012345678", "123456789012346000"],
      ["1.5E-7", "0.00000015"],
      ["  12  ", "12"],
      ["1e21", "1e+21"],
      ["not a number", "not a number"],
    ];
    const rows = `<row r="1">${cases.map(([value]) => `<c><v>${value}</v></c>`).join("")}</row>`;
    assert.deepEqual(await rowsOf(rows), [cases.map(([, text]) => text)]);
  });

  test("gaps are blank, blank cells at a row's end are dropped, and so are blank rows at the end", async () => {
    const rows =
      `<row r="2"><c r="B2"><v>1</v></c><c r="D2"><v>2</v></c><c r="E2" s="1"/><c r="F2" t="s"/></row>` +
      `<row r="3"><c r="A3" s="1"/></row>` +
      `<row r="5"><c r="C5" t="inlineStr"><is><t>x</t></is></c></row>` +
      `<row r="6"><c r="A6"><f>1/0</f></c></row><row r="9" customHeight="1"/>`;
    assert.deepEqual(await rowsOf(rows), [[], ["", "1", "", "2"], [], [], ["", "", "x"]]);
  });

  test("rows and cells without r follow the one before; a cell's own reference wins", async () => {
    const rows =
      `<row><c><v>1</v></c><c><v>2</v></c></row>` + // row 1
      `<row r="3"><c><v>3</v></c><c r="D3"><v>4</v></c><c><v>5</v></c></row>` +
      `<row><c r="B4"><v>6</v></c><c r="a4"><v>7</v></c></row>` + // cells out of order
      `<row><c r="A6"><v>8</v></c></row>` + // the cell says row 6
      `<row><c><v>9</v></c></row>`; // so this is row 7
    assert.deepEqual(await rowsOf(rows), [["1", "2"], [], ["3", "", "", "4", "5"], ["7", "6"], [], ["8"], ["9"]]);
  });

  test("a cell outside Excel's grid is refused", async () => {
    for (const ref of ["XFE1", "A1048577", "ZZZZZZZZZZZZ1"]) {
      const error = await refusal(book({ sheets: [{ name: "Far", rows: `<row><c r="${ref}"><v>1</v></c></row>` }] }));
      assert.match(error.message, /sheet "Far" has a cell outside Excel's grid/);
    }
    await refusal(book({ sheets: [{ name: "Far", rows: `<row r="1048577"><c><v>1</v></c></row>` }] }));
    // The far corner itself is fine.
    const corner = await rowsOf(`<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>`, {});
    assert.equal(corner.length, 1_048_576);
    assert.equal(corner[1_048_575].length, 16_384);
  });

  test("at most maxCells cells, counting the blanks that pad rows out, across all sheets", async () => {
    const ten = `<row r="1">${"<c><v>1</v></c>".repeat(5)}</row><row r="2">${"<c><v>1</v></c>".repeat(5)}</row>`;
    assert.equal((await readXlsx(book({ sheets: [{ name: "A", rows: ten }] }), { maxCells: 10 }))[0].rows.length, 2);
    const error = await refusal(book({ sheets: [{ name: "A", rows: ten }] }), { maxCells: 9 });
    assert.match(error.message, /more than 9 cells/);
    // Two cells, with three blanks between them and two blank rows above.
    const padded = `<row r="3"><c r="A3"><v>1</v></c><c r="E3"><v>1</v></c></row>`;
    await readXlsx(book({ sheets: [{ name: "A", rows: padded }] }), { maxCells: 7 });
    await refusal(book({ sheets: [{ name: "A", rows: padded }] }), { maxCells: 6 });
    // Empty cells count: a sheet of nothing but styled cells is still work.
    await refusal(book({ sheets: [{ name: "A", rows: `<row r="1">${'<c s="1"/>'.repeat(11)}</row>` }] }), { maxCells: 10 });
    // Across sheets.
    const two = book({ sheets: [{ name: "A", rows: ten }, { name: "B", rows: ten }] });
    await readXlsx(two, { maxCells: 20 });
    await refusal(two, { maxCells: 19 });
    // Shared strings beyond the limit are refused too.
    await refusal(book({ sheets: [{ name: "A", rows: "" }], strings: "<si><t>x</t></si>".repeat(11) }), { maxCells: 10 });
    assert.match((await refusal(book({ sheets: [{ name: "A", rows: `<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>` }] }), { maxCells: 1000 })).message, /1,000 cells/);
  });
});

describe("dates and times", () => {
  test("Excel's built-in date and time formats", async () => {
    const serial = "45444.385416666664"; // 2024-06-01 09:15
    assert.equal(await shown(serial, 14), "2024-06-01");
    assert.equal(await shown(serial, 15), "2024-06-01");
    assert.equal(await shown(serial, 22), "2024-06-01 09:15");
    assert.equal(await shown(serial, 18), "09:15");
    assert.equal(await shown(serial, 20), "09:15");
    assert.equal(await shown(serial, 19), "09:15:00");
    assert.equal(await shown(serial, 21), "09:15:00");
    assert.equal(await shown("0.0625", 45), "01:30:00");
    assert.equal(await shown("1.5", 46), "36:00:00"); // [h]:mm:ss keeps counting hours
    assert.equal(await shown(serial, 57), "2024-06-01");
    // Numbers in other formats are just numbers.
    for (const id of [0, 1, 2, 4, 9, 10, 11, 37, 44, 48, 49]) assert.equal(await shown(serial, id), "45444.3854166667", `format ${id}`);
  });

  test("format codes: date and time letters count outside quotes, escapes and [brackets]", async () => {
    const serial = "45444.385763888889"; // 2024-06-01 09:15:30
    const cases: [string, string][] = [
      ["yyyy-mm-dd", "2024-06-01"],
      ["dd/mm/yyyy", "2024-06-01"],
      ["MM/DD/YY", "2024-06-01"],
      ["d-mmm", "2024-06-01"],
      ["mmm-yy", "2024-06-01"],
      ["[$-409]mmmm d, yyyy;@", "2024-06-01"],
      ['yyyy"年"m"月"d"日"', "2024-06-01"],
      ["yyyy-mm-dd hh:mm", "2024-06-01 09:15"],
      ["yyyy-mm-dd h:mm:ss", "2024-06-01 09:15:30"],
      ["yyyy\\-mm\\-dd\\ hh:mm", "2024-06-01 09:15"], // as LibreOffice writes them
      ["m/d/yy h:mm AM/PM", "2024-06-01 09:15"],
      ["h:mm AM/PM", "09:15"],
      ["h:mm a/p", "09:15"],
      ["hh:mm", "09:15"],
      ["mm:ss", "09:15:30"],
      ["[h]:mm", "1090665:15"],
      ["[mm]:ss", "1090665:15:30"],
      ["[Red]0.00", "45444.3857638889"],
      ['0.00" days"', "45444.3857638889"],
      ['"Day "0', "45444.3857638889"],
      ["0.00\\d", "45444.3857638889"],
      ["#,##0_);[Red](#,##0)", "45444.3857638889"],
      ['_("$"* #,##0.00_)', "45444.3857638889"],
      ["General", "45444.3857638889"],
      ["@", "45444.3857638889"],
      ["0.00E+00", "45444.3857638889"],
    ];
    for (const [code, text] of cases) assert.equal(await shown(serial, code), text, code);
  });

  test("a format the file spells out wins over the built-in one with its number", async () => {
    const styles = (inside: string) =>
      `<styleSheet xmlns="${MAIN}"><numFmts><numFmt numFmtId="14" formatCode="0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>` +
      `<cellStyleXfs><xf numFmtId="165"/></cellStyleXfs><cellXfs>${inside}</cellXfs>` +
      `<dxfs><dxf><numFmt numFmtId="166" formatCode="yyyy-mm-dd"/></dxf></dxfs></styleSheet>`;
    const rows = `<row r="1"><c s="0"><v>45444</v></c><c s="1"><v>45444</v></c><c s="2"><v>45444</v></c><c s="3"><v>45444</v></c><c s="9"><v>45444</v></c></row>`;
    assert.deepEqual(await rowsOf(rows, { styles: styles(`<xf numFmtId="14"/><xf numFmtId="165"><alignment/></xf><xf numFmtId="166"/><xf/>`) }), [
      ["45444", "2024-06-01", "45444", "45444", "45444"],
    ]);
  });

  test("the 1900 system, with Lotus's 29 February 1900, rounded to the nearest second", async () => {
    assert.equal(await shown("1", 14), "1900-01-01");
    assert.equal(await shown("59", 14), "1900-02-28");
    assert.equal(await shown("60", 14), "1900-02-29");
    assert.equal(await shown("61", 14), "1900-03-01");
    assert.equal(await shown("0", 14), "1900-01-00");
    assert.equal(await shown("0.5", 22), "1900-01-00 12:00");
    assert.equal(await shown("2958465", 14), "9999-12-31");
    assert.equal(await shown("45444.99999999", 22), "2024-06-02 00:00");
    assert.equal(await shown(String(0.5 + 0.4 / 86400), 21), "12:00:00");
    assert.equal(await shown(String(0.5 + 0.6 / 86400), 21), "12:00:01");
    assert.equal(await shown("1.75", 20), "18:00"); // a time format shows only the time
    // Excel shows #### for these; the number is more use.
    assert.equal(await shown("-1", 14), "-1");
    assert.equal(await shown("2958466", 14), "2958466");
  });

  test("the 1904 system, and LibreOffice's 1900 system without the leap day", async () => {
    for (const flag of ['date1904="1"', 'date1904="true"']) {
      assert.equal(await shown("0", 14, flag), "1904-01-01");
      assert.equal(await shown("42067", 14, flag), "2019-03-05");
      assert.equal(await shown("42067.25", 22, flag), "2019-03-05 06:00");
    }
    for (const flag of ['date1904="0"', 'date1904="false"', 'dateCompatibility="true"', 'dateCompatibility="maybe"']) {
      assert.equal(await shown("60", 14, flag), "1900-02-29");
      assert.equal(await shown("43529", 14, flag), "2019-03-05");
    }
    const libreOffice = 'dateCompatibility="false"';
    assert.equal(await shown("2", 14, libreOffice), "1900-01-01");
    assert.equal(await shown("60", 14, libreOffice), "1900-02-28");
    assert.equal(await shown("61", 14, libreOffice), "1900-03-01");
    assert.equal(await shown("43529", 14, libreOffice), "2019-03-05");
    assert.equal(await shown("-1", 14, libreOffice), "1899-12-29");
  });

  test("ISO dates (t=\"d\"): shown as their style says, or with the time only when there is one", async () => {
    const styles = `<styleSheet xmlns="${MAIN}"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/><xf numFmtId="21"/></cellXfs></styleSheet>`;
    const cells: [string, number, string][] = [
      ["2024-03-05", 0, "2024-03-05"],
      ["2024-03-05T00:00:00", 0, "2024-03-05"],
      ["2024-03-05T13:45:00", 0, "2024-03-05 13:45"],
      ["2024-03-05T13:45:30.6Z", 0, "2024-03-05 13:45:31"],
      ["2024-03-05T23:59:59.7+02:00", 0, "2024-03-06"],
      ["2024-03-05T13:45:00", 1, "2024-03-05"],
      ["2024-03-05", 2, "2024-03-05 00:00"],
      ["2024-03-05T13:45:00", 3, "13:45:00"],
      ["13:45:00", 0, "13:45"],
      ["13:45:20", 0, "13:45:20"],
      ["13:45", 3, "13:45:00"],
      ["2024-02-31", 0, "2024-02-31"],
      ["5 March 2024", 0, "5 March 2024"],
    ];
    const rows = `<row r="1">${cells.map(([value, style]) => `<c t="d" s="${style}"><v>${value}</v></c>`).join("")}</row>`;
    assert.deepEqual(await rowsOf(rows, { styles }), [cells.map(([, , text]) => text)]);
  });

  test("only numbers become dates: text in a date style stays as typed", async () => {
    const styles = `<styleSheet xmlns="${MAIN}"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
    const rows = `<row r="1"><c s="1" t="s"><v>0</v></c><c s="1" t="inlineStr"><is><t>45444</t></is></c><c s="1" t="b"><v>1</v></c></row>`;
    assert.deepEqual(await rowsOf(rows, { styles, strings: "<si><t>45444</t></si>" }), [["45444", "45444", "TRUE"]]);
  });
});

describe("speed", () => {
  test("200,000 cells read in well under the time an admin waits", async () => {
    const strings: string[] = [];
    for (let i = 0; i < 20_000; i++) strings.push(`<si><t>Customer ${i} &amp; family</t></si>`);
    const rows: string[] = [];
    for (let r = 1; r <= 20_000; r++) {
      let row = `<row r="${r}">`;
      for (let c = 0; c < 10; c++) row += c % 2 ? `<c r="${"ABCDEFGHIJ"[c]}${r}" t="s"><v>${(r * 7 + c) % 20_000}</v></c>` : `<c r="${"ABCDEFGHIJ"[c]}${r}" s="1"><v>${r * 1.25 + c}</v></c>`;
      rows.push(`${row}</row>`);
    }
    const styles = `<styleSheet xmlns="${MAIN}"><cellXfs><xf numFmtId="0"/><xf numFmtId="2"/></cellXfs></styleSheet>`;
    const bytes = book({ sheets: [{ name: "Big", rows: rows.join("") }], strings: strings.join(""), styles });
    const started = Date.now();
    const [sheet] = await readXlsx(bytes);
    const took = Date.now() - started;
    assert.equal(sheet.rows.length, 20_000);
    assert.deepEqual(sheet.rows[19_999].slice(0, 2), ["25000", "Customer 1 & family"]);
    assert.ok(took < 5000, `took ${took} ms`);
  });
});
