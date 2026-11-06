// Rebates (the Rebates tab): a Polaris rebate invoice read line by line,
// each unit on it found in the NUSR, and its rebate put in the NUSR
// sheet's AO (Holdback), AP (Retail Rwds) and AQ (Add'l Hlbk) columns, as
// the shop has kept them by hand.
//
// The invoice is the dealer portal's Invoice Print of a "Type: Rebate"
// invoice, often printed and scanned: a line per unit whose Description is
// the unit's VIN and model code ("3NSXAW1R9TM204033/R26XAW1RB"), with the
// credit in its Amount column (-$1,494.97; Unit Price is $0.00), then lines
// with the program ("US RGR NSR 2H 2026 R"), when it was bought
// ("PUR:08/21/26 PD:04/30/26") and who bought it ("ROBERT NEESE"). The
// browser reads its pages (src/app/(app)/rebates/reader.ts: a PDF's own
// text, or OCR on a scan or a picture) into words and where each sits on
// the page; this sorts them into the table's columns by where its headings
// are, puts each unit's lines together, and reads the amounts and the
// invoice's total, putting right the slips OCR makes where it can and
// marking the amounts it can't be sure of.
//
// Polaris prints the lines under a VIN out of step now and then (a name
// under the next unit's VIN, a unit's lines with no VIN over them), so a
// unit is found by its VIN; the name and purchase date only stand in for a
// VIN the NUSR doesn't have. A VIN OCR got a character or two wrong (9 read
// as S, 8 as B, an extra S beside a 5), or one typed into the NUSR with a
// slip, is found by how close it is, allowing for the characters OCR mixes
// up, with the check digit saying which side the slip is on.
//
// No server imports: the browser reads the invoice with these rules, and
// the server matches it and writes the workbook with the same ones.

import { cutText } from "@/lib/manual-rules";
import { MAX_AMOUNT_CENTS, formatMoney, parseIsoDate, type Cents } from "@/lib/nusr-rules";
import { vinCheckDigit } from "@/lib/vin";

// --- Words and lines ----------------------------------------------------------

// A word on a page and the box it sits in (any unit, from the top left),
// with the line Tesseract put it on when OCR read it.
export type InvoiceWord = { text: string; left: number; top: number; width: number; height: number; line?: string };
export type InvoicePage = { words: InvoiceWord[] };

// A page's words from Tesseract's TSV (level, page, block, paragraph, line,
// word, left, top, width, height, confidence, text), every one of them:
// an amount with a tick through it is read with little confidence, but
// it's still the amount.
export function wordsFromTsv(tsv: string): InvoiceWord[] {
  const words: InvoiceWord[] = [];
  for (const row of tsv.split("\n")) {
    const fields = row.split("\t");
    if (fields[0] !== "5" || fields.length < 12) continue;
    const text = fields.slice(11).join(" ").trim();
    if (!text) continue;
    const [left, top, width, height] = fields.slice(6, 10).map(Number);
    if (![left, top, width, height].every(Number.isFinite)) continue;
    words.push({ text, left, top, width, height, line: `${fields[2]}.${fields[3]}.${fields[4]}` });
  }
  return words;
}

type Line = { words: InvoiceWord[]; center: number; text: string };

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const centerOf = (word: InvoiceWord) => word.top + word.height / 2;

function makeLine(words: InvoiceWord[]): Line {
  const sorted = [...words].sort((a, b) => a.left - b.left);
  return { words: sorted, center: median(sorted.map(centerOf)), text: sorted.map((word) => word.text).join(" ") };
}

// A page's lines, top to bottom, each one's words left to right, and how
// tall a line of print is. OCR's own lines are kept (it follows a line
// across a page that's a little skewed); a line it split in two, the
// amounts in a block of their own, is put back together. A PDF's own text
// sits on its lines exactly.
export function pageLines(words: readonly InvoiceWord[]): { lines: Line[]; height: number } {
  const printed = words.filter((word) => /[A-Za-z0-9]{2}/.test(word.text));
  const height = Math.max(median((printed.length ? printed : words).map((word) => word.height)), 1e-6);
  let groups: InvoiceWord[][];
  if (words.length > 0 && words.every((word) => word.line !== undefined)) {
    const byLine = new Map<string, InvoiceWord[]>();
    for (const word of words) {
      const line = byLine.get(word.line!) ?? [];
      line.push(word);
      byLine.set(word.line!, line);
    }
    groups = [...byLine.values()];
  } else {
    groups = [];
    for (const word of [...words].sort((a, b) => centerOf(a) - centerOf(b))) {
      const last = groups.at(-1);
      if (last && Math.abs(centerOf(word) - median(last.map(centerOf))) <= height * 0.4) last.push(word);
      else groups.push([word]);
    }
  }
  // Whether two lines have words over one another, which one line can't.
  const overlap = (a: Line, b: Line) => a.words.some((x) => b.words.some((y) => x.left < y.left + y.width && y.left < x.left + x.width));
  const lines: Line[] = [];
  for (const line of groups.map(makeLine).sort((a, b) => a.center - b.center)) {
    const last = lines.at(-1);
    if (last && Math.abs(line.center - last.center) < height * 0.7 && !overlap(last, line)) lines[lines.length - 1] = makeLine([...last.words, ...line.words]);
    else lines.push(line);
  }
  return { lines, height };
}

// --- The table's columns ------------------------------------------------------

// Where the Description column starts, and where the Unit Price and Amount
// columns end (their figures line up on the right).
type Columns = { descriptionLeft: number; priceRight: number; amountRight: number };

// The table's headings row ("Part Description Unit Price Amount"), or null.
function headingColumns(line: Line): Columns | null {
  const find = (pattern: RegExp) => line.words.find((word) => pattern.test(word.text));
  const description = find(/^desc/i);
  const amount = find(/^amo?unt|^amt\b/i);
  const price = find(/^pric/i);
  const unit = find(/^unit/i);
  if (!description || !amount || (!price && !unit)) return null;
  const right = (word: InvoiceWord) => word.left + word.width;
  const priceRight = price ? right(price) : right(unit!) + unit!.width * 1.4;
  if (!(description.left < priceRight && priceRight < right(amount))) return null;
  return { descriptionLeft: description.left, priceRight, amountRight: right(amount) };
}

// Where a page's Amount column is, for reading its figures again: from a
// little left of its widest figure to just past its right edge, where a
// tick made by hand mostly starts. Null when the page has no headings row.
export function amountColumn(words: readonly InvoiceWord[]): { left: number; right: number; height: number } | null {
  const { lines, height } = pageLines(words);
  for (const line of lines) {
    const columns = headingColumns(line);
    if (columns) return { left: columns.amountRight - height * AMOUNT_WIDTH, right: columns.amountRight + height * AMOUNT_PAST, height };
  }
  return null;
}

// An Amount cell's box, in line heights: "-$12,345.67" is about 8 wide,
// and lines are about 1.6 apart.
const AMOUNT_WIDTH = 9;
const AMOUNT_PAST = 0.6;
const AMOUNT_HALF_HEIGHT = 0.75;

type Cells = { part: string; description: string; unitPrice: string[]; amount: string[]; figuresCenter: number };

// A line's words in the table's columns: the Part code left of the
// Description, the description, and the figures by which column they line
// up under. Marks out past the description that aren't figures are ticks
// made by hand on the printout, and are left out.
function lineCells(line: Line, columns: Columns, height: number): Cells {
  const figuresFrom = Math.max(columns.descriptionLeft + height * 12, columns.priceRight - height * 6);
  const between = (columns.priceRight + columns.amountRight) / 2;
  const part: string[] = [];
  const description: string[] = [];
  const unitPrice: string[] = [];
  const amount: string[] = [];
  const figures: InvoiceWord[] = [];
  for (const word of line.words) {
    const right = word.left + word.width;
    if (right <= columns.descriptionLeft - height * 0.3) part.push(word.text);
    else if (word.left + word.width / 2 < figuresFrom) description.push(word.text);
    else if (/\d/.test(word.text)) {
      (right < between ? unitPrice : amount).push(word.text);
      figures.push(word);
    }
  }
  // Where the figures sit, which a tick across them stretches upwards: the
  // Unit Price's, if it has one.
  const steady = figures.filter((word) => word.left + word.width < between);
  const figuresCenter = steady.length ? median(steady.map(centerOf)) : line.center;
  return { part: part.join(" "), description: description.join(" "), unitPrice, amount, figuresCenter };
}

// --- Amounts ------------------------------------------------------------------

// An amount as read: whole cents, as a positive number (a rebate invoice's
// amounts are all credits, printed with a minus that OCR often loses), and
// whether it read cleanly; when it didn't, the other ways it could read.
export type ReadAmount = { text: string; cents: Cents | null; sure: boolean; others: Cents[] };

const toCents = (whole: string, fraction: string) => Number(whole.replace(/,/g, "")) * 100 + Number(fraction);
const isAmount = (cents: number) => Number.isSafeInteger(cents) && cents <= MAX_AMOUNT_CENTS;

// One word of the Amount (or Unit Price) column: "-$1,494.97", the tick
// after it and all ("-$1,494.97y/", "-$796.22Vv"). Polaris prints a dollar
// sign, commas in the thousands and the cents, so a reading that needed
// putting right isn't sure: a dollar sign read as a figure ("-6796.22" is
// -$796.22), a comma for the decimal point ("-$519,97"), a tick read as a
// third figure of cents ("-$174.987"), or no dollar sign at all.
function readAmountWord(word: string): (Omit<ReadAmount, "text"> & { dollar: boolean }) | null {
  const text = word.replace(/\s+/g, "");
  let match = /\$((?:\d{1,3}(?:,\d{3})+)|\d+)\.(\d{2})(\d*)/.exec(text);
  if (match) {
    const grouped = !/^\d{4,}$/.test(match[1]);
    return { cents: toCents(match[1], match[2]), sure: match[3] === "" && grouped, others: [], dollar: true };
  }
  match = /((?:\d{1,3}(?:,\d{3})+)|\d+)\.(\d{2})(\d*)/.exec(text);
  if (match) {
    const [, whole, fraction] = match;
    if (whole.includes(",")) {
      // "41,494.97": the dollar sign may be the 4.
      const first = whole.split(",")[0];
      return { cents: toCents(whole, fraction), sure: false, others: first.length > 1 ? [toCents(whole.slice(1), fraction)] : [], dollar: false };
    }
    // Four figures or more without a comma: the first is the dollar sign.
    if (whole.length >= 4) return { cents: toCents(whole.slice(1), fraction), sure: false, others: [toCents(whole, fraction)], dollar: false };
    return { cents: toCents(whole, fraction), sure: false, others: [], dollar: false };
  }
  match = /(\d{1,3}),(\d{2})\d?(?!\d)/.exec(text);
  if (match) return { cents: toCents(match[1], match[2]), sure: false, others: [], dollar: /\$/.test(text) };
  return null;
}

// What a column's words on one line say: the word that reads cleanly as
// an amount ("-$1,624.97", with "V" after it), else one with a dollar sign,
// else the last that's an amount at all (amounts line up on the right, so
// a stray figure left of one is from the next column); words split oddly
// are read together. Null cents when there's no amount there at all.
export function readAmount(words: readonly string[] | string): ReadAmount {
  const list = typeof words === "string" ? [words] : words;
  const text = list.join(" ").trim();
  const reads = list.map(readAmountWord).filter((read) => read !== null && isAmount(read.cents!));
  const read = reads.find((one) => one!.sure) ?? reads.find((one) => one!.dollar) ?? reads.at(-1) ?? readAmountWord(list.join(""));
  if (read && isAmount(read.cents!)) return { text, cents: read.cents, sure: read.sure, others: read.others.filter(isAmount) };
  return { text, cents: null, sure: text === "", others: [] };
}

// When the amounts read don't add up to the invoice's total: the one change
// to an unsure amount (one of its other readings), or the one pair of
// changes, that makes them add up. Amounts as they were when there's none,
// or more than one.
export function reconcileAmounts(amounts: readonly ReadAmount[], total: Cents | null): ReadAmount[] {
  if (total === null) return [...amounts];
  const sum = amounts.reduce((all, amount) => all + (amount.cents ?? 0), 0);
  const short = Math.abs(total) - sum;
  if (short === 0) return [...amounts];
  const changes = amounts.flatMap((amount, index) =>
    amount.sure || amount.cents === null ? [] : amount.others.map((other) => ({ index, other, by: other - amount.cents! })),
  );
  const apply = (picked: typeof changes) =>
    amounts.map((amount, index) => {
      const change = picked.find((one) => one.index === index);
      return change ? { ...amount, cents: change.other, others: [amount.cents!, ...amount.others.filter((other) => other !== change.other)] } : amount;
    });
  const singles = changes.filter((change) => change.by === short);
  if (singles.length === 1) return apply(singles);
  if (singles.length > 1) return [...amounts];
  const pairs: (typeof changes)[] = [];
  for (let i = 0; i < changes.length && pairs.length < 2; i++) {
    for (let j = i + 1; j < changes.length && pairs.length < 2; j++) {
      if (changes[i].index !== changes[j].index && changes[i].by + changes[j].by === short) pairs.push([changes[i], changes[j]]);
    }
  }
  return pairs.length === 1 ? apply(pairs[0]) : [...amounts];
}

// --- Dates and names ----------------------------------------------------------

// "08/21/26", "8/21/2026" as a date ("2026-08-21"), with OCR's usual slips
// in figures put right (O or C or a bracket for a 0, l or I for a 1), or
// null.
export function readInvoiceDate(text: string): string | null {
  const fixed = text.replace(/[OoCcDQ([{]/g, "0").replace(/[lI|]/g, "1").replace(/[Zz]/g, "2");
  const match = /(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/.exec(fixed);
  if (!match) return null;
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  return parseIsoDate(`${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`);
}

const PURCHASE_LINE = /\bP[UV]R\b|\bPD\b/i;
const PROGRAM_LINE = /^(?:US|CA|CAN)\s+\S+|\b(?:NSR|PROGRAM|PROMO|REBATE|RETAIL|REWARDS?|RWDS?|HOLDBACK|HLDBK|HLBK)\b/i;
const NAME_LINE = /^[A-Za-z][A-Za-z .,'’&/-]*$/;

const tidy = (text: string) => text.replace(/^[|!\s]+/, "").replace(/\s+/g, " ").trim();

// The words a name is known by, lower-cased: without punctuation, titles,
// generations (Jr, III) or a company's Inc and LLC.
const NAME_FILLER = new Set(["and", "the", "of", "inc", "llc", "ltd", "co", "corp", "company", "comp", "jr", "sr", "ii", "iii", "iv", "mr", "mrs", "ms", "dr"]);
export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !NAME_FILLER.has(word));
}

// Edits (one letter changed, added or taken out) from one word to another,
// up to `most` + 1.
function wordEdits(a: string, b: string, most: number) {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}

// How much two names have in common, 0 to 1: the share of the shorter
// one's words in the other, a word of five letters or more counting with a
// letter off ("Homes" and "HOLMES"). "Nicole and Todd Volk" and "TODD VOLK"
// are 1; "Clymer FD" and "CLYMER VOLUNTEER FIRE COMP" 0.5.
export function nameLikeness(a: string, b: string) {
  const x = nameWords(a);
  const y = nameWords(b);
  if (x.length === 0 || y.length === 0) return 0;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  const alike = (word: string, other: string) => word === other || (Math.min(word.length, other.length) >= 5 && wordEdits(word, other, 1) <= 1);
  return shorter.filter((word) => longer.some((other) => alike(word, other))).length / shorter.length;
}

// --- The invoice --------------------------------------------------------------

// A unit's lines on the invoice: the VIN's line, and those under it.
export type InvoiceLine = {
  // Its place on the invoice, from 1, and the page its VIN is on.
  line: number;
  page: number;
  // The Part column ("012").
  part: string | null;
  // The VIN as read: upper-cased, without spaces, a character OCR couldn't
  // make out as "?". The model code after the slash.
  vinRead: string;
  modelCode: string | null;
  unitPrice: ReadAmount;
  amount: ReadAmount;
  // Where its Amount cell is on its page (in the page's units), to read it
  // again from a scan without the ticks beside it.
  amountBox: { left: number; top: number; right: number; bottom: number };
  // The lines under it: the program, the purchase dates as printed and
  // the purchase date read, the names, and anything else.
  programs: string[];
  dates: string[];
  purchased: string[];
  names: string[];
  other: string[];
};

export type Invoice = {
  // "314886", "Rebate", the invoice date ("2026-10-29") and its total.
  number: string | null;
  type: string | null;
  date: string | null;
  total: ReadAmount | null;
  pages: number;
  lines: InvoiceLine[];
};

// Where the table ends: the invoice's summary, or the page's foot (the
// portal's address and the page number).
const TABLE_END = /^summary\b|\bfinanced by\b|\bmail your\b|\bvat charges\b|^tax\b.*\btotal\b/i;
const PAGE_FOOT = /https?:|www\.|\.asp\b|polarisportal/i;
// The head of a page, which is read as the table's when OCR missed the
// page's headings row: when it was printed, "Parts", and the headings.
const PAGE_HEAD = /\binvoice print\b|^\W*parts\W*$|\bord\b.*\bship\b|\bunit price\b/i;

// The VIN at the start of a description ("3NSXAW1R9TM204033/R26XAW1RB",
// "3NSX6W1R7TM296793/R26 <6W1RB"), and the model code after it.
function vinAtStart(description: string): { vin: string; model: string | null } | null {
  const text = description.trim();
  const slash = text.indexOf("/");
  let head = (slash >= 0 ? text.slice(0, slash) : (text.split(/\s+/)[0] ?? "")).replace(/\s+/g, "").toUpperCase();
  let model = slash >= 0 ? text.slice(slash + 1).replace(/\s+/g, "").toUpperCase() || null : null;
  // The VIN and the model code run together, the slash not read.
  if (slash < 0 && head.length >= 24) {
    model = head.slice(17);
    head = head.slice(0, 17);
  }
  const vin = head.replace(/[^A-Z0-9]/g, "?");
  if (vin.length < 15 || vin.length > 19) return null;
  const count = (pattern: RegExp) => (vin.match(pattern) ?? []).length;
  if (count(/\d/g) < 6 || count(/[A-Z]/g) < 2 || count(/\?/g) > 3) return null;
  return { vin, model: model ? model.replace(/[^A-Z0-9]/g, "?") : null };
}

// The invoice's number, type and date from the top of its first page:
// "Invoice - 314886 Type:Rebate", and the date under "Invoice Date".
function invoiceDetails(lines: readonly Line[], height: number) {
  const text = lines.map((line) => line.text).join("\n");
  const number = /\binvoice\s*(?:no\.?|number|#)?\s*[-–—:#]*\s*(\d{4,12})\b/i.exec(text)?.[1] ?? null;
  const type = /\btype\s*[:.]?\s*([A-Za-z]{3,20})\b/i.exec(text)?.[1] ?? null;
  let date: string | null = null;
  const at = lines.findIndex((line) => /\binvoice\s+date\b/i.test(line.text));
  if (at >= 0) {
    const heading = lines[at].words.find((word, index, words) => /^invoice$/i.test(word.text) && /^date/i.test(words[index + 1]?.text ?? ""));
    for (const line of lines.slice(at, at + 4)) {
      const under = line.words.find((word) => (!heading || Math.abs(word.left - heading.left) < height * 4) && readInvoiceDate(word.text));
      if (under) {
        date = readInvoiceDate(under.text);
        break;
      }
    }
  }
  return { number, type: type ? type[0].toUpperCase() + type.slice(1).toLowerCase() : null, date };
}

// The invoice's total: the amount beside "Total", or under it.
function invoiceTotal(lines: readonly Line[]): ReadAmount | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const label = lines[i].words.find((word) => /^total:?$/i.test(word.text));
    if (!label) continue;
    const labelRight = label.left + label.width;
    const beside = lines[i].words.filter((word) => word.left > label.left && /\d/.test(word.text));
    const read = beside.length ? readAmount(beside.map((word) => word.text)) : null;
    if (read?.cents != null) return read;
    const under = (lines[i + 1]?.words ?? []).filter((word) => /\d/.test(word.text));
    if (under.length === 0) continue;
    const nearest = under.reduce((best, word) =>
      Math.abs(word.left + word.width - labelRight) < Math.abs(best.left + best.width - labelRight) ? word : best,
    );
    const total = readAmount([nearest.text]);
    if (total.cents !== null) return total;
  }
  return null;
}

export const NO_TABLE =
  "This doesn't look like a Polaris invoice: no table with Description, Unit Price and Amount headings was found. Drop the invoice as printed from the dealer portal (a PDF, or a scan or photo of it).";
export const NO_UNITS =
  "No units were found on this invoice: none of its lines starts with a VIN. A rebate invoice lists a VIN and model code on each unit's first line.";

// The invoice read from its pages: its details, total and units, each
// with its lines, its amount and unit price as read (and where its Amount
// cell is, to read it again from a scan), and the total's reading used to
// settle an amount OCR couldn't be sure of.
export function readInvoice(pages: readonly InvoicePage[]): Invoice | { error: string } {
  let columns: Columns | null = null;
  let details: ReturnType<typeof invoiceDetails> | null = null;
  let total: ReadAmount | null = null;
  let ended = false;
  const lines: InvoiceLine[] = [];
  let unit: InvoiceLine | null = null;

  pages.forEach((page, pageIndex) => {
    const { lines: pageLinesRead, height } = pageLines(page.words);
    const headingAt = pageLinesRead.findIndex((line) => headingColumns(line) !== null);
    if (headingAt >= 0) columns = headingColumns(pageLinesRead[headingAt]);
    if (!details && headingAt >= 0) details = invoiceDetails(pageLinesRead.slice(0, headingAt), height);
    total = invoiceTotal(pageLinesRead) ?? total;
    if (!columns || ended) return;
    for (const line of pageLinesRead.slice(headingAt + 1)) {
      if (TABLE_END.test(tidy(line.text))) {
        ended = true;
        break;
      }
      if (PAGE_FOOT.test(line.text)) break;
      if (PAGE_HEAD.test(line.text)) continue;
      const cells = lineCells(line, columns, height);
      const vin = vinAtStart(cells.description);
      if (vin) {
        unit = {
          line: lines.length + 1,
          page: pageIndex + 1,
          part: /^\d{2,4}$/.test(cells.part.replace(/\s+/g, "")) ? cells.part.replace(/\s+/g, "") : (/\b\d{3}\b/.exec(cells.part)?.[0] ?? null),
          vinRead: vin.vin,
          modelCode: vin.model,
          unitPrice: readAmount(cells.unitPrice),
          amount: readAmount(cells.amount),
          amountBox: {
            left: columns.amountRight - height * AMOUNT_WIDTH,
            top: cells.figuresCenter - height * AMOUNT_HALF_HEIGHT,
            right: columns.amountRight + height * AMOUNT_PAST,
            bottom: cells.figuresCenter + height * AMOUNT_HALF_HEIGHT,
          },
          programs: [],
          dates: [],
          purchased: [],
          names: [],
          other: [],
        };
        lines.push(unit);
        continue;
      }
      if (!unit) continue;
      const current: InvoiceLine = unit;
      // An amount on a line under the VIN's, when the VIN's line had none.
      if (current.amount.cents === null) {
        const under = readAmount(cells.amount);
        if (under.cents) current.amount = { ...under, sure: false };
      }
      const text = tidy(cells.description);
      if (!text) continue;
      if (PURCHASE_LINE.test(text)) {
        current.dates.push(text);
        const purchased = /P[UV]R\s*[:;.,]?\s*(\S+)/i.exec(text);
        const day = purchased ? readInvoiceDate(purchased[1]) : null;
        if (day && !current.purchased.includes(day)) current.purchased.push(day);
      } else if (PROGRAM_LINE.test(text)) current.programs.push(text);
      else if (NAME_LINE.test(text) && /[A-Za-z].*[A-Za-z]/.test(text) && text.length <= 60) current.names.push(text);
      else current.other.push(text);
    }
  });

  if (!columns) return { error: NO_TABLE };
  if (lines.length === 0) return { error: NO_UNITS };
  const found: { number: string | null; type: string | null; date: string | null } = details ?? { number: null, type: null, date: null };
  return settleAmounts({ ...found, total: total as ReadAmount | null, pages: pages.length, lines }, new Map());
}

// Two readings of one amount as one: the first as the page was read, the
// second of its cell alone, cut off where a tick beside it starts and read
// as figures only. Readings that agree are sure; otherwise the second,
// unless only the first read cleanly.
function bothReadings(first: ReadAmount, second: ReadAmount): ReadAmount {
  if (first.sure || second.cents === null) return first;
  const others = (...lists: (Cents | null)[][]) => [...new Set(lists.flat().filter((cents): cents is Cents => cents !== null))];
  if (first.cents === second.cents) return { ...first, sure: true };
  return { text: first.text, cents: second.cents, sure: second.sure, others: others([first.cents], first.others, second.others).filter((cents) => cents !== second.cents) };
}

// The amounts settled: each read again (its line's text in `again`) put
// together with its first reading, then checked against the invoice's
// total, which settles a reading that could go two ways; when they add up
// to the total, every one is sure.
export function settleAmounts(invoice: Invoice, again: ReadonlyMap<number, string>): Invoice {
  const amounts = invoice.lines.map((line) => {
    const text = again.get(line.line);
    return text === undefined ? line.amount : bothReadings(line.amount, readAmount(text.split(/\s+/)));
  });
  const total = invoice.total?.cents ?? null;
  const settled = reconcileAmounts(amounts, total);
  const adds = total !== null && settled.every((amount) => amount.cents !== null) && settled.reduce((sum, amount) => sum + amount.cents!, 0) === Math.abs(total);
  return { ...invoice, lines: invoice.lines.map((line, index) => ({ ...line, amount: adds ? { ...settled[index], sure: true } : settled[index] })) };
}

// The amounts read, added up, and how far that is from the invoice's
// total (null without one).
export function amountsAddUp(invoice: Pick<Invoice, "lines" | "total">) {
  const sum = invoice.lines.reduce((all, line) => all + (line.amount.cents ?? 0), 0);
  const total = invoice.total?.cents ?? null;
  return { sum, total: total === null ? null : Math.abs(total), apart: total === null ? null : Math.abs(total) - sum };
}

// --- VINs ---------------------------------------------------------------------

// Characters OCR mixes up on Polaris's printouts, and a VIN typed by hand.
const MIXED_UP = ["0O", "0Q", "0D", "0C", "0U", "1I", "1L", "1T", "1J", "17", "2Z", "5S", "9S", "8S", "8B", "8E", "3B", "38", "6G", "6B", "4A", "9G", "9Q", "7T", "7Z", "UV", "VY", "MN", "HN", "KX", "EF", "PF", "RK"];
const MIXED = new Set(MIXED_UP.flatMap(([a, b]) => [a + b, b + a]));
const alike = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && (a === b || MIXED.has(a + b));

// The VIN as read, with the letters a VIN never has (I, O, Q) as the
// figures they stand for: what's shown for a unit that isn't found.
export const vinGuess = (read: string) => read.replace(/I/g, "1").replace(/[OQ]/g, "0");

// Whether a VIN is a whole one with the check digit that matches the rest.
export const isWholeVin = (vin: string | null | undefined) => typeof vin === "string" && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) && vinCheckDigit(vin) === vin[8];

// How far a VIN as read is from one on file: a character changed is 1, or
// 0.4 for one OCR mixes up (S and 5) and 0.5 for one it couldn't make out;
// a character too many is 1, or 0.5 beside one it's mixed up with (OCR
// reads a 5 as S5); one missing, or two swapped, is 1.
export function vinDistance(read: string, known: string): number {
  const a = read.toUpperCase();
  const b = known.toUpperCase();
  const extra = (i: number) => (alike(a[i - 1], a[i - 2]) || alike(a[i - 1], a[i]) ? 0.5 : 1);
  const change = (x: string, y: string) => (x === y ? 0 : x === "?" || y === "?" ? 0.5 : MIXED.has(x + y) ? 0.4 : 1);
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [rows[i - 1][0] + extra(i)];
    for (let j = 1; j <= b.length; j++) {
      let best = Math.min(rows[i - 1][j] + extra(i), row[j - 1] + 1, rows[i - 1][j - 1] + change(a[i - 1], b[j - 1]));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] && a[i - 1] !== a[i - 2]) best = Math.min(best, rows[i - 2][j - 2] + 1);
      row.push(best);
    }
    rows.push(row);
  }
  return Math.round(rows[a.length][b.length] * 100) / 100;
}

// A quick look before working out the distance: most of the characters
// line up from one end or the other.
function couldBeClose(a: string, b: string) {
  let fromStart = 0;
  let fromEnd = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (alike(a[i], b[i])) fromStart++;
    if (alike(a[a.length - 1 - i], b[b.length - 1 - i])) fromEnd++;
  }
  return Math.max(fromStart, fromEnd) >= 9;
}

// --- Finding the units in the NUSR -------------------------------------------

// A sale as matching needs it.
export type MatchUnit = { id: string; soldOn: string; customerName: string; vin: string | null; condition: "new" | "used" };

// What the browser sends for each unit: its key, the VIN as read, and the
// names and purchase dates printed under it.
export type MatchItem = { key: string; vinRead: string; names: string[]; purchased: string[] };

// How a unit was found: its VIN; a VIN a slip away (OCR's, read as "read",
// or the NUSR's, which then fails its check digit: "typo"); by the name and
// purchase date, the NUSR having no VIN for it; or not at all.
export const MATCH_HOWS = ["vin", "read", "typo", "name"] as const;
export type MatchHow = (typeof MATCH_HOWS)[number] | null;

export type ItemMatch = {
  key: string;
  saleId: string | null;
  how: MatchHow;
  // Sales it may be, the likeliest first (the one picked among them).
  candidates: string[];
  // Another line of the invoice found the same sale.
  sharedWith: string[];
};

// The most a VIN as read can be from the NUSR's, slips and all.
export const NEAR_VIN = 2;
// A name found within this many days of the purchase date is offered;
// within SAME_DAYS, and with no VIN in the NUSR, it's taken.
const NAME_DAYS = 10;
const SAME_DAYS = 3;
const MAX_CANDIDATES = 5;

const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

// The likeliest of several sales of one VIN: sold new, then nearest the
// purchase date, then the latest.
function rankSameVin(units: MatchUnit[], purchased: readonly string[]) {
  const nearest = (unit: MatchUnit) => (purchased.length ? Math.min(...purchased.map((day) => daysApart(day, unit.soldOn))) : 0);
  return [...units].sort(
    (a, b) => (a.condition === "new" ? 0 : 1) - (b.condition === "new" ? 0 : 1) || nearest(a) - nearest(b) || (a.soldOn < b.soldOn ? 1 : a.soldOn > b.soldOn ? -1 : 0),
  );
}

// Each unit on the invoice found in the NUSR: by its VIN first (every line
// found that way keeps its sale), then by a VIN a slip away, then by name
// and date; a sale one line has is offered to another, not taken.
export function matchItems(items: readonly MatchItem[], units: readonly MatchUnit[]): ItemMatch[] {
  const byVin = new Map<string, MatchUnit[]>();
  for (const unit of units) {
    if (!unit.vin) continue;
    const vin = unit.vin.toUpperCase();
    byVin.set(vin, [...(byVin.get(vin) ?? []), unit]);
  }
  const withVin = [...byVin.entries()];
  const taken = new Set<string>();
  const results = new Map<string, ItemMatch>();

  // 1. The VIN as read (OCR's I, O and Q for 1 and 0).
  for (const item of items) {
    const same = byVin.get(vinGuess(item.vinRead));
    if (!same) continue;
    const ranked = rankSameVin(same, item.purchased);
    results.set(item.key, { key: item.key, saleId: ranked[0].id, how: "vin", candidates: ranked.map((unit) => unit.id).slice(0, MAX_CANDIDATES), sharedWith: [] });
    taken.add(ranked[0].id);
  }

  // 2. A VIN a slip away. A whole VIN as read, check digit and all, is the
  // unit's: one on file that's a whole VIN too is a different unit, and one
  // that fails its check digit was typed with a slip. A VIN that isn't
  // whole as read is OCR's slip, found when one VIN on file is clearly the
  // nearest.
  const near: { item: MatchItem; ids: string[]; distance: number; how: MatchHow; sure: boolean }[] = [];
  for (const item of items) {
    if (results.has(item.key)) continue;
    const read = item.vinRead.toUpperCase();
    const whole = isWholeVin(vinGuess(read));
    const scored = withVin
      .filter(([vin]) => couldBeClose(read, vin) && !(whole && isWholeVin(vin)))
      .map(([vin, same]) => ({ vin, same, distance: vinDistance(read, vin) }))
      .filter((entry) => entry.distance <= NEAR_VIN + 1.5)
      .sort((a, b) => a.distance - b.distance);
    const [best, second] = scored;
    if (!best) continue;
    const clear = best.distance <= NEAR_VIN && (!second || second.distance - best.distance >= 1);
    const ids = scored.flatMap((entry) => rankSameVin(entry.same, item.purchased).map((unit) => unit.id)).slice(0, MAX_CANDIDATES);
    near.push({ item, ids, distance: best.distance, how: whole ? "typo" : "read", sure: clear });
  }
  for (const entry of near.sort((a, b) => a.distance - b.distance)) {
    const pick = entry.sure ? entry.ids.find((id) => !taken.has(id)) : undefined;
    const saleId = pick !== undefined && pick === entry.ids[0] ? pick : null;
    if (saleId) taken.add(saleId);
    results.set(entry.item.key, { key: entry.item.key, saleId, how: saleId ? entry.how : null, candidates: entry.ids, sharedWith: [] });
  }

  // 3. By name, near the purchase date: for a unit the NUSR has no VIN
  // for (or one too far from what was read).
  for (const item of items) {
    const sofar = results.get(item.key);
    if (sofar?.saleId) continue;
    const named = units
      .filter((unit) => !taken.has(unit.id))
      .map((unit) => ({
        unit,
        likeness: Math.max(0, ...item.names.map((name) => nameLikeness(name, unit.customerName))),
        days: item.purchased.length ? Math.min(...item.purchased.map((day) => daysApart(day, unit.soldOn))) : Infinity,
      }))
      .filter((entry) => entry.likeness >= 0.5 && entry.days <= NAME_DAYS)
      .sort((a, b) => b.likeness - a.likeness || a.days - b.days);
    const [best, second] = named;
    const take =
      best &&
      !isWholeVin(best.unit.vin) &&
      best.days <= SAME_DAYS &&
      (!second || second.likeness < best.likeness || second.days > best.days);
    if (take) taken.add(best.unit.id);
    const candidates = [...new Set([...named.map((entry) => entry.unit.id), ...(sofar?.candidates ?? [])])].slice(0, MAX_CANDIDATES);
    results.set(item.key, { key: item.key, saleId: take ? best.unit.id : null, how: take ? "name" : null, candidates, sharedWith: [] });
  }

  // Lines that found the same sale (the same VIN twice on the invoice).
  const all = items.map((item) => results.get(item.key)!);
  for (const result of all) {
    if (!result.saleId) continue;
    result.sharedWith = all.filter((other) => other !== result && other.saleId === result.saleId).map((other) => other.key);
  }
  return all;
}

// What's worth knowing about the sale a line was found as, for the page
// and the download's notes; `check` ones are for someone to look at, and
// most are for correcting the sale in the NUSR.
export type SaleNote = { check: boolean; text: string; correct: boolean };

export function saleNotes(
  line: { vinRead: string; how: MatchHow; sharedWith: readonly (string | number)[] },
  sale: { vin: string | null; condition: "new" | "used"; holdback: Cents },
  column: RebateColumn | null,
): SaleNote[] {
  const notes: SaleNote[] = [];
  const read = vinGuess(line.vinRead);
  if (sale.vin && !isWholeVin(sale.vin)) {
    const invoice = isWholeVin(read) ? `; the invoice's is ${read}` : "";
    notes.push({ check: true, correct: true, text: `The NUSR has its VIN as ${sale.vin}, which isn't a whole VIN (a character is off or missing)${invoice}.` });
  } else if (!sale.vin) {
    notes.push({ check: true, correct: true, text: `The NUSR has no VIN for this sale${line.how === "name" ? ": it was found by the name and date" : ""}.` });
  } else if (sale.vin !== read) {
    notes.push({ check: false, correct: false, text: `VIN read as ${line.vinRead}.` });
  }
  if (line.sharedWith.length) notes.push({ check: true, correct: false, text: `Line ${line.sharedWith.join(" and ")} found the same sale.` });
  if (sale.condition === "used") {
    notes.push({
      check: true,
      correct: true,
      text: `The NUSR has this sale as used, but Polaris paid a rebate on it as a new unit${column === "addlHoldback" ? ", and it has no holdback for AO" : ""}: check its New/Used, MSRP and type of deal.`,
    });
  } else if (column === "addlHoldback" && sale.holdback === 0) {
    notes.push({ check: true, correct: true, text: "The NUSR has no holdback on this sale, so AO is left blank: check its MSRP and holdback rate." });
  }
  return notes;
}

// --- AO, AP and AQ ------------------------------------------------------------

// The NUSR sheet's rebate columns, as the shop heads them.
export const REBATE_COLUMNS = ["holdback", "retailRewards", "addlHoldback"] as const;
export type RebateColumn = (typeof REBATE_COLUMNS)[number];
export const REBATE_COLUMN_HEADINGS: Record<RebateColumn, string> = { holdback: "Holdback", retailRewards: "Retail Rwds", addlHoldback: "Add'l Hlbk" };
export const REBATE_COLUMN_LETTERS: Record<RebateColumn, string> = { holdback: "AO", retailRewards: "AP", addlHoldback: "AQ" };
export const REBATE_COLUMN_LABELS: Record<RebateColumn, string> = {
  holdback: "Holdback (AO)",
  retailRewards: "Retail rewards (AP)",
  addlHoldback: "Add'l holdback (AQ)",
};
export const isRebateColumn = (value: unknown): value is RebateColumn => (REBATE_COLUMNS as readonly unknown[]).includes(value);

// The column one program's amounts go in, by Polaris's words for it, or
// null when they don't say: an NSR program ("US RGR NSR 2H 2026 R") pays the
// additional holdback (AQ); retail rewards go in AP; a holdback statement
// in AO.
export function programColumn(program: string): RebateColumn | null {
  const text = program.toUpperCase().replace(/[^A-Z0-9']+/g, " ");
  if (/\bNSR\b|\bADD'?L\b|\bADDITIONAL\b/.test(text)) return "addlHoldback";
  if (/\bRETAIL REW|\bRTL\b|\bRWDS?\b|\bREWARDS?\b|\bRR\b/.test(text)) return "retailRewards";
  if (/\bHOLDBACK\b|\bHLDBK\b|\bHLBK\b|\bHB\b/.test(text)) return "holdback";
  return null;
}

// What an invoice's programs say about where its amounts go: each line's
// program (a line printed with two goes by the first that says), and the
// column most of its lines say, so a program OCR misread on a line or two
// doesn't decide it. Null when none say, or two say as often; `lines` has
// how many lines said each, and `programs` the programs read, the most
// printed first.
export type InvoicePrograms = { column: RebateColumn | null; lines: Partial<Record<RebateColumn, number>>; programs: string[] };

export function invoicePrograms(lines: readonly Pick<InvoiceLine, "programs">[]): InvoicePrograms {
  const said: Partial<Record<RebateColumn, number>> = {};
  const printed = new Map<string, number>();
  for (const line of lines) {
    let column: RebateColumn | null = null;
    for (const program of line.programs) {
      printed.set(program, (printed.get(program) ?? 0) + 1);
      column ??= programColumn(program);
    }
    if (column) said[column] = (said[column] ?? 0) + 1;
  }
  const [first, second] = (Object.entries(said) as [RebateColumn, number][]).sort((a, b) => b[1] - a[1]);
  return {
    column: first && (!second || first[1] > second[1]) ? first[0] : null,
    lines: said,
    programs: [...printed.entries()].sort((a, b) => b[1] - a[1]).map(([program]) => program),
  };
}

export type RebateCells = Record<RebateColumn, Cents | null>;

// What goes in a sale's AO, AP and AQ: each invoice line's amount added up
// in its invoice's column. The Holdback (AO) is the sale's own holdback
// from the NUSR for a unit an additional holdback was paid on, unless an
// invoice paid the holdback itself.
export function rebateCells(lines: readonly { column: RebateColumn; cents: Cents }[], nusrHoldback: Cents): RebateCells {
  const cells: RebateCells = { holdback: null, retailRewards: null, addlHoldback: null };
  for (const { column, cents } of lines) cells[column] = (cells[column] ?? 0) + cents;
  if (cells.holdback === null && cells.addlHoldback !== null && nusrHoldback !== 0) cells.holdback = nusrHoldback;
  return cells;
}

// "Rebates 314886 2026-11-06.xlsx", or with every invoice's number.
export function rebatesFileName(numbers: readonly (string | null)[], today: string) {
  const known = [...new Set(numbers.filter((number): number is string => Boolean(number)))];
  const named = known.length === 0 ? "" : known.length <= 3 ? ` ${known.join(" ")}` : ` ${known.slice(0, 3).join(" ")} and ${known.length - 3} more`;
  return `Rebates${named} ${today}.xlsx`;
}

// "$60,602.36" for a total.
export const formatCredit = (cents: Cents | null) => formatMoney(cents === null ? null : Math.abs(cents));

// --- Saved rebates' filters ---------------------------------------------------

// Whether a saved line was found in the NUSR.
export const REBATE_STATUSES = ["found", "missing"] as const;
export type RebateStatus = (typeof REBATE_STATUSES)[number];
export const REBATE_STATUS_LABELS: Record<RebateStatus, string> = { found: "Found in the NUSR", missing: "Not found" };

// The saved rebates' filters, from the address: the year (this one unless
// another or "all" is asked for) and month of the invoice's date, the
// column its amounts went in, the salesman and category of the sale a line
// was found as, whether it was found, and a search.
export type RebateFilters = {
  year: number | null;
  month: number | null;
  column: RebateColumn | null;
  salesperson: string | null;
  category: string | null;
  status: RebateStatus | null;
  query: string;
};

type FilterParams = Record<string, string | string[] | undefined>;
const filterParam = (params: FilterParams, key: string) => {
  const value = params[key];
  return (typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? "") : "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
};

export function parseRebateFilters(params: FilterParams, thisYear: number): RebateFilters {
  const yearText = filterParam(params, "year");
  const year = yearText === "all" ? null : /^\d{4}$/.test(yearText) && Number(yearText) >= 2000 && Number(yearText) <= 2100 ? Number(yearText) : thisYear;
  const month = filterParam(params, "month");
  const column = filterParam(params, "column");
  const status = filterParam(params, "status");
  return {
    year,
    month: year !== null && /^(?:[1-9]|1[0-2])$/.test(month) ? Number(month) : null,
    column: isRebateColumn(column) ? column : null,
    salesperson: filterParam(params, "salesperson").slice(0, 80) || null,
    category: filterParam(params, "category").slice(0, 30) || null,
    status: (REBATE_STATUSES as readonly string[]).includes(status) ? (status as RebateStatus) : null,
    query: filterParam(params, "q").slice(0, 100),
  };
}

// The filters as an address's search, without what's as it is by default
// (this year, the rest unset); `extra` adds the page and the like.
export function rebateFiltersSearch(filters: RebateFilters, thisYear: number, extra: Record<string, string | number | null> = {}) {
  const search = new URLSearchParams();
  if (filters.year === null) search.set("year", "all");
  else if (filters.year !== thisYear) search.set("year", String(filters.year));
  if (filters.month !== null) search.set("month", String(filters.month));
  if (filters.column) search.set("column", filters.column);
  if (filters.salesperson) search.set("salesperson", filters.salesperson);
  if (filters.category) search.set("category", filters.category);
  if (filters.status) search.set("status", filters.status);
  if (filters.query) search.set("q", filters.query);
  for (const [key, value] of Object.entries(extra)) if (value !== null && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

const FILTER_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "2026", "October 2026 · Add'l holdback (AQ) · Brian Setree", "All years".
export function rebateFiltersTitle(filters: RebateFilters) {
  const when = filters.year === null ? "All years" : filters.month === null ? String(filters.year) : `${FILTER_MONTHS[filters.month - 1]} ${filters.year}`;
  return [
    when,
    filters.column ? REBATE_COLUMN_LABELS[filters.column] : null,
    filters.salesperson,
    filters.category,
    filters.status ? REBATE_STATUS_LABELS[filters.status] : null,
    filters.query ? `“${filters.query}”` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// The saved rebates' download's name, "Rebates 2026 2026-11-06.xlsx": the
// filters' title and the day, as the NUSR's download is named.
export function savedRebatesFileName(title: string, today: string) {
  const safe = title
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .trim();
  return `Rebates ${cutText(safe, 120).trim()} ${today}.xlsx`.replace(/\s+/g, " ");
}
