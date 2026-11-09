import "server-only";

import * as zlib from "node:zlib";

// Excel workbooks (.xlsx) written out, for NUSR's download: the shop's
// spreadsheet back as a real workbook, its amounts, dates and live formulas
// in the shop's own formats, with a frozen heading row, a filter and pages
// set up to print. A workbook is a zip of XML files (src/lib/xlsx.ts reads
// them, for the imports); this writes the few a workbook needs, with no
// library, zipped with Node's own zlib, in a shape Excel, Google Sheets,
// Numbers and LibreOffice all open without asking to repair it.
//
// Text goes into its own cell (an inline string), so a cell is a formula
// only when it's given one: a customer typed as "=HYPERLINK(…)" stays text.
// A formula carries the value it works out to, shown until the program
// works it out itself, and the workbook asks to be worked out again as it
// opens (fullCalcOnLoad), so what Excel shows is always its own sums.

export type CellValue = string | number | boolean | Date | null;

// What a cell holds: a value, a value with a style of its own, or a formula
// ("L2-M2", with or without its "=") with the value it works out to.
export type Cell = CellValue | { value: CellValue; style?: CellStyle } | { formula: string; value: CellValue; style?: CellStyle };

// A column's width, in characters as Excel counts them, and the style its
// cells take unless they have their own; Excel gives it to whatever is
// typed into the column later, too.
export type Column = { width?: number; style?: CellStyle };

export type Sheet = {
  name: string;
  columns?: Column[];
  rows: Cell[][];
  // The rows at the top and the columns at the left that stay in view.
  freeze?: { rows?: number; columns?: number };
  // The range with filter buttons on its first row, such as "B1:AQ40".
  autoFilter?: string;
  landscape?: boolean;
  // Printed one page wide, as many pages tall as it takes.
  fitToWidth?: boolean;
  // How many rows at the top are printed again on every page.
  printTitles?: number;
  printGridlines?: boolean;
  // Printed at the foot of every page, with "Page 1 of 3".
  footer?: string;
};

// The shop's spreadsheet's own number formats: amounts in Excel's
// Accounting style without a dollar sign (1,234.56, (142.61) for a minus, a
// dash for zero), dates month first, and a change with its sign. Whole
// numbers, percentages and hours (decimal, as labor is booked: 1.25) are
// Excel's built-in formats, which follow the computer's way of writing
// numbers.
const NUMBER_FORMATS = { general: 0, hours: 2, integer: 3, percent: 10, money: 164, date: 165, change: 166 } as const;
const FORMAT_CODES: [number, string][] = [
  [NUMBER_FORMATS.money, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'],
  [NUMBER_FORMATS.date, "m/d/yyyy"],
  [NUMBER_FORMATS.change, "+#,##0;-#,##0;0"],
];

// The spreadsheet's heading colours: grey over what's typed, green over the
// profits it works out, yellow over the holdback, total profit and bonuses.
const FILLS = { grey: "FFECECEC", green: "FFC5E0B3", yellow: "FFFFE598" } as const;

type StyleSpec = {
  format?: keyof typeof NUMBER_FORMATS;
  font?: "bold" | "title";
  fill?: keyof typeof FILLS;
  border?: "top" | "bottom";
};

// Every style a cell can have: a heading row's (bold on a colour, a line
// under it), a TOTAL row's (bold, a line over it) and the plain ones.
const STYLES = {
  text: {},
  money: { format: "money" },
  percent: { format: "percent" },
  date: { format: "date" },
  integer: { format: "integer" },
  change: { format: "change" },
  bold: { font: "bold" },
  title: { font: "title" },
  header: { font: "bold", fill: "grey", border: "bottom" },
  headerGreen: { font: "bold", fill: "green", border: "bottom" },
  headerYellow: { font: "bold", fill: "yellow", border: "bottom" },
  total: { font: "bold", border: "top" },
  totalMoney: { font: "bold", border: "top", format: "money" },
  totalPercent: { font: "bold", border: "top", format: "percent" },
  totalInteger: { font: "bold", border: "top", format: "integer" },
  totalChange: { font: "bold", border: "top", format: "change" },
  hours: { format: "hours" },
  totalHours: { font: "bold", border: "top", format: "hours" },
} as const satisfies Record<string, StyleSpec>;

export type CellStyle = keyof typeof STYLES;

const STYLE_NAMES = Object.keys(STYLES) as CellStyle[];
const STYLE_INDEX = Object.fromEntries(STYLE_NAMES.map((name, i) => [name, i])) as Record<CellStyle, number>;

// Excel's grid, and its limits on a cell's text and a formula's length.
const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;
const MAX_CELL_TEXT = 32_767;
const MAX_FORMULA = 8_192;
// What a column without a width is, in Calibri 11.
const DEFAULT_WIDTH = 9.140625;

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const OFFICE_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// The characters XML can't hold at all, and the control characters, which
// no cell shows: everything below a space but tab and line breaks, DEL and
// the C1 controls, half a surrogate pair, and U+FFFE and U+FFFF.
const NOT_XML_SOURCE = String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]`;
const NOT_XML = new RegExp(NOT_XML_SOURCE, "g");
const HAS_NOT_XML = new RegExp(NOT_XML_SOURCE);

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

// The workbook: its sheets in order, the first one open. Throws on what
// would make a broken file (a sheet name Excel refuses, a number that isn't
// one), which is a mistake in the caller, never in what the shop typed.
export function writeXlsx(sheets: readonly Sheet[], { title, created = new Date() }: { title?: string; created?: Date } = {}): Uint8Array<ArrayBuffer> {
  if (sheets.length === 0) throw new Error("A workbook needs at least one sheet.");
  checkSheetNames(sheets);
  const parts: [string, string][] = [
    ["[Content_Types].xml", contentTypesXml(sheets.length)],
    ["_rels/.rels", PACKAGE_RELS_XML],
    ["docProps/core.xml", coreXml(title, created)],
    ["xl/workbook.xml", workbookXml(sheets)],
    ["xl/_rels/workbook.xml.rels", workbookRelsXml(sheets.length)],
    ["xl/styles.xml", stylesXml()],
    ...sheets.map((sheet, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet, i === 0)]),
  ];
  const encoder = new TextEncoder();
  return zip(
    parts.map(([name, xml]) => ({ name, data: encoder.encode(xml) })),
    created,
  );
}

// The names Excel takes for a sheet: 1 to 31 characters, none of : \ / ? *
// [ ], not starting or ending with an apostrophe, not "History" (Excel
// keeps it for itself), and each different from the others in any case.
function checkSheetNames(sheets: readonly Sheet[]) {
  const seen = new Set<string>();
  for (const { name } of sheets) {
    if (name.length === 0 || name.length > 31) throw new Error(`A sheet's name is 1 to 31 characters: "${name}" isn't.`);
    if (/[:\\/?*[\]]/.test(name)) throw new Error(`A sheet's name can't have : \\ / ? * [ or ] in it: "${name}" has.`);
    if (HAS_NOT_XML.test(name)) throw new Error(`A sheet's name can't have control characters in it: "${name}" has.`);
    if (name.startsWith("'") || name.endsWith("'")) throw new Error(`A sheet's name can't start or end with an apostrophe: "${name}" does.`);
    const key = name.toLowerCase();
    if (key === "history") throw new Error('Excel keeps the sheet name "History" for itself.');
    if (seen.has(key)) throw new Error(`Two sheets are named "${name}".`);
    seen.add(key);
  }
}

// --- The parts ----------------------------------------------------------------

function contentTypesXml(sheetCount: number) {
  let overrides = `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`;
  for (let i = 1; i <= sheetCount; i++) {
    overrides += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  }
  overrides +=
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`;
  return (
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`
  );
}

const PACKAGE_RELS_XML =
  `${XML_HEAD}<Relationships xmlns="${PACKAGE_RELS}">` +
  `<Relationship Id="rId1" Type="${OFFICE_RELS}/officeDocument" Target="xl/workbook.xml"/>` +
  `<Relationship Id="rId2" Type="${PACKAGE_RELS}/metadata/core-properties" Target="docProps/core.xml"/>` +
  `</Relationships>`;

// The workbook's title and when it was made, which Excel shows under File >
// Info.
function coreXml(title: string | undefined, created: Date) {
  const when = created.toISOString().replace(/\.\d{3}Z$/, "Z");
  const named = title ? `<dc:title>${escapeXml(title.replace(NOT_XML, ""))}</dc:title>` : "";
  return (
    `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${named}` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified></cp:coreProperties>`
  );
}

// The sheets, and the names Excel keeps a filter's range and the rows
// printed on every page under.
function workbookXml(sheets: readonly Sheet[]) {
  const names: string[] = [];
  sheets.forEach((sheet, i) => {
    const sheetRef = `'${sheet.name.replace(/'/g, "''")}'!`;
    if (sheet.autoFilter) {
      const range = rangeOf(sheet.autoFilter);
      names.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${escapeXml(sheetRef + range.absolute)}</definedName>`);
    }
    if (sheet.printTitles) {
      const rows = wholeCount(sheet.printTitles, "printTitles");
      names.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${escapeXml(`${sheetRef}$1:$${rows}`)}</definedName>`);
    }
  });
  const list = sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  return (
    `${XML_HEAD}<workbook xmlns="${MAIN}" xmlns:r="${OFFICE_RELS}"><workbookPr/><bookViews><workbookView/></bookViews>` +
    `<sheets>${list}</sheets>${names.length ? `<definedNames>${names.join("")}</definedNames>` : ""}` +
    `<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`
  );
}

function workbookRelsXml(sheetCount: number) {
  let rels = "";
  for (let i = 1; i <= sheetCount; i++) rels += `<Relationship Id="rId${i}" Type="${OFFICE_RELS}/worksheet" Target="worksheets/sheet${i}.xml"/>`;
  rels += `<Relationship Id="rId${sheetCount + 1}" Type="${OFFICE_RELS}/styles" Target="styles.xml"/>`;
  return `${XML_HEAD}<Relationships xmlns="${PACKAGE_RELS}">${rels}</Relationships>`;
}

// Fonts, fills and borders, then one cell format per style, in STYLES'
// order (a cell's s is its style's place there). Excel needs the first two
// fills to be "none" and "gray125", whatever else there is.
function stylesXml() {
  const font = (inside: string) => `<font>${inside}<name val="Calibri"/><family val="2"/></font>`;
  const fonts = [font('<sz val="11"/>'), font('<b/><sz val="11"/>'), font('<b/><sz val="14"/>')];
  const fillNames = Object.keys(FILLS) as (keyof typeof FILLS)[];
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    ...fillNames.map((name) => `<fill><patternFill patternType="solid"><fgColor rgb="${FILLS[name]}"/><bgColor indexed="64"/></patternFill></fill>`),
  ];
  const line = '<color auto="1"/>';
  const borders = [
    "<border><left/><right/><top/><bottom/><diagonal/></border>",
    `<border><left/><right/><top/><bottom style="thin">${line}</bottom><diagonal/></border>`,
    `<border><left/><right/><top style="thin">${line}</top><bottom/><diagonal/></border>`,
  ];
  const formats = STYLE_NAMES.map((name) => {
    const spec: StyleSpec = STYLES[name];
    const numFmtId = NUMBER_FORMATS[spec.format ?? "general"];
    const fontId = spec.font === "bold" ? 1 : spec.font === "title" ? 2 : 0;
    const fillId = spec.fill ? 2 + fillNames.indexOf(spec.fill) : 0;
    const borderId = spec.border === "bottom" ? 1 : spec.border === "top" ? 2 : 0;
    const applies = [numFmtId ? ' applyNumberFormat="1"' : "", fontId ? ' applyFont="1"' : "", fillId ? ' applyFill="1"' : "", borderId ? ' applyBorder="1"' : ""].join("");
    return `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${applies}/>`;
  });
  const codes = FORMAT_CODES.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`);
  return (
    `${XML_HEAD}<styleSheet xmlns="${MAIN}">` +
    `<numFmts count="${codes.length}">${codes.join("")}</numFmts>` +
    `<fonts count="${fonts.length}">${fonts.join("")}</fonts>` +
    `<fills count="${fills.length}">${fills.join("")}</fills>` +
    `<borders count="${borders.length}">${borders.join("")}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${formats.length}">${formats.join("")}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
    "</styleSheet>"
  );
}

// One sheet: what stays in view, the columns, the rows, the filter and how
// it prints, in the order Excel insists on.
function sheetXml(sheet: Sheet, first: boolean) {
  const columns = sheet.columns ?? [];
  if (sheet.rows.length > MAX_ROWS) throw new Error(`Sheet "${sheet.name}" has more rows than Excel can hold.`);
  let width = columns.length;
  for (const row of sheet.rows) width = Math.max(width, row.length);
  if (width > MAX_COLUMNS) throw new Error(`Sheet "${sheet.name}" has more columns than Excel can hold.`);
  const letters = Array.from({ length: width }, (_, i) => columnName(i));

  const rows: string[] = [];
  sheet.rows.forEach((row, r) => {
    let cells = "";
    for (let c = 0; c < row.length; c++) cells += cellXml(`${letters[c]}${r + 1}`, row[c], columns[c]?.style);
    if (cells) rows.push(`<row r="${r + 1}">${cells}</row>`);
  });

  const setup = [sheet.landscape ? 'orientation="landscape"' : "", sheet.fitToWidth ? 'fitToWidth="1" fitToHeight="0"' : ""].filter(Boolean);
  const cols = columns.map((column, i) => colXml(column, i)).join("");
  return [
    `${XML_HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${OFFICE_RELS}">`,
    sheet.fitToWidth ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : "",
    `<dimension ref="${width && sheet.rows.length ? `A1:${letters[width - 1]}${sheet.rows.length}` : "A1"}"/>`,
    `<sheetViews><sheetView workbookViewId="0"${first ? ' tabSelected="1"' : ""}>${paneXml(sheet.freeze)}</sheetView></sheetViews>`,
    '<sheetFormatPr defaultRowHeight="15"/>',
    cols ? `<cols>${cols}</cols>` : "",
    `<sheetData>${rows.join("")}</sheetData>`,
    sheet.autoFilter ? `<autoFilter ref="${rangeOf(sheet.autoFilter).relative}"/>` : "",
    sheet.printGridlines ? '<printOptions gridLines="1"/>' : "",
    '<pageMargins left="0.25" right="0.25" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>',
    setup.length ? `<pageSetup ${setup.join(" ")}/>` : "",
    sheet.footer !== undefined ? `<headerFooter><oddFooter>${escapeXml(`&L${footerText(sheet.footer)}&RPage &P of &N`)}</oddFooter></headerFooter>` : "",
    "</worksheet>",
  ].join("");
}

// A column's width and style, or nothing for a column with neither.
function colXml(column: Column, index: number) {
  const { width, style } = column;
  if (width === undefined && style === undefined) return "";
  if (width !== undefined && !(Number.isFinite(width) && width >= 0 && width <= 255)) {
    throw new Error(`A column's width is 0 to 255 characters: ${width} isn't.`);
  }
  const styled = style && style !== "text" ? ` style="${STYLE_INDEX[style]}"` : "";
  const sized = width === undefined ? ` width="${DEFAULT_WIDTH}"` : ` width="${width}" customWidth="1"`;
  return `<col min="${index + 1}" max="${index + 1}"${sized}${styled}/>`;
}

// Frozen rows and columns, as Excel writes them: the pane below and to the
// right of them is the one that scrolls, and the first cell in it is
// selected.
function paneXml(freeze: Sheet["freeze"]) {
  const rows = wholeCount(freeze?.rows ?? 0, "freeze.rows");
  const columns = wholeCount(freeze?.columns ?? 0, "freeze.columns");
  if (rows === 0 && columns === 0) return "";
  const topLeft = `${columnName(columns)}${rows + 1}`;
  const active = rows && columns ? "bottomRight" : rows ? "bottomLeft" : "topRight";
  const split = `${columns ? ` xSplit="${columns}"` : ""}${rows ? ` ySplit="${rows}"` : ""}`;
  const others = rows && columns ? '<selection pane="topRight"/><selection pane="bottomLeft"/>' : "";
  return `<pane${split} topLeftCell="${topLeft}" activePane="${active}" state="frozen"/>${others}<selection pane="${active}" activeCell="${topLeft}" sqref="${topLeft}"/>`;
}

// --- Cells --------------------------------------------------------------------

// A cell as XML, or nothing for a blank one without a style of its own (a
// blank cell takes its column's look anyway).
function cellXml(ref: string, cell: Cell | undefined, columnStyle: CellStyle | undefined): string {
  if (cell === null || cell === undefined) return "";
  const given: { value: CellValue; style?: CellStyle; formula?: string } = typeof cell === "object" && !(cell instanceof Date) ? cell : { value: cell };
  const { value } = given;
  const style = given.style ?? (value instanceof Date ? "date" : columnStyle);
  const s = style && style !== "text" ? ` s="${STYLE_INDEX[style]}"` : "";

  if (given.formula !== undefined) {
    const formula = given.formula.replace(/^\s*=/, "").replace(NOT_XML, "");
    if (!formula.trim()) throw new Error(`The formula in ${ref} is empty.`);
    if (formula.length > MAX_FORMULA) throw new Error(`The formula in ${ref} is longer than Excel takes.`);
    const result = resultXml(value, ref);
    return `<c r="${ref}"${s}${result.type}><f>${escapeXml(formula)}</f>${result.value}</c>`;
  }
  if (typeof value === "number") return `<c r="${ref}"${s}><v>${numberText(value, ref)}</v></c>`;
  if (typeof value === "boolean") return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (value instanceof Date) {
    const serial = dateSerial(value);
    return serial === null ? textCell(ref, s, value.toISOString().slice(0, 10)) : `<c r="${ref}"${s}><v>${serial}</v></c>`;
  }
  if (value === null || value === "") return given.style ? `<c r="${ref}"${s}/>` : "";
  return textCell(ref, s, value);
}

// Text in its own cell (an inline string), or a styled blank when nothing
// of it is left.
function textCell(ref: string, s: string, value: string) {
  const text = cellText(value);
  if (text === "") return s ? `<c r="${ref}"${s}/>` : "";
  // Spaces at either end kept, as Excel marks them (XML keeps the rest).
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t${preserve}>${escapeText(text)}</t></is></c>`;
}

// What a formula works out to, as its cell's type and cached value: none
// for a formula nobody has worked out yet.
function resultXml(value: CellValue, ref: string): { type: string; value: string } {
  if (value === null) return { type: "", value: "" };
  if (typeof value === "number") return { type: "", value: `<v>${numberText(value, ref)}</v>` };
  if (typeof value === "boolean") return { type: ' t="b"', value: `<v>${value ? 1 : 0}</v>` };
  if (value instanceof Date) {
    const serial = dateSerial(value);
    if (serial !== null) return { type: "", value: `<v>${serial}</v>` };
    return { type: ' t="str"', value: `<v>${value.toISOString().slice(0, 10)}</v>` };
  }
  return { type: ' t="str"', value: `<v>${escapeText(cellText(value))}</v>` };
}

// A number as XML writes one, in full: JavaScript's shortest text that
// reads back as the same number. One that isn't a number (NaN, Infinity)
// would make the file one Excel refuses.
function numberText(value: number, ref: string) {
  if (!Number.isFinite(value)) throw new Error(`${ref} isn't a number Excel can hold (${value}).`);
  return String(value);
}

const DAY_MS = 86_400_000;
// 9999-12-31, the last day Excel has.
const LAST_SERIAL = 2_958_465;

// A date as Excel counts days, in its 1900 system: day 1 is 1900-01-01,
// and day 60 is Lotus's 29 February 1900, a day that never was, so days
// from 1 March 1900 count one more. The time of day is the fraction. In
// UTC, so a day on its own (midnight UTC) is a whole day. Null for a date
// Excel can't show (before 1900 or after 9999), which is written as text.
function dateSerial(date: Date): number | null {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new Error("A date cell holds an invalid date.");
  let days = (ms - Date.UTC(1899, 11, 31)) / DAY_MS;
  if (days < 1) return null;
  if (days >= 60) days += 1;
  return days < LAST_SERIAL + 1 ? days : null;
}

// --- Text ---------------------------------------------------------------------

// Text as a cell keeps it: line breaks as Excel writes them (\n), without
// the characters XML can't hold, and at most Excel's 32,767 characters
// (never cutting an emoji in half).
function cellText(text: string) {
  const clean = text.replace(/\r\n?/g, "\n").replace(NOT_XML, "");
  if (clean.length <= MAX_CELL_TEXT) return clean;
  const last = clean.charCodeAt(MAX_CELL_TEXT - 1);
  return clean.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_CELL_TEXT - 1 : MAX_CELL_TEXT);
}

// Text in a cell as XML, with anything that would read as one of Excel's
// _xHHHH_ escapes escaped itself (_x005F_ is the underscore), so it reads
// back as it was written.
function escapeText(text: string) {
  return escapeXml(text.replace(/_(?=x[0-9A-Fa-f]{4}_)/g, "_x005F_"));
}

function escapeXml(text: string) {
  return text.replace(/[&<>"]/g, (c) => ENTITIES[c]);
}

// A footer's own text, on one line: "&" starts one of Excel's codes there
// (&P is the page number), so a real one is written twice. Excel takes 255
// characters for all of it, codes included.
function footerText(text: string) {
  return text.replace(NOT_XML, "").replace(/\s+/g, " ").trim().slice(0, 200).replace(/&/g, "&&");
}

// --- References ---------------------------------------------------------------

// "A" for the first column, "Z", "AA", and so on to "XFD", the last.
function columnName(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// A range such as "B1:AQ40", checked, and as a defined name writes it
// ("$B$1:$AQ$40").
function rangeOf(range: string) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6}):([A-Z]{1,3})([1-9]\d{0,6})$/.exec(range);
  if (!match) throw new Error(`"${range}" isn't a range such as B1:AQ40.`);
  const [, fromColumn, fromRow, toColumn, toRow] = match;
  return { relative: range, absolute: `$${fromColumn}$${fromRow}:$${toColumn}$${toRow}` };
}

function wholeCount(value: number, what: string) {
  if (!Number.isInteger(value) || value < 0 || value >= MAX_ROWS) throw new Error(`${what} is a whole number of rows or columns: ${value} isn't.`);
  return value;
}

// --- The zip --------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

// The zip's checksum, CRC-32, worked out a byte at a time: for a Node
// without its own (before 20.15 and 22.2). Exported for the tests, which
// check the two agree.
export function crc32ByTable(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const crc32: (data: Uint8Array) => number = typeof zlib.crc32 === "function" ? (data) => zlib.crc32(data) : crc32ByTable;

// The parts, each deflated, then the directory that lists them, as every
// unzip reads a zip. Each part is dated when the workbook was made, to the
// two seconds a zip keeps.
function zip(files: { name: string; data: Uint8Array }[], modified: Date): Uint8Array<ArrayBuffer> {
  const year = Math.min(Math.max(modified.getUTCFullYear(), 1980), 2107);
  const dosDate = ((year - 1980) << 9) | ((modified.getUTCMonth() + 1) << 5) | modified.getUTCDate();
  const dosTime = (modified.getUTCHours() << 11) | (modified.getUTCMinutes() << 5) | (modified.getUTCSeconds() >> 1);
  const encoder = new TextEncoder();
  const entries: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const packed = zlib.deflateRawSync(file.data);
    const crc = crc32(file.data);
    if (file.data.length > 0xfffffffe || offset + 30 + name.length + packed.length > 0xfffffffe) throw new Error("The workbook is too big for a zip.");

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // the version that reads deflate
    local.setUint16(8, 8, true); // deflated
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, packed.length, true);
    local.setUint32(22, file.data.length, true);
    local.setUint16(26, name.length, true);
    entries.push(new Uint8Array(local.buffer), name, packed);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(10, 8, true);
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, packed.length, true);
    central.setUint32(24, file.data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    directory.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + packed.length;
  }
  const directorySize = directory.reduce((size, piece) => size + piece.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  const bytes = new Uint8Array(offset + directorySize + 22);
  let at = 0;
  for (const piece of [...entries, ...directory, new Uint8Array(end.buffer)]) {
    bytes.set(piece, at);
    at += piece.length;
  }
  return bytes;
}
