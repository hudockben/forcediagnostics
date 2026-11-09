// Unit List (the Unit List tab): the shop's units in stock, each with its
// model, VIN, the day it was received, its cost and its list price, as the
// shop kept them on a spreadsheet (Model, VIN, Received, Cost, List, and a
// 1 in the count column for each unit). Units come in from Polaris's whole
// goods invoices, dropped on the tab: this reads them, as
// src/lib/rebate-rules.ts reads rebate invoices.
//
// A whole goods invoice is the dealer portal's Invoice Print of a "Type:
// Whole Goods" invoice, one unit each as a rule: its Part is the model number
// ("R27RSY99AA": R, the model year's two figures, the model code in the
// VIN's characters 4-8, then paint and market), its Description Polaris's
// abbreviation of the model ("RGR-27,1K,XP,NSULT,CR,ARMYG"), its Unit Price
// what the unit cost the shop, and on the line under it the VIN and the
// engine number ("4XARSY991V8074528 1209389077163"). The shop scans the
// printouts, often several invoices in one PDF (parts and rebate invoices
// among them, which have no units and are left out), and a scanner's streak
// down the page cuts through a character or two. So the VIN is put right
// from what else the invoice says: the model code and year in its model
// number, and the check digit (character 9), which settles a character the
// two readings disagree on.
//
// No server imports: the browser reads the invoice with these rules, and the
// server checks what's saved with the same ones.

import { floorStatus } from "@/lib/loc-rules";
import { MAX_AMOUNT_CENTS, cleanVin, formatMoney, guessCategory, line, parseIsoDate, parseMoney, type Cents } from "@/lib/nusr-rules";
import {
  NO_TABLE,
  PAGE_FOOT,
  PAGE_HEAD,
  TABLE_END,
  headingColumns,
  invoiceTotal,
  lineCells,
  ocrAlike,
  pageLines,
  readAmount,
  readInvoiceDate,
  tidy,
  type Columns,
  type InvoicePage,
  type Line,
  type ReadAmount,
} from "@/lib/rebate-rules";
import { modelNumberYear, vinCheckDigit, vinYearCode } from "@/lib/vin";

export { NO_TABLE };

// --- Invoices -------------------------------------------------------------------

// What an invoice is, by its Type: only whole goods have units on them.
export const INVOICE_KINDS = ["wholeGoods", "parts", "rebate", "other"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export function invoiceKind(type: string | null): InvoiceKind {
  if (!type) return "other";
  if (/whole/i.test(type)) return "wholeGoods";
  if (/rebate/i.test(type)) return "rebate";
  if (/pg\s*&?\s*a|\bparts?\b|access/i.test(type)) return "parts";
  return "other";
}

// A VIN as read, and as put right: the VIN it most likely is, whether that's
// sure (its check digit matches, and nothing else that was read could be
// the VIN), the other VINs it could be, and whether its check digit
// matches.
export type ReadVin = { text: string; vin: string; sure: boolean; others: string[]; checkDigitOk: boolean };

// A unit on an invoice.
export type InvoiceUnit = {
  // Its place among the file's units, from 1; its invoice's number; the
  // page its VIN is on.
  index: number;
  invoice: string | null;
  page: number;
  // The Part column, as a model number ("R27RSY99AA"), and the description
  // as printed ("RGR-27,1K,XP,NSULT,CR,ARMYG").
  modelNumber: string | null;
  description: string;
  // The model year, from the model number (or the VIN when there's none).
  year: number | null;
  vin: ReadVin | null;
  engineNumber: string | null;
  // What it cost the shop: the Unit Price (or the Amount), as read.
  cost: ReadAmount;
};

// A charge on a whole goods invoice that isn't a unit (freight, say).
export type InvoiceCharge = { description: string; amount: Cents | null };

export type UnitInvoice = {
  // "374953", "Whole Goods" (as printed), what that makes it, the invoice
  // date ("2026-11-06"), its total, and the file's pages it's on.
  number: string | null;
  type: string | null;
  kind: InvoiceKind;
  date: string | null;
  total: ReadAmount | null;
  pages: number[];
  units: InvoiceUnit[];
  charges: InvoiceCharge[];
};

// A model number in the Part column: a letter, the year's two figures, the
// five characters of the model code, then up to four for paint and market.
const MODEL_NUMBER = /^[A-Z]\d{2}[A-HJ-NPR-Z0-9]{5}[A-Z0-9]{0,4}$/;
// Figures OCR reads as letters, in a model number's year.
const AS_FIGURE: Record<string, string> = { O: "0", D: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6", T: "7" };

// The model number in what was read in the Part column ("1 1 R27RSY99AA":
// the quantities ordered and shipped come first), with OCR's slips put
// right where they can be (a bracket for the J at its end, a letter for a
// figure of its year), or null.
export function readModelNumber(part: string): string | null {
  for (const token of part.toUpperCase().split(/\s+/)) {
    if (token.length < 8) continue;
    const cleaned = token.replace(/[\])}]$/, "J").replace(/[^A-Z0-9]/g, "");
    if (cleaned.length < 8 || !/^[A-Z]/.test(cleaned)) continue;
    const year = cleaned.slice(1, 3).replace(/[A-Z]/g, (letter) => AS_FIGURE[letter] ?? letter);
    const code = cleaned.slice(3).replace(/I/g, "1").replace(/[OQ]/g, "0");
    const number = cleaned[0] + year + code;
    if (MODEL_NUMBER.test(number)) return number;
  }
  return null;
}

// How many of a line were shipped: the figures before its Part ("1 1
// R27RSY99AA" is one ordered, one shipped), or 1.
function shippedOf(part: string): number {
  const figures = part
    .split(/\s+/)
    .filter((word) => /^\d{1,2}$/.test(word))
    .map(Number);
  const shipped = figures.length >= 2 ? figures[1] : (figures[0] ?? 1);
  return Math.min(50, Math.max(1, shipped));
}

// --- VINs -----------------------------------------------------------------------

const VIN_CHARACTERS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
const FIGURES = "0123456789";
// What OCR's I, O and Q stand for in a VIN, which never has them.
const NOT_IN_VINS: Record<string, string> = { I: "1", O: "0", Q: "0" };

// What can go in each of a VIN's characters: anything but I, O and Q, but
// only a figure (or X) in the check digit and figures in the last four.
const fits = (slot: number, character: string) =>
  slot === 8 ? /^[0-9X]$/.test(character) : slot >= 13 ? FIGURES.includes(character) : VIN_CHARACTERS.includes(character);
const choicesFor = (slot: number) => (slot === 8 ? `${FIGURES}X` : slot >= 13 ? FIGURES : VIN_CHARACTERS).split("");

// The most VINs worked through to find one whose check digit matches.
const MAX_TRIES = 20_000;
// More tries than this and a single match isn't telling.
const SURE_TRIES = 16;

// The VIN at the start of a unit's second line ("3NSTAU990VH272059
// 1209259165869"), as read, with the engine number after it. A scanner's
// streak can split it in two, or take a character out ("3NS AUS90VH272059"),
// so up to three pieces are put together; a character that isn't a letter
// or figure is one OCR couldn't make out ("?").
export function vinOnLine(description: string): { text: string; rest: string[] } | null {
  const words = description
    .replace(/^\W*VIN\W*/i, "")
    .split(/\s+/)
    .filter(Boolean);
  const looksLikeVin = (text: string) => {
    const count = (pattern: RegExp) => (text.match(pattern) ?? []).length;
    return count(/\d/g) >= 6 && count(/[A-Z]/g) >= 2 && count(/\?/g) <= 3;
  };
  const pieces: string[] = [];
  for (let k = 0; k < Math.min(3, words.length); k++) {
    pieces.push(words[k].toUpperCase().replace(/[^A-Z0-9]/g, "?"));
    const joined = pieces.join("");
    // The VIN and the engine number run together.
    if (k === 0 && joined.length > 19 && looksLikeVin(joined.slice(0, 17)) && /^\d{6,}$/.test(joined.slice(17))) {
      return { text: joined.slice(0, 17), rest: [joined.slice(17), ...words.slice(1)] };
    }
    if (joined.length > 19) return null;
    if (joined.length >= 15 && looksLikeVin(joined)) {
      // Two pieces a character short: the character the gap took.
      const text = k === 1 && joined.length === 16 ? `${pieces[0]}?${pieces[1]}` : joined;
      return { text, rest: words.slice(k + 1) };
    }
  }
  return null;
}

// What each of a VIN's characters should be by its model number: the model
// code in 4-8 and the model year in 10. Nothing for the rest.
function expectedByModel(modelNumber: string | null): (string | null)[] {
  const expected: (string | null)[] = Array(17).fill(null);
  if (!modelNumber || !MODEL_NUMBER.test(modelNumber)) return expected;
  const code = modelNumber.slice(3, 8);
  for (let i = 0; i < 5; i++) if (fits(3 + i, code[i])) expected[3 + i] = code[i];
  const year = modelNumberYear(modelNumber);
  const yearCode = year === null ? null : vinYearCode(year);
  if (yearCode) expected[9] = yearCode;
  return expected;
}

// Lines up a VIN as read (15 to 19 characters) with a VIN's 17, by what
// each should be: for each, the character read there, or null when it
// wasn't read. Reading a character for another OCR mixes it up with costs
// little; one too many, or missing, costs more.
function alignVin(read: string, expected: readonly (string | null)[]): (string | null)[] {
  const n = read.length;
  const substitute = (character: string, slot: number) => {
    const want = expected[slot];
    if (character === "?") return 0.5;
    if (want === null) return fits(slot, character) ? 0 : 0.5;
    if (character === want) return 0;
    return ocrAlike(character, want) ? 0.4 : 1;
  };
  const extra = (character: string) => (character === "?" ? 0.6 : 1);
  const cost: number[][] = Array.from({ length: n + 1 }, () => Array(18).fill(Infinity));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let s = 0; s <= 17; s++) {
      if (i === 0 && s === 0) continue;
      let best = Infinity;
      if (i > 0 && s > 0) best = Math.min(best, cost[i - 1][s - 1] + substitute(read[i - 1], s - 1));
      if (i > 0) best = Math.min(best, cost[i - 1][s] + extra(read[i - 1]));
      if (s > 0) best = Math.min(best, cost[i][s - 1] + 1);
      cost[i][s] = best;
    }
  }
  const slots: (string | null)[] = Array(17).fill(null);
  let i = n;
  let s = 17;
  while (i > 0 || s > 0) {
    if (i > 0 && s > 0 && Math.abs(cost[i][s] - (cost[i - 1][s - 1] + substitute(read[i - 1], s - 1))) < 1e-9) {
      slots[s - 1] = read[i - 1];
      i--;
      s--;
    } else if (i > 0 && Math.abs(cost[i][s] - (cost[i - 1][s] + extra(read[i - 1]))) < 1e-9) {
      i--;
    } else {
      s--;
    }
  }
  return slots;
}

const checks = (vin: string) => vinCheckDigit(vin) === vin[8];

// The VIN a reading most likely is, put right by the model number (its
// model code and year) and the check digit: where what was read and what
// the model number says differ, or a character couldn't be made out (or
// can't be in a VIN: I, O, Q), each way it could be is tried, and the one
// whose check digit matches is it. More than one matching, or none, and
// it isn't sure: the page asks for it to be checked against the unit,
// offering the others.
export function resolveVin(read: string, modelNumber: string | null = null): ReadVin {
  const text = read.toUpperCase().replace(/[^A-Z0-9?]/g, "?");
  const expected = expectedByModel(modelNumber);
  const slots = text.length === 17 && expected.every((want) => want === null) ? text.split("") : alignVin(text, expected);
  // The ways each character could be, the likeliest first.
  const ways = slots.map((character, slot) => {
    const want = expected[slot];
    const options: string[] = [];
    if (character && fits(slot, character)) options.push(character);
    else if (character && character !== "?") {
      const meant = NOT_IN_VINS[character];
      if (meant && fits(slot, meant)) options.push(meant);
      for (const other of choicesFor(slot)) if (!options.includes(other) && ocrAlike(character, other)) options.push(other);
    }
    if (want && !options.includes(want)) options.push(want);
    return options.length ? options : choicesFor(slot);
  });
  const tries = ways.reduce((product, options) => product * options.length, 1);
  const likeliest = ways.map((options) => options[0]).join("");
  if (tries > MAX_TRIES) return { text, vin: likeliest, sure: false, others: [], checkDigitOk: checks(likeliest) };

  // How far a VIN is from both readings: a character unlike what was read,
  // and one unlike what the model number says.
  const distance = (vin: string) =>
    slots.reduce((sum, character, slot) => {
      const read = character && fits(slot, character) ? character : null;
      return sum + (read !== null && vin[slot] !== read ? 1 : 0) + (expected[slot] !== null && vin[slot] !== expected[slot] ? 1 : 0);
    }, 0);
  const matching: string[] = [];
  const pick = Array(17).fill(0);
  for (let t = 0; t < tries; t++) {
    const vin = ways.map((options, slot) => options[pick[slot]]).join("");
    if (checks(vin)) matching.push(vin);
    for (let slot = 16; slot >= 0; slot--) {
      if (++pick[slot] < ways[slot].length) break;
      pick[slot] = 0;
    }
  }
  if (matching.length === 0) return { text, vin: likeliest, sure: false, others: [], checkDigitOk: false };
  const ranked = matching
    .map((vin, order) => ({ vin, order, distance: distance(vin) }))
    .sort((a, b) => a.distance - b.distance || a.order - b.order)
    .map((one) => one.vin);
  return { text, vin: ranked[0], sure: ranked.length === 1 && tries <= SURE_TRIES, others: ranked.slice(1, 4), checkDigitOk: true };
}

// --- Reading the invoice --------------------------------------------------------

// The table's headings row, as the rebate invoices' (src/lib/rebate-rules.ts),
// or one whose "Description" a streak cut up ("Descrip ion", "Des cription"):
// then the description starts with the word after "Part".
function tableColumns(line: Line): Columns | null {
  const columns = headingColumns(line);
  if (columns) return columns;
  const at = line.words.findIndex((word) => /^part$/i.test(word.text));
  const amount = line.words.find((word) => /^amo?unt|^amt\b/i.test(word.text));
  const price = line.words.find((word) => /^pric/i.test(word.text));
  const next = at >= 0 ? line.words[at + 1] : undefined;
  if (!amount || !price || !next || /^unit$|^pric/i.test(next.text)) return null;
  const right = (word: { left: number; width: number }) => word.left + word.width;
  if (!(next.left < right(price) && right(price) < right(amount))) return null;
  return { descriptionLeft: next.left, priceRight: right(price), amountRight: right(amount) };
}

// An invoice's number, type and date from the head of a page ("Invoice -
// 374953 Type:Whole Goods", the date under "Invoice Date"). OCR reads the
// dash as a tilde or a bracket now and then.
function invoiceHead(lines: readonly Line[], height: number) {
  const text = lines.map((one) => one.text).join("\n");
  const number = /\binvoice\s*(?:no\.?|number|#)?\s*[^A-Za-z0-9\s]{0,3}\s*(\d{5,10})\b/i.exec(text)?.[1] ?? null;
  const typed = /\btype\s*[:;.]?\s*([A-Za-z&]+(?:\s+goods\b)?)/i.exec(text)?.[1] ?? null;
  let date: string | null = null;
  const at = lines.findIndex((one) => /\binvoice\s+date\b/i.test(one.text));
  if (at >= 0) {
    const heading = lines[at].words.find((word, index, words) => /^invoice$/i.test(word.text) && /^date/i.test(words[index + 1]?.text ?? ""));
    for (const one of lines.slice(at, at + 4)) {
      const under = one.words.find((word) => (!heading || Math.abs(word.left - heading.left) < height * 4) && readInvoiceDate(word.text));
      if (under) {
        date = readInvoiceDate(under.text);
        break;
      }
    }
  }
  return { number, type: typed ? typed.replace(/\s+/g, " ") : null, date };
}

// Polaris's description as it prints it, commas without spaces, from what
// OCR made of it ("RGR-27 1K, XP,NSULT" and "RGR-27:1K,XP,NSULT" are
// "RGR-27,1K,XP,NSULT").
export function tidyDescription(text: string): string {
  return tidy(text)
    .replace(/\s*,\s*/g, ",")
    .replace(/^([A-Za-z]+-\d{2})[.:;\s]+(?=\S)/, "$1,")
    .slice(0, UNIT_LIMITS.description);
}

// The model year in Polaris's description ("GEN-26,1K"), from the model
// number when OCR couldn't make it out ("GEN-2¢,1K").
export function descriptionYear(description: string, modelNumber: string | null): string {
  const year = modelNumber && MODEL_NUMBER.test(modelNumber) ? modelNumber.slice(1, 3) : null;
  return year ? description.replace(/^([A-Za-z]+)-[^,\s]{1,3}(?=,)/, `$1-${year}`) : description;
}

// A line with a price on it, and the VIN lines under it.
type Head = {
  page: number;
  modelNumber: string | null;
  description: string;
  price: ReadAmount;
  amount: ReadAmount;
  shipped: number;
  vins: { text: string; rest: string[]; page: number }[];
};

type Building = Omit<UnitInvoice, "units" | "charges"> & { heads: Head[]; ended: boolean };

// What a unit cost: its Unit Price when that read cleanly, else the Amount
// (a line's price times what was shipped), else whichever was read; sure
// when the two agree.
function costOf(head: Head): ReadAmount {
  const { price, amount, shipped } = head;
  if (price.cents !== null && price.sure) return price;
  if (amount.cents !== null && amount.sure && amount.cents % shipped === 0) return { ...amount, cents: amount.cents / shipped };
  if (price.cents !== null && amount.cents !== null && price.cents * shipped === amount.cents) return { ...price, sure: true };
  if (price.cents !== null) return price;
  if (amount.cents !== null) return { ...amount, cents: Math.round(amount.cents / shipped), sure: false };
  return price;
}

// The engine number printed after a VIN ("1209389077163"), or null.
function engineNumberIn(rest: readonly string[]): string | null {
  for (const word of rest) {
    const figures = word.toUpperCase().replace(/[OD]/g, "0").replace(/[IL|]/g, "1");
    if (/^[0-9]{6,20}$/.test(figures)) return figures;
  }
  return null;
}

export const NO_INVOICE_UNITS =
  "No units were found on this invoice: a whole goods invoice has the model number in its Part column and the VIN on the line under it.";

// The invoices in a file read from its pages (src/app/(app)/rebates/reader.ts
// reads a PDF's own text, or OCR on a scan or a picture): a page whose
// invoice number differs from the one before, or that comes after an
// invoice's totals, starts another invoice. Each one's number, type, date
// and total, and on a whole goods invoice its units: the model number,
// description and Unit Price on one line and the VIN and engine number on
// the line (or lines) under it. Parts and rebate invoices are listed with
// no units.
export function readUnitInvoices(pages: readonly InvoicePage[]): { invoices: UnitInvoice[] } | { error: string } {
  let columns: Columns | null = null;
  let current: Building | null = null;
  const built: Building[] = [];

  pages.forEach((page, pageIndex) => {
    const { lines, height } = pageLines(page.words);
    const headingAt = lines.findIndex((one) => tableColumns(one) !== null);
    if (headingAt >= 0) columns = tableColumns(lines[headingAt]);
    const head = invoiceHead(headingAt >= 0 ? lines.slice(0, headingAt) : lines, height);
    const total = invoiceTotal(lines);
    let invoice: Building | null = current;
    if (!invoice || invoice.ended || (head.number !== null && invoice.number !== null && head.number !== invoice.number)) {
      invoice = { number: head.number, type: head.type, kind: invoiceKind(head.type), date: head.date, total: null, pages: [], heads: [], ended: false };
      built.push(invoice);
      current = invoice;
    } else {
      invoice.number ??= head.number;
      if (!invoice.type && head.type) {
        invoice.type = head.type;
        invoice.kind = invoiceKind(head.type);
      }
      invoice.date ??= head.date;
    }
    invoice.pages.push(pageIndex + 1);
    if (total) invoice.total = total;
    if (!columns) {
      if (total) invoice.ended = true;
      return;
    }
    for (const one of lines.slice(headingAt + 1)) {
      if (TABLE_END.test(tidy(one.text))) break;
      if (PAGE_FOOT.test(one.text)) break;
      if (PAGE_HEAD.test(one.text)) continue;
      if (invoice.kind === "parts" || invoice.kind === "rebate") continue;
      const cells = lineCells(one, columns, height);
      const price = readAmount(cells.unitPrice);
      const amount = readAmount(cells.amount);
      const priced = price.cents !== null || amount.cents !== null;
      const vin = vinOnLine(cells.description);
      if (priced) {
        invoice.heads.push({
          page: pageIndex + 1,
          modelNumber: readModelNumber(cells.part),
          description: vin ? "" : tidyDescription(cells.description),
          price,
          amount,
          shipped: shippedOf(cells.part),
          // A VIN on the priced line itself (laid out as a rebate's).
          vins: vin ? [{ ...vin, page: pageIndex + 1 }] : [],
        });
      } else if (vin) {
        invoice.heads.at(-1)?.vins.push({ ...vin, page: pageIndex + 1 });
      }
    }
    if (total) invoice.ended = true;
  });

  if (!columns) return { error: NO_TABLE };
  let index = 0;
  const invoices = built.map(({ heads, number, type, kind, date, total, pages: on }): UnitInvoice => {
    const details = { number, type, kind, date, total, pages: on };
    const units: InvoiceUnit[] = [];
    const charges: InvoiceCharge[] = [];
    for (const head of heads) {
      const cost = costOf(head);
      // A credit (a minus, or nothing to pay) is never a unit.
      const credit = cost.cents === 0 || /-/.test(head.amount.text) || /-/.test(head.price.text);
      // Units: a line with a model number, or (on a whole goods invoice) a
      // VIN under it. Another priced line on a whole goods invoice is a
      // charge (freight, say).
      const unit = !credit && (head.modelNumber !== null || (details.kind === "wholeGoods" && head.vins.length > 0));
      if (!unit) {
        if (details.kind === "wholeGoods") charges.push({ description: head.description, amount: head.amount.cents ?? head.price.cents });
        continue;
      }
      if (head.vins.length === 0) {
        if (details.kind !== "wholeGoods") continue;
        const year = head.modelNumber ? modelNumberYear(head.modelNumber) : null;
        units.push({ index: ++index, invoice: details.number, page: head.page, modelNumber: head.modelNumber, description: head.description, year, vin: null, engineNumber: null, cost });
        continue;
      }
      for (const found of head.vins) {
        const vin = resolveVin(found.text, head.modelNumber);
        const modelNumber = modelNumberByVin(head.modelNumber, vin);
        units.push({
          index: ++index,
          invoice: details.number,
          page: found.page,
          modelNumber,
          description: descriptionYear(head.description, modelNumber),
          year: (modelNumber ? modelNumberYear(modelNumber) : null) ?? (vin.sure ? yearFromVin(vin.vin) : null),
          vin,
          engineNumber: engineNumberIn(found.rest),
          cost,
        });
      }
    }
    // When the units' costs (and any charges) add up to the invoice's
    // total, every cost is sure.
    const sum = units.reduce((all, unit) => all + (unit.cost.cents ?? 0), 0) + charges.reduce((all, charge) => all + (charge.amount ?? 0), 0);
    const adds = details.total?.cents != null && units.every((unit) => unit.cost.cents !== null) && sum === Math.abs(details.total.cents);
    return { ...details, units: adds ? units.map((unit) => ({ ...unit, cost: { ...unit.cost, sure: true } })) : units, charges };
  });
  return { invoices };
}

// The model number with the model code its VIN has, once the VIN is sure:
// OCR misreads the Part column as it does the VIN ("R27RSYS9AA" for
// R27RSY99AA), and a VIN whose check digit settles it says which. Left as
// read when the codes are more than OCR's slips apart.
export function modelNumberByVin(modelNumber: string | null, vin: ReadVin | null): string | null {
  if (!modelNumber || !vin?.sure || !MODEL_NUMBER.test(modelNumber)) return modelNumber;
  const code = vin.vin.slice(3, 8);
  const read = modelNumber.slice(3, 8);
  if (code === read || ![...code].every((character, i) => ocrAlike(character, read[i]))) return modelNumber;
  return modelNumber.slice(0, 3) + code + modelNumber.slice(8);
}

// A whole VIN's model year: the latest character 10 can mean, up to next
// year.
function yearFromVin(vin: string): number | null {
  const code = vin[9];
  for (let year = new Date().getUTCFullYear() + 1; year >= 1980; year--) if (vinYearCode(year) === code) return year;
  return null;
}

// What an invoice's units cost, added up, and how far that (with its
// charges) is from its total, or null without one.
export function invoiceAddsUp(invoice: Pick<UnitInvoice, "units" | "charges" | "total">) {
  const sum = invoice.units.reduce((all, unit) => all + (unit.cost.cents ?? 0), 0);
  const charges = invoice.charges.reduce((all, charge) => all + (charge.amount ?? 0), 0);
  const total = invoice.total?.cents ?? null;
  return { sum, charges, total: total === null ? null : Math.abs(total), apart: total === null ? null : Math.abs(total) - sum - charges };
}

// --- Models ---------------------------------------------------------------------

// "RGR-27,1K,XP,NSULT,CR,ARMYG" -> "RGR 1K XP NSULT CR ARMYG": the model as
// Polaris abbreviates it, without the model year, for a model the shop
// hasn't named on its list yet.
export function modelFromDescription(description: string): string {
  return line(description)
    .toUpperCase()
    .replace(/^([A-Z]+)-[^,.:;\s]{1,3}[,.:;\s]*/, "$1,")
    .split(/[,\s]+/)
    .filter(Boolean)
    .join(" ")
    .slice(0, UNIT_LIMITS.model);
}

// The paint at the end of Polaris's description ("ARMYG"), or null.
export function paintOf(description: string | null): string | null {
  const last = line(description ?? "")
    .toUpperCase()
    .split(/[,\s]+/)
    .filter(Boolean)
    .at(-1);
  return last && /^[A-Z][A-Z.]{2,}$/.test(last) && !/^(?:XP|PS|HTR|CR|EPS|ULT|NS|NSU|NSULT|PRM|PREM|SPORT|TRAIL|ADV)$/.test(last) ? last : null;
}

// A model the shop named for the same model with another paint ("Rngr 1000
// XP NSU Crew - Blue Lab"), with this one's paint ("ARMYG") in its place.
export function withPaint(model: string, paint: string | null): string {
  const base = model.split(/\s+-\s+/)[0].trim();
  return paint && base !== model ? `${base} - ${paint}`.slice(0, UNIT_LIMITS.model) : model;
}

// "2027 Rngr 1000 XP NSU Crew - Blue Lab".
export const unitName = (unit: { unitYear: number | null; model: string }) => [unit.unitYear, unit.model].filter(Boolean).join(" ");

// "4XARSY991V" and "8074528": a VIN's last seven, which the shop's list
// went by, and what comes before them.
export function vinParts(vin: string): [string, string] {
  return vin.length > 7 ? [vin.slice(0, -7), vin.slice(-7)] : ["", vin];
}

// --- A unit as typed ------------------------------------------------------------

export const UNIT_LIMITS = { vin: 30, model: 120, modelNumber: 20, description: 120, engineNumber: 30, notes: 1000, invoiceNumber: 20, fileName: 200 } as const;
export const MIN_UNIT_YEAR = 1950;
export const MAX_UNIT_YEAR = 2100;

export type UnitFields = {
  vin: string;
  unitYear: number | null;
  model: string;
  modelNumber: string | null;
  description: string | null;
  engineNumber: string | null;
  receivedOn: string;
  cost: Cents | null;
  listPrice: Cents | null;
  // Marked sold on the list; null while it's in stock.
  soldOn: string | null;
  notes: string | null;
};

export const UNIT_LABELS: Record<keyof UnitFields, string> = {
  vin: "VIN",
  unitYear: "Year",
  model: "Model",
  modelNumber: "Model number",
  description: "Description",
  engineNumber: "Engine #",
  receivedOn: "Received",
  cost: "Cost",
  listPrice: "List Price",
  soldOn: "Sold",
  notes: "Notes",
};

export type UnitInput = Partial<Record<keyof UnitFields, unknown>>;
export type UnitProblem = { error: string; field?: keyof UnitFields };

const orNull = (value: string) => (value === "" ? null : value);

// A unit as typed (or read from an invoice and checked), checked: its VIN
// and model, the day it was received, and amounts that are amounts. What's
// wrong comes back with the box it's about.
export function checkUnit(input: UnitInput): { unit: UnitFields } | UnitProblem {
  const vin = cleanVin(input.vin);
  if ("error" in vin) return { error: vin.error, field: "vin" };
  if (!vin.vin) return { error: "Every unit needs its VIN.", field: "vin" };
  if (vin.vin.length > UNIT_LIMITS.vin) return { error: "That VIN is too long.", field: "vin" };

  const yearText = line(input.unitYear);
  let unitYear: number | null = null;
  if (yearText) {
    unitYear = Number(yearText);
    if (!/^\d{4}$/.test(yearText) || unitYear < MIN_UNIT_YEAR || unitYear > MAX_UNIT_YEAR) return { error: "The year is a model year, such as 2027.", field: "unitYear" };
  }

  const model = line(input.model);
  if (!model) return { error: "Give the unit its model, as the list should show it.", field: "model" };
  if (model.length > UNIT_LIMITS.model) return { error: `The model is ${UNIT_LIMITS.model} characters at most.`, field: "model" };

  const modelNumber = line(input.modelNumber).toUpperCase().replace(/\s+/g, "");
  if (modelNumber.length > UNIT_LIMITS.modelNumber || (modelNumber && !/^[A-Z0-9-]+$/.test(modelNumber))) {
    return { error: "A model number is letters and figures, such as R27RSY99AA.", field: "modelNumber" };
  }
  const description = line(input.description);
  if (description.length > UNIT_LIMITS.description) return { error: `The description is ${UNIT_LIMITS.description} characters at most.`, field: "description" };
  const engineNumber = line(input.engineNumber).toUpperCase().replace(/\s+/g, "");
  if (engineNumber.length > UNIT_LIMITS.engineNumber) return { error: "That engine number is too long.", field: "engineNumber" };

  const receivedOn = parseIsoDate(input.receivedOn);
  if (!receivedOn) return { error: "Give the day it was received.", field: "receivedOn" };
  const soldText = line(input.soldOn);
  const soldOn = soldText ? parseIsoDate(soldText) : null;
  if (soldText && !soldOn) return { error: "That isn't a day it could have been sold.", field: "soldOn" };

  const money = (field: "cost" | "listPrice"): { cents: Cents | null } | UnitProblem => {
    const read = parseMoney(input[field]);
    if ("error" in read) return { error: `The ${UNIT_LABELS[field].toLowerCase()} ${read.error}.`, field };
    if (read.cents !== null && read.cents < 0) return { error: `The ${UNIT_LABELS[field].toLowerCase()} can't be below zero.`, field };
    return read;
  };
  const cost = money("cost");
  if ("error" in cost) return cost;
  const listPrice = money("listPrice");
  if ("error" in listPrice) return listPrice;

  const notes = line(input.notes);
  if (notes.length > UNIT_LIMITS.notes) return { error: `Notes are ${UNIT_LIMITS.notes} characters at most.`, field: "notes" };

  return {
    unit: {
      vin: vin.vin,
      unitYear,
      model,
      modelNumber: orNull(modelNumber),
      description: orNull(description),
      engineNumber: orNull(engineNumber),
      receivedOn,
      cost: cost.cents,
      listPrice: listPrice.cents,
      soldOn,
      notes: orNull(notes),
    },
  };
}

// What a unit's form boxes show.
export type UnitValues = Record<keyof UnitFields, string>;

const moneyBox = (cents: Cents | null) => (cents === null ? "" : formatMoney(cents).replace("$", ""));

export function unitValues(unit: UnitFields): UnitValues {
  return {
    vin: unit.vin,
    unitYear: unit.unitYear === null ? "" : String(unit.unitYear),
    model: unit.model,
    modelNumber: unit.modelNumber ?? "",
    description: unit.description ?? "",
    engineNumber: unit.engineNumber ?? "",
    receivedOn: unit.receivedOn,
    cost: moneyBox(unit.cost),
    listPrice: moneyBox(unit.listPrice),
    soldOn: unit.soldOn ?? "",
    notes: unit.notes ?? "",
  };
}

export { moneyBox };

// What changed between two versions of a unit, field by field, for the
// Activity log (amounts in cents).
export function unitChanges(before: UnitFields, after: UnitFields) {
  const changes: Partial<Record<keyof UnitFields, { from: unknown; to: unknown }>> = {};
  for (const key of Object.keys(UNIT_LABELS) as (keyof UnitFields)[]) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  }
  return changes;
}

// --- The list -------------------------------------------------------------------

export const UNIT_STATUSES = ["stock", "sold", "all"] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];
export const UNIT_STATUS_LABELS: Record<UnitStatus, string> = { stock: "In stock", sold: "Sold", all: "All" };

export type UnitFilters = { status: UnitStatus; query: string };

const MAX_QUERY = 100;

type Params = Record<string, string | string[] | undefined>;

// The list's filters from the address: in stock (unless sold or all is
// asked for) and a search.
export function parseUnitFilters(params: Params): UnitFilters {
  const status = typeof params.status === "string" && (UNIT_STATUSES as readonly string[]).includes(params.status) ? (params.status as UnitStatus) : "stock";
  const query = typeof params.q === "string" ? line(params.q).slice(0, MAX_QUERY) : "";
  return { status, query };
}

export function unitListHref(filters: UnitFilters) {
  const params = new URLSearchParams();
  if (filters.status !== "stock") params.set("status", filters.status);
  if (filters.query) params.set("q", filters.query);
  const search = params.toString();
  return `/unit-list${search ? `?${search}` : ""}`;
}

// The NUSR's sale of a unit (sold new): the Unit List counts it as sold.
export type NusrSale = { id: string; soldOn: string; customerName: string; salesperson: string | null };

// --- Partial VINs -----------------------------------------------------------------

// The shop's sheet kept each unit's VIN as its last seven characters (the
// plant and the serial number: "8056154"), so a unit imported from it has
// only those until its invoice is dropped or the whole VIN is typed. A VIN
// that short is matched by the end of a whole one, from this many
// characters.
export const MIN_VIN_TAIL = 6;
export const isPartialVin = (vin: string) => vin.length < 17;

// Whether two VINs are one unit's: the same, or the shorter (6 to 16
// characters, as a sheet kept it) the end of the longer.
export function sameVin(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= MIN_VIN_TAIL && short.length < 17 && long.endsWith(short);
}

// The endings of a whole VIN a sheet could have kept: its last 16 to 6.
export const vinTails = (vin: string) => (vin.length === 17 ? Array.from({ length: 17 - MIN_VIN_TAIL }, (_, i) => vin.slice(i + 1)) : []);

// Whether a whole VIN can be a unit's of this model year (its character
// 10 says the year).
const fitsYear = (vin: string, year: number | null) => year === null || vin.length !== 17 || vin[9] === vinYearCode(year);

// Whether two units are one: the same VIN, or one VIN the end of the other,
// of the same model year.
export function sameUnit(a: { vin: string; unitYear: number | null }, b: { vin: string; unitYear: number | null }): boolean {
  if (a.vin === b.vin) return true;
  if (!sameVin(a.vin, b.vin)) return false;
  if (a.unitYear !== null && b.unitYear !== null && a.unitYear !== b.unitYear) return false;
  return fitsYear(a.vin, b.unitYear) && fitsYear(b.vin, a.unitYear);
}

// The unit on the list that a unit (read from an invoice, or a sheet) is:
// the one with its VIN, else one with only its end, or whose end it has.
export function listedAs<T extends { vin: string; unitYear: number | null }>(unit: { vin: string; unitYear: number | null }, listed: readonly T[]): T | null {
  return listed.find((one) => one.vin === unit.vin) ?? listed.find((one) => sameUnit(one, unit)) ?? null;
}

// The NUSR's sale of a unit on the list: of its VIN, sold new; or, when one
// of the two VINs is only the end of the other, a sale of the unit's model
// year (by the whole VIN's character 10) no more than a year before it came
// in, so an old sale whose serial ends the same isn't taken for it. The
// latest, when there's more than one.
export function nusrSaleOf(unit: { vin: string; unitYear: number | null; receivedOn: string }, sales: readonly (NusrSale & { vin: string })[]): NusrSale | null {
  const exact = sales.filter((sale) => sale.vin === unit.vin);
  const found = exact.length
    ? exact
    : sales.filter((sale) => sameVin(sale.vin, unit.vin) && fitsYear(sale.vin, unit.unitYear) && daysBetween(sale.soldOn, unit.receivedOn) <= 365);
  if (found.length === 0) return null;
  const latest = found.reduce((best, sale) => (sale.soldOn > best.soldOn ? sale : best));
  return { id: latest.id, soldOn: latest.soldOn, customerName: latest.customerName, salesperson: latest.salesperson };
}

// When a unit was sold, and how the list knows: marked sold on it, sold
// new in the NUSR, or marked sold on the LOC. Null while it's in stock.
export function soldOf(unit: { soldOn: string | null; nusrSale: NusrSale | null; loc?: Pick<LocLink, "soldOn"> | null }): { on: string; how: "marked" | "nusr" | "loc" } | null {
  if (unit.soldOn) return { on: unit.soldOn, how: "marked" };
  if (unit.nusrSale) return { on: unit.nusrSale.soldOn, how: "nusr" };
  if (unit.loc?.soldOn) return { on: unit.loc.soldOn, how: "loc" };
  return null;
}

// --- The LOC ---------------------------------------------------------------------------

// The LOC tab's unit (src/lib/loc.ts) that a unit on the Unit List is: where
// it stands on the shop's line of credit.
export type LocLink = {
  id: string;
  stockNumber: string | null;
  vin: string | null;
  unitYear: number | null;
  model: string;
  cost: Cents;
  freeFloorEnds: string | null;
  receivedOn: string | null;
  onLoc: boolean;
  paidOffOn: string | null;
  soldOn: string | null;
};

// The stock # the LOC numbers a unit by, from its VIN on the Unit List: the
// digits at the end of its last seven characters (six after a plant
// letter, seven where the plant is a digit), as the LOC's stockFromVin
// gives it from a whole VIN; the end of a VIN the shop's sheet kept
// ("8056154", "H272059") gives the same.
export function stockOfVin(vin: string): string | null {
  if (vin.length < MIN_VIN_TAIL) return null;
  const digits = /\d+$/.exec(vin.slice(-7))?.[0] ?? "";
  return digits.length >= 4 ? digits : null;
}

// Whether a unit on the LOC is this one on the Unit List: the same VIN; or,
// of the same model year when both say, a VIN one is the end of the other,
// or, for a unit the LOC has no VIN for (as its sheet keeps them), the
// stock # the Unit List's VIN gives.
export function isLocUnitOf(unit: { vin: string; unitYear: number | null }, loc: Pick<LocLink, "vin" | "stockNumber" | "unitYear">): boolean {
  if (loc.vin && loc.vin === unit.vin) return true;
  if (unit.unitYear !== null && loc.unitYear !== null && unit.unitYear !== loc.unitYear) return false;
  if (loc.vin) return sameVin(loc.vin, unit.vin);
  const stock = stockOfVin(unit.vin);
  return stock !== null && loc.stockNumber !== null && loc.stockNumber.toLowerCase() === stock.toLowerCase();
}

// The LOC's unit a unit on the Unit List is (isLocUnitOf): one still on the
// LOC's list (in stock, or sold and still owed) before one long gone, then
// the latest in.
export function locUnitOf<T extends Pick<LocLink, "vin" | "stockNumber" | "unitYear" | "soldOn" | "onLoc" | "receivedOn">>(unit: { vin: string; unitYear: number | null }, loc: readonly T[]): T | null {
  const listed = (one: T) => one.soldOn === null || one.onLoc;
  const found = loc.filter((one) => isLocUnitOf(unit, one));
  found.sort((a, b) => Number(listed(b)) - Number(listed(a)) || (b.receivedOn ?? "").localeCompare(a.receivedOn ?? ""));
  return found[0] ?? null;
}

// A unit on the Unit List as the LOC's form takes it (checkLocUnit in
// src/lib/loc-rules.ts): its stock # from its VIN, the whole VIN (the end
// of one stays its stock #), its year and model, the category its model
// says, new, its cost and the day it came in, and its free floor; on the
// LOC as a new unit is floored when it comes in, or the shop's own.
export function locInputOf(unit: UnitFields, { freeFloorEnds, section }: { freeFloorEnds: string | null; section: "loc" | "owned" }) {
  return {
    stockNumber: stockOfVin(unit.vin) ?? "",
    vin: isPartialVin(unit.vin) ? "" : unit.vin,
    unitYear: unit.unitYear === null ? "" : String(unit.unitYear),
    model: unit.model,
    category: guessCategory(unit.model) ?? "",
    condition: "new",
    cost: unit.cost === null ? "" : (unit.cost / 100).toFixed(2),
    freeFloorEnds: freeFloorEnds ?? "",
    receivedOn: unit.receivedOn,
    section,
    paidOffOn: "",
    soldOn: unit.soldOn ?? "",
    notes: "",
  };
}

// Whole days from one day ("2026-11-06") to another.
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// Days a unit has been in stock: from the day it was received to the day it
// sold, or to today; never below zero (a unit sold before it came in).
export const daysInStock = (unit: { receivedOn: string; soldOn: string | null; nusrSale: NusrSale | null; loc?: Pick<LocLink, "soldOn"> | null }, today: string) =>
  Math.max(0, daysBetween(unit.receivedOn, soldOf(unit)?.on ?? today));

type Listed = {
  unitYear: number | null;
  model: string;
  receivedOn: string;
  vin: string;
  cost: Cents | null;
  listPrice: Cents | null;
  soldOn: string | null;
  nusrSale: NusrSale | null;
  loc?: Pick<LocLink, "onLoc" | "freeFloorEnds" | "soldOn"> | null;
};

// Where the units stand on the LOC: owed on it (and of those, how many
// have run out of free flooring, or will within 30 days), the shop's own,
// and not on it.
export type LocTally = { onLoc: number; owned: number; none: number; ended: number; soon: number };

export type UnitTotals = { units: number; cost: Cents; list: Cents; noCost: number; noList: number; averageDays: number | null; oldestDays: number | null; loc: LocTally };

function locTally(units: readonly Listed[], today: string): LocTally {
  const tally: LocTally = { onLoc: 0, owned: 0, none: 0, ended: 0, soon: 0 };
  for (const unit of units) {
    if (!unit.loc) tally.none++;
    else if (!unit.loc.onLoc) tally.owned++;
    else {
      tally.onLoc++;
      const floor = floorStatus(unit.loc.freeFloorEnds, today).state;
      if (floor === "ended") tally.ended++;
      else if (floor === "soon") tally.soon++;
    }
  }
  return tally;
}

// The units, counted, their costs and list prices added up (and how many
// have none yet), and how long they've been in stock on average and at
// most.
export function unitTotals(units: readonly Listed[], today: string): UnitTotals {
  const days = units.map((unit) => daysInStock(unit, today));
  return {
    units: units.length,
    cost: units.reduce((sum, unit) => sum + (unit.cost ?? 0), 0),
    list: units.reduce((sum, unit) => sum + (unit.listPrice ?? 0), 0),
    noCost: units.filter((unit) => unit.cost === null).length,
    noList: units.filter((unit) => unit.listPrice === null).length,
    averageDays: days.length ? Math.round(days.reduce((sum, day) => sum + day, 0) / days.length) : null,
    oldestDays: days.length ? Math.max(...days) : null,
    loc: locTally(units, today),
  };
}

export type UnitGroup<T> = { key: string; name: string; units: T[]; totals: UnitTotals };

// The units by model, as the shop's sheet kept them (each model's units
// together, with their count): the newest model year first, then by name;
// each model's units the longest in stock first.
export function groupUnits<T extends Listed>(units: readonly T[], today: string): UnitGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const unit of units) {
    const key = `${unit.unitYear ?? ""}|${unit.model.toLowerCase().replace(/\s+/g, " ")}`;
    const group = groups.get(key) ?? [];
    group.push(unit);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({
      key,
      name: unitName(list[0]),
      units: [...list].sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.vin.localeCompare(b.vin)),
      totals: unitTotals(list, today),
    }))
    .sort((a, b) => (b.units[0].unitYear ?? 0) - (a.units[0].unitYear ?? 0) || a.name.localeCompare(b.name, "en-US", { sensitivity: "base" }));
}

export { MAX_AMOUNT_CENTS };
