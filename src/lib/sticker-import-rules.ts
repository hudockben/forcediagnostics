// Importing the Sticker & Plate log from a spreadsheet (Sticker & Plate log >
// Import): which column is which, what each entry is, and what importing
// the rows would do, each sticker and plate checked as the log's form
// checks it. A sheet can hold several lists side by side, as the shop's
// does: stickers in one pair of columns (Sticker #, Customer Name), Class 1
// plates in the next (Class 1 Plate, Customer Name) and Class 2 plates in
// another, a row's sticker and plates nothing to do with each other. Each
// number column is a list, and the Customer Name, Phone and Type columns
// after it, up to the next number column, are its. No server imports: the
// browser plans the import to show what will happen, and the server checks
// every entry again as it saves them (importStickers in
// src/lib/sticker-log.ts).

import { HEADER_SEARCH_ROWS, headingKey, nameKey } from "@/lib/customer-import-rules";
import { checkCustomer, normalizePhone, type CustomerFields } from "@/lib/customer-rules";
import {
  ENTRY_KINDS,
  ENTRY_KIND_LABELS,
  checkStickerEntry,
  classOf,
  entryLabel,
  entryWords,
  normalizeSticker,
  type EntryKind,
  type PlateClass,
} from "@/lib/sticker-log-rules";

// What a column can be. A number column is a list: of stickers, of one
// class of plates, or of either ("Sticker or plate #"), when a Type column
// or the choice on the page says which.
export const STICKER_IMPORT_FIELDS = ["sticker", "plate1", "plate2", "number", "customerName", "phone", "type"] as const;
export type StickerImportField = (typeof STICKER_IMPORT_FIELDS)[number];

export const STICKER_IMPORT_LABELS: Record<StickerImportField, string> = {
  sticker: "Sticker #",
  plate1: "Class 1 Plate #",
  plate2: "Class 2 Plate #",
  number: "Sticker or plate #",
  customerName: "Customer Name",
  phone: "Phone",
  type: "Type",
};

const NUMBER_FIELDS: readonly StickerImportField[] = ["sticker", "plate1", "plate2", "number"];
export const isNumberField = (field: StickerImportField | null): boolean => field !== null && NUMBER_FIELDS.includes(field);

// What a number column's entries are, when the column says.
const FIELD_KINDS: Partial<Record<StickerImportField, EntryKind>> = { sticker: "sticker", plate1: "1", plate2: "2" };

// The headings each field goes by ("Sticker #" is "stickernumber" to
// headingKey, "Class 1 Plate" is "class1plate").
const HEADINGS: Record<StickerImportField, string[]> = {
  sticker: ["stickernumber", "sticker", "stickerno", "stickernum", "decalnumber", "decal", "decalno", "registrationsticker", "regsticker", "tempsticker", "temporarysticker"],
  plate1: ["class1plate", "class1platenumber", "class1plateno", "classiplate", "classiplatenumber", "plateclass1", "class1plates", "class1"],
  plate2: ["class2plate", "class2platenumber", "class2plateno", "classiiplate", "classiiplatenumber", "plateclass2", "class2plates", "class2"],
  number: [
    "stickerplatenumber", "stickerorplatenumber", "stickerplate", "stickerorplate", "platenumber", "plateno", "plate",
    "number", "registrationnumber", "registrationno", "regnumber", "regno",
  ],
  customerName: ["customername", "customer", "name", "fullname", "ownername", "owner", "registeredowner", "buyername", "buyer", "purchaser", "clientname", "client"],
  phone: ["phone", "phonenumber", "customerphone", "mobile", "mobilephone", "cell", "cellphone", "telephone", "tel", "homephone", "workphone"],
  type: ["type", "plateclassification", "plateclass", "classification", "class", "kind"],
};

const fieldFor = new Map<string, StickerImportField>();
for (const field of STICKER_IMPORT_FIELDS) {
  for (const heading of HEADINGS[field]) if (!fieldFor.has(heading)) fieldFor.set(heading, field);
}

// Which field each column is, by its heading. Several columns can be the
// same field, for lists side by side; anything else ("Logged",
// "Logged by") is left out.
export function stickerColumns(headings: string[]): (StickerImportField | null)[] {
  return headings.map((heading) => fieldFor.get(headingKey(heading)) ?? null);
}

// The headings row: the one among the first ten naming the most fields
// (a title line or two above it is fine). -1 when none does.
export function findStickerHeader(rows: string[][]): number {
  let best = -1;
  let bestCount = 0;
  for (let index = 0; index < rows.length && index < HEADER_SEARCH_ROWS; index++) {
    const count = stickerColumns(rows[index]).filter(Boolean).length;
    if (count > bestCount) [best, bestCount] = [index, count];
  }
  return best;
}

// One list on the sheet: its number column, and its Customer Name, Phone
// and Type columns (the first of each after it, before the next number
// column; a column before every number column is the first list's).
export type StickerList = { column: number; field: StickerImportField; name: number | null; phone: number | null; type: number | null };

// The list each column is part of: the number column at or before it.
export function listOf(mapping: (StickerImportField | null)[], column: number): number | null {
  const numbers = mapping.flatMap((field, at) => (isNumberField(field) ? [at] : []));
  if (numbers.length === 0) return null;
  return numbers.filter((at) => at <= column).at(-1) ?? numbers[0];
}

export function stickerLists(mapping: (StickerImportField | null)[]): StickerList[] {
  const first = (owner: number, field: StickerImportField) => {
    const at = mapping.findIndex((each, column) => each === field && listOf(mapping, column) === owner);
    return at === -1 ? null : at;
  };
  return mapping.flatMap((field, column) =>
    field && isNumberField(field) ? [{ column, field, name: first(column, "customerName"), phone: first(column, "phone"), type: first(column, "type") }] : [],
  );
}

const CLASS_WORDS: Record<string, PlateClass> = { "1": 1, "2": 2, i: 1, ii: 2, one: 1, two: 2 };

// "1", "Class 2", "CLASS II", "Plate class #1", "Class 1 Plate", "2.0" (a
// number from Excel) -> 1 or 2. Null for anything else.
export function parsePlateClass(text: string): PlateClass | null {
  const key = text
    .toLowerCase()
    .replace(/\b(?:plates?|classification|class|type)\b|\bno\b\.?|[#:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^0+(?=\d)/, "")
    .replace(/^(\d)\.0+$/, "$1");
  return CLASS_WORDS[key] ?? null;
}

// A Type cell: "Sticker", "Class 1 plate", "Class II", "2"... Null for
// anything else.
export function parseKind(text: string): EntryKind | null {
  if (/\b(?:stickers?|decals?)\b/i.test(text)) return "sticker";
  const plateClass = parsePlateClass(text);
  return plateClass === null ? null : plateClass === 1 ? "1" : "2";
}

// Whom a name is, either way round: "Rudd, Benjamin" (last name first, one
// comma) is Benjamin Rudd. Without case or extra spaces, as nameKey.
// importStickers works the same out in SQL to find customers on file.
export function personKey(name: string): string {
  const key = nameKey(name);
  const parts = key.split(",").map((part) => part.trim());
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[1]} ${parts[0]}` : key;
}

// One sticker or plate of an import, as the browser sends it: the number
// as the log keeps it, what it is (a plate's class, or null for a
// sticker), and whose it is, with the sheet row it's on.
export type StickerImportRow = {
  row: number;
  stickerNumber: string;
  customerName: string;
  phone: string | null;
  plateClass: PlateClass | null;
};
export type StickerImportNote = { row: number; message: string };
export type StickerImportPlan = { stickers: StickerImportRow[]; notes: StickerImportNote[]; rowsRead: number };

export type StickerImportEntry = { stickerNumber: string; plateClass: PlateClass | null; customer: CustomerFields };

// An entry checked the way the log's form checks one and Customers checks
// a name and a phone number. The server checks each entry it's sent with
// this, whatever the browser did.
export function checkStickerImport(input: unknown): { entry: StickerImportEntry } | { error: string } {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const sticker = checkStickerEntry({ stickerNumber: value.stickerNumber, plateClass: value.plateClass });
  if ("error" in sticker) return sticker;
  const customer = checkCustomer({
    name: value.customerName,
    phone: value.phone ?? "",
    email: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    notes: "",
  });
  if ("error" in customer) return customer;
  return { entry: { ...sticker.entry, customer: customer.customer } };
}

export const MAX_STICKER_IMPORT_ROWS = 20_000;

const quoted = (text: string) => `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`;

// A sticker or plate given back ("Benanti, Anthony - returned") or voided
// isn't the customer's: it's left out.
const RETURNED = /\b(?:returned|void(?:ed)?)\b/i;

// What importing the rows would do. Each list is read down its rows, the
// stickers' first and then each list of plates', in the file's order; a
// row with nothing in a list's columns is no entry of that list. What an
// entry is comes from the list's Type column, else its number column
// (Sticker #, Class 1 or Class 2 Plate), else the choice on the page
// (picked). An entry without a number, a name or a type, one marked
// returned, or a number already on an earlier entry (only the first is
// logged) is left out, with a note. A phone number that isn't one is left
// out, keeping the entry.
export function planStickerImport(
  rows: string[][],
  headerRow: number,
  mapping: (StickerImportField | null)[],
  { kind: picked = null }: { kind?: EntryKind | null } = {},
): StickerImportPlan {
  const lists = stickerLists(mapping);
  const read = mapping.flatMap((field, column) => (field ? [column] : []));
  const notes: StickerImportNote[] = [];
  // The rows with something in a column the import reads.
  const taken: number[] = [];
  for (let index = headerRow + 1; index < rows.length; index++) {
    if (!read.some((column) => rows[index][column]?.trim())) continue;
    if (taken.length === MAX_STICKER_IMPORT_ROWS) {
      notes.push({ row: index + 1, message: `Only the first ${MAX_STICKER_IMPORT_ROWS.toLocaleString("en-US")} rows are imported; split the file to import the rest.` });
      break;
    }
    taken.push(index);
  }
  const stickers: StickerImportRow[] = [];
  const byNumber = new Map<string, StickerImportRow>();
  for (const list of lists) {
    for (const index of taken) {
      const row = index + 1;
      const cell = (column: number | null) => (column === null ? "" : (rows[index][column] ?? "").trim());
      const [number, name, phone, typed] = [cell(list.column), cell(list.name), cell(list.phone), cell(list.type)];
      if (!normalizeSticker(number) && !name) continue;
      const note = (message: string) => notes.push({ row, message });
      const typedKind = typed ? parseKind(typed) : null;
      if (typed && !typedKind) {
        note(`Type ${quoted(typed)} isn't a sticker or a Class 1 or Class 2 plate: ${number || "it"} left out.`);
        continue;
      }
      const kind = typedKind ?? FIELD_KINDS[list.field] ?? picked;
      const what = kind ? `${entryWords(classOf(kind))} ${number}` : number;
      if (!normalizeSticker(number)) {
        note(`No ${STICKER_IMPORT_LABELS[list.field]} for ${quoted(name)}: left out.`);
        continue;
      }
      if (!name) {
        note(`No Customer Name for ${what}: left out.`);
        continue;
      }
      if (RETURNED.test(name) || RETURNED.test(number)) {
        note(`${what.charAt(0).toUpperCase()}${what.slice(1)} is marked returned: left out.`);
        continue;
      }
      if (!kind) {
        note(`Nothing says whether ${number} is a sticker or a plate: left out.`);
        continue;
      }
      const plateClass = classOf(kind);
      const sticker = checkStickerEntry({ stickerNumber: number, plateClass });
      if ("error" in sticker) {
        note(`${ENTRY_KIND_LABELS[kind]} ${quoted(number)}: ${sticker.error} Left out.`);
        continue;
      }
      const typedPhone = normalizePhone(phone);
      if ("error" in typedPhone) note(`Phone ${quoted(phone)} left out: ${typedPhone.error}`);
      const checked = checkStickerImport({ stickerNumber: number, customerName: name, phone: "error" in typedPhone ? "" : phone, plateClass });
      if ("error" in checked) {
        note(`Customer Name ${quoted(name)}: ${checked.error} Left out.`);
        continue;
      }
      const { stickerNumber, customer } = checked.entry;
      const earlier = byNumber.get(stickerNumber);
      if (earlier) {
        note(
          personKey(earlier.customerName) === personKey(customer.name) && earlier.plateClass === plateClass
            ? `${entryLabel(plateClass)} ${stickerNumber} is on row ${earlier.row} too: logged once.`
            : `${stickerNumber} is also on row ${earlier.row}, as a ${entryWords(earlier.plateClass)} for ${earlier.customerName}: only that one is logged.`,
        );
        continue;
      }
      const entry: StickerImportRow = { row, stickerNumber, customerName: customer.name, phone: customer.phone, plateClass };
      byNumber.set(stickerNumber, entry);
      stickers.push(entry);
    }
  }
  notes.sort((a, b) => a.row - b.row);
  return { stickers, notes, rowsRead: taken.length };
}

// "21 stickers, 17 Class 1 plates and 19 Class 2 plates".
export function countByKind(stickers: { plateClass: PlateClass | null }[]): string {
  const parts = ENTRY_KINDS.flatMap((kind) => {
    const count = stickers.filter((entry) => entry.plateClass === classOf(kind)).length;
    const words = entryWords(classOf(kind));
    return count === 0 ? [] : [`${count.toLocaleString("en-US")} ${count === 1 ? words : `${words}s`}`];
  });
  return parts.length === 0 ? "nothing" : parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export const MAX_STICKER_IMPORT_BATCH = 500;

// What the server did with each entry of an import batch.
export type StickerImportOutcome = {
  row: number;
  // logged: added to the log; already: that number is in the log already
  // (left as it is); failed: left out.
  result: "logged" | "already" | "failed";
  // For one logged: its customer was found on Customers, or added.
  customer: "found" | "added" | null;
  // Why it was left out, or how the log's entry differs from the file.
  message: string | null;
};
