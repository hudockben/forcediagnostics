// Writing Excel workbooks (src/lib/xlsx-write.ts), for NUSR's download:
// what's written reads back as written through the app's own reader
// (src/lib/xlsx.ts), which checks every part's checksum as it unzips it.
// Text with XML's special characters, emoji and control characters,
// numbers, dates (Lotus's 29 February 1900 included), booleans, formulas
// with the values they work out to, several sheets and the names Excel
// allows one; and the parts that carry the shop's number formats, the
// frozen panes, the filter and the printing, written as Excel needs them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { crc32, inflateRawSync } from "node:zlib";

import { readXlsx } from "../src/lib/xlsx";
import { crc32ByTable, writeXlsx, type Cell, type Sheet } from "../src/lib/xlsx-write";

// The workbook's parts as text, by name, unzipped through its directory.
function partsOf(bytes: Uint8Array): Map<string, string> {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  const parts = new Map<string, string>();
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const packed = zip.subarray(start, start + zip.readUInt32LE(at + 20));
    parts.set(zip.toString("utf8", at + 46, at + 46 + nameLength), inflateRawSync(packed).toString("utf8"));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return parts;
}

const one = (rows: Cell[][], sheet: Partial<Sheet> = {}): Sheet[] => [{ name: "Sheet1", rows, ...sheet }];

// The rows of a one-sheet workbook, as the app's reader reads them.
async function readBack(rows: Cell[][], sheet: Partial<Sheet> = {}) {
  const sheets = await readXlsx(writeXlsx(one(rows, sheet)));
  assert.equal(sheets.length, 1);
  return sheets[0].rows;
}

const sheetXml = (rows: Cell[][], sheet: Partial<Sheet> = {}) => partsOf(writeXlsx(one(rows, sheet))).get("xl/worksheets/sheet1.xml")!;

describe("cells", () => {
  test("text reads back as written: XML's own characters, emoji, line breaks, spaces at either end", async () => {
    assert.deepEqual(
      await readBack([
        [`Plow & winch <installed> "today" it's done`],
        ["🏍️ Zoë Müller, 山田"],
        ["two\r\nlines\rthree"],
        ["  spaced  "],
        ["tab\there"],
        ["_x0041_ is how Excel would write A"],
        ['=HYPERLINK("http://example.com")'],
      ]),
      [
        [`Plow & winch <installed> "today" it's done`],
        ["🏍️ Zoë Müller, 山田"],
        ["two\nlines\nthree"],
        ["  spaced  "],
        ["tab\there"],
        ["_x0041_ is how Excel would write A"],
        ['=HYPERLINK("http://example.com")'],
      ],
    );
    // Text that looks like a formula is text: no cell is a formula unless
    // it's given one.
    const xml = sheetXml([['=HYPERLINK("http://example.com")']]);
    assert.ok(!xml.includes("<f>"), xml);
    assert.match(xml, /<c r="A1" t="inlineStr"><is><t>=HYPERLINK\(&quot;http:\/\/example.com&quot;\)<\/t><\/is><\/c>/);
  });

  test("control characters, and anything XML can't hold, are left out", async () => {
    const typed = "bell\u0007 nul\u0000 esc\u001b del\u007f next\u0085 half\uD800 other half\uDFFF end\uFFFE\uFFFF";
    assert.deepEqual(await readBack([[typed], ["\u0001\u0002"], ["fine"]]), [["bell nul esc del next half other half end"], [], ["fine"]]);
    assert.deepEqual(await readBack([["🏍️"]]), [["🏍️"]]);
  });

  test("a cell holds at most Excel's 32,767 characters, never half an emoji", async () => {
    const [[long]] = await readBack([["a".repeat(40_000)]]);
    assert.equal(long.length, 32_767);
    const [[emoji]] = await readBack([["a".repeat(32_766) + "😀"]]);
    assert.equal(emoji, "a".repeat(32_766));
  });

  test("numbers, negative numbers and booleans", async () => {
    assert.deepEqual(await readBack([[1234.56, -142.61, 0, -0, 0.1 + 0.2, 8145550199, -0.0544, 1e21, true, false]]), [
      ["1234.56", "-142.61", "0", "0", "0.3", "8145550199", "-0.0544", "1e+21", "TRUE", "FALSE"],
    ]);
    assert.match(sheetXml([[-142.61, true]]), /<c r="A1"><v>-142.61<\/v><\/c><c r="B1" t="b"><v>1<\/v><\/c>/);
  });

  test("dates as Excel counts days, Lotus's 29 February 1900 included; one Excel can't show is text", async () => {
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
    assert.deepEqual(
      await readBack([
        [day("2026-10-30"), day("1900-01-01"), day("1900-02-28"), day("1900-03-01"), day("9999-12-31"), new Date("2026-10-30T13:45:00Z")],
        [day("1899-12-31")],
      ]),
      [["2026-10-30", "1900-01-01", "1900-02-28", "1900-03-01", "9999-12-31", "2026-10-30"], ["1899-12-31"]],
    );
    // 30 October 2026 is day 46325; dates get the shop's m/d/yyyy.
    const xml = sheetXml([[day("2026-10-30"), day("1900-03-01")]]);
    assert.match(xml, /<c r="A1" s="(\d+)"><v>46325<\/v><\/c><c r="B1" s="\1"><v>61<\/v><\/c>/);
    assert.throws(() => writeXlsx(one([[new Date("not a date")]])), /invalid date/);
  });

  test("formulas carry the value they work out to: a number, text, nothing yet, or a boolean", async () => {
    const rows: Cell[][] = [
      [
        2,
        3,
        { formula: "A1+B1", value: 5 },
        { formula: '=IF(A1=0,"","two")', value: "two" },
        { formula: 'IF(A1>9,"x","")', value: "" },
        { formula: "A1<B1", value: true },
        { formula: "A1*B1", value: null },
      ],
    ];
    assert.deepEqual(await readBack(rows), [["2", "3", "5", "two", "", "TRUE"]]);
    const xml = sheetXml(rows);
    assert.match(xml, /<c r="C1"><f>A1\+B1<\/f><v>5<\/v><\/c>/);
    assert.match(xml, /<c r="D1" t="str"><f>IF\(A1=0,&quot;&quot;,&quot;two&quot;\)<\/f><v>two<\/v><\/c>/);
    assert.match(xml, /<c r="E1" t="str"><f>IF\(A1&gt;9,&quot;x&quot;,&quot;&quot;\)<\/f><v><\/v><\/c>/);
    assert.match(xml, /<c r="F1" t="b"><f>A1&lt;B1<\/f><v>1<\/v><\/c>/);
    assert.match(xml, /<c r="G1"><f>A1\*B1<\/f><\/c>/);
    // Whatever's cached, the workbook asks to be worked out again as it opens.
    assert.match(partsOf(writeXlsx(one(rows))).get("xl/workbook.xml")!, /<calcPr calcId="\d+" fullCalcOnLoad="1"\/>/);
  });

  test("blank cells are left out unless they have a style of their own; gaps and blank rows stay where they are", async () => {
    assert.deepEqual(await readBack([[null, "B1", "", { value: null, style: "total" }, "E1"], [], [undefined as unknown as Cell, "B3"]]), [
      ["", "B1", "", "", "E1"],
      [],
      ["", "B3"],
    ]);
    const xml = sheetXml([[null, "B1", "", { value: null, style: "total" }]]);
    assert.match(xml, /<row r="1"><c r="B1" t="inlineStr"><is><t>B1<\/t><\/is><\/c><c r="D1" s="\d+"\/><\/row>/);
  });
});

describe("the workbook", () => {
  test("several sheets, in order, the first one open", async () => {
    const bytes = writeXlsx([
      { name: "NUSR", rows: [["first"]] },
      { name: "Summary", rows: [["second"]] },
      { name: "Comparison", rows: [] },
    ]);
    assert.deepEqual(await readXlsx(bytes), [
      { name: "NUSR", rows: [["first"]] },
      { name: "Summary", rows: [["second"]] },
      { name: "Comparison", rows: [] },
    ]);
    const parts = partsOf(bytes);
    assert.match(parts.get("xl/worksheets/sheet1.xml")!, /<sheetView workbookViewId="0" tabSelected="1">/);
    assert.match(parts.get("xl/worksheets/sheet2.xml")!, /<sheetView workbookViewId="0">/);
    assert.match(parts.get("xl/worksheets/sheet3.xml")!, /<dimension ref="A1"\/>/);
  });

  test("the names Excel allows a sheet, and none it refuses", async () => {
    const allowed = ["NUSR", "2026", "Bob's units", "Sales & profit", "x".repeat(31), "🏍️ Units"];
    const bytes = writeXlsx(allowed.map((name) => ({ name, rows: [[name]] })));
    assert.deepEqual(
      (await readXlsx(bytes)).map((sheet) => sheet.name),
      allowed,
    );
    for (const name of ["", "x".repeat(32), "Sales/2026", "Q1\\Q2", "a:b", "Totals*", "Why?", "[2026]", "'Quoted'", "Bob'", "history", "tab\u0001"]) {
      assert.throws(() => writeXlsx([{ name, rows: [] }]), Error, JSON.stringify(name));
    }
    // Two the same, in any case.
    assert.throws(() => writeXlsx([{ name: "NUSR", rows: [] }, { name: "nusr", rows: [] }]), /Two sheets are named "nusr"/);
    assert.throws(() => writeXlsx([]), /at least one sheet/);
  });

  test("the parts every program looks for, its title, and checksums that agree with Node's", async () => {
    const bytes = writeXlsx(one([["x"]]), { title: "NUSR October 2026 · “Yarrow & Co” <draft>", created: new Date("2026-10-31T21:04:05.678Z") });
    const parts = partsOf(bytes);
    assert.deepEqual([...parts.keys()], [
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    assert.match(parts.get("[Content_Types].xml")!, /<Override PartName="\/xl\/worksheets\/sheet1.xml" ContentType="application\/vnd.openxmlformats-officedocument.spreadsheetml.worksheet\+xml"\/>/);
    assert.match(parts.get("_rels/.rels")!, /Type="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships\/officeDocument" Target="xl\/workbook.xml"/);
    const core = parts.get("docProps/core.xml")!;
    assert.match(core, /<dc:title>NUSR October 2026 · “Yarrow &amp; Co” &lt;draft&gt;<\/dc:title>/);
    assert.match(core, /<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-31T21:04:05Z<\/dcterms:created>/);
    // Every part's checksum is checked as the app's reader unzips it.
    assert.deepEqual(await readXlsx(bytes), [{ name: "Sheet1", rows: [["x"]] }]);
    // The checksum worked out here, for a Node without its own, agrees.
    let seed = 11;
    const data = Uint8Array.from({ length: 100_000 }, () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) & 0xff);
    for (const sample of [new Uint8Array(0), new TextEncoder().encode("The quick brown fox"), data]) assert.equal(crc32ByTable(sample), crc32(sample));
  });

  test("the shop's number formats, and the headings' and TOTAL rows' styles", async () => {
    const styles = partsOf(writeXlsx(one([]))).get("xl/styles.xml")!;
    // Excel's Accounting format without the dollar sign, as the spreadsheet had it.
    assert.ok(styles.includes('formatCode="_(* #,##0.00_);_(* \\(#,##0.00\\);_(* &quot;-&quot;??_);_(@_)"'), styles);
    assert.ok(styles.includes('formatCode="m/d/yyyy"'));
    assert.match(styles, /<fills count="5"><fill><patternFill patternType="none"\/><\/fill><fill><patternFill patternType="gray125"\/><\/fill>/);
    for (const colour of ["FFECECEC", "FFC5E0B3", "FFFFE598"]) assert.ok(styles.includes(`<fgColor rgb="${colour}"/>`), colour);

    // Each style's cell format: its number format, bold font, fill and line.
    const formats = [...styles.matchAll(/<xf numFmtId="(\d+)" fontId="(\d+)" fillId="(\d+)" borderId="(\d+)" xfId="0"/g)].map((m) => m.slice(1).map(Number));
    const xml = sheetXml([
      [
        { value: 1, style: "money" },
        { value: 0.0544, style: "percent" },
        { value: 7, style: "integer" },
        { value: "Date", style: "header" },
        { value: "Holdback", style: "headerYellow" },
        { value: 2, style: "totalMoney" },
        { value: 0.5, style: "totalPercent" },
        { value: "TOTAL", style: "total" },
      ],
    ]);
    const styleOf = (ref: string) => formats[Number(new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(xml)![1])];
    assert.deepEqual(styleOf("A1"), [164, 0, 0, 0]);
    assert.deepEqual(styleOf("B1"), [10, 0, 0, 0]);
    assert.deepEqual(styleOf("C1"), [3, 0, 0, 0]);
    assert.deepEqual(styleOf("D1"), [0, 1, 2, 1]);
    assert.deepEqual(styleOf("E1"), [0, 1, 4, 1]);
    assert.deepEqual(styleOf("F1"), [164, 1, 0, 2]);
    assert.deepEqual(styleOf("G1"), [10, 1, 0, 2]);
    assert.deepEqual(styleOf("H1"), [0, 1, 0, 2]);
  });

  test("a column's style is its cells' unless they have their own, and what's typed there later", async () => {
    const columns = [{ width: 11, style: "date" as const }, { width: 13.5, style: "money" as const }, {}, { style: "percent" as const }];
    const rows: Cell[][] = [[{ value: "Date", style: "header" }, "Sales Price"], [46325, 1234.5]];
    assert.deepEqual(await readBack(rows, { columns }), [["Date", "Sales Price"], ["2026-10-30", "1234.5"]]);
    const xml = sheetXml(rows, { columns });
    assert.match(xml, /<cols><col min="1" max="1" width="11" customWidth="1" style="\d+"\/><col min="2" max="2" width="13.5" customWidth="1" style="\d+"\/><col min="4" max="4" width="9.140625" style="\d+"\/><\/cols>/);
    assert.throws(() => writeXlsx(one([], { columns: [{ width: -1 }] })), /width/);
  });

  test("frozen headings, a filter, and pages set up to print: landscape, one page wide, headings on every page", () => {
    const bytes = writeXlsx([
      { name: "Bob's NUSR", rows: [["Date"]], freeze: { rows: 1, columns: 4 }, autoFilter: "B1:AQ40", landscape: true, fitToWidth: true, printTitles: 1, printGridlines: true, footer: "NUSR 2026 & more" },
      { name: "Rows", rows: [], freeze: { rows: 2 } },
      { name: "Columns", rows: [], freeze: { columns: 1 } },
    ]);
    const parts = partsOf(bytes);
    const sheet = parts.get("xl/worksheets/sheet1.xml")!;
    assert.match(sheet, /^<\?xml[^>]*\?>\n<worksheet [^>]*><sheetPr><pageSetUpPr fitToPage="1"\/><\/sheetPr><dimension ref="A1:A1"\/><sheetViews>/);
    assert.ok(
      sheet.includes(
        '<pane xSplit="4" ySplit="1" topLeftCell="E2" activePane="bottomRight" state="frozen"/><selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight" activeCell="E2" sqref="E2"/>',
      ),
      sheet,
    );
    // In the order Excel's schema has them.
    assert.match(
      sheet,
      /<\/sheetData><autoFilter ref="B1:AQ40"\/><printOptions gridLines="1"\/><pageMargins [^>]*\/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"\/><headerFooter><oddFooter>&amp;LNUSR 2026 &amp;&amp; more&amp;RPage &amp;P of &amp;N<\/oddFooter><\/headerFooter><\/worksheet>$/,
    );
    assert.ok(parts.get("xl/worksheets/sheet2.xml")!.includes('<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A3" sqref="A3"/>'));
    assert.ok(parts.get("xl/worksheets/sheet3.xml")!.includes('<pane xSplit="1" topLeftCell="B1" activePane="topRight" state="frozen"/>'));
    const workbook = parts.get("xl/workbook.xml")!;
    assert.ok(workbook.includes(`<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Bob''s NUSR'!$B$1:$AQ$40</definedName>`), workbook);
    assert.ok(workbook.includes(`<definedName name="_xlnm.Print_Titles" localSheetId="0">'Bob''s NUSR'!$1:$1</definedName>`), workbook);
    assert.throws(() => writeXlsx(one([], { autoFilter: "B1-AQ40" })), /isn't a range/);
    assert.throws(() => writeXlsx(one([], { freeze: { rows: 1.5 } })), /whole number/);
  });

  test("what would make a broken file is refused, rather than written", () => {
    for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => writeXlsx(one([[value]])), /isn't a number Excel can hold/);
    assert.throws(() => writeXlsx(one([[{ formula: "A1+1", value: NaN }]])), /isn't a number/);
    assert.throws(() => writeXlsx(one([[{ formula: " = ", value: 1 }]])), /formula in A1 is empty/);
    assert.throws(() => writeXlsx(one([[{ formula: `1${"+1".repeat(5_000)}`, value: 1 }]])), /longer than Excel takes/);
  });

  test("the most the log holds, 20,000 sales of 43 columns, is written in a few seconds", async () => {
    const row = (r: number): Cell[] => [
      null,
      new Date(Date.UTC(2026, r % 12, 1 + (r % 28))),
      "Sam Ortiz",
      `Customer ${r}`,
      `${r} Example Rd, Anytown, PA 16601`,
      "(814) 555-0101",
      2026,
      "Rngr 570 NS",
      "N",
      "4XARAA578TE000001",
      ...Array.from({ length: 33 }, (_, c): Cell => (c % 4 === 0 ? { formula: `L${r}-M${r}-N${r}+O${r}`, value: r + c / 100 } : r * 1.25 + c)),
    ];
    const rows = Array.from({ length: 20_000 }, (_, i) => row(i + 2));
    const started = Date.now();
    const bytes = writeXlsx(one(rows));
    const took = Date.now() - started;
    assert.ok(took < 8000, `took ${took} ms`);
    const [sheet] = await readXlsx(bytes);
    assert.equal(sheet.rows.length, 20_000);
    assert.equal(sheet.rows[19_999][3], "Customer 20001");
  });
});
