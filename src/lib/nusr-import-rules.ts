// NUSR > Import: bringing in the shop's NUSR workbook, years of unit sales
// kept in Excel (a sheet a year, 2015 to 2026, and Trailers, New and Used),
// so the whole history is in the NUSR tab. Which sheets are NUSR sheets,
// which of their rows are sales (not the TOTAL and AVG rows, the year
// dividers, the template rows or the comparison table), and how each cell
// is read: as the shop typed it, with the plain slips put right and a note
// for each. The figures are worked out again by saleFigures and checked
// against the sheet's own, and a sale on two sheets (Trailers repeats the
// year sheets' trailers; New and Used repeat everything) comes in once. No
// server imports: the browser plans the import, to show what will happen
// before anything is saved, and the server checks every sale again as it
// saves it (importSales in src/lib/nusr-import.ts).

import { HEADER_SEARCH_ROWS, IMPORT_BATCH_BYTES, type ImportNote, type Sheet } from "@/lib/customer-import-rules";
import { cutText } from "@/lib/manual-rules";
import {
  CATEGORIES,
  DEFAULT_BONUS_RATE_BP,
  MAX_RATE_BP,
  MAX_UNIT_YEAR,
  MIN_UNIT_YEAR,
  SALE_LABELS,
  SALE_LIMITS,
  UNIT_TYPES,
  UNIT_TYPE_LABELS,
  checkSale,
  formatMoney,
  guessCategory,
  guessUnitType,
  moneyInput,
  parseCondition,
  parseMoney,
  parseRate,
  rateInput,
  saleFigures,
  type Cents,
  type SaleFields,
  type UnitType,
} from "@/lib/nusr-rules";
import { checkVin } from "@/lib/vin";

// What a sale's form sends: every field as text, as checkSale reads it.
export type SaleInput = Record<keyof SaleFields, string>;

// --- Which sheets, and which columns -------------------------------------------

// "Funding Rec'd" -> "fundingrecd", "Unit Profit %" -> "unitprofitpct",
// "COMS #" -> "coms", "*Notes*" -> "notes".
export const nusrHeading = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/%/g, "pct")
    .replace(/#/g, "")
    .replace(/[^a-z0-9]+/g, "");

// What a column of an NUSR sheet holds, by the headings it goes by (the
// NUSR's own first): something a sale keeps, the holdback (which gives the
// sale its rate), or one of the sheet's formulas that the import checks its
// own workings against.
const HEADINGS = {
  soldOn: ["date", "saledate", "datesold", "solddate"],
  salesperson: ["salesman", "salesperson", "salesrep"],
  customerName: ["customername", "customer", "buyer"],
  customerAddress: ["address", "customeraddress"],
  customerPhone: ["phone", "phonenumber", "customerphone"],
  unitYear: ["year", "modelyear"],
  unitModel: ["model", "unitmodel"],
  condition: ["newused", "nu", "condition"],
  vin: ["vin", "vinnumber", "serialnumber"],
  msrp: ["msrp"],
  salesPrice: ["salesprice", "saleprice"],
  dealerCost: ["dealercost"],
  unitLabor: ["unitlabor"],
  rebate: ["polarisrebate", "rebate", "mfgrebate"],
  notes: ["notes", "note", "comments"],
  accPrice: ["accsalesprice", "accprice"],
  accCost: ["acccost"],
  accLabor: ["acclabor"],
  escPrice: ["escprice"],
  escCost: ["esccost"],
  rewards: ["rewards"],
  holdback: ["holdback"],
  financeCompany: ["financecompany", "lender"],
  amountFinanced: ["amtfinanced", "amountfinanced"],
  downPayment: ["downpymt", "downpayment"],
  fundingReceivedOn: ["fundingrecd", "fundingreceived"],
  paidOn: ["datepaid"],
  comsNumber: ["coms", "comsnumber"],
  category: ["category"],
  unitProfit: ["unitprofit"],
  totalProfit: ["totalprofit"],
  totalBonus: ["totalbonus"],
  holdbackBonus: ["holdbackbonus"],
  salesBonus: ["salesbonus"],
  // The NUSR tab's own columns, on a workbook its Download Excel made: they
  // say outright what the import otherwise works out from the rest.
  unitType: ["type", "typeofdeal", "dealtype"],
  holdbackRate: ["holdbackpct", "holdbackrate"],
  bonusRate: ["bonuspct", "bonusrate"],
  bonusAdjustment: ["bonusadjustment"],
} satisfies Record<string, string[]>;
type Column = keyof typeof HEADINGS;

// The sheet's other formulas, worked out again by the NUSR tab: not read.
const WORKED_OUT = new Set(["unitprofitpct", "accprofit", "accprofitpct", "profitpct"]);

const COLUMN_OF = new Map<string, Column>();
for (const [column, headings] of Object.entries(HEADINGS) as [Column, string[]][]) {
  for (const heading of headings) if (!COLUMN_OF.has(heading)) COLUMN_OF.set(heading, column);
}

// Where a sheet's headings are and what each column is. The column beside
// Polaris Rebate with no heading holds the notes on most sheets, but on the
// Used sheet half the rows keep the rebate there instead. Columns with a
// heading the log has no field for go in the notes, under their heading.
type Layout = {
  header: number;
  headings: string[];
  columns: Partial<Record<Column, number>>;
  besideRebate: number | null;
  others: number[];
};

// The headings an NUSR sheet can't do without.
const NEEDED: Column[] = ["soldOn", "customerName", "salesPrice"];

// The headings row, among the first few: the one that names the most
// columns, with a Date, a Customer Name, a Sales Price and a VIN or a
// Salesman. Null when no row does: not an NUSR sheet.
function layoutOf(rows: string[][]): Layout | null {
  let best: Layout | null = null;
  let bestCount = 0;
  for (let index = 0; index < rows.length && index < HEADER_SEARCH_ROWS; index++) {
    const headings = rows[index];
    const columns: Partial<Record<Column, number>> = {};
    let count = 0;
    headings.forEach((heading, column) => {
      const found = COLUMN_OF.get(nusrHeading(heading));
      if (found && columns[found] === undefined) {
        columns[found] = column;
        count++;
      }
    });
    if (!NEEDED.every((column) => columns[column] !== undefined) || (columns.vin === undefined && columns.salesperson === undefined)) continue;
    if (count <= bestCount) continue;
    const unheaded = (column: number) => column > (columns.soldOn ?? 0) && !(headings[column] ?? "").trim();
    const rebate = columns.rebate;
    const besideRebate = rebate === undefined ? null : unheaded(rebate + 1) ? rebate + 1 : unheaded(rebate - 1) ? rebate - 1 : null;
    const others = headings.flatMap((heading, column) => {
      const key = nusrHeading(heading);
      return key && !COLUMN_OF.has(key) && !WORKED_OUT.has(key) ? [column] : [];
    });
    best = { header: index, headings, columns, besideRebate, others };
    bestCount = count;
  }
  return best;
}

const cellAt = (cells: readonly string[], column: number | null | undefined) =>
  column === undefined || column === null ? "" : (cells[column] ?? "").replace(/\u0000/g, "").trim();
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const quoted = (text: string) => `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`;

const LABEL_ROW = /^(?:total|avg)\b/i;
const COMPARISON = /^comparison$/i;
// A date cell as the reader gives it ("2024-06-14"), or a date as typed.
const DATE_LIKE = /^\d{1,4}(?:[/.-]+\d{1,4}){1,3}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/;

// What a row of an NUSR sheet is, by the sheet's own pattern: a sale has a
// customer and a date (a date cell, or typed like one), a salesman, a VIN
// or a sales price. So a sale with no salesman counts (the NUSR tab logs
// sales without one), and so does one whose date was left blank or typed
// some other way: it's left out with a note, not dropped without a word.
// Anything else is a spacer, a year divider, a row of formulas waiting for
// a sale, or a stray number. "end" is the first TOTAL, AVG or Comparison
// row, under the last sale: nothing below it is read.
function rowKind(cells: readonly string[], layout: Layout): "sale" | "end" | "other" {
  const salesman = cellAt(cells, layout.columns.salesperson);
  const customer = cellAt(cells, layout.columns.customerName);
  if (LABEL_ROW.test(salesman) || COMPARISON.test(salesman) || COMPARISON.test(customer)) return "end";
  if (customer === "") return "other";
  const dated = DATE_LIKE.test(cellAt(cells, layout.columns.soldOn));
  return dated || salesman !== "" || cellAt(cells, layout.columns.vin) !== "" || cellAt(cells, layout.columns.salesPrice) !== "" ? "sale" : "other";
}

// The sale rows of a sheet (their index in rows), and where the TOTAL rows
// under them start, if they do.
function dealRowsOf(rows: readonly string[][], layout: Layout): { rows: number[]; end: number | null } {
  const found: number[] = [];
  for (let index = layout.header + 1; index < rows.length; index++) {
    const kind = rowKind(rows[index], layout);
    if (kind === "end") return { rows: found, end: index };
    if (kind === "sale") found.push(index);
  }
  return { rows: found, end: null };
}

// "2026" -> 2026: a sheet named for its year.
const yearOf = (name: string) => {
  const match = /^\s*(\d{4})\s*$/.exec(name);
  const year = match ? Number(match[1]) : null;
  return year !== null && year >= 2000 && year <= 2100 ? year : null;
};

// A workbook's NUSR sheets: where they are, their year (a sheet named for
// one), how many sales each holds, whether it's hidden in the workbook, and
// whether it's in the import to start with. When there are year sheets, New
// and Used repeat them (every new and every used unit since 2015, copied
// from the year sheets), so they're offered but left out to start with, as
// is a hidden sheet (often an old copy); any other NUSR sheet (Trailers) is
// in, its sales already on a year sheet left out as the same sales.
export type NusrSheet = {
  index: number;
  name: string;
  year: number | null;
  sales: number;
  repeats: boolean;
  hidden: boolean;
  chosen: boolean;
};

// --- Reading a cell -----------------------------------------------------------------

type Day = { year: number; month: number; day: number };

const two = (n: number) => String(n).padStart(2, "0");
const dayText = (day: Day) => `${day.year}-${two(day.month)}-${two(day.day)}`;
const isDay = ({ year, month, day }: Day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
// "12 days", "5 months", "17 years".
const span = (days: number) =>
  days < 120 ? `${days} days` : days < 730 ? `${Math.round(days / 30.44)} months` : `${Math.round(days / 365.25)} years`;
// What a date box takes (parseIsoDate in nusr-rules): 2000 to 2100.
const storable = (day: Day) => day.year >= 2000 && day.year <= 2100;
const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;

const DATE_CELL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/;

// A date as the reader gives a date cell ("2024-06-14"), or as it was
// typed, slips and all: "6/14/24", "0614/24" (no slash between the month
// and the day), "6/14/2/4" (a slash in the year), "06/14//24" and
// "006/14/24". Two-digit years are this century's. Null when it isn't a
// day: "06/314/24", "0/14/24", "6/14/224".
export function readSheetDate(text: string): { date: Day; typed: boolean } | null {
  const value = text.trim();
  const cell = DATE_CELL.exec(value);
  if (cell) {
    const date = { year: Number(cell[1]), month: Number(cell[2]), day: Number(cell[3]) };
    return isDay(date) ? { date, typed: false } : null;
  }
  if (!DATE_LIKE.test(value)) return null;
  const parts = value
    .replace(/[ T]\d{1,2}:\d{2}(?::\d{2})?$/, "")
    .split(/\D+/)
    .filter(Boolean);
  let month: string;
  let day: string;
  let year: string;
  if (parts.length === 2) {
    // "0614/24": the month and day run together.
    if (parts[0].length < 3) return null;
    [month, day, year] = [parts[0].slice(0, -2), parts[0].slice(-2), parts[1]];
  } else if (parts.length === 3 && parts[0].length === 4) {
    [year, month, day] = parts;
  } else {
    [month, day] = parts;
    year = parts.slice(2).join("");
  }
  if (year.length !== 4 && year.length > 2) return null;
  const date = { year: year.length === 4 ? Number(year) : 2000 + Number(year), month: Number(month), day: Number(day) };
  return isDay(date) ? { date, typed: true } : null;
}

// An Excel date that lost its date format: 45457 is 2024-06-14.
function serialDay(text: string): Day | null {
  if (!/^\d{5}(?:\.0+)?$/.test(text)) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Number(text.split(".")[0]) * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

const EXCEL_ERROR = /^#(?:DIV\/0!|N\/A|REF!|VALUE!|NAME\?|NUM!|NULL!|SPILL!|CALC!)$/i;
const SLASH_DATE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
// What the shop typed for "nothing here": N/A on a trade's payment, a dash.
const NOTHING = /^(?:n\/?a|-+|none)$/i;

// An amount as a cell holds it: a number (as the reader gives it, or typed
// as parseMoney reads one), "4590..50" (a dot typed twice), a date (in the
// wrong column), an error the sheet shows (#DIV/0!), or words.
type Amount = { cents: Cents | null; read?: string } | { date: Day } | { error: string } | { text: string };

function readAmount(text: string): Amount {
  const value = text.trim();
  if (value === "") return { cents: null };
  if (DATE_CELL.test(value) || SLASH_DATE.test(value)) {
    const read = readSheetDate(value);
    if (read) return { date: read.date };
  }
  if (EXCEL_ERROR.test(value) || /^(?:true|false)$/i.test(value)) return { error: value };
  const money = parseMoney(value);
  if ("cents" in money) return money;
  if (/^-?\d[\d,]*\.\.\d+$/.test(value)) {
    const again = parseMoney(value.replace("..", "."));
    if ("cents" in again) return { cents: again.cents, read: value.replace("..", ".") };
  }
  // 1.5E-7: a remainder too small to show.
  if (/^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(value) && Math.abs(Number(value)) < 1e9) return { cents: Math.round(Number(value) * 100) };
  return { text: value };
}

// A figure the sheet worked out, as a number, for checking (null when it
// shows none, or an error).
const cachedNumber = (text: string) => (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : null);
const cachedCents = (text: string) => {
  const number = cachedNumber(text);
  return number === null ? null : Math.round(number * 100);
};

// The MSRP column's words for a deal with no MSRP.
function markerOf(text: string): UnitType | null {
  if (/^\s*trai/i.test(text)) return "trailer";
  if (/^\s*tra/i.test(text)) return "trade";
  if (/contest/i.test(text)) return "contest";
  if (/free/i.test(text)) return "free";
  return null;
}

// --- Names --------------------------------------------------------------------------

// Whether two names are within this many edits of each other (letters
// added, dropped or changed): "Sam Tellr" and "Sam Teller" are one.
function withinEdits(a: string, b: string, most: number) {
  if (Math.abs(a.length - b.length) > most) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      least = Math.min(least, current[j]);
    }
    if (least > most) return false;
    previous = current;
  }
  return previous[b.length] <= most;
}

// "keystone" is the first word of "keystone finance".
const startsWords = (short: string, long: string) => long.length > short.length && long.startsWith(`${short} `);

// The names a sheet's salesmen or lenders go by, as each is spelt most
// often. Case and spacing don't count ("sam Teller", "Keystone "), and a
// name that is the first words of a more common one ("Keystone Finance Co"
// and "Keystone") is that one, when it can only be that one. A slip or two
// from a much more common name ("Sam Tellr", "Keystne", "Keyst one") is
// that one only when it's on one sale and 8 letters or more: a short name
// or one on several sales may be someone else a letter apart ("Abe" and
// "Ade", or two banks' initials), so it's kept as typed, with the name it
// may be. Each name typed comes with the sale it's on (its customer and
// date), so a row copied onto New or Used is still one sale. By lower-cased
// name: the name it goes by, whether that's another name's, and the name
// it may be.
type Names = Map<string, { name: string; merged: boolean; mayBe: string | null }>;

const LOOK_ALIKE_LETTERS = 8;

function namesOf(typed: readonly { name: string; sale: string }[]): Names {
  const groups = new Map<string, { count: number; sales: Set<string>; spellings: Map<string, number> }>();
  for (const { name: text, sale } of typed) {
    const name = oneLine(text);
    if (!name) continue;
    const group = groups.get(name.toLowerCase()) ?? { count: 0, sales: new Set<string>(), spellings: new Map<string, number>() };
    group.count++;
    group.sales.add(sale);
    group.spellings.set(name, (group.spellings.get(name) ?? 0) + 1);
    groups.set(name.toLowerCase(), group);
  }
  // Each name as most rows spell it (one with capitals over one without).
  const spelling = (spellings: Map<string, number>) =>
    [...spellings].sort((a, b) => b[1] - a[1] || Number(b[0] !== b[0].toLowerCase()) - Number(a[0] !== a[0].toLowerCase()) || (a[0] < b[0] ? -1 : 1))[0][0];
  const ranked = [...groups]
    .map(([key, group]) => ({ key, count: group.count, sales: group.sales.size, name: spelling(group.spellings) }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const kept: typeof ranked = [];
  const names: Names = new Map();
  for (const entry of ranked) {
    const firstWords = (other: (typeof ranked)[number]) =>
      other.count > entry.count && (startsWords(entry.key, other.key) || startsWords(other.key, entry.key));
    const into = kept.filter(
      (other) =>
        firstWords(other) ||
        (other.count >= 5 * entry.count && withinEdits(entry.key, other.key, Math.min(entry.key.length, other.key.length) >= 6 ? 2 : 1)),
    );
    const slip = entry.sales === 1 && entry.key.replace(/[^\p{L}]/gu, "").length >= LOOK_ALIKE_LETTERS;
    if (into.length === 1 && (firstWords(into[0]) || slip)) {
      names.set(entry.key, { name: into[0].name, merged: true, mayBe: null });
    } else {
      kept.push(entry);
      names.set(entry.key, { name: entry.name, merged: false, mayBe: into.length === 1 ? into[0].name : null });
    }
  }
  return names;
}

// --- Finding a sale again -----------------------------------------------------------

// A sale as matching sees it: where it was imported from ("2026!374", the
// sheet and row; null when it was typed in), its VIN, the day it was sold
// (null when the sheet's date can't be read), the customer, the price and
// the model. A sale already in the NUSR when the server saves a batch has
// onFile: its id, and whether this same import added it (an earlier batch,
// or this one sent again); planned sales and the batch's own have none.
export type KnownSale = {
  ref: string | null;
  vin: string | null;
  soldOn: string | null;
  customerName: string;
  salesPrice: Cents | null;
  unitModel?: string | null;
  onFile?: { id: string; thisImport: boolean } | null;
};

export type SaleMatch = "ref" | "vinDay" | "vinCustomer" | "customerPrice" | "customerDay";

export const MATCH_WORDS: Record<SaleMatch, string> = {
  ref: "the same row of the same sheet",
  vinDay: "the same VIN, sold the same day",
  vinCustomer: "the same VIN, sold to the same customer",
  customerPrice: "the same customer and sales price, within a week",
  customerDay: "the same customer the same day, one of them with no sales price",
};

// Customers are matched on their name's letters and digits: "Hollow Creek
// Farms, Inc." and "Hollow Creek Farms Inc" are one.
export const customerKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

// "2026!374" -> "2026".
export const refSheet = (ref: string | null) => (ref ? ref.slice(0, ref.lastIndexOf("!")) : null);

// "2026!374", as the import keeps where a sale came from.
export const isImportRef = (ref: unknown): ref is string => typeof ref === "string" && /^[^\u0000!][^\u0000]{0,99}![1-9]\d{0,6}$/.test(ref);

export const refLabel = (ref: string) => `the ${refSheet(ref)} sheet, row ${ref.slice(ref.lastIndexOf("!") + 1)}`;

// Whether a VIN is whole and right: 17 characters, its check digit
// matching the rest.
function isWholeVin(vin: string | null) {
  if (!vin) return false;
  const checked = checkVin(vin);
  return checked.status === "ok" && checked.checkDigitOk && checked.vin === vin;
}

// Models are compared on their letters and digits, as customers are; a
// sale without one agrees with any.
const sameModel = (a: string | null | undefined, b: string | null | undefined) => !a || !b || customerKey(a) === customerKey(b);

// The sales known so far (planned already, or on file), to find a sale
// again: the same row of the same sheet, for the same unit or customer
// (importing a file again); the same VIN sold the same day (what the log
// can't hold twice); the same VIN sold to the same customer (a date typed
// differently on another sheet); the same customer and sales price within
// a week, with VINs that could be one: one left out, one a character off
// the other or inside it (a VIN typed wrong, with something typed before
// it), or the sale's VIN another sale's already (copied from the wrong
// row); or the same customer the same day when one of them has no sales
// price yet (logged before its numbers were in), unless both have whole
// VINs that differ or their models do. Two different VINs that are both
// whole and right are two units, so a customer's several units of a model
// bought together stay several. Those last two, the customer rules, never
// match two rows of one sheet, as rows of the file in hand or of sales
// this same import added; a sale an earlier import brought in from that
// sheet is matched once the rows have moved (this row's place is another
// sale's now, or that sale's is), so a row moved down or up by one put in
// or taken out above is found again without a VIN. And they find a sale on
// file only while this import hasn't found it already, in any way, so one
// sale never stands for two of the file's: found (the ids of the sales
// found by earlier batches of the import) carries that from batch to
// batch, and only ever narrows what's found. When a sale's row is already
// taken by another sale (the file has changed since), refTaken says so.
export function saleFinder(known: readonly KnownSale[] = [], found: Iterable<string> = []) {
  const byRef = new Map<string, KnownSale>();
  const byVinDay = new Map<string, KnownSale>();
  const byVinCustomer = new Map<string, KnownSale>();
  const vins = new Set<string>();
  const byCustomer = new Map<string, KnownSale[]>();
  // Sales on file this import has found, and those whose row is another
  // sale's now.
  const taken = new Set(found);
  const moved = new Set<string>();
  const whole = new Map<string, boolean>();
  const isWhole = (vin: string | null) => {
    if (!vin) return false;
    if (!whole.has(vin)) whole.set(vin, isWholeVin(vin));
    return whole.get(vin)!;
  };
  // An earlier import's sale on file (not this one's).
  const earlier = (sale: KnownSale) => (sale.onFile && !sale.onFile.thisImport ? sale.onFile.id : null);

  function add(sale: KnownSale) {
    const customer = customerKey(sale.customerName);
    if (sale.ref && !byRef.has(sale.ref)) byRef.set(sale.ref, sale);
    if (sale.vin && sale.soldOn && !byVinDay.has(`${sale.vin}|${sale.soldOn}`)) byVinDay.set(`${sale.vin}|${sale.soldOn}`, sale);
    if (sale.vin && customer && !byVinCustomer.has(`${sale.vin}|${customer}`)) byVinCustomer.set(`${sale.vin}|${customer}`, sale);
    if (sale.vin) vins.add(sale.vin);
    if (customer && sale.soldOn) {
      const list = byCustomer.get(customer);
      if (list) list.push(sale);
      else byCustomer.set(customer, [sale]);
    }
  }

  function find(sale: KnownSale): { match: KnownSale; how: SaleMatch } | { match: null; refTaken: boolean } {
    const matched = (match: KnownSale, how: SaleMatch) => {
      const id = earlier(match);
      if (id) taken.add(id);
      return { match, how };
    };
    const customer = customerKey(sale.customerName);
    let refTaken = false;
    const onRef = sale.ref ? byRef.get(sale.ref) : undefined;
    if (onRef) {
      if ((sale.vin && onRef.vin === sale.vin) || (customer && customerKey(onRef.customerName) === customer)) return matched(onRef, "ref");
      refTaken = true;
      const id = earlier(onRef);
      if (id) moved.add(id);
    }
    const vinDay = sale.vin && sale.soldOn ? byVinDay.get(`${sale.vin}|${sale.soldOn}`) : undefined;
    if (vinDay) return matched(vinDay, "vinDay");
    const vinCustomer = sale.vin && customer ? byVinCustomer.get(`${sale.vin}|${customer}`) : undefined;
    if (vinCustomer) return matched(vinCustomer, "vinCustomer");
    if (!customer || !sale.soldOn) return { match: null, refTaken };
    const day = dayNumber(sale.soldOn);
    const sheet = refSheet(sale.ref);
    const open = (other: KnownSale) => {
      if (other.onFile && taken.has(other.onFile.id)) return false;
      if (sheet === null || refSheet(other.ref) !== sheet) return true;
      const id = earlier(other);
      return id !== null && (refTaken || moved.has(id));
    };
    const others = byCustomer.get(customer) ?? [];
    if (sale.salesPrice !== null) {
      const copied = sale.vin !== null && vins.has(sale.vin);
      const couldBeOne = (other: string | null) => {
        if (!sale.vin || !other || copied) return true;
        if (isWhole(sale.vin) && isWhole(other)) return false;
        const inside = Math.min(sale.vin.length, other.length) >= 8 && (sale.vin.includes(other) || other.includes(sale.vin));
        return inside || withinEdits(sale.vin, other, 1);
      };
      const near = others.find(
        (other) => other.salesPrice === sale.salesPrice && Math.abs(dayNumber(other.soldOn!) - day) <= 7 && couldBeOne(other.vin) && open(other),
      );
      if (near) return matched(near, "customerPrice");
    }
    const sameDay = others.find(
      (other) =>
        other.soldOn === sale.soldOn &&
        (other.salesPrice === null || sale.salesPrice === null) &&
        !(isWhole(sale.vin) && isWhole(other.vin) && sale.vin !== other.vin) &&
        sameModel(sale.unitModel, other.unitModel) &&
        open(other),
    );
    if (sameDay) return matched(sameDay, "customerDay");
    return { match: null, refTaken };
  }

  for (const sale of known) add(sale);
  return { add, find };
}

// --- Planning ---------------------------------------------------------------------------

// What a note is about, to group them by.
export const NOTE_KINDS = ["skipped", "duplicate", "repeat", "onFile", "date", "payment", "amount", "figures", "vin", "unit", "name", "other"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  skipped: "Left out",
  duplicate: "On another sheet too",
  repeat: "May be on a year sheet too",
  onFile: "Already in the NUSR",
  date: "Sale dates",
  payment: "Funding and payment",
  amount: "Amounts",
  figures: "Figures the sheet worked out differently",
  vin: "VINs",
  unit: "New/Used, type and category",
  name: "Salesmen and lenders",
  other: "Other",
};

// A note on one row of one sheet: as the customer import's, with the sheet
// and what it's about.
export type NusrImportNote = ImportNote & { sheet: string; kind: NoteKind };

// A sale to import: where it came from, the fields the server gets, and
// the same fields checked (for the preview's figures).
export type PlannedSale = { ref: string; sheet: string; row: number; fields: SaleInput; sale: SaleFields };

// What a chosen sheet adds: its sales, those to add, those on another sheet
// too and those left out, and the row its TOTAL rows start on (not read).
export type SheetPlan = { index: number; name: string; sales: number; toAdd: number; duplicates: number; skipped: number; totalsFrom: number | null };

export type NusrImportPlan = { sales: PlannedSale[]; sheets: SheetPlan[]; notes: NusrImportNote[] };

type Note = { kind: NoteKind; message: string };

// The amounts typed on a sale, besides the MSRP and the rebate (read
// differently) and the bonus adjustment (worked out).
const TYPED_AMOUNTS = ["salesPrice", "dealerCost", "unitLabor", "accPrice", "accCost", "accLabor", "escPrice", "escCost", "rewards", "amountFinanced", "downPayment"] as const;

// Where a sale's date sits among the other dates on its sheet: a date in
// another year that fits between the rows around it (allowing a month for
// rows out of order) is a slip in the year.
const FITS_DAYS = 31;

// A sale's Date as readSheetDate reads it, or an Excel day number that lost
// its date format (45457).
function saleDay(typed: string): { date: Day; typed: boolean; serial: boolean } | null {
  const read = readSheetDate(typed);
  if (read) return { ...read, serial: false };
  const serial = serialDay(typed);
  return serial ? { date: serial, typed: true, serial: true } : null;
}

// Each sale row's date on a sheet, as read: a year sheet's date in another
// year ("2023-06-14" on the 2024 sheet, "1924-06-14" on the 2024 sheet)
// takes the sheet's year when that puts it between the rows around it, or
// when its own year can't be right; otherwise it's kept, with a note.
function saleDates(rows: readonly string[][], sales: readonly number[], layout: Layout, sheetYear: number | null) {
  const read = sales.map((index) => {
    const typed = cellAt(rows[index], layout.columns.soldOn);
    return { typed, read: saleDay(typed) };
  });
  const inYear = read.map((entry) => (entry.read && entry.read.date.year === sheetYear ? dayNumber(dayText(entry.read.date)) : null));
  const nearest = (from: number, step: number) => {
    for (let at = from + step; at >= 0 && at < inYear.length; at += step) if (inYear[at] !== null) return inYear[at];
    return null;
  };
  return read.map(({ typed, read: date }, at): { soldOn: string; notes: Note[] } | { problem: string } => {
    if (!date) return { problem: typed ? `Date ${quoted(typed)} isn't a day: left out.` : "No Date: left out." };
    const notes: Note[] = [];
    let day = date.date;
    if (date.serial) notes.push({ kind: "date", message: `Date ${typed} read as the date ${dayText(day)}.` });
    else if (date.typed) notes.push({ kind: "date", message: `Date ${quoted(typed)} read as ${dayText(day)}.` });
    if (sheetYear !== null && day.year !== sheetYear) {
      const moved = { ...day, year: sheetYear };
      const before = nearest(at, -1);
      const after = nearest(at, 1);
      const fits = isDay(moved) && (before === null || dayNumber(dayText(moved)) >= before - FITS_DAYS) && (after === null || dayNumber(dayText(moved)) <= after + FITS_DAYS);
      if (isDay(moved) && (fits || !storable(day))) {
        notes.push({ kind: "date", message: `Date ${dayText(day)} is on the ${sheetYear} sheet: read as ${dayText(moved)}${fits ? "" : ". Check it"}.` });
        day = moved;
      } else {
        notes.push({
          kind: "date",
          message: `Date ${dayText(day)} is on the ${sheetYear} sheet, but in ${sheetYear} it wouldn't fall between the rows around it: kept as ${dayText(day)}. Check it.`,
        });
      }
    }
    if (!storable(day)) return { problem: `Date ${dayText(day)} can't be right: left out.` };
    return { soldOn: dayText(day), notes };
  });
}

// A VIN as the log keeps one (upper-cased, letters and digits only), with
// a note when it can't be right: kept as typed all the same, since a typo
// is only a typo. "NONE" is none. A whole VIN never has I, O or Q, so
// those are read as the 1 and 0 they pass for.
function readVin(typed: string, note: (kind: NoteKind, message: string) => void, moved: string[]): string {
  const raw = oneLine(typed);
  if (!raw) return "";
  if (NOTHING.test(raw)) {
    note("vin", `VIN ${quoted(raw)}: left blank.`);
    return "";
  }
  let vin = raw.toUpperCase().replace(/^VIN(?:NO|NUMBER)?[.:#\s]*/, "").replace(/[\s-]+/g, "");
  if (/[^A-Z0-9]/.test(vin)) {
    note("vin", `VIN ${quoted(raw)} has characters a VIN never has: read as ${vin.replace(/[^A-Z0-9]/g, "")}.`);
    vin = vin.replace(/[^A-Z0-9]/g, "");
  }
  if (vin.length > SALE_LIMITS.vin) {
    moved.push(`VIN: ${raw}`);
    note("vin", `VIN ${quoted(raw)} is too long to be one: put in the notes.`);
    return "";
  }
  if (vin.length === 17 && /[IOQ]/.test(vin)) {
    const fixed = vin.replace(/I/g, "1").replace(/[OQ]/g, "0");
    note("vin", `VIN ${vin} has an I, O or Q, which a VIN never has: read as ${fixed}.`);
    vin = fixed;
  }
  const checked = checkVin(vin);
  if (checked.status === "ok" && !checked.checkDigitOk) {
    note("vin", `VIN ${vin}: its check digit (the 9th character) doesn't match the rest, so a character may be off. Kept as typed.`);
  } else if (checked.status !== "ok" && vin) {
    note("vin", `VIN ${vin} has ${vin.length} characters (a whole VIN has 17): kept as typed.`);
  }
  return vin;
}

// What the sheet's columns hold on a sale's row, read into the fields a
// sale's form sends; the notes say what was read another way.
function readSale(context: { layout: Layout; salespeople: Names; lenders: Names; today: string | null }, cells: readonly string[], soldOn: string) {
  const { layout, today } = context;
  const notes: Note[] = [];
  const note = (kind: NoteKind, message: string) => notes.push({ kind, message });
  const value = (column: Column) => cellAt(cells, layout.columns[column]);
  // The heading as the sheet writes it.
  const heading = (column: Column) => oneLine(layout.headings[layout.columns[column] ?? -1] ?? "") || SALE_LABELS[column as keyof SaleFields] || column;
  // The sale's notes: the sheet's own (its Notes column and any column
  // without a heading), then words found where an amount should be.
  const sheetNotes: string[] = [];
  const moved: string[] = [];

  const amounts = Object.fromEntries(TYPED_AMOUNTS.map((field) => [field, null])) as Record<(typeof TYPED_AMOUNTS)[number], Cents | null>;
  let dateInDownPayment: { day: Day; typed: string } | null = null;
  for (const field of TYPED_AMOUNTS) {
    const typed = value(field);
    const read = readAmount(typed);
    if ("cents" in read) {
      amounts[field] = read.cents;
      if (read.read) note("amount", `${heading(field)} ${quoted(typed)} read as ${read.read}.`);
    } else if ("date" in read && field === "downPayment") {
      dateInDownPayment = { day: read.date, typed };
    } else if ("error" in read) {
      note("amount", `${heading(field)} shows ${typed}: left blank.`);
    } else {
      moved.push(`${heading(field)}: ${typed}`);
      note("amount", `${heading(field)} ${quoted(typed)} isn't an amount: put in the notes.`);
    }
  }

  // Polaris Rebate, or the column beside it when that's where the row keeps
  // it (whichever holds a number). Words in either are notes.
  const rebateCells = [
    { typed: value("rebate"), beside: false },
    ...(layout.besideRebate !== null ? [{ typed: cellAt(cells, layout.besideRebate), beside: true }] : []),
  ].map((entry) => ({ ...entry, read: readAmount(entry.typed) }));
  const unitProfit = cachedCents(value("unitProfit"));
  const withoutRebate = (amounts.salesPrice ?? 0) - (amounts.dealerCost ?? 0) - (amounts.unitLabor ?? 0);
  const numbers = rebateCells.flatMap((entry) => ("cents" in entry.read && entry.read.cents !== null ? [{ ...entry, cents: entry.read.cents }] : []));
  // Both hold a number: the one the sheet's Unit Profit adds. A number
  // only beside it that the Unit Profit leaves out is a note.
  const adds = (cents: number) => unitProfit !== null && Math.abs(withoutRebate + cents - unitProfit) <= 1;
  let rebate: (typeof numbers)[number] | null = numbers.length === 2 ? (numbers.find((entry) => adds(entry.cents)) ?? numbers[0]) : (numbers[0] ?? null);
  if (rebate?.beside && numbers.length === 1 && unitProfit !== null && !adds(rebate.cents) && Math.abs(withoutRebate - unitProfit) <= 1) rebate = null;
  for (const entry of rebateCells) {
    if (!entry.typed || (rebate && entry.beside === rebate.beside)) continue;
    const read = entry.read;
    // A zero adds nothing; words beside the rebate are the row's notes.
    if ("cents" in read && read.cents === 0) continue;
    if (entry.beside && !("cents" in read)) sheetNotes.push(oneLine(entry.typed));
    else if ("error" in read) note("amount", `${heading("rebate")} shows ${entry.typed}: left blank.`);
    else {
      moved.push(`${heading("rebate")}: ${entry.typed}`);
      note("amount", `${heading("rebate")} ${quoted(entry.typed)} isn't the rebate this row's Unit Profit adds: put in the notes.`);
    }
  }

  // MSRP: a number, or the deal's kind.
  const msrpTyped = value("msrp");
  const msrpRead = readAmount(msrpTyped);
  let msrp: Cents | null = null;
  let marker: UnitType | null = null;
  if ("cents" in msrpRead) msrp = msrpRead.cents;
  else if ("text" in msrpRead) marker = markerOf(msrpTyped);
  if (msrpTyped && msrp === null && !marker) {
    moved.push(`${heading("msrp")}: ${msrpTyped}`);
    note("unit", `${heading("msrp")} ${quoted(msrpTyped)} isn't an amount, Trade, Trailer, Contest or Free: put in the notes.`);
  }

  const model = oneLine(value("unitModel"));
  const categoryTyped = oneLine(value("category"));
  let category: string | null = CATEGORIES.find((name) => name.toLowerCase() === categoryTyped.toLowerCase()) ?? null;
  if (categoryTyped && !category) {
    moved.push(`${heading("category")}: ${categoryTyped}`);
    note("unit", `${heading("category")} ${quoted(categoryTyped)} isn't ${CATEGORIES.join(", ").replace(/, ([^,]+)$/, " or $1")}: put in the notes.`);
  }
  category ??= guessCategory(model);

  const conditionTyped = value("condition");
  let condition = parseCondition(conditionTyped);
  const trailer = category === "Trailer" || guessCategory(model) === "Trailer";
  // The kind of deal, as the NUSR tab's Type column says it ("New whole
  // good", "Trade"), or else from the MSRP column and the unit.
  const typeTyped = oneLine(value("unitType"));
  const typeGiven = UNIT_TYPES.find((type) => [type, UNIT_TYPE_LABELS[type]].some((name) => name.toLowerCase() === typeTyped.toLowerCase())) ?? null;
  if (typeTyped && !typeGiven) {
    moved.push(`${heading("unitType")}: ${typeTyped}`);
    note("unit", `${heading("unitType")} ${quoted(typeTyped)} isn't a kind of deal the NUSR keeps: worked out from the MSRP column instead.`);
  }
  const unitType: UnitType =
    typeGiven ?? marker ?? (msrp !== null ? (trailer ? "trailer" : "whole_good") : guessUnitType({ condition, category, model }));
  if (!typeGiven && !marker && msrp === null) note("unit", `No MSRP, and nothing to say what kind of deal it is: taken as ${UNIT_TYPE_LABELS[unitType].toLowerCase()}.`);
  if (unitType === "trailer") category ??= "Trailer";
  if (unitType === "trade" && condition === "new") {
    condition = "used";
    note("unit", `${heading("condition")} says N, but the MSRP column says Trade: imported as used.`);
  }
  if (!condition) {
    condition = unitType === "trade" ? "used" : "new";
    note("unit", `${conditionTyped ? `${heading("condition")} ${quoted(conditionTyped)} isn't N or U` : `No ${heading("condition")}`}: taken as ${condition}.`);
  }
  if (condition === "used" && unitType === "whole_good") {
    note("unit", `${heading("condition")} says U, but the MSRP column has a price, as for a new whole good: imported as a used whole good. Check it.`);
  }

  const yearTyped = value("unitYear");
  const unitYear = /^\d{4}$/.test(yearTyped) && Number(yearTyped) >= MIN_UNIT_YEAR && Number(yearTyped) <= MAX_UNIT_YEAR ? yearTyped : "";
  if (yearTyped && !unitYear) note("unit", `${heading("unitYear")} ${quoted(yearTyped)} isn't a model year: left blank.`);

  const vin = readVin(value("vin"), note, moved);

  // A rate the NUSR tab's own columns give: a share as Excel keeps a
  // percentage (0.04, or 1 for 100%), a percentage typed as one (4, "4%"),
  // or null when there's none or it can't be one.
  const givenRate = (column: Column) => {
    const typed = value(column);
    if (!typed) return null;
    const share = cachedNumber(typed);
    // 1 is 100%, as Excel keeps it (and as the download writes every rate).
    const read = share === null ? parseRate(typed) : { bp: Math.round(share > 1 ? share * 100 : share * 10_000) };
    if ("bp" in read && read.bp !== null && read.bp >= 0 && read.bp <= MAX_RATE_BP) return read.bp;
    note("figures", `${heading(column)} ${quoted(typed)} isn't a rate: worked out from the sheet's figures instead.`);
    return null;
  };

  // The holdback's rate: the sheet's Holdback over the MSRP, to the basis
  // point (4%, 5%, 7% as the years went), none without an MSRP.
  const holdbackTyped = value("holdback");
  const holdback = cachedNumber(holdbackTyped);
  const holdbackGiven = givenRate("holdbackRate");
  let holdbackRateBp = holdbackGiven ?? 0;
  if (holdbackGiven === null && msrp !== null && msrp !== 0) {
    if (holdback !== null && holdback !== 0) {
      const bp = Math.round((holdback * 100 * 10_000) / msrp);
      if (bp >= 0 && bp <= MAX_RATE_BP) holdbackRateBp = bp;
      else note("figures", `${heading("holdback")} ${formatMoney(Math.round(holdback * 100))} can't be a share of the MSRP (${formatMoney(msrp)}): none worked out.`);
    } else if (holdback === null && holdbackTyped) {
      note("figures", `${heading("holdback")} ${quoted(holdbackTyped)} isn't an amount: none worked out.`);
    } else if (unitType === "whole_good" && condition === "new") {
      note("figures", `No ${heading("holdback")} on the sheet for this new whole good: imported with none.`);
    }
  }

  // The bonus's rate: TOTAL BONUS over TOTAL PROFIT (10% every year; none
  // where the sheet zeroed a loss deal's bonus).
  const totalProfit = cachedNumber(value("totalProfit"));
  const totalBonus = cachedNumber(value("totalBonus"));
  const bonusGiven = givenRate("bonusRate");
  let bonusRateBp = bonusGiven ?? DEFAULT_BONUS_RATE_BP;
  if (bonusGiven === null && totalProfit !== null && Math.abs(totalProfit) >= 1 && totalBonus !== null) {
    const bp = Math.round((totalBonus / totalProfit) * 10_000);
    if (bp >= 0 && bp <= MAX_RATE_BP) bonusRateBp = bp;
    else note("figures", `${heading("totalBonus")} isn't a share of ${heading("totalProfit")} on the sheet: worked out at the usual ${rateInput(DEFAULT_BONUS_RATE_BP)}%.`);
  }
  // A Sales Bonus the sheet changed by hand (TOTAL BONUS less Holdback
  // Bonus, less $100, say) keeps the change as the sale's adjustment.
  // The NUSR tab's own Bonus adjustment column says it outright.
  const holdbackBonus = cachedNumber(value("holdbackBonus"));
  const salesBonus = cachedNumber(value("salesBonus"));
  const adjustmentColumn = layout.columns.bonusAdjustment !== undefined;
  const adjustmentTyped = value("bonusAdjustment");
  const adjustmentRead = parseMoney(adjustmentTyped);
  if (adjustmentTyped && "error" in adjustmentRead) {
    note("figures", `${heading("bonusAdjustment")} ${quoted(adjustmentTyped)} isn't an amount: worked out from the sheet's bonuses instead.`);
  }
  const adjustmentGiven = adjustmentColumn && !("error" in adjustmentRead);
  let bonusAdjustment: Cents | null = adjustmentGiven && "cents" in adjustmentRead ? adjustmentRead.cents : null;
  if (!adjustmentGiven && totalBonus !== null && holdbackBonus !== null && salesBonus !== null) {
    const change = Math.round((salesBonus - (totalBonus - holdbackBonus)) * 100);
    if (Math.abs(change) > 1) {
      bonusAdjustment = change;
      note(
        "figures",
        `${heading("salesBonus")} on the sheet is ${formatMoney(Math.abs(change))} ${change < 0 ? "less" : "more"} than ${heading("totalBonus")} less ${heading("holdbackBonus")}: kept as a bonus adjustment of ${formatMoney(change)}.`,
      );
    }
  }

  // Salesman and lender, by the names they go by most.
  const named = (names: Names, typed: string) => names.get(typed.toLowerCase()) ?? { name: typed, merged: false, mayBe: null };
  const salesTyped = oneLine(value("salesperson"));
  const salesperson = salesTyped ? named(context.salespeople, salesTyped) : null;
  const lenderTyped = oneLine(value("financeCompany"));
  const noLender = !lenderTyped || NOTHING.test(lenderTyped) || cachedNumber(lenderTyped) !== null;
  const lender = noLender ? null : named(context.lenders, lenderTyped);

  // Funding Rec'd, Date Paid and COMS #. On the Trailers sheet's first rows
  // the last two sit a column to the left, with no funding date.
  let fundingTyped = value("fundingReceivedOn");
  let paidTyped = value("paidOn");
  let comsTyped = value("comsNumber");
  if (/^(?:PLA|S ?& ?T)/i.test(paidTyped) && !comsTyped) {
    const paid = fundingTyped ? `${heading("paidOn")} ${fundingTyped} and ${heading("comsNumber")} ${paidTyped}` : `${heading("comsNumber")} ${paidTyped}, with no ${heading("paidOn")}`;
    note("payment", `${heading("paidOn")} and ${heading("comsNumber")} are a column to the left, as on the sheet's first rows: read as ${paid}.`);
    [paidTyped, comsTyped, fundingTyped] = [fundingTyped, paidTyped, ""];
  }
  const paymentDate = (column: "fundingReceivedOn" | "paidOn", typed: string): string => {
    if (!typed || NOTHING.test(typed)) return "";
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(typed)) {
      note("payment", `${heading(column)} holds only a time (${typed}): left blank.`);
      return "";
    }
    const read = readSheetDate(typed);
    const serial = read ? null : serialDay(typed);
    const day = read?.date ?? serial;
    if (!day) {
      note("payment", `${heading(column)} ${quoted(typed)} isn't a date: left blank.`);
      return "";
    }
    if (!storable(day)) {
      note("payment", `${heading(column)} ${dayText(day)} can't be right: left blank.`);
      return "";
    }
    if (serial) note("payment", `${heading(column)} ${typed} read as the date ${dayText(day)}.`);
    else if (read?.typed) note("payment", `${heading(column)} ${quoted(typed)} read as ${dayText(day)}.`);
    return dayText(day);
  };
  let fundingReceivedOn = paymentDate("fundingReceivedOn", fundingTyped);
  const paidOn = paymentDate("paidOn", paidTyped);
  if (dateInDownPayment) {
    const { day, typed } = dateInDownPayment;
    if (!fundingReceivedOn && (!fundingTyped || NOTHING.test(fundingTyped)) && storable(day)) {
      fundingReceivedOn = dayText(day);
      note("payment", `${heading("downPayment")} holds a date, ${dayText(day)}: read as ${heading("fundingReceivedOn")}.`);
    } else {
      moved.push(`${heading("downPayment")}: ${typed}`);
      note("payment", `${heading("downPayment")} holds a date, ${dayText(day)}: put in the notes.`);
    }
  }
  // Payments are usually within days of the sale. A Date Paid before it is
  // the floor plan paid off, which is usual too, unless it's years before.
  const lag = (date: string) => Math.round(dayNumber(date) - dayNumber(soldOn));
  const far = (column: "fundingReceivedOn" | "paidOn", date: string, before: number, after: number) => {
    const days = lag(date);
    if (today && date > today) note("payment", `${heading(column)} ${date} is in the future: check it.`);
    else if (days < -before || days > after) note("payment", `${heading(column)} ${date} is ${span(Math.abs(days))} ${days < 0 ? "before" : "after"} the sale: check it.`);
  };
  if (fundingReceivedOn) far("fundingReceivedOn", fundingReceivedOn, 60, 90);
  if (paidOn) far("paidOn", paidOn, 730, 90);
  const comsNumber = NOTHING.test(comsTyped) ? "" : oneLine(comsTyped);

  // The Notes column, its lines kept as typed (Alt+Enter in Excel), and
  // text in any column without a heading (past the Date: column A has the
  // month's running count).
  const notesLines = value("notes").split(/\r\n?|\n/).map(oneLine).filter(Boolean).join("\n");
  sheetNotes.unshift(...(notesLines ? [notesLines] : []));
  const dateColumn = layout.columns.soldOn ?? 0;
  cells.forEach((cell, column) => {
    if (column <= dateColumn || column === layout.besideRebate || (layout.headings[column] ?? "").trim()) return;
    if (cell.trim()) sheetNotes.push(oneLine(cell));
  });
  for (const column of layout.others) if (cellAt(cells, column)) sheetNotes.push(`${oneLine(layout.headings[column])}: ${oneLine(cellAt(cells, column))}`);
  let notesText = [...sheetNotes, ...moved].join(" | ");
  if (notesText.length > SALE_LIMITS.notes) {
    note("other", `The notes are longer than ${SALE_LIMITS.notes.toLocaleString("en-US")} characters: cut to fit.`);
    notesText = cutText(notesText, SALE_LIMITS.notes);
  }

  // Text longer than the log keeps, cut to fit.
  const fit = (field: keyof typeof SALE_LIMITS, text: string) => {
    if (text.length <= SALE_LIMITS[field]) return text;
    note("other", `${SALE_LABELS[field]} is longer than ${SALE_LIMITS[field]} characters: cut to fit.`);
    return cutText(text, SALE_LIMITS[field]).trim();
  };
  const money = (cents: Cents | null) => moneyInput(cents);
  const fields: SaleInput = {
    soldOn,
    salesperson: fit("salesperson", salesperson?.name ?? ""),
    customerName: fit("customerName", oneLine(value("customerName"))),
    customerAddress: fit("customerAddress", oneLine(value("customerAddress"))),
    customerPhone: fit("customerPhone", oneLine(value("customerPhone"))),
    unitYear,
    unitModel: fit("unitModel", model),
    condition,
    unitType,
    vin,
    category: fit("category", category ?? ""),
    notes: notesText,
    financeCompany: fit("financeCompany", lender?.name ?? ""),
    fundingReceivedOn,
    paidOn,
    comsNumber: fit("comsNumber", comsNumber),
    msrp: money(msrp),
    salesPrice: money(amounts.salesPrice),
    dealerCost: money(amounts.dealerCost),
    unitLabor: money(amounts.unitLabor),
    rebate: money(rebate?.cents ?? null),
    accPrice: money(amounts.accPrice),
    accCost: money(amounts.accCost),
    accLabor: money(amounts.accLabor),
    escPrice: money(amounts.escPrice),
    escCost: money(amounts.escCost),
    rewards: money(amounts.rewards),
    amountFinanced: money(amounts.amountFinanced),
    downPayment: money(amounts.downPayment),
    bonusAdjustment: money(bonusAdjustment),
    holdbackRateBp: rateInput(holdbackRateBp),
    bonusRateBp: rateInput(bonusRateBp),
  };
  const merged = [
    ...(salesperson?.merged ? [{ what: heading("salesperson"), typed: salesTyped, name: salesperson.name }] : []),
    ...(lender?.merged ? [{ what: heading("financeCompany"), typed: lenderTyped, name: lender.name }] : []),
  ];
  // Names kept as they are that may be another: the name kept, and that one.
  const lookAlikes = [
    ...(salesperson?.mayBe ? [{ what: heading("salesperson"), typed: salesperson.name, name: salesperson.mayBe }] : []),
    ...(lender?.mayBe ? [{ what: heading("financeCompany"), typed: lender.name, name: lender.mayBe }] : []),
  ];
  return { fields, notes, merged, lookAlikes };
}

// Where the sheet's own figures and the ones worked out from the row's
// amounts differ by more than a cent (the sheet's formulas were sometimes
// copied from the wrong row): what each is.
function figureNote(sale: SaleFields, cells: readonly string[], layout: Layout): Note | null {
  const figures = saleFigures(sale);
  const checked = [
    ["unitProfit", "Unit Profit"],
    ["totalProfit", "TOTAL PROFIT"],
    ["salesBonus", "Sales Bonus"],
  ] as const;
  const differ = checked.flatMap(([column, label]) => {
    const onSheet = cachedCents(cellAt(cells, layout.columns[column]));
    return onSheet !== null && Math.abs(onSheet - figures[column]) > 1 ? [`${label} ${formatMoney(figures[column])} (the sheet has ${formatMoney(onSheet)})`] : [];
  });
  if (differ.length === 0) return null;
  const list = differ.length === 1 ? differ[0] : `${differ.slice(0, -1).join(", ")} and ${differ.at(-1)}`;
  return { kind: "figures", message: `Worked out from the row's amounts: ${list}.` };
}

// A sale row, read: the sale with its notes, any names read as another and
// any kept that may be another, or why it can't be read (with what it is,
// to find it on another sheet).
type NameNote = { what: string; typed: string; name: string };
type ReadRow = {
  row: number;
  ref: string;
  read:
    | { sale: SaleFields; fields: SaleInput; notes: Note[]; merged: NameNote[]; lookAlikes: NameNote[] }
    | { problem: string; probe: KnownSale };
};

// The workbook's NUSR sheets, every sale row read, for planning: what the
// sheets are chosen for doesn't change how a row reads, so a file is read
// once however often the sheets chosen change.
export type NusrWorkbook = {
  sheets: NusrSheet[];
  rows: Map<number, { rows: ReadRow[]; end: number | null }>;
};

// Reads every NUSR sheet's sale rows: each checked as the form checks a
// sale, with the sheet's own figures checked against the ones worked out.
// Name spellings are settled across every NUSR sheet in the file (hidden
// ones too), so the same file always gives the same names. today
// ("2026-10-31") is for noting dates in the future.
export function readNusrWorkbook(sheets: readonly Sheet[], { today = null }: { today?: string | null } = {}): NusrWorkbook {
  const found = sheets.flatMap((sheet, index) => {
    const layout = layoutOf(sheet.rows);
    return layout ? [{ index, sheet, layout, year: yearOf(sheet.name), deals: dealRowsOf(sheet.rows, layout) }] : [];
  });
  const hasYears = found.some((entry) => entry.year !== null);
  // Each sale row's salesman or lender as typed, with the sale it's on.
  const typedNames = (column: Column) =>
    found.flatMap(({ sheet, layout, deals }) =>
      deals.rows.map((index) => {
        const cells = sheet.rows[index];
        return { name: cellAt(cells, layout.columns[column]), sale: `${customerKey(cellAt(cells, layout.columns.customerName))}|${cellAt(cells, layout.columns.soldOn)}` };
      }),
    );
  const salespeople = namesOf(typedNames("salesperson"));
  const lenders = namesOf(typedNames("financeCompany").filter(({ name }) => name && !NOTHING.test(name) && cachedNumber(name) === null));

  const rows = new Map<number, { rows: ReadRow[]; end: number | null }>();
  for (const { index, sheet, layout, year, deals } of found) {
    const dates = saleDates(sheet.rows, deals.rows, layout, year);
    const read = deals.rows.map((rowIndex, at): ReadRow => {
      const cells = sheet.rows[rowIndex];
      const row = rowIndex + 1;
      const ref = `${sheet.name}!${row}`;
      const date = dates[at];
      if ("problem" in date) {
        // A sale whose date can't be read may still be one on another sheet.
        const vinTyped = cellAt(cells, layout.columns.vin);
        const vin = NOTHING.test(vinTyped) ? null : vinTyped.toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
        const customerName = oneLine(cellAt(cells, layout.columns.customerName));
        return { row, ref, read: { problem: date.problem, probe: { ref, vin, soldOn: null, customerName, salesPrice: null } } };
      }
      const sheetRow = readSale({ layout, salespeople, lenders, today }, cells, date.soldOn);
      const checked = checkSale(sheetRow.fields);
      if ("error" in checked) {
        const problem = `${checked.error.replace(/\.$/, "")}: left out.`;
        return { row, ref, read: { problem, probe: { ref, vin: null, soldOn: null, customerName: "", salesPrice: null } } };
      }
      const sale = checked.sale;
      const future: Note[] = today && sale.soldOn > today ? [{ kind: "date", message: `Date ${sale.soldOn} is in the future: check it.` }] : [];
      const notes = [...future, ...date.notes, ...sheetRow.notes];
      const figures = figureNote(sale, cells, layout);
      if (figures) notes.push(figures);
      return { row, ref, read: { sale, fields: sheetRow.fields, notes, merged: sheetRow.merged, lookAlikes: sheetRow.lookAlikes } };
    });
    rows.set(index, { rows: read, end: deals.end });
  }
  return {
    sheets: found.map(({ index, sheet, year, deals }) => {
      const repeats = hasYears && year === null && /^\s*(?:new|used)\s*$/i.test(sheet.name);
      const hidden = sheet.hidden === true;
      return { index, name: sheet.name, year, sales: deals.rows.length, repeats, hidden, chosen: !repeats && !hidden };
    }),
    rows,
  };
}

// What importing the chosen sheets would do. The year sheets go first, then
// the others (Trailers), then New and Used, so a sale on two sheets comes
// in from its year sheet; each sale is matched against the sales planned
// before it (see saleFinder), and only those found nowhere before are
// added, with their notes. New and Used repeat the year sheets, typed
// again with slips of their own, so a row of theirs is also a year sheet's
// sale when that sheet has a sale to the same customer that day, whatever
// the price, unless both have whole VINs that differ (two units bought
// together); and a row of New is when a year sheet sold its VIN new on any
// day, to anyone, as a new unit sells new once (on Used a VIN can come
// back: a unit traded in sells used again). A sale they add all the same
// is noted, to be checked.
export function planNusrImport(workbook: NusrWorkbook, chosen: readonly number[]): NusrImportPlan {
  const rank = (sheet: NusrSheet) => (sheet.year !== null ? 0 : sheet.repeats ? 2 : 1);
  const order = workbook.sheets.filter((sheet) => chosen.includes(sheet.index)).sort((a, b) => rank(a) - rank(b) || a.index - b.index);
  const withYears = order.some((sheet) => sheet.year !== null);
  const finder = saleFinder();
  const sales: PlannedSale[] = [];
  const notes: NusrImportNote[] = [];
  const counts: SheetPlan[] = [];
  // The year sheets' sales by customer and day, and their new units by
  // VIN, for New and Used.
  const yearDays = new Map<string, PlannedSale[]>();
  const yearVins = new Map<string, PlannedSale>();
  const yearSale = (sheet: NusrSheet, known: KnownSale): { planned: PlannedSale; words: string } | null => {
    const customer = customerKey(known.customerName);
    const sameDay = customer && known.soldOn ? yearDays.get(`${customer}|${known.soldOn}`) : undefined;
    const twoUnits = (other: PlannedSale) => isWholeVin(known.vin) && isWholeVin(other.sale.vin) && known.vin !== other.sale.vin;
    const day = sameDay?.find((other) => !twoUnits(other));
    if (day) return { planned: day, words: "the same customer the same day" };
    const unit = /^\s*new\s*$/i.test(sheet.name) && known.vin ? yearVins.get(known.vin) : undefined;
    return unit ? { planned: unit, words: "the same VIN, sold new" } : null;
  };
  // Names read as another, or kept that may be another, with the first sale
  // they're on and how many.
  const merges = new Map<string, NameNote & { sheet: string; row: number; count: number }>();
  const lookAlikes = new Map<string, NameNote & { sheet: string; row: number; count: number }>();
  const tally = (into: typeof merges, sheet: string, row: number, names: NameNote[]) => {
    for (const { what, typed, name } of names) {
      const key = `${what}|${typed.toLowerCase()}`;
      const entry = into.get(key);
      if (entry) entry.count++;
      else into.set(key, { sheet, row, what, typed, name, count: 1 });
    }
  };

  for (const sheet of order) {
    const read = workbook.rows.get(sheet.index) ?? { rows: [], end: null };
    const totalsFrom = read.end === null ? null : read.end + 1;
    const count: SheetPlan = { index: sheet.index, name: sheet.name, sales: read.rows.length, toAdd: 0, duplicates: 0, skipped: 0, totalsFrom };
    counts.push(count);
    for (const { row, ref, read: entry } of read.rows) {
      const add = (kind: NoteKind, message: string, skipped = false) => notes.push({ sheet: sheet.name, row, kind, message, skipped });
      const known: KnownSale =
        "problem" in entry
          ? entry.probe
          : { ref, vin: entry.sale.vin, soldOn: entry.sale.soldOn, customerName: entry.sale.customerName, salesPrice: entry.sale.salesPrice, unitModel: entry.sale.unitModel };
      const match = finder.find(known);
      if (match.match) {
        count.duplicates++;
        add("duplicate", `Already on ${match.match.ref ? refLabel(match.match.ref) : "another sheet"} (${MATCH_WORDS[match.how]}): left out.`);
        continue;
      }
      const repeat = sheet.repeats ? yearSale(sheet, known) : null;
      if (repeat) {
        count.duplicates++;
        add("duplicate", `Already on ${refLabel(repeat.planned.ref)} (${repeat.words}): left out.`);
        continue;
      }
      if ("problem" in entry) {
        count.skipped++;
        add("skipped", entry.problem, true);
        continue;
      }
      finder.add(known);
      count.toAdd++;
      const planned: PlannedSale = { ref, sheet: sheet.name, row, fields: entry.fields, sale: entry.sale };
      sales.push(planned);
      if (sheet.year !== null) {
        const key = `${customerKey(entry.sale.customerName)}|${entry.sale.soldOn}`;
        yearDays.set(key, [...(yearDays.get(key) ?? []), planned]);
        if (entry.sale.vin && entry.sale.condition === "new" && !yearVins.has(entry.sale.vin)) yearVins.set(entry.sale.vin, planned);
      }
      if (sheet.repeats && withYears) {
        add("repeat", `No year sheet has this sale, but ${sheet.name} repeats them: it may be one of theirs with its date, VIN or customer typed another way. Check it.`);
      }
      for (const note of entry.notes) add(note.kind, note.message);
      tally(merges, sheet.name, row, entry.merged);
      tally(lookAlikes, sheet.name, row, entry.lookAlikes);
    }
  }
  for (const { sheet, row, what, typed, name, count } of merges.values()) {
    const sales = count > 1 ? ` (${count.toLocaleString("en-US")} sales)` : "";
    notes.push({ sheet, row, kind: "name", message: `${what} ${quoted(typed)} read as ${name}, as most rows have it${sales}.`, skipped: false });
  }
  for (const { sheet, row, what, typed, name, count } of lookAlikes.values()) {
    const sales = count > 1 ? ` (${count.toLocaleString("en-US")} sales)` : "";
    notes.push({ sheet, row, kind: "name", message: `${what} ${quoted(typed)} may be ${name}: kept as typed${sales}.`, skipped: false });
  }

  // In the order the sheets were read, by row.
  const sheetRank = new Map(order.map((sheet, at) => [sheet.name, at]));
  notes.sort((a, b) => (sheetRank.get(a.sheet) ?? 0) - (sheetRank.get(b.sheet) ?? 0) || a.row - b.row);
  return { sales, sheets: counts, notes };
}

// --- Sending --------------------------------------------------------------------------

// What goes to the server for each sale: where it came from, and its
// fields as text, checked again there.
export type NusrImportEntry = { ref: string; fields: SaleInput };

// Sales go to the server in batches, well under the 1 MB Server Action
// limit, one batch at a time.
export const MAX_NUSR_IMPORT_BATCH = 250;

// The sales on file an import has found go back with each later batch, so
// none is found twice (see saleFinder): the latest this many, which keeps
// a batch well under that limit too.
export const MAX_NUSR_IMPORT_FOUND = 10_000;

export function nusrImportBatches(sales: readonly PlannedSale[]): NusrImportEntry[][] {
  const batches: NusrImportEntry[][] = [];
  let batch: NusrImportEntry[] = [];
  let bytes = 0;
  for (const sale of sales) {
    const entry = { ref: sale.ref, fields: sale.fields };
    const size = JSON.stringify(entry).length * 2;
    if (batch.length > 0 && (bytes + size > IMPORT_BATCH_BYTES || batch.length >= MAX_NUSR_IMPORT_BATCH)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// What the server did with each sale of a batch: added; already in the
// NUSR (reason says how it was found); or left out, with why.
export type NusrImportOutcome = { ref: string; result: "added" | "already" | "failed"; reason: string | null };

// The import's notes as CSV, by sheet and row: a byte order mark so Excel
// reads it as UTF-8, and a cell starting with = + - or @ kept as text.
export function importNotesCsv(notes: readonly NusrImportNote[]): string {
  const cell = (value: string) => {
    const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    "Sheet,Row,About,What happened",
    ...notes.map((note) => [cell(note.sheet), String(note.row), cell(NOTE_KIND_LABELS[note.kind]), cell(note.message)].join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}
